import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_WORKER_STALE_MS = 1000 * 60 * 10;

export function getBridgePaths(bridgeDir, workerId = null) {
  const rootDir = bridgeDir;
  // Once workers are isolated, every queue and status file lives under workers/<workerId>/...
  const workerDir = workerId ? path.join(rootDir, "workers", workerId) : rootDir;
  return {
    rootDir,
    workerId,
    workersDir: path.join(rootDir, "workers"),
    workerDir,
    inboxDir: path.join(workerDir, "inbox"),
    outboxDir: path.join(workerDir, "outbox"),
    archiveDir: path.join(workerDir, "archive"),
    statusPath: path.join(workerDir, "status.json"),
  };
}

export function parseBridgeWorkerPid(workerId) {
  if (typeof workerId !== "string") {
    return null;
  }

  const match = /^pid-(\d+)$/.exec(workerId);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function isBridgeWorkerAlive(workerId, deps = {}) {
  const pid = parseBridgeWorkerPid(workerId);
  if (!pid) {
    return null;
  }

  const processExists =
    deps.processExists ??
    ((targetPid) => {
      try {
        process.kill(targetPid, 0);
        return true;
      } catch {
        return false;
      }
    });

  return processExists(pid);
}

export function summarizeBridgeWorkerHealth(worker, deps = {}) {
  const now = deps.now ?? Date.now();
  const staleMs = deps.workerStaleMs ?? DEFAULT_WORKER_STALE_MS;
  const updatedAtMs = Date.parse(worker.status?.updatedAt ?? "");
  const ageMs = Number.isFinite(updatedAtMs) ? Math.max(0, now - updatedAtMs) : null;
  const alive = isBridgeWorkerAlive(worker.workerId, deps);
  const hasWorkspaceRoots = Array.isArray(worker.status?.workspaceRoots);

  let state = "live";
  if (alive === false) {
    state = "dead";
  } else if (ageMs !== null && ageMs > staleMs) {
    state = alive === true ? "stale" : "stale_unverified";
  } else if (alive === null && !hasWorkspaceRoots) {
    state = "unverified";
  }

  return {
    state,
    pid: parseBridgeWorkerPid(worker.workerId),
    alive,
    ageMs,
    staleMs,
  };
}

export function readBridgeWorkerStatuses(bridgeDir, deps = {}) {
  const rootPaths = getBridgePaths(bridgeDir);
  if (!fs.existsSync(rootPaths.workersDir)) {
    return [];
  }

  return fs
    .readdirSync(rootPaths.workersDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const paths = getBridgePaths(bridgeDir, entry.name);
      if (!fs.existsSync(paths.statusPath)) {
        return null;
      }

      try {
        const status = JSON.parse(fs.readFileSync(paths.statusPath, "utf8"));
        const worker = { workerId: entry.name, paths, status };
        return {
          ...worker,
          health: summarizeBridgeWorkerHealth(worker, deps),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function selectBridgeWorker(bridgeDir, cwd, deps = {}) {
  const targetCwd = path.resolve(cwd);
  const workers = readBridgeWorkerStatuses(bridgeDir, deps);
  for (const worker of workers) {
    if (worker.health?.state !== "live") {
      continue;
    }

    const roots = Array.isArray(worker.status?.workspaceRoots) ? worker.status.workspaceRoots : [];
    // Match by root containment so nested workspaces still route to the owning Antigravity window.
    if (roots.some((root) => targetCwd === root || targetCwd.startsWith(root + path.sep))) {
      return worker;
    }
  }
  return null;
}

export function createBridgeRequestPayload(options) {
  const requestId = `bridge-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  return {
    id: requestId,
    runId: options.runId ?? null,
    type: "sendPrompt",
    createdAt: new Date().toISOString(),
    cwd: path.resolve(options.cwd),
    prompt: options.prompt,
    mode: options.mode,
    addFiles: (options.addFiles ?? []).map((filePath) => path.resolve(filePath)),
    profile: options.profile ?? null,
    commandCandidates: ["antigravity.sendPromptToAgentPanel"],
  };
}

export function createBridgeCommandPayload(options, overrides = {}) {
  const requestId = `bridge-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  return {
    id: requestId,
    runId: options.runId ?? null,
    type: "executeCommand",
    createdAt: new Date().toISOString(),
    cwd: path.resolve(options.cwd),
    commandId: overrides.commandId ?? null,
    args: overrides.args ?? [],
    commandCandidates: overrides.commandCandidates ?? [],
    interaction: overrides.interaction ?? null,
  };
}

export function createBridgeListCommandsPayload(options, overrides = {}) {
  const requestId = `bridge-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  return {
    id: requestId,
    runId: options.runId ?? null,
    type: "listCommands",
    createdAt: new Date().toISOString(),
    cwd: path.resolve(options.cwd),
    pattern: overrides.pattern ?? null,
    flags: overrides.flags ?? "i",
  };
}

export function writeBridgeRequest(bridgeDir, payload, ensureDir, workerId = null) {
  const paths = getBridgePaths(bridgeDir, workerId);
  ensureDir(paths.inboxDir);
  ensureDir(paths.outboxDir);
  ensureDir(paths.archiveDir);

  const filePath = path.join(paths.inboxDir, `${payload.id}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { filePath, ...paths };
}

export async function waitForBridgeResponse(bridgeDir, requestId, sleep, timeoutMs = 8000, workerId = null) {
  const paths = getBridgePaths(bridgeDir, workerId);
  const responsePath = path.join(paths.outboxDir, `${requestId}.json`);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    if (fs.existsSync(responsePath)) {
      const raw = fs.readFileSync(responsePath, "utf8");
      try {
        return {
          responsePath,
          response: JSON.parse(raw),
        };
      } catch {
        // The bridge writes JSON files non-atomically, so a partial read should retry instead of failing fast.
      }
    }

    await sleep(250);
  }

  return {
    responsePath,
    response: null,
  };
}
