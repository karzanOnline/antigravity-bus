#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
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
const DEFAULT_STORE_DIR = path.join(process.cwd(), ".cowork-temp", "antigravity-bus");
const RECENT_TASK_WINDOW_MS = 1000 * 60 * 60 * 24 * 2;
const TOPIC_REQUEST_TIMEOUT_MS = 1500;
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
    }
  }

  return options;
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function normalizeWorkspaceId(cwd) {
  return `file_${cwd.replace(/^\/+/, "").replaceAll(/[/.:-]/g, "_")}`;
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
  antigravity-bus --help
  antigravity-bus --version

Examples:
  antigravity-bus discover
  antigravity-bus snapshot --cwd /absolute/path/to/workspace
  antigravity-bus watch --cwd /absolute/path/to/workspace --interval 4000
  npx antigravity-bus --help`);
}

export async function buildSnapshot(options) {
  const baseSnapshot = buildSnapshotSync(options);
  const extensionServer = await buildExtensionServerSnapshot(baseSnapshot.workspaceInstance, baseSnapshot.tasks);
  return {
    ...baseSnapshot,
    extensionServer,
    supervisor: {
      state: extensionServer.state,
      activeCascadeIds: extensionServer.activeCascadeIds,
      healthy: extensionServer.healthy,
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

  printUsage();
  process.exitCode = 1;
}

const currentModulePath = fileURLToPath(import.meta.url);
const entryPath = process.argv[1] ? fs.realpathSync.native(process.argv[1]) : null;

if (entryPath === currentModulePath) {
  await main();
}
