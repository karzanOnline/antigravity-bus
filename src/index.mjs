#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  const [command = "snapshot", ...rest] = argv;
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

export function buildSnapshot(options) {
  const instances = discoverInstances();
  const logSignals = readRecentLogSignals();
  const tasks = buildTaskSummaries(options.cwd);
  const normalizedCwd = options.cwd.replace(/^\/+/, "");
  const activeWorkspaceId = `file_${normalizedCwd.replaceAll(/[/.:-]/g, "_")}`;

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
    userStatusAvailable: Boolean(readStateValue("antigravityUnifiedStateSync.userStatus")),
    authStatusAvailable: Boolean(readStateValue("antigravityAuthStatus")),
    recentLogSignals: logSignals,
    tasks,
  };
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
      })}\n`
    );
  }

  return { latestPath, eventsPath, changed: hash !== previousHash };
}

export async function watch(options) {
  ensureDir(options.outDir);
  for (;;) {
    const snapshot = buildSnapshot(options);
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

Examples:
  antigravity-bus discover
  antigravity-bus snapshot --cwd /absolute/path/to/workspace
  antigravity-bus watch --cwd /absolute/path/to/workspace --interval 4000`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);

  if (options.command === "discover") {
    console.log(JSON.stringify({ instances: discoverInstances() }, null, 2));
    return;
  }

  if (options.command === "snapshot") {
    console.log(JSON.stringify(buildSnapshot(options), null, 2));
    return;
  }

  if (options.command === "watch") {
    await watch(options);
    return;
  }

  printUsage();
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
