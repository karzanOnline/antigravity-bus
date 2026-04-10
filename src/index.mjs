#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const APP_SUPPORT_DIR = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Antigravity"
);
const STATE_DB_PATH = path.join(
  APP_SUPPORT_DIR,
  "User",
  "globalStorage",
  "state.vscdb"
);
const LOGS_DIR = path.join(APP_SUPPORT_DIR, "logs");
const MAIN_IPC_SUFFIX = "-main.sock";
const DEFAULT_BRIDGE_DIR = path.join(APP_SUPPORT_DIR, "antigravity-bus-bridge");
const DEFAULT_STORE_DIR = path.join(process.cwd(), ".cowork-temp", "antigravity-bus");
const RECENT_TASK_WINDOW_MS = 1000 * 60 * 60 * 24 * 2;
const TOPIC_REQUEST_TIMEOUT_MS = 1500;
const MAIN_IPC_INIT_TIMEOUT_MS = 3000;
const IPC_FRAME_TYPE_REGULAR = 1;
const IPC_RESPONSE = {
  initialize: 200,
  success: 201,
  promiseError: 202,
  error: 203,
  eventFire: 204,
};
const IPC_VALUE_TYPE = {
  undefined: 0,
  string: 1,
  buffer: 2,
  vsBuffer: 3,
  array: 4,
  object: 5,
  int: 6,
};
const EXTENSION_SERVER_SERVICE = "/exa.extension_server_pb.ExtensionServerService";
const TOPICS = {
  activeCascadeIds: "uss-activeCascadeIds",
  trajectorySummaries: "trajectorySummaries",
  userStatus: "uss-userStatus",
  machineInfos: "uss-lsClientMachineInfos",
};
const PACKAGE_JSON = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
);

export const PACKAGE_NAME = PACKAGE_JSON.name;
export const PACKAGE_VERSION = PACKAGE_JSON.version;

export function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      ...options,
    }).trim();
  } catch (error) {
    return "";
  }
}

export function parseArgs(argv) {
  const [rawCommand = "snapshot", ...rest] = argv;
  const command =
    rawCommand === "-h" || rawCommand === "--help"
      ? "help"
      : rawCommand === "-v" || rawCommand === "--version"
        ? "version"
        : rawCommand;
  const options = {
    command,
    cwd: process.cwd(),
    intervalMs: 4000,
    outDir: DEFAULT_STORE_DIR,
    addFiles: [],
    profile: null,
    mode: "agent",
    prompt: null,
    waitMs: 8000,
    waitForNewCascade: false,
    bridgeDir: DEFAULT_BRIDGE_DIR,
  };

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    const next = rest[index + 1];

    if (value === "--cwd" && next) {
      options.cwd = path.resolve(next);
      index += 1;
    } else if (value === "--interval" && next) {
      options.intervalMs = Number.parseInt(next, 10) || options.intervalMs;
      index += 1;
    } else if (value === "--out-dir" && next) {
      options.outDir = path.resolve(next);
      index += 1;
    } else if (value === "--add-file" && next) {
      options.addFiles.push(path.resolve(next));
      index += 1;
    } else if (value === "--profile" && next) {
      options.profile = next;
      index += 1;
    } else if (value === "--mode" && next) {
      options.mode = next;
      index += 1;
    } else if (value === "--prompt" && next) {
      options.prompt = next;
      index += 1;
    } else if (value === "--wait-ms" && next) {
      options.waitMs = Number.parseInt(next, 10) || options.waitMs;
      index += 1;
    } else if (value === "--wait-for-new-cascade") {
      options.waitForNewCascade = true;
    } else if (value === "--bridge-dir" && next) {
      options.bridgeDir = path.resolve(next);
      index += 1;
    } else if (!value.startsWith("--") && !options.prompt) {
      options.prompt = value;
    }
  }

  return options;
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class VSBufferWriter {
  constructor() {
    this.parts = [];
  }

  write(buffer) {
    this.parts.push(Buffer.from(buffer));
  }

  toBuffer() {
    return Buffer.concat(this.parts);
  }
}

export function writeVarint(writer, value) {
  if (value === 0) {
    writer.write(Buffer.from([0]));
    return;
  }

  const bytes = [];
  let current = value >>> 0;
  while (current !== 0) {
    let nextByte = current & 0x7f;
    current >>>= 7;
    if (current > 0) {
      nextByte |= 0x80;
    }
    bytes.push(nextByte);
  }

  writer.write(Buffer.from(bytes));
}

export function readVarint(buffer, state) {
  let value = 0;
  let shift = 0;

  for (;;) {
    const byte = buffer[state.offset];
    state.offset += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return value;
    }
    shift += 7;
  }
}

export function encodeIpcValue(writer, value) {
  if (value === undefined) {
    writer.write(Buffer.from([IPC_VALUE_TYPE.undefined]));
    return;
  }

  if (typeof value === "string") {
    const encoded = Buffer.from(value);
    writer.write(Buffer.from([IPC_VALUE_TYPE.string]));
    writeVarint(writer, encoded.length);
    writer.write(encoded);
    return;
  }

  if (Array.isArray(value)) {
    writer.write(Buffer.from([IPC_VALUE_TYPE.array]));
    writeVarint(writer, value.length);
    for (const item of value) {
      encodeIpcValue(writer, item);
    }
    return;
  }

  if (typeof value === "number" && Number.isInteger(value)) {
    writer.write(Buffer.from([IPC_VALUE_TYPE.int]));
    writeVarint(writer, value >>> 0);
    return;
  }

  if (Buffer.isBuffer(value)) {
    writer.write(Buffer.from([IPC_VALUE_TYPE.buffer]));
    writeVarint(writer, value.length);
    writer.write(value);
    return;
  }

  const encoded = Buffer.from(JSON.stringify(value));
  writer.write(Buffer.from([IPC_VALUE_TYPE.object]));
  writeVarint(writer, encoded.length);
  writer.write(encoded);
}

export function decodeIpcValue(buffer, state) {
  const valueType = buffer[state.offset];
  state.offset += 1;

  switch (valueType) {
    case IPC_VALUE_TYPE.undefined:
      return undefined;
    case IPC_VALUE_TYPE.string: {
      const length = readVarint(buffer, state);
      const value = buffer.slice(state.offset, state.offset + length).toString("utf8");
      state.offset += length;
      return value;
    }
    case IPC_VALUE_TYPE.array: {
      const count = readVarint(buffer, state);
      const value = [];
      for (let index = 0; index < count; index += 1) {
        value.push(decodeIpcValue(buffer, state));
      }
      return value;
    }
    case IPC_VALUE_TYPE.object: {
      const length = readVarint(buffer, state);
      const value = JSON.parse(buffer.slice(state.offset, state.offset + length).toString("utf8"));
      state.offset += length;
      return value;
    }
    case IPC_VALUE_TYPE.int:
      return readVarint(buffer, state);
    case IPC_VALUE_TYPE.buffer:
    case IPC_VALUE_TYPE.vsBuffer: {
      const length = readVarint(buffer, state);
      const value = buffer.slice(state.offset, state.offset + length);
      state.offset += length;
      return value;
    }
    default:
      throw new Error(`Unknown IPC value type: ${valueType}`);
  }
}

export function encodeIpcParts(first, second = undefined) {
  const writer = new VSBufferWriter();
  encodeIpcValue(writer, first);
  if (arguments.length > 1) {
    encodeIpcValue(writer, second);
  }
  return writer.toBuffer();
}

export function decodeIpcParts(buffer) {
  const state = { offset: 0 };
  const first = decodeIpcValue(buffer, state);
  const second = state.offset < buffer.length ? decodeIpcValue(buffer, state) : undefined;
  return { first, second };
}

export function frameIpcMessage(data, messageType = IPC_FRAME_TYPE_REGULAR, id = 0, ack = 0) {
  const header = Buffer.alloc(13);
  header.writeUInt8(messageType, 0);
  header.writeUInt32BE(id, 1);
  header.writeUInt32BE(ack, 5);
  header.writeUInt32BE(data.length, 9);
  return Buffer.concat([header, data]);
}

export function normalizeWorkspaceId(cwd) {
  return `file_${cwd.replace(/^\/+/, "").replaceAll(/[/.:-]/g, "_")}`;
}

export function deriveProfileName(cwd) {
  const baseName = path.basename(cwd).replaceAll(/[^a-zA-Z0-9_-]+/g, "-") || "workspace";
  const suffix = crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 8);
  return `agbus-${baseName}-${suffix}`;
}

export function readStateValue(key) {
  if (!fs.existsSync(STATE_DB_PATH)) {
    return null;
  }

  const sql = `select value from ItemTable where key='${key.replaceAll("'", "''")}';`;
  const value = run("sqlite3", [STATE_DB_PATH, sql]);
  return value || null;
}

export function extractPrintableStrings(buffer, minLength = 8) {
  const matches = [];
  let start = -1;

  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index];
    const printable = byte >= 32 && byte <= 126;
    if (printable) {
      if (start === -1) {
        start = index;
      }
      continue;
    }

    if (start !== -1 && index - start >= minLength) {
      matches.push({
        offset: start,
        value: buffer.toString("utf8", start, index),
      });
    }
    start = -1;
  }

  if (start !== -1 && buffer.length - start >= minLength) {
    matches.push({
      offset: start,
      value: buffer.toString("utf8", start),
    });
  }

  return matches;
}

export function decodeBase64Strings(key) {
  const raw = readStateValue(key);
  if (!raw) {
    return [];
  }

  try {
    const decoded = Buffer.from(raw, "base64");
    return extractPrintableStrings(decoded);
  } catch {
    return [];
  }
}

export function listSidebarWorkspacePaths() {
  return decodeBase64Strings("antigravityUnifiedStateSync.sidebarWorkspaces")
    .map((entry) => entry.value)
    .filter((value) => value.includes("file:///"))
    .map((value) => value.slice(value.indexOf("file:///")))
    .map(fileUriToPath)
    .filter(Boolean);
}

export function parseInstanceLine(line) {
  if (!line.includes("language_server_macos_arm")) {
    return null;
  }

  // Antigravity exposes most runtime coordination data as CLI flags on the LS process.
  const trimmed = line.trim();
  const [pidToken, ...commandParts] = trimmed.split(/\s+/);
  const command = commandParts.join(" ");
  const readFlag = (flag) => command.match(new RegExp(`--${flag}\\s+(.+?)(?=\\s+--[a-z_]+\\s|\\s+--[a-z_]+$|$)`))?.[1] ?? null;
  const csrfToken = readFlag("csrf_token");
  const extensionServerPort = readFlag("extension_server_port");
  const extensionServerCsrfToken = readFlag("extension_server_csrf_token");
  const workspaceId = readFlag("workspace_id");
  const cloudCodeEndpoint = readFlag("cloud_code_endpoint");
  const appDataDir = readFlag("app_data_dir");

  return {
    pid: Number.parseInt(pidToken, 10),
    command,
    csrfToken,
    extensionServerPort: extensionServerPort ? Number.parseInt(extensionServerPort, 10) : null,
    extensionServerCsrfToken,
    workspaceId,
    cloudCodeEndpoint,
    appDataDir,
    supportsLsp: command.includes("--enable_lsp"),
  };
}

export function discoverInstances() {
  const output = run("ps", ["-axo", "pid=,command="]);
  const lines = output.split("\n").filter(Boolean);

  return lines.map(parseInstanceLine).filter(Boolean);
}

export function findWorkspaceInstance(instances, workspaceId) {
  return (
    instances.find((instance) => instance.workspaceId === workspaceId) ??
    instances.find((instance) => instance.supportsLsp) ??
    null
  );
}

export function frameConnectJson(payload) {
  const json = Buffer.from(JSON.stringify(payload));
  const envelope = Buffer.alloc(5);
  envelope[0] = 0;
  envelope.writeUInt32BE(json.length, 1);
  return Buffer.concat([envelope, json]);
}

export function parseConnectJsonResponse(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5) {
    return null;
  }

  const flag = buffer[0];
  const size = buffer.readUInt32BE(1);
  const body = buffer.subarray(5, 5 + size);
  if (flag !== 0 || body.length !== size) {
    return null;
  }

  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
}

export function decodeTopicStateEntries(topicPayload) {
  const data = topicPayload?.initialState?.data;
  if (!data || typeof data !== "object") {
    return [];
  }

  return Object.entries(data)
    .map(([key, value]) => ({
      key,
      value: value?.value ?? null,
    }))
    .filter((entry) => typeof entry.value === "string");
}

export function decodeBase64PrintableStrings(rawValue, minLength = 8) {
  try {
    const decoded = Buffer.from(rawValue, "base64");
    return extractPrintableStrings(decoded, minLength).map((item) => item.value);
  } catch {
    return [];
  }
}

export function extractActiveCascadeIds(topicPayload) {
  const ids = new Set();
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;

  for (const entry of decodeTopicStateEntries(topicPayload)) {
    for (const value of decodeBase64PrintableStrings(entry.value, 4)) {
      const matches = value.match(uuidPattern) ?? [];
      for (const match of matches) {
        ids.add(match);
      }
    }
  }

  return Array.from(ids);
}

export function extractTrajectorySignals(topicPayload) {
  const strings = [];
  const seen = new Set();

  for (const entry of decodeTopicStateEntries(topicPayload)) {
    for (const value of decodeBase64PrintableStrings(entry.value, 12)) {
      if (!seen.has(value)) {
        strings.push(value);
        seen.add(value);
      }
      if (strings.length >= 80) {
        return strings;
      }
    }
  }

  return strings;
}

export function deriveSupervisorState({ activeCascadeIds, trajectorySignals, tasks }) {
  const hasWaitingSignal = trajectorySignals.some((signal) =>
    /BlockedOnUser|ShouldAutoProceed|waiting|confirm|approval|user interaction/i.test(signal)
  );
  if (hasWaitingSignal) {
    return "waiting";
  }

  if (activeCascadeIds.length > 0) {
    return "running";
  }

  if (tasks.some((task) => ["completed", "written"].includes(task.statusGuess))) {
    return "done";
  }

  return "idle";
}

export function readTextFileIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

export function hasAnyPattern(text, patterns) {
  if (!text) {
    return false;
  }

  return patterns.some((pattern) => pattern.test(text));
}

export function hasTaskOutput(tasks) {
  return tasks.some((task) =>
    ["written", "completed", "in_progress"].includes(task.statusGuess)
  );
}

export function listDirtyFiles(cwd) {
  const output = run("git", ["-C", cwd, "status", "--short", "--untracked-files=all"]);
  if (!output) {
    return [];
  }

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[A-Z?]{1,2}\s+/, ""))
    .map((filePath) => path.resolve(cwd, filePath));
}

export function evaluateSkinSaasAppointmentStatusChain(cwd) {
  const detailPagePath = path.join(
    cwd,
    "apps",
    "admin",
    "src",
    "app",
    "appointments",
    "[id]",
    "page.tsx"
  );
  const controllerPath = path.join(cwd, "apps", "api", "src", "appointments", "appointments.controller.ts");
  const servicePath = path.join(cwd, "apps", "api", "src", "appointments", "appointments.service.ts");

  const detailPage = readTextFileIfExists(detailPagePath);
  const controller = readTextFileIfExists(controllerPath);
  const service = readTextFileIfExists(servicePath);

  const hasDetailPage = Boolean(detailPage);
  const hasStatusButton = hasAnyPattern(detailPage, [/更新状态/u, /Update\s+Status/i]);
  const hasFrontendMutation = hasAnyPattern(detailPage, [
    /fetch\s*\(/,
    /axios\./,
    /api(?:Fetch|Client|Request)?\s*\(/,
    /mutation/i,
    /PATCH/i,
    /PUT/i,
    /updateStatus/i,
  ]);
  const hasBackendRoute = hasAnyPattern(controller, [
    /@Patch\s*\(/,
    /@Put\s*\(/,
    /updateStatus/i,
    /updateAppointmentStatus/i,
    /setAppointmentStatus/i,
  ]);
  const hasBackendService = hasAnyPattern(service, [
    /updateStatus/i,
    /updateAppointmentStatus/i,
    /setAppointmentStatus/i,
    /status:\s*[^=]/,
  ]);

  const reasons = [];
  if (hasStatusButton && !hasFrontendMutation) {
    reasons.push("Appointment detail page exposes a status-update UI but does not send any update request.");
  }
  if (hasStatusButton && !hasBackendRoute) {
    reasons.push("Appointments controller does not expose a status-update route.");
  }
  if (hasStatusButton && hasBackendRoute && !hasBackendService) {
    reasons.push("Appointments service does not implement a status-update handler behind the route.");
  }

  const applicable = hasDetailPage && hasStatusButton;
  const passed = applicable && reasons.length === 0;
  const failed = applicable && reasons.length > 0;

  return {
    id: "skin-saas.appointment-status-chain",
    label: "Skin SaaS appointment status update chain",
    applicable,
    passed,
    failed,
    reasons,
    evidence: {
      detailPagePath,
      controllerPath,
      servicePath,
      hasDetailPage,
      hasStatusButton,
      hasFrontendMutation,
      hasBackendRoute,
      hasBackendService,
    },
  };
}

export function evaluateAcceptanceChecks(cwd, tasks) {
  const dirtyFiles = listDirtyFiles(cwd);
  const checks = [evaluateSkinSaasAppointmentStatusChain(cwd)];
  const applicableChecks = checks.filter((check) => check.applicable);
  const failedChecks = applicableChecks.filter((check) => check.failed);
  const passedChecks = applicableChecks.filter((check) => check.passed);
  const taskOutputDetected = hasTaskOutput(tasks);
  const dirtyRelevantFiles = dirtyFiles.filter((filePath) =>
    failedChecks.some((check) =>
      Object.values(check.evidence)
        .filter((value) => typeof value === "string")
        .includes(filePath)
    )
  );

  let state = "unknown";
  if (failedChecks.length > 0 && (taskOutputDetected || dirtyRelevantFiles.length > 0)) {
    state = "failed";
  } else if (applicableChecks.length > 0 && failedChecks.length === 0 && passedChecks.length === applicableChecks.length) {
    state = "passed";
  } else if (applicableChecks.length > 0) {
    state = "pending";
  }

  return {
    state,
    taskOutputDetected,
    dirtyRelevantFiles,
    checks,
    failedChecks: failedChecks.map((check) => ({
      id: check.id,
      label: check.label,
      reasons: check.reasons,
    })),
  };
}

export function buildRemediationPrompt(snapshot) {
  const acceptance = snapshot?.supervisor?.acceptance;
  if (!acceptance || acceptance.state !== "failed" || acceptance.failedChecks.length === 0) {
    return null;
  }

  const lines = [
    `Continue working in ${snapshot.cwd}.`,
    "Your last delivery does not pass supervisor acceptance.",
    "",
    "Failure reasons:",
  ];

  for (const failedCheck of acceptance.failedChecks) {
    lines.push(`- ${failedCheck.label}`);
    for (const reason of failedCheck.reasons) {
      lines.push(`- ${reason}`);
    }
  }

  const dirtyFiles = acceptance.dirtyRelevantFiles ?? [];
  if (dirtyFiles.length > 0) {
    lines.push("", "Files already touched in this failed delivery:");
    for (const filePath of dirtyFiles) {
      lines.push(`- ${filePath}`);
    }
  }

  lines.push(
    "",
    "Hard requirements:",
    "- Do not stop at UI changes.",
    "- Add the missing backend route and the corresponding service handler.",
    "- Wire the existing status update button to call the real backend endpoint.",
    "- Refresh the appointment detail view after a successful update.",
    "- Keep unrelated files unchanged.",
    "",
    "Completion rule:",
    "- Only stop when the missing route is implemented and the detail page is wired to it.",
    "- If you cannot complete the change, explain exactly which required file or API contract is blocking you.",
    "",
    "When finished, summarize the exact files you changed."
  );

  return lines.join("\n");
}

export function listBrainActivity(rootDir = path.join(os.homedir(), ".gemini", "antigravity", "brain")) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  return fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "tempmediaStorage")
    .map((entry) => {
      const trajectoryId = entry.name;
      const trajectoryDir = path.join(rootDir, trajectoryId);
      const files = fs
        .readdirSync(trajectoryDir, { withFileTypes: true })
        .filter((child) => child.isFile())
        .map((child) => {
          const filePath = path.join(trajectoryDir, child.name);
          const stats = fs.statSync(filePath);
          return {
            fileName: child.name,
            filePath,
            updatedAtMs: stats.mtimeMs,
          };
        })
        .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
      const latestFile = files[0] ?? null;

      return {
        trajectoryId,
        trajectoryDir,
        updatedAtMs: latestFile?.updatedAtMs ?? fs.statSync(trajectoryDir).mtimeMs,
        latestFile,
      };
    })
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}

export function diffBrainActivity(before, after, sinceMs = 0) {
  const beforeMap = new Map(before.map((entry) => [entry.trajectoryId, entry.updatedAtMs]));

  return after.filter((entry) => {
    const previous = beforeMap.get(entry.trajectoryId) ?? 0;
    return entry.updatedAtMs > previous && entry.updatedAtMs >= sinceMs;
  });
}

export function runAntigravity(args, options = {}) {
  try {
    execFileSync("antigravity", args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      ...options,
    });
    return true;
  } catch {
    return false;
  }
}

export function findMainIpcHandle(appSupportDir = APP_SUPPORT_DIR) {
  if (!fs.existsSync(appSupportDir)) {
    return null;
  }

  const entries = fs
    .readdirSync(appSupportDir, { withFileTypes: true })
    .filter((entry) => entry.isSocket?.() || entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(MAIN_IPC_SUFFIX))
    .sort();

  const latest = entries.at(-1);
  return latest ? path.join(appSupportDir, latest) : null;
}

export function buildDispatchArgs(options) {
  const args = {
    _: [path.resolve(options.cwd)],
    "reuse-window": true,
    chat: {
      _: [options.prompt],
      "reuse-window": true,
      mode: options.mode,
    },
  };

  if (options.profile) {
    args.profile = options.profile;
    args.chat.profile = options.profile;
  }

  if (options.addFiles?.length) {
    args.chat["add-file"] = options.addFiles.map((filePath) => path.resolve(filePath));
  }

  return args;
}

export function getBridgePaths(bridgeDir = DEFAULT_BRIDGE_DIR) {
  return {
    rootDir: bridgeDir,
    inboxDir: path.join(bridgeDir, "inbox"),
    outboxDir: path.join(bridgeDir, "outbox"),
    archiveDir: path.join(bridgeDir, "archive"),
    statusPath: path.join(bridgeDir, "status.json"),
  };
}

export function createBridgeRequestPayload(options) {
  const requestId = `bridge-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  return {
    id: requestId,
    createdAt: new Date().toISOString(),
    cwd: path.resolve(options.cwd),
    prompt: options.prompt,
    mode: options.mode,
    addFiles: (options.addFiles ?? []).map((filePath) => path.resolve(filePath)),
    profile: options.profile ?? null,
    commandCandidates: ["antigravity.sendPromptToAgentPanel"],
  };
}

export function writeBridgeRequest(bridgeDir, payload) {
  const paths = getBridgePaths(bridgeDir);
  ensureDir(paths.inboxDir);
  ensureDir(paths.outboxDir);
  ensureDir(paths.archiveDir);

  const filePath = path.join(paths.inboxDir, `${payload.id}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { filePath, ...paths };
}

export async function waitForBridgeResponse(bridgeDir, requestId, timeoutMs = 8000) {
  const paths = getBridgePaths(bridgeDir);
  const responsePath = path.join(paths.outboxDir, `${requestId}.json`);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    if (fs.existsSync(responsePath)) {
      return {
        responsePath,
        response: JSON.parse(fs.readFileSync(responsePath, "utf8")),
      };
    }
    await sleep(250);
  }

  return {
    responsePath,
    response: null,
  };
}

export async function dispatchViaBridge(options) {
  const bridgeDir = options.bridgeDir ?? DEFAULT_BRIDGE_DIR;
  const payload = createBridgeRequestPayload(options);
  const writeResult = writeBridgeRequest(bridgeDir, payload);
  const status = fs.existsSync(writeResult.statusPath)
    ? JSON.parse(fs.readFileSync(writeResult.statusPath, "utf8"))
    : null;
  const waited = await waitForBridgeResponse(bridgeDir, payload.id, options.waitMs);

  return {
    bridgeDir,
    requestId: payload.id,
    requestPath: writeResult.filePath,
    status,
    responsePath: waited.responsePath,
    responded: Boolean(waited.response),
    response: waited.response,
  };
}

export function diffActiveCascadeIds(beforeIds, afterIds) {
  const previous = new Set(beforeIds ?? []);
  return (afterIds ?? []).filter((id) => !previous.has(id));
}

export function deriveDispatchVerification({
  waitForNewCascade,
  workspaceReady,
  sidebarIncludesWorkspace,
  changedTrajectories,
  newCascadeIds,
}) {
  if (newCascadeIds.length > 0) {
    return {
      state: "confirmed_new_cascade",
      targetHit: true,
      reasons: ["Observed new active cascade IDs after dispatch."],
    };
  }

  if (waitForNewCascade) {
    return {
      state: "delivered_but_unconfirmed",
      targetHit: false,
      reasons: ["No new active cascade IDs were observed before the dispatch timeout expired."],
    };
  }

  if (workspaceReady || sidebarIncludesWorkspace || changedTrajectories.length > 0) {
    return {
      state: "confirmed_existing_workspace_only",
      targetHit: true,
      reasons: ["Dispatch hit a ready workspace, but no new cascade was observed."],
    };
  }

  return {
    state: "delivered_but_unconfirmed",
    targetHit: false,
    reasons: ["Dispatch returned without new cascade, workspace, or trajectory evidence."],
  };
}

export async function createMainIpcClient(socketPath, context = "main") {
  const socket = net.createConnection(socketPath);
  socket.setNoDelay(true);

  let initialized = false;
  let receiveBuffer = Buffer.alloc(0);
  let requestId = 1;
  const pending = new Map();

  const cleanupPending = (error) => {
    for (const entry of pending.values()) {
      entry.reject(error);
    }
    pending.clear();
  };

  const close = () =>
    new Promise((resolve) => {
      if (socket.destroyed) {
        resolve();
        return;
      }
      socket.once("close", resolve);
      socket.end();
    });

  socket.on("data", (chunk) => {
    receiveBuffer = Buffer.concat([receiveBuffer, chunk]);

    while (receiveBuffer.length >= 13) {
      const messageType = receiveBuffer.readUInt8(0);
      const bodyLength = receiveBuffer.readUInt32BE(9);
      if (receiveBuffer.length < 13 + bodyLength) {
        break;
      }

      const body = receiveBuffer.slice(13, 13 + bodyLength);
      receiveBuffer = receiveBuffer.slice(13 + bodyLength);
      if (messageType !== IPC_FRAME_TYPE_REGULAR) {
        continue;
      }

      const { first, second } = decodeIpcParts(body);
      if (!Array.isArray(first)) {
        continue;
      }

      const responseType = first[0];
      if (responseType === IPC_RESPONSE.initialize) {
        initialized = true;
        continue;
      }

      const pendingRequest = pending.get(first[1]);
      if (!pendingRequest) {
        continue;
      }

      if (responseType === IPC_RESPONSE.success) {
        pending.delete(first[1]);
        pendingRequest.resolve(second);
      } else if (
        responseType === IPC_RESPONSE.promiseError ||
        responseType === IPC_RESPONSE.error
      ) {
        pending.delete(first[1]);
        pendingRequest.reject(new Error(typeof second === "string" ? second : JSON.stringify(second)));
      }
    }
  });

  socket.on("error", (error) => cleanupPending(error));
  socket.on("close", () => cleanupPending(new Error("IPC socket closed")));

  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  socket.write(frameIpcMessage(encodeIpcParts(context)));
  const startedAt = Date.now();
  while (!initialized && Date.now() - startedAt < MAIN_IPC_INIT_TIMEOUT_MS) {
    await sleep(25);
  }

  if (!initialized) {
    socket.destroy();
    throw new Error("IPC init timeout");
  }

  return {
    async call(channel, method, args = []) {
      const id = requestId;
      requestId += 1;
      socket.write(frameIpcMessage(encodeIpcParts([100, id, channel, method], args)));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    },
    close,
  };
}

export async function waitForWorkspaceInstance(cwd, timeoutMs = 8000) {
  const workspaceId = normalizeWorkspaceId(cwd);
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const instance = findWorkspaceInstance(discoverInstances(), workspaceId);
    if (instance?.workspaceId === workspaceId) {
      return instance;
    }
    await sleep(400);
  }

  return null;
}

export async function dispatchToWorkspace(options) {
  const cwd = path.resolve(options.cwd);
  const profile = options.profile || deriveProfileName(cwd);
  const prompt = options.prompt;
  const beforeBrain = listBrainActivity();
  const dispatchStartedAt = Date.now();
  const workspaceId = normalizeWorkspaceId(cwd);
  const socketPath = findMainIpcHandle();
  if (!socketPath) {
    throw new Error("Could not find Antigravity main IPC socket.");
  }

  const beforeInstance = findWorkspaceInstance(discoverInstances(), workspaceId);
  const beforeExtensionServer = await buildExtensionServerSnapshot(beforeInstance, []);
  const beforeActiveCascadeIds = beforeExtensionServer.activeCascadeIds ?? [];

  const dispatchArgs = buildDispatchArgs({
    ...options,
    cwd,
    profile,
    prompt,
  });

  const client = await createMainIpcClient(socketPath, "main");
  let launchReply = null;
  try {
    launchReply = await client.call("launch", "start", [dispatchArgs, process.env]);
  } finally {
    await client.close();
  }

  const deadline = Date.now() + options.waitMs;
  let changedTrajectories = [];
  let workspaceInstance = null;
  let currentActiveCascadeIds = beforeActiveCascadeIds;
  let newCascadeIds = [];
  while (Date.now() <= deadline) {
    workspaceInstance = findWorkspaceInstance(discoverInstances(), workspaceId);
    if (workspaceInstance) {
      const extensionServer = await buildExtensionServerSnapshot(workspaceInstance, []);
      currentActiveCascadeIds = extensionServer.activeCascadeIds ?? [];
      newCascadeIds = diffActiveCascadeIds(beforeActiveCascadeIds, currentActiveCascadeIds);
    }
    changedTrajectories = diffBrainActivity(beforeBrain, listBrainActivity(), dispatchStartedAt);
    if (newCascadeIds.length > 0) {
      break;
    }
    if (!options.waitForNewCascade && changedTrajectories.length > 0) {
      break;
    }
    await sleep(500);
  }

  const sidebarIncludesWorkspace = listSidebarWorkspacePaths().includes(cwd);
  const verification = deriveDispatchVerification({
    waitForNewCascade: options.waitForNewCascade,
    workspaceReady: Boolean(workspaceInstance),
    sidebarIncludesWorkspace,
    changedTrajectories,
    newCascadeIds,
  });

  return {
    cwd,
    profile,
    socketPath,
    dispatchArgs,
    launchReply,
    workspaceReady: Boolean(workspaceInstance),
    workspaceId,
    targetHit: verification.targetHit,
    verification,
    activeCascadeIdsBefore: beforeActiveCascadeIds,
    activeCascadeIdsAfter: currentActiveCascadeIds,
    newCascadeIds,
    changedTrajectories: changedTrajectories.slice(0, 8).map((entry) => ({
      trajectoryId: entry.trajectoryId,
      updatedAt: new Date(entry.updatedAtMs).toISOString(),
      latestFile: entry.latestFile?.filePath ?? null,
    })),
    sidebarIncludesWorkspace,
  };
}

export function postJson(port, csrfToken, method, payload, timeoutMs = TOPIC_REQUEST_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: `${EXTENSION_SERVER_SERVICE}/${method}`,
        method: "POST",
        headers: {
          "x-codeium-csrf-token": csrfToken,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const rawBody = Buffer.concat(chunks).toString("utf8");
          let parsedBody = null;
          try {
            parsedBody = rawBody ? JSON.parse(rawBody) : null;
          } catch {
            parsedBody = rawBody || null;
          }

          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            statusCode: response.statusCode,
            body: parsedBody,
          });
        });
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("timeout"));
    });
    request.on("error", () => resolve({ ok: false, statusCode: null, body: null }));
    request.write(body);
    request.end();
  });
}

export function subscribeTopicInitialState(port, csrfToken, topic, timeoutMs = TOPIC_REQUEST_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const payload = frameConnectJson({ topic });
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: `${EXTENSION_SERVER_SERVICE}/SubscribeToUnifiedStateSyncTopic`,
        method: "POST",
        headers: {
          "x-codeium-csrf-token": csrfToken,
          "content-type": "application/connect+json",
          "content-length": payload.length,
        },
      },
      (response) => {
        const chunks = [];
        let settled = false;
        const finish = () => {
          if (settled) {
            return;
          }
          settled = true;
          const parsed = parseConnectJsonResponse(Buffer.concat(chunks));
          resolve({
            ok: response.statusCode === 200 && Boolean(parsed),
            statusCode: response.statusCode,
            body: parsed,
          });
          request.destroy();
        };

        response.on("data", (chunk) => {
          chunks.push(chunk);
          finish();
        });
        response.on("end", finish);
        setTimeout(finish, timeoutMs);
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("timeout"));
    });
    request.on("error", () => resolve({ ok: false, statusCode: null, body: null }));
    request.write(payload);
    request.end();
  });
}

export async function buildExtensionServerSnapshot(instance, tasks) {
  if (!instance?.extensionServerPort || !instance?.extensionServerCsrfToken) {
    return {
      available: false,
      healthy: false,
      state: "idle",
      activeCascadeIds: [],
      topicSignals: [],
    };
  }

  const heartbeat = await postJson(instance.extensionServerPort, instance.extensionServerCsrfToken, "Heartbeat", {});
  const activeCascadeState = await subscribeTopicInitialState(
    instance.extensionServerPort,
    instance.extensionServerCsrfToken,
    TOPICS.activeCascadeIds
  );
  const trajectoryState = await subscribeTopicInitialState(
    instance.extensionServerPort,
    instance.extensionServerCsrfToken,
    TOPICS.trajectorySummaries
  );
  const userStatusState = await subscribeTopicInitialState(
    instance.extensionServerPort,
    instance.extensionServerCsrfToken,
    TOPICS.userStatus
  );
  const machineInfoState = await subscribeTopicInitialState(
    instance.extensionServerPort,
    instance.extensionServerCsrfToken,
    TOPICS.machineInfos
  );

  const activeCascadeIds = extractActiveCascadeIds(activeCascadeState.body);
  const trajectorySignals = extractTrajectorySignals(trajectoryState.body);
  const state = deriveSupervisorState({
    activeCascadeIds,
    trajectorySignals,
    tasks,
  });

  return {
    available: true,
    healthy: heartbeat.ok,
    state,
    activeCascadeIds,
    topicSignals: trajectorySignals.slice(0, 20),
    rawTopics: {
      activeCascadeIds: activeCascadeState.body,
      trajectorySummaries: trajectoryState.body,
      userStatus: userStatusState.body,
      machineInfos: machineInfoState.body,
    },
  };
}

export function fileUriToPath(fileUri) {
  if (!fileUri.startsWith("file://")) {
    return null;
  }

  try {
    return decodeURIComponent(fileUri.replace("file://", ""));
  } catch {
    return null;
  }
}

export function readArtifactPreview(filePath) {
  try {
    const extension = path.extname(filePath).toLowerCase();
    const textLikeExtensions = new Set([".md", ".txt", ".json", ".yml", ".yaml", ".ts", ".tsx", ".js", ".jsx"]);
    if (!textLikeExtensions.has(extension)) {
      return {
        preview: null,
        statusGuess: "artifact",
        checked: 0,
        unchecked: 0,
      };
    }

    const content = fs.readFileSync(filePath, "utf8");
    const lines = content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const preview = lines.slice(0, 4).join(" ").slice(0, 240);

    const checked = (content.match(/- \[x\]/gi) ?? []).length;
    const unchecked = (content.match(/- \[ \]/g) ?? []).length;
    let statusGuess = "unknown";
    if (unchecked > 0) {
      statusGuess = checked > 0 ? "in_progress" : "pending";
    } else if (checked > 0) {
      statusGuess = "completed";
    } else if (content.length > 0) {
      statusGuess = "written";
    }

    return {
      preview,
      statusGuess,
      checked,
      unchecked,
    };
  } catch {
    return {
      preview: null,
      statusGuess: "missing",
      checked: 0,
      unchecked: 0,
    };
  }
}

export function listArtifacts() {
  const artifactStrings = decodeBase64Strings("antigravityUnifiedStateSync.artifactReview");
  const artifacts = [];

  for (let index = 0; index < artifactStrings.length; index += 1) {
    const current = artifactStrings[index]?.value ?? "";
    if (!current.startsWith("file:///")) {
      continue;
    }

    const filePath = fileUriToPath(current);
    if (!filePath) {
      continue;
    }

    const match = filePath.match(/\/brain\/([0-9a-f-]+)\/([^/]+)$/i);
    if (!match) {
      continue;
    }

    const [, trajectoryId, fileName] = match;
    const metadataString = artifactStrings[index + 1]?.value ?? "";
    let metadata = null;
    if (metadataString.startsWith("{")) {
      try {
        metadata = JSON.parse(metadataString);
      } catch {
        metadata = null;
      }
    }

    const stats = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
    const preview = readArtifactPreview(filePath);

    artifacts.push({
      trajectoryId,
      fileName,
      fileUri: current,
      filePath,
      exists: Boolean(stats),
      updatedAt: stats?.mtime.toISOString() ?? null,
      preview: preview.preview,
      statusGuess: preview.statusGuess,
      checklist: {
        checked: preview.checked,
        unchecked: preview.unchecked,
      },
      review: metadata,
    });
  }

  return artifacts.sort((left, right) => {
    const leftTime = left.updatedAt ? new Date(left.updatedAt).getTime() : 0;
    const rightTime = right.updatedAt ? new Date(right.updatedAt).getTime() : 0;
    return rightTime - leftTime;
  });
}

export function listTasksFromManagerState() {
  const stateStrings = decodeBase64Strings("jetskiStateSync.agentManagerInitState");
  const tasks = new Map();

  for (let index = 0; index < stateStrings.length; index += 1) {
    const current = stateStrings[index]?.value ?? "";
    const fileMatch = current.match(/^file:\/\/\/.*\/brain\/([0-9a-f-]+)\/([^/]+)$/i);

    if (fileMatch) {
      const [, trajectoryId, fileName] = fileMatch;
      const task = tasks.get(trajectoryId) ?? {
        trajectoryId,
        taskFile: null,
        workspaceHints: [],
        messages: [],
      };
      task.taskFile ??= current;
      task.files = Array.from(new Set([...(task.files ?? []), fileName]));
      tasks.set(trajectoryId, task);
      continue;
    }

    // The manager state payload is lossy after base64 string extraction, so we keep
    // a small set of nearby local file URIs as workspace hints for later attribution.
    if (current.startsWith("file:///") && current.includes("/Users/")) {
      for (const task of tasks.values()) {
        if (task.workspaceHints.length >= 4) {
          continue;
        }
        if (!task.workspaceHints.includes(current)) {
          task.workspaceHints.push(current);
        }
      }
      continue;
    }

    if (
      current.length >= 12 &&
      /[A-Za-z\u4e00-\u9fff]/u.test(current) &&
      !/^[A-Za-z0-9+/=:_-]+$/.test(current) &&
      !current.startsWith("{")
    ) {
      const lastTask = Array.from(tasks.values()).at(-1);
      if (lastTask && lastTask.messages.length < 6) {
        lastTask.messages.push(current);
      }
    }
  }

  return Array.from(tasks.values());
}

export function readRecentLogSignals() {
  if (!fs.existsSync(LOGS_DIR)) {
    return [];
  }

  const logDirs = fs
    .readdirSync(LOGS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const latestDir = logDirs.at(-1);
  if (!latestDir) {
    return [];
  }

  const logFile = path.join(LOGS_DIR, latestDir, "ls-main.log");
  if (!fs.existsSync(logFile)) {
    return [];
  }

  const content = fs.readFileSync(logFile, "utf8");
  return content
    .split("\n")
    .filter(
      (line) =>
        line.includes("planner_generator.go") ||
        line.includes("fetchAvailableModels") ||
        line.includes("loadCodeAssist") ||
        line.includes("TLS handshake error")
    )
    .slice(-12);
}

export function buildTaskSummaries(cwd) {
  const artifacts = listArtifacts();
  const managerTasks = listTasksFromManagerState();
  const groupedArtifacts = new Map();
  const now = Date.now();

  for (const artifact of artifacts) {
    const bucket = groupedArtifacts.get(artifact.trajectoryId) ?? [];
    bucket.push(artifact);
    groupedArtifacts.set(artifact.trajectoryId, bucket);
  }

  const result = [];

  for (const task of managerTasks) {
    const taskArtifacts = groupedArtifacts.get(task.trajectoryId) ?? [];
    const latestArtifact = taskArtifacts[0] ?? null;
    const workspaceHints = task.workspaceHints
      .map(fileUriToPath)
      .filter(Boolean)
      .filter((hint) => hint === cwd || hint.startsWith(cwd));
    const taskPreview = latestArtifact?.preview ?? task.messages[0] ?? null;
    const statusGuess =
      latestArtifact?.statusGuess ??
      (task.messages.some((message) => /complet|done|finished|完成/u.test(message))
        ? "completed"
        : "running");

    result.push({
      trajectoryId: task.trajectoryId,
      statusGuess,
      taskFile: task.taskFile ? fileUriToPath(task.taskFile) : null,
      workspaceHints,
      messages: task.messages,
      latestArtifact: latestArtifact
        ? {
            fileName: latestArtifact.fileName,
            filePath: latestArtifact.filePath,
            updatedAt: latestArtifact.updatedAt,
            preview: latestArtifact.preview,
          }
        : null,
      artifacts: taskArtifacts.slice(0, 8),
    });
  }

  return result
    .filter((task) => {
      if (task.workspaceHints.length > 0) {
        return true;
      }

      // Fall back to recent artifact activity when the manager state does not expose
      // a direct workspace hint for this trajectory.
      const latestTime = task.latestArtifact?.updatedAt
        ? new Date(task.latestArtifact.updatedAt).getTime()
        : 0;

      return latestTime > 0 && now - latestTime <= RECENT_TASK_WINDOW_MS;
    })
    .sort((left, right) => {
      const leftTime = left.latestArtifact?.updatedAt
        ? new Date(left.latestArtifact.updatedAt).getTime()
        : 0;
      const rightTime = right.latestArtifact?.updatedAt
        ? new Date(right.latestArtifact.updatedAt).getTime()
        : 0;
      return rightTime - leftTime;
    });
}

export function writeSnapshotFiles(outDir, snapshot) {
  ensureDir(outDir);
  const latestPath = path.join(outDir, "latest.json");
  const eventsPath = path.join(outDir, "events.jsonl");

  const serialized = JSON.stringify(snapshot, null, 2);
  const hash = crypto.createHash("sha256").update(serialized).digest("hex");

  let previousHash = null;
  if (fs.existsSync(latestPath)) {
    previousHash = crypto
      .createHash("sha256")
      .update(fs.readFileSync(latestPath, "utf8"))
      .digest("hex");
  }

  fs.writeFileSync(latestPath, serialized);

  // `latest.json` is always refreshed, while `events.jsonl` only appends on change
  // so consumers can tail discrete state transitions without duplicate churn.
  if (hash !== previousHash) {
    fs.appendFileSync(
      eventsPath,
      `${JSON.stringify({
        generatedAt: snapshot.generatedAt,
        hash,
        cwd: snapshot.cwd,
        taskCount: snapshot.tasks.length,
        supervisorState: snapshot.supervisor?.state ?? null,
        acceptanceState: snapshot.supervisor?.acceptance?.state ?? null,
      })}\n`
    );
  }

  return { latestPath, eventsPath, changed: hash !== previousHash };
}

export async function watch(options) {
  ensureDir(options.outDir);
  for (;;) {
    const snapshot = await buildSnapshot(options);
    const writeResult = writeSnapshotFiles(options.outDir, snapshot);
    process.stdout.write(
      `${JSON.stringify({
        generatedAt: snapshot.generatedAt,
        changed: writeResult.changed,
        taskCount: snapshot.tasks.length,
        latestPath: writeResult.latestPath,
        acceptanceState: snapshot.supervisor?.acceptance?.state ?? null,
      })}\n`
    );
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  }
}

export function printUsage() {
  console.log(`Usage:
  antigravity-bus discover [--cwd <path>]
  antigravity-bus snapshot [--cwd <path>]
  antigravity-bus watch [--cwd <path>] [--interval <ms>] [--out-dir <path>]
  antigravity-bus dispatch --cwd <path> --prompt <text> [--mode <mode>] [--add-file <path>] [--wait-ms <ms>] [--bridge-dir <path>]
  antigravity-bus ipc-dispatch --cwd <path> --prompt <text> [--profile <name>] [--mode <mode>] [--add-file <path>] [--wait-ms <ms>] [--wait-for-new-cascade]
  antigravity-bus --help
  antigravity-bus --version

Examples:
  antigravity-bus discover
  antigravity-bus snapshot --cwd /absolute/path/to/workspace
  antigravity-bus watch --cwd /absolute/path/to/workspace --interval 4000
  antigravity-bus dispatch --cwd /absolute/path/to/workspace --prompt "Continue the task"
  antigravity-bus ipc-dispatch --cwd /absolute/path/to/workspace --prompt "Continue the task" --wait-for-new-cascade
  npx antigravity-bus --help`);
}

export async function buildSnapshot(options) {
  const baseSnapshot = buildSnapshotSync(options);
  const extensionServer = await buildExtensionServerSnapshot(baseSnapshot.workspaceInstance, baseSnapshot.tasks);
  const acceptance = evaluateAcceptanceChecks(baseSnapshot.cwd, baseSnapshot.tasks);

  return {
    ...baseSnapshot,
    extensionServer,
    supervisor: {
      state: extensionServer.state,
      activeCascadeIds: extensionServer.activeCascadeIds,
      healthy: extensionServer.healthy,
      acceptance,
    },
  };
}

export function buildSnapshotSync(options) {
  const instances = discoverInstances();
  const logSignals = readRecentLogSignals();
  const tasks = buildTaskSummaries(options.cwd);
  const activeWorkspaceId = normalizeWorkspaceId(options.cwd);
  const workspaceInstance = findWorkspaceInstance(instances, activeWorkspaceId);

  return {
    generatedAt: new Date().toISOString(),
    cwd: options.cwd,
    activeWorkspaceId,
    antigravity: {
      appSupportDir: APP_SUPPORT_DIR,
      stateDbPath: STATE_DB_PATH,
      running: instances.length > 0,
      instances,
    },
    workspaceInstance,
    userStatusAvailable: Boolean(readStateValue("antigravityUnifiedStateSync.userStatus")),
    authStatusAvailable: Boolean(readStateValue("antigravityAuthStatus")),
    recentLogSignals: logSignals,
    tasks,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);

  if (options.command === "help") {
    printUsage();
    return;
  }

  if (options.command === "version") {
    console.log(PACKAGE_VERSION);
    return;
  }

  if (options.command === "discover") {
    console.log(JSON.stringify({ instances: discoverInstances() }, null, 2));
    return;
  }

  if (options.command === "snapshot") {
    console.log(JSON.stringify(await buildSnapshot(options), null, 2));
    return;
  }

  if (options.command === "watch") {
    await watch(options);
    return;
  }

  if (options.command === "dispatch") {
    console.log(JSON.stringify(await dispatchViaBridge(options), null, 2));
    return;
  }

  if (options.command === "ipc-dispatch") {
    console.log(JSON.stringify(await dispatchToWorkspace(options), null, 2));
    return;
  }

  printUsage();
  process.exitCode = 1;
}

const currentModulePath = fileURLToPath(import.meta.url);
const entryPath = process.argv[1] ? fs.realpathSync.native(process.argv[1]) : null;

if (entryPath === currentModulePath) {
  await main();
}
