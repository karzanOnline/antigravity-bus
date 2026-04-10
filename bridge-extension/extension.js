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

function getBridgeDir() {
  return process.env.ANTIGRAVITY_BUS_BRIDGE_DIR || DEFAULT_BRIDGE_DIR;
}

function getBridgePaths() {
  const rootDir = getBridgeDir();
  return {
    rootDir,
    inboxDir: path.join(rootDir, "inbox"),
    outboxDir: path.join(rootDir, "outbox"),
    archiveDir: path.join(rootDir, "archive"),
    statusPath: path.join(rootDir, STATUS_FILE_NAME),
  };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureBridgeLayout() {
  const paths = getBridgePaths();
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

async function writeStatus(extra = {}) {
  const paths = ensureBridgeLayout();
  const allCommands = await vscode.commands.getCommands(true);
  const interestingCommands = listInterestingCommands(allCommands);
  const payload = {
    bridgeDir: paths.rootDir,
    activatedAt: extra.activatedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    knownCommandAvailable: allCommands.includes("antigravity.sendPromptToAgentPanel"),
    interestingCommands,
    ...extra,
  };

  writeJson(paths.statusPath, payload);
}

async function executeRequest(request, availableCommands) {
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

    const requestPath = inboxFiles[0];
    const raw = fs.readFileSync(requestPath, "utf8");
    const request = JSON.parse(raw);
    const archivePath = path.join(paths.archiveDir, `${request.id}.request.json`);
    fs.renameSync(requestPath, archivePath);

    const availableCommands = await vscode.commands.getCommands(true);
    const execution = await executeRequest(request, availableCommands);
    const response = {
      id: request.id,
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
