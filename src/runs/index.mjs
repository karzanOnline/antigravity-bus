import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function createRunId() {
  return `run-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

export function getRunsDir(outDir) {
  return path.join(outDir, "runs");
}

export function getRunPaths(outDir, runId) {
  const runsDir = getRunsDir(outDir);
  const runDir = path.join(runsDir, runId);
  return {
    runsDir,
    runDir,
    latestPath: path.join(runDir, "latest.json"),
    eventsPath: path.join(runDir, "events.jsonl"),
  };
}

export function readRunLatest(outDir, runId) {
  const paths = getRunPaths(outDir, runId);
  if (!fs.existsSync(paths.latestPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(paths.latestPath, "utf8"));
}

export function createRunRecord(outDir, metadata, ensureDir) {
  const runId = metadata.runId ?? createRunId();
  const createdAt = metadata.createdAt ?? new Date().toISOString();
  const paths = getRunPaths(outDir, runId);
  ensureDir(paths.runDir);

  const latest = {
    runId,
    createdAt,
    updatedAt: createdAt,
    cwd: metadata.cwd,
    prompt: metadata.prompt ?? null,
    mode: metadata.mode ?? null,
    profile: metadata.profile ?? null,
    addFiles: metadata.addFiles ?? [],
    bridgeDir: metadata.bridgeDir ?? null,
    waitMs: metadata.waitMs ?? null,
    autoRemediate: metadata.autoRemediate ?? false,
    maxRemediations: metadata.maxRemediations ?? 0,
    supervisorLoopTimeoutMs: metadata.supervisorLoopTimeoutMs ?? null,
    status: metadata.status ?? "queued",
    completion: null,
    requestId: null,
    response: null,
    bridgeWorkerId: null,
    latestSnapshot: null,
    latestWorkspaceChanges: metadata.workspaceChanges ?? null,
    baselineWorkspaceChanges: metadata.workspaceChanges ?? null,
    latestWorkspaceDelta: null,
    baselineWorkspaceFingerprint: metadata.workspaceFingerprint ?? null,
    approvals: [],
    remediations: [],
    eventCount: 0,
    lastEvent: null,
  };

  fs.writeFileSync(paths.latestPath, `${JSON.stringify(latest, null, 2)}\n`, "utf8");
  return { runId, paths, latest };
}

export function recordRunEvent(outDir, runId, event, ensureDir) {
  const paths = getRunPaths(outDir, runId);
  ensureDir(paths.runDir);
  const existing = readRunLatest(outDir, runId) ?? {
    runId,
    createdAt: event.at ?? new Date().toISOString(),
    eventCount: 0,
  };
  const at = event.at ?? new Date().toISOString();
  const patch = event.patch ?? {};
  const next = {
    ...existing,
    ...patch,
    runId,
    updatedAt: at,
    eventCount: (existing.eventCount ?? 0) + 1,
    lastEvent: {
      type: event.type,
      at,
    },
  };

  fs.writeFileSync(paths.latestPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.appendFileSync(
    paths.eventsPath,
    `${JSON.stringify({
      runId,
      type: event.type,
      at,
      data: event.data ?? null,
      patch,
    })}\n`,
    "utf8"
  );

  return next;
}
