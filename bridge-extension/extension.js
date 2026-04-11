"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

const DEFAULT_BRIDGE_DIR = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Antigravity",
  "antigravity-bus-bridge"
);

const DEFAULT_COMMAND_CANDIDATES = ["antigravity.sendPromptToAgentPanel"];
const STATUS_FILE_NAME = "status.json";
const POLL_INTERVAL_MS = 750;
const WORKER_ID = `pid-${process.pid}`;

function getBridgeDir() {
  return process.env.ANTIGRAVITY_BUS_BRIDGE_DIR || DEFAULT_BRIDGE_DIR;
}

function getBridgePaths(workerId = WORKER_ID) {
  const rootDir = getBridgeDir();
  const workerDir = path.join(rootDir, "workers", workerId);
  return {
    rootDir,
    workerId,
    workersDir: path.join(rootDir, "workers"),
    workerDir,
    inboxDir: path.join(workerDir, "inbox"),
    outboxDir: path.join(workerDir, "outbox"),
    archiveDir: path.join(workerDir, "archive"),
    statusPath: path.join(workerDir, STATUS_FILE_NAME),
    rootStatusPath: path.join(rootDir, STATUS_FILE_NAME),
  };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureBridgeLayout(workerId = WORKER_ID) {
  const paths = getBridgePaths(workerId);
  ensureDir(paths.workersDir);
  ensureDir(paths.inboxDir);
  ensureDir(paths.outboxDir);
  ensureDir(paths.archiveDir);
  return paths;
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function listInboxFiles(paths) {
  return fs
    .readdirSync(paths.inboxDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(paths.inboxDir, entry.name))
    .sort();
}

function listInterestingCommands(commands) {
  return commands.filter((commandId) => /(antigravity|chat|prompt|agent)/i.test(commandId)).slice(0, 40);
}

function getWorkspaceRoots() {
  return (vscode.workspace.workspaceFolders ?? [])
    .map((folder) => folder.uri?.fsPath)
    .filter((value) => typeof value === "string" && value.length > 0)
    .map((value) => path.resolve(value));
}

function isRequestForCurrentWorkspace(request) {
  if (!request?.cwd) {
    return true;
  }

  const requestCwd = path.resolve(request.cwd);
  const workspaceRoots = getWorkspaceRoots();
  if (workspaceRoots.length === 0) {
    return false;
  }

  return workspaceRoots.some((root) => requestCwd === root || requestCwd.startsWith(root + path.sep));
}

async function writeStatus(extra = {}) {
  const paths = ensureBridgeLayout();
  const allCommands = await vscode.commands.getCommands(true);
  const interestingCommands = listInterestingCommands(allCommands);
  const payload = {
    bridgeDir: paths.rootDir,
    workerId: paths.workerId,
    activatedAt: extra.activatedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    knownCommandAvailable: allCommands.includes("antigravity.sendPromptToAgentPanel"),
    interestingCommands,
    workspaceRoots: getWorkspaceRoots(),
    ...extra,
  };

  writeJson(paths.statusPath, payload);
  writeJson(paths.rootStatusPath, payload);
}

async function executeRequest(request, availableCommands) {
  if (request.type === "listCommands") {
    return executeListCommandsRequest(request, availableCommands);
  }

  if (request.type === "executeCommand") {
    return executeCommandRequest(request, availableCommands);
  }

  return executePromptRequest(request, availableCommands);
}

async function executeListCommandsRequest(request, availableCommands) {
  const pattern = request.pattern
    ? new RegExp(request.pattern, request.flags || "i")
    : null;
  const commands = pattern
    ? availableCommands.filter((commandId) => pattern.test(commandId))
    : availableCommands.slice();

  return {
    ok: true,
    commandUsed: null,
    commands,
    count: commands.length,
    attempts: [],
  };
}

async function executePromptRequest(request, availableCommands) {
  const attempts = [];
  const commandCandidates = request.commandCandidates?.length
    ? request.commandCandidates
    : DEFAULT_COMMAND_CANDIDATES;

  for (const commandId of commandCandidates) {
    const discovered = availableCommands.includes(commandId);
    try {
      await vscode.commands.executeCommand(commandId, request.prompt);
      return {
        ok: true,
        commandUsed: commandId,
        attempts: [
          ...attempts,
          {
            commandId,
            discovered,
            ok: true,
          },
        ],
      };
    } catch (error) {
      attempts.push({
        commandId,
        discovered,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    ok: false,
    commandUsed: null,
    attempts,
  };
}

async function executeCommandRequest(request, availableCommands) {
  const attempts = [];
  const commandCandidates = request.commandCandidates?.length
    ? request.commandCandidates
    : request.commandId
      ? [request.commandId]
      : [];

  for (const commandId of commandCandidates) {
    const discovered = availableCommands.includes(commandId);
    try {
      const payload = await vscode.commands.executeCommand(commandId, ...(request.args ?? []));
      return {
        ok: true,
        commandUsed: commandId,
        payload,
        attempts: [
          ...attempts,
          {
            commandId,
            discovered,
            ok: true,
          },
        ],
      };
    } catch (error) {
      attempts.push({
        commandId,
        discovered,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    ok: false,
    commandUsed: null,
    attempts,
  };
}

async function processInboxOnce(state) {
  if (state.processing) {
    return;
  }

  state.processing = true;
  try {
    const paths = ensureBridgeLayout();
    const inboxFiles = listInboxFiles(paths);
    if (inboxFiles.length === 0) {
      return;
    }

    let requestPath = null;
    let request = null;
    let skippedRequestId = null;

    for (const candidatePath of inboxFiles) {
      const raw = fs.readFileSync(candidatePath, "utf8");
      const candidate = JSON.parse(raw);
      if (isRequestForCurrentWorkspace(candidate)) {
        requestPath = candidatePath;
        request = candidate;
        break;
      }
      skippedRequestId ||= candidate.id;
    }

    if (!requestPath || !request) {
      await writeStatus({
        activatedAt: state.activatedAt,
        processedCount: state.processedCount,
        lastSkippedRequestId: skippedRequestId,
        lastSkipReason: "workspace-mismatch",
        workspaceRoots: getWorkspaceRoots(),
      });
      return;
    }

    const archivePath = path.join(paths.archiveDir, `${request.id}.request.json`);
    fs.renameSync(requestPath, archivePath);

    const availableCommands = await vscode.commands.getCommands(true);
    const execution = await executeRequest(request, availableCommands);
    const response = {
      id: request.id,
      type: request.type ?? "sendPrompt",
      prompt: request.prompt,
      cwd: request.cwd,
      requestedAt: request.createdAt || null,
      processedAt: new Date().toISOString(),
      ...execution,
      interestingCommands: listInterestingCommands(availableCommands),
    };

    writeJson(path.join(paths.outboxDir, `${request.id}.json`), response);
    state.processedCount += 1;
    await writeStatus({
      activatedAt: state.activatedAt,
      processedCount: state.processedCount,
      lastRequestId: request.id,
      lastCommandUsed: response.commandUsed,
      lastOk: response.ok,
    });
  } finally {
    state.processing = false;
  }
}

function activate(context) {
  const state = {
    activatedAt: new Date().toISOString(),
    processedCount: 0,
    processing: false,
  };

  ensureBridgeLayout();
  void writeStatus({
    activatedAt: state.activatedAt,
    processedCount: state.processedCount,
    lastRequestId: null,
    lastCommandUsed: null,
    lastOk: null,
  });

  const command = vscode.commands.registerCommand("antigravityBusBridge.processInbox", async () => {
    await processInboxOnce(state);
  });

  const interval = setInterval(() => {
    void processInboxOnce(state);
  }, POLL_INTERVAL_MS);

  context.subscriptions.push(command);
  context.subscriptions.push({
    dispose() {
      clearInterval(interval);
    },
  });
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
