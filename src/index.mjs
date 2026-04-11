#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  discoverInstances as discoverInstancesCore,
  findWorkspaceInstance as findWorkspaceInstanceCore,
  parseInstanceLine as parseInstanceLineCore,
} from "./antigravity/instances.mjs";
import {
  createMainIpcClient as createMainIpcClientCore,
  findMainIpcHandle as findMainIpcHandleCore,
  frameConnectJson as frameConnectJsonCore,
  frameIpcMessage as frameIpcMessageCore,
  parseConnectJsonResponse as parseConnectJsonResponseCore,
  VSBufferWriter as VSBufferWriterCore,
  decodeIpcParts as decodeIpcPartsCore,
  encodeIpcParts as encodeIpcPartsCore,
} from "./antigravity/ipc.mjs";
import {
  diffBrainActivity as diffBrainActivityModule,
  listBrainActivity as listBrainActivityModule,
  runAntigravity as runAntigravityModule,
} from "./antigravity/activity.mjs";
import {
  buildDispatchArgs as buildDispatchArgsModule,
  deriveDispatchVerification as deriveDispatchVerificationModule,
  diffActiveCascadeIds as diffActiveCascadeIdsModule,
  dispatchToWorkspace as dispatchToWorkspaceModule,
  waitForWorkspaceInstance as waitForWorkspaceInstanceModule,
} from "./antigravity/workspace-dispatch.mjs";
import {
  decodeBase64Strings as decodeBase64StringsModule,
  deriveProfileName as deriveProfileNameModule,
  extractPrintableStrings as extractPrintableStringsModule,
  listSidebarWorkspacePaths as listSidebarWorkspacePathsModule,
  normalizeWorkspaceId as normalizeWorkspaceIdModule,
  readStateValue as readStateValueModule,
} from "./antigravity/state.mjs";
import {
  createBridgeCommandPayload as createBridgeCommandPayloadCore,
  createBridgeListCommandsPayload as createBridgeListCommandsPayloadCore,
  createBridgeRequestPayload as createBridgeRequestPayloadCore,
  getBridgePaths as getBridgePathsCore,
  readBridgeWorkerStatuses as readBridgeWorkerStatusesCore,
  selectBridgeWorker as selectBridgeWorkerCore,
  waitForBridgeResponse as waitForBridgeResponseCore,
  writeBridgeRequest as writeBridgeRequestCore,
} from "./bridge/index.mjs";
import {
  buildAutoApprovalCommandPlans as buildAutoApprovalCommandPlansCore,
  buildRemediationPayload as buildRemediationPayloadCore,
  isRemediationTerminal as isRemediationTerminalCore,
  shouldAutoRemediateCompletion as shouldAutoRemediateCompletionCore,
  summarizeSnapshotForCompletion as summarizeSnapshotForCompletionCore,
  summarizeWaitingInteraction as summarizeWaitingInteractionCore,
} from "./supervisor/core.mjs";
import {
  attemptAutoApprove as attemptAutoApproveRuntime,
  dispatchViaBridge as dispatchViaBridgeRuntime,
  waitForCompletionResult as waitForCompletionResultRuntime,
} from "./supervisor/runtime.mjs";
import { writeSnapshotFiles as writeSnapshotFilesCore } from "./snapshot/files.mjs";
import {
  buildExtensionServerSnapshot as buildExtensionServerSnapshotCore,
  decodeBase64PrintableStrings as decodeBase64PrintableStringsCore,
  decodeTopicStateEntries as decodeTopicStateEntriesCore,
  deriveSupervisorState as deriveSupervisorStateCore,
  extractActiveCascadeIds as extractActiveCascadeIdsCore,
  extractTrajectorySignals as extractTrajectorySignalsCore,
} from "./snapshot/extension-server.mjs";
import {
  defaultHttpRequest,
  postJson as postJsonModule,
  subscribeTopicInitialState as subscribeTopicInitialStateModule,
} from "./snapshot/http.mjs";
import {
  buildTaskSummaries as buildTaskSummariesCore,
  fileUriToPath as fileUriToPathCore,
  listArtifacts as listArtifactsCore,
  listTasksFromManagerState as listTasksFromManagerStateCore,
  readArtifactPreview as readArtifactPreviewCore,
  readRecentLogSignals as readRecentLogSignalsCore,
} from "./snapshot/tasks.mjs";
import {
  buildSnapshot as buildSnapshotModule,
  buildSnapshotSync as buildSnapshotSyncModule,
  watch as watchModule,
} from "./snapshot/index.mjs";
import {
  buildRemediationPrompt as buildRemediationPromptModule,
  evaluateAcceptanceChecks as evaluateAcceptanceChecksModule,
  evaluateSkinSaasAppointmentStatusChain as evaluateSkinSaasAppointmentStatusChainModule,
  hasAnyPattern as hasAnyPatternModule,
  hasTaskOutput as hasTaskOutputModule,
  readTextFileIfExists as readTextFileIfExistsModule,
} from "./acceptance/index.mjs";
import {
  captureWorkspaceBaseline as captureWorkspaceBaselineModule,
  diffWorkspaceAgainstBaseline as diffWorkspaceAgainstBaselineModule,
  hashWorkspaceFile as hashWorkspaceFileModule,
  listDirtyFiles as listDirtyFilesModule,
  summarizeWorkspaceChanges as summarizeWorkspaceChangesModule,
} from "./vcs/index.mjs";
import {
  ensureDir as ensureDirModule,
  run as runModule,
  sleep as sleepModule,
} from "./shared/runtime.mjs";
import {
  createRunRecord as createRunRecordCore,
  getRunPaths as getRunPathsCore,
  readRunLatest as readRunLatestCore,
  recordRunEvent as recordRunEventCore,
} from "./runs/index.mjs";
import { parseArgs as parseArgsModule } from "./cli/args.mjs";
import { main as mainModule } from "./cli/main.mjs";
import { printUsage as printUsageModule } from "./cli/usage.mjs";

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
const DEFAULT_BRIDGE_DIR = path.join(APP_SUPPORT_DIR, "antigravity-bus-bridge");
const DEFAULT_STORE_DIR = path.join(process.cwd(), ".cowork-temp", "antigravity-bus");
const ASYNC_IDLE_NO_OUTPUT_TIMEOUT_MS = 15000;
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

// Keep this file as the stable public facade while moving implementation into focused modules.
export const PACKAGE_NAME = PACKAGE_JSON.name;
export const PACKAGE_VERSION = PACKAGE_JSON.version;

// Stable runtime helpers used across the CLI and tests.
export function run(command, args, options = {}) {
  return runModule(command, args, options, {
    execFileSync,
  });
}

export function parseArgs(argv) {
  return parseArgsModule(argv, {
    cwd: () => process.cwd(),
    defaultBridgeDir: DEFAULT_BRIDGE_DIR,
    defaultStoreDir: DEFAULT_STORE_DIR,
    resolvePath: (value) => path.resolve(value),
  });
}

export function ensureDir(dirPath) {
  return ensureDirModule(dirPath, {
    mkdirSync: fs.mkdirSync,
  });
}

export function sleep(ms) {
  return sleepModule(ms);
}

export function getRunPaths(outDir, runId) {
  return getRunPathsCore(outDir, runId);
}

export function readRunLatest(outDir, runId) {
  return readRunLatestCore(outDir, runId);
}

export function createRunRecord(outDir, metadata) {
  return createRunRecordCore(outDir, metadata, ensureDir);
}

export function recordRunEvent(outDir, runId, event) {
  return recordRunEventCore(outDir, runId, event, ensureDir);
}

export function captureWorkspaceBaseline(cwd) {
  return captureWorkspaceBaselineModule(cwd, {
    hashWorkspaceFile: (filePath) => hashWorkspaceFileModule(filePath),
    listDirtyFiles,
  });
}

export function diffWorkspaceAgainstBaseline(baseline, cwd, maxFiles = 20) {
  return diffWorkspaceAgainstBaselineModule(baseline, cwd, maxFiles, {
    hashWorkspaceFile: (filePath) => hashWorkspaceFileModule(filePath),
    listDirtyFiles,
  });
}

export const VSBufferWriter = VSBufferWriterCore;
export const encodeIpcParts = encodeIpcPartsCore;
export const decodeIpcParts = decodeIpcPartsCore;
export const frameIpcMessage = frameIpcMessageCore;

// Antigravity local-state helpers remain exported here for backward compatibility.
export function normalizeWorkspaceId(cwd) {
  return normalizeWorkspaceIdModule(cwd);
}

export function deriveProfileName(cwd) {
  return deriveProfileNameModule(cwd);
}

export function readStateValue(key) {
  return readStateValueModule(STATE_DB_PATH, key, {
    existsSync: fs.existsSync,
    run,
  });
}

export function extractPrintableStrings(buffer, minLength = 8) {
  return extractPrintableStringsModule(buffer, minLength);
}

export function decodeBase64Strings(key) {
  return decodeBase64StringsModule(key, {
    extractPrintableStrings,
    readStateValue,
  });
}

export function listSidebarWorkspacePaths() {
  return listSidebarWorkspacePathsModule({
    decodeBase64Strings,
    fileUriToPath,
  });
}

export const parseInstanceLine = parseInstanceLineCore;

export function discoverInstances() {
  return discoverInstancesCore(run);
}

export function findWorkspaceInstance(instances, workspaceId, options = {}) {
  return findWorkspaceInstanceCore(instances, workspaceId, options);
}

export const frameConnectJson = frameConnectJsonCore;
export const parseConnectJsonResponse = parseConnectJsonResponseCore;

// Snapshot decoding helpers are still re-exported from the facade so existing callers
// do not need to know which internal module owns the implementation.
export function decodeTopicStateEntries(topicPayload) {
  return decodeTopicStateEntriesCore(topicPayload);
}

export function decodeBase64PrintableStrings(rawValue, minLength = 8) {
  return decodeBase64PrintableStringsCore(rawValue, extractPrintableStrings, minLength);
}

export function extractActiveCascadeIds(topicPayload) {
  return extractActiveCascadeIdsCore(topicPayload, extractPrintableStrings);
}

export function extractTrajectorySignals(topicPayload) {
  return extractTrajectorySignalsCore(topicPayload, extractPrintableStrings);
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
  return readTextFileIfExistsModule(filePath, {
    readFileSync: fs.readFileSync,
  });
}

// Acceptance and VCS helpers are facade exports over the new focused modules.
export const hasAnyPattern = hasAnyPatternModule;
export const hasTaskOutput = hasTaskOutputModule;

export function listDirtyFiles(cwd) {
  return listDirtyFilesModule(cwd, { run });
}

export function summarizeWorkspaceChanges(cwd, maxFiles = 20) {
  return summarizeWorkspaceChangesModule(cwd, maxFiles, {
    listDirtyFiles,
    run,
  });
}

export function deriveAsyncRunOutcome(latest, snapshotSummary, workspaceDelta) {
  if (latest?.completion) {
    return latest.completion;
  }

  const ageMs = Date.now() - Date.parse(latest?.createdAt ?? 0);
  const idle = snapshotSummary?.supervisorState === "idle";
  const waiting = snapshotSummary?.supervisorState === "waiting";
  const hasTaskResults = (snapshotSummary?.taskResults?.length ?? 0) > 0;

  if (!idle || waiting || ageMs < ASYNC_IDLE_NO_OUTPUT_TIMEOUT_MS) {
    return null;
  }

  if (hasTaskResults || workspaceDelta?.producedChanges) {
    return {
      state: "completed_with_changes",
      reason:
        "Run returned to idle and produced observable task results or workspace changes relative to its baseline.",
      snapshot: snapshotSummary,
      approvals: latest?.approvals ?? [],
      workspaceChanges: latest?.latestWorkspaceChanges ?? null,
      workspaceDelta,
    };
  }

  return {
    state: "no_observable_output",
    reason:
      "Run returned to idle without any observable task results or workspace changes relative to its baseline.",
    snapshot: snapshotSummary,
    approvals: latest?.approvals ?? [],
    workspaceChanges: latest?.latestWorkspaceChanges ?? null,
    workspaceDelta,
  };
}

export function evaluateSkinSaasAppointmentStatusChain(cwd) {
  return evaluateSkinSaasAppointmentStatusChainModule(cwd, {
    readTextFileIfExists,
  });
}

export function evaluateAcceptanceChecks(cwd, tasks) {
  return evaluateAcceptanceChecksModule(cwd, tasks, {
    evaluateSkinSaasAppointmentStatusChain,
    listDirtyFiles,
  });
}

export const buildRemediationPrompt = buildRemediationPromptModule;

export function listBrainActivity(rootDir = path.join(os.homedir(), ".gemini", "antigravity", "brain")) {
  return listBrainActivityModule(rootDir, {
    existsSync: fs.existsSync,
    readdirSync: fs.readdirSync,
    statSync: fs.statSync,
  });
}

export const diffBrainActivity = diffBrainActivityModule;

export function runAntigravity(args, options = {}) {
  return runAntigravityModule(args, options, {
    execFileSync,
  });
}

export function findMainIpcHandle(appSupportDir = APP_SUPPORT_DIR) {
  return findMainIpcHandleCore(appSupportDir);
}

// Bridge-related exports intentionally stay here because the current public API and tests
// still import them from src/index.mjs.
export const buildDispatchArgs = buildDispatchArgsModule;

export function getBridgePaths(bridgeDir = DEFAULT_BRIDGE_DIR, workerId = null) {
  return getBridgePathsCore(bridgeDir, workerId);
}

export function readBridgeWorkerStatuses(bridgeDir = DEFAULT_BRIDGE_DIR) {
  return readBridgeWorkerStatusesCore(bridgeDir);
}

export function selectBridgeWorker(bridgeDir, cwd) {
  return selectBridgeWorkerCore(bridgeDir, cwd);
}

export function createBridgeRequestPayload(options) {
  return createBridgeRequestPayloadCore(options);
}

export function createBridgeCommandPayload(options, overrides = {}) {
  return createBridgeCommandPayloadCore(options, overrides);
}

export function createBridgeListCommandsPayload(options, overrides = {}) {
  return createBridgeListCommandsPayloadCore(options, overrides);
}

export function writeBridgeRequest(bridgeDir, payload, workerId = null) {
  return writeBridgeRequestCore(bridgeDir, payload, ensureDir, workerId);
}

export async function waitForBridgeResponse(bridgeDir, requestId, timeoutMs = 8000, workerId = null) {
  return waitForBridgeResponseCore(bridgeDir, requestId, sleep, timeoutMs, workerId);
}

export const summarizeSnapshotForCompletion = summarizeSnapshotForCompletionCore;
export const summarizeWaitingInteraction = summarizeWaitingInteractionCore;
export const buildAutoApprovalCommandPlans = buildAutoApprovalCommandPlansCore;

// Supervisor orchestration is composed here by wiring policy modules to effectful helpers.
export async function attemptAutoApprove(options, snapshot) {
  return attemptAutoApproveRuntime(options, snapshot, {
    buildSnapshot,
    createBridgeCommandPayload,
    dispatchBridgeRequest,
    recordRunEvent: options.recordRunEvent ?? null,
    sleep,
  });
}

export async function waitForCompletionResult(options) {
  return waitForCompletionResultRuntime(options, {
    attemptAutoApproveImpl: attemptAutoApprove,
    buildSnapshot,
    createBridgeCommandPayload,
    dispatchBridgeRequest,
    recordRunEvent: options.recordRunEvent ?? null,
    sleep,
    summarizeWorkspaceChanges,
  });
}

export async function dispatchBridgeRequest(options, payload = createBridgeRequestPayload(options)) {
  const bridgeDir = options.bridgeDir ?? DEFAULT_BRIDGE_DIR;
  const workerStatuses = readBridgeWorkerStatuses(bridgeDir);
  const targetCwd = path.resolve(options.cwd);
  const matchingWorkers = workerStatuses.filter((worker) => {
    const roots = Array.isArray(worker.status?.workspaceRoots) ? worker.status.workspaceRoots : [];
    return roots.some((root) => targetCwd === root || targetCwd.startsWith(root + path.sep));
  });
  const selectedWorker = selectBridgeWorker(bridgeDir, options.cwd);
  const workerId = selectedWorker?.workerId ?? null;

  if (!workerId && workerStatuses.length > 0) {
    const bridgeError =
      matchingWorkers.length > 0
        ? {
            code: "no_live_worker",
            message:
              "Matched bridge workers exist for the target workspace, but none of them are currently healthy.",
            matchingWorkers: matchingWorkers.map((worker) => ({
              workerId: worker.workerId,
              health: worker.health ?? null,
            })),
          }
        : {
            code: "no_matching_worker",
            message: "No healthy bridge worker is currently attached to the target workspace.",
            availableWorkers: workerStatuses.map((worker) => ({
              workerId: worker.workerId,
              workspaceRoots: worker.status?.workspaceRoots ?? [],
              health: worker.health ?? null,
            })),
          };

    options.recordRunEvent?.("bridge.responded", {
      requestId: payload.id,
      bridgeWorkerId: null,
      responded: false,
      response: null,
      bridgeError,
    });

    return {
      bridgeDir,
      bridgeWorkerId: null,
      bridgeWorkerStatus: null,
      requestId: payload.id,
      requestPath: null,
      status: null,
      responsePath: null,
      responded: false,
      response: null,
      completion: null,
      bridgeError,
    };
  }

  const writeResult = writeBridgeRequest(bridgeDir, payload, workerId);
  const status = fs.existsSync(writeResult.statusPath)
    ? JSON.parse(fs.readFileSync(writeResult.statusPath, "utf8"))
    : null;
  const waited = await waitForBridgeResponse(bridgeDir, payload.id, options.waitMs, workerId);
  options.recordRunEvent?.("bridge.responded", {
    requestId: payload.id,
    bridgeWorkerId: workerId,
    responded: Boolean(waited.response),
    response: waited.response,
  });
  const completion =
    options.waitForCompletion && waited.response?.ok ? await waitForCompletionResult(options) : null;

  return {
    bridgeDir,
    bridgeWorkerId: workerId,
    bridgeWorkerStatus: selectedWorker?.status ?? status,
    requestId: payload.id,
    requestPath: writeResult.filePath,
    status,
    responsePath: waited.responsePath,
    responded: Boolean(waited.response),
    response: waited.response,
    completion,
    bridgeError: null,
  };
}

export function buildRemediationPayload(options, snapshot) {
  return buildRemediationPayloadCore(
    {
      ...options,
      cwd: path.resolve(options.cwd),
      addFiles: (options.addFiles ?? []).map((filePath) => path.resolve(filePath)),
      completion: options.completion ?? null,
    },
    snapshot,
    buildRemediationPrompt
  );
}

export const isRemediationTerminal = isRemediationTerminalCore;
export const shouldAutoRemediateCompletion = shouldAutoRemediateCompletionCore;

export async function dispatchViaBridge(options) {
  const workspaceChanges = summarizeWorkspaceChanges(options.cwd);
  const workspaceFingerprint = captureWorkspaceBaseline(options.cwd);
  const runRecord = createRunRecord(options.outDir, {
    runId: options.runId,
    cwd: path.resolve(options.cwd),
    prompt: options.prompt,
    mode: options.mode,
    profile: options.profile ?? null,
    addFiles: (options.addFiles ?? []).map((filePath) => path.resolve(filePath)),
    bridgeDir: options.bridgeDir ?? DEFAULT_BRIDGE_DIR,
    waitMs: options.waitMs,
    autoRemediate: options.autoRemediate,
    maxRemediations: options.maxRemediations,
    supervisorLoopTimeoutMs: options.supervisorLoopTimeoutMs,
    workspaceChanges,
    workspaceFingerprint,
  });
  const emitRunEvent = (type, data = {}, patch = {}) =>
    recordRunEvent(options.outDir, runRecord.runId, {
      type,
      data,
      patch,
    });

  emitRunEvent(
    "run.created",
    {
      cwd: runRecord.latest.cwd,
      prompt: runRecord.latest.prompt,
    },
    {
      status: "queued",
    }
  );

  const payload = createBridgeRequestPayload({
    ...options,
    runId: runRecord.runId,
  });
  emitRunEvent(
    "bridge.requested",
    {
      requestId: payload.id,
      type: payload.type,
    },
    {
      status: "dispatching",
      requestId: payload.id,
    }
  );

  const result = await dispatchViaBridgeRuntime(
    {
      ...options,
      runId: runRecord.runId,
      recordRunEvent: emitRunEvent,
    },
    {
      buildRemediationPrompt,
      buildSnapshot,
      dispatchBridgeRequest: (dispatchOptions, dispatchPayload = payload) =>
        dispatchBridgeRequest(
          {
            ...dispatchOptions,
            runId: runRecord.runId,
            recordRunEvent: emitRunEvent,
          },
          dispatchPayload
        ),
      recordRunEvent: emitRunEvent,
    }
  );

  const completionState = result.final?.completion?.state ?? result.completion?.state ?? null;
  emitRunEvent(
    "run.updated",
    {
      completionState,
      responded: result.responded,
      bridgeError: result.bridgeError ?? null,
    },
    {
      status:
        completionState ??
        result.bridgeError?.code ??
        (result.responded ? "dispatched" : "unacknowledged"),
      bridgeWorkerId: result.bridgeWorkerId ?? null,
      response: result.response ?? null,
      completion: result.final?.completion ?? result.completion ?? null,
      latestSnapshot: result.final?.completion?.snapshot ?? null,
      latestWorkspaceChanges:
        result.final?.completion?.workspaceChanges ?? workspaceChanges,
      latestWorkspaceDelta: result.final?.completion?.workspaceDelta ?? null,
      approvals: result.final?.completion?.approvals ?? [],
      remediations: result.remediations ?? [],
    }
  );

  return {
    runId: runRecord.runId,
    ...result,
  };
}

export async function getRunStatus(options) {
  if (!options.runId) {
    throw new Error("run-status requires --run-id");
  }

  const latest = readRunLatest(options.outDir, options.runId);
  if (!latest) {
    throw new Error(`Run not found: ${options.runId}`);
  }

  const emitRunEvent = (type, data = {}, patch = {}) =>
    recordRunEvent(options.outDir, options.runId, {
      type,
      data,
      patch,
    });

  if (!options.refresh) {
    return latest;
  }

  const snapshot = await buildSnapshot({
    ...options,
    cwd: latest.cwd,
  });
  const snapshotSummary = summarizeSnapshotForCompletion(snapshot);
  const workspaceChanges = summarizeWorkspaceChanges(latest.cwd);
  const workspaceDelta = diffWorkspaceAgainstBaseline(
    latest.baselineWorkspaceFingerprint ?? null,
    latest.cwd
  );
  const derivedCompletion = deriveAsyncRunOutcome(
    {
      ...latest,
      latestWorkspaceChanges: workspaceChanges,
    },
    snapshotSummary,
    workspaceDelta
  );
  const currentStatus =
    derivedCompletion?.state ??
    (snapshot.supervisor?.state === "waiting"
      ? "waiting"
      : snapshot.supervisor?.state === "running"
        ? "running"
        : snapshot.supervisor?.state === "idle"
          ? "idle"
          : latest.status);

  const autoRemediateEnabled = options.autoRemediate ?? latest.autoRemediate ?? false;
  const remediationCount = Array.isArray(latest.remediations) ? latest.remediations.length : 0;
  const maxRemediations = options.maxRemediations ?? latest.maxRemediations ?? 1;

  if (
    autoRemediateEnabled &&
    shouldAutoRemediateCompletion(derivedCompletion) &&
    remediationCount < maxRemediations
  ) {
    const remediationPayload = buildRemediationPayload(
      {
        cwd: latest.cwd,
        prompt: latest.prompt,
        mode: latest.mode,
        profile: latest.profile ?? null,
        addFiles: latest.addFiles ?? [],
        completion: derivedCompletion,
      },
      snapshot
    );

    if (remediationPayload) {
      emitRunEvent(
        "supervisor.remediation_requested",
        {
          prompt: remediationPayload.prompt,
          source: remediationPayload.remediation?.source ?? null,
          previousCompletionState: derivedCompletion?.state ?? null,
        },
        {
          status: "remediating",
          completion: null,
        }
      );

      const remediationResult = await dispatchBridgeRequest(
        {
          ...options,
          cwd: latest.cwd,
          prompt: remediationPayload.prompt,
          mode: latest.mode,
          profile: latest.profile ?? null,
          addFiles: latest.addFiles ?? [],
          bridgeDir: latest.bridgeDir ?? options.bridgeDir ?? DEFAULT_BRIDGE_DIR,
          waitMs: latest.waitMs ?? options.waitMs,
          waitForCompletion: false,
          autoRemediate: false,
          runId: latest.runId,
          recordRunEvent: emitRunEvent,
        },
        remediationPayload
      );

      const remediations = [
        ...(latest.remediations ?? []),
        {
          attempt: remediationCount + 1,
          requestId: remediationResult.requestId,
          responded: remediationResult.responded,
          response: remediationResult.response,
          completion: remediationResult.completion,
          remediationPrompt: remediationPayload.prompt,
        },
      ];

      return emitRunEvent(
        "supervisor.remediation_dispatched",
        {
          requestId: remediationResult.requestId,
          responded: remediationResult.responded,
          source: remediationPayload.remediation?.source ?? null,
        },
        {
          status: remediationResult.responded ? "remediating" : "remediation_unacknowledged",
          requestId: remediationResult.requestId,
          bridgeWorkerId: remediationResult.bridgeWorkerId ?? latest.bridgeWorkerId ?? null,
          response: remediationResult.response ?? latest.response ?? null,
          completion: null,
          latestSnapshot: snapshotSummary,
          latestWorkspaceChanges: workspaceChanges,
          latestWorkspaceDelta: workspaceDelta,
          remediations,
        }
      );
    }
  }

  return emitRunEvent("snapshot.observed", {
    snapshot: snapshotSummary,
  }, {
    status: currentStatus,
    completion: derivedCompletion ?? latest.completion ?? null,
    latestSnapshot: snapshotSummary,
    latestWorkspaceChanges: workspaceChanges,
    latestWorkspaceDelta: workspaceDelta,
  });
}

export const diffActiveCascadeIds = diffActiveCascadeIdsModule;
export const deriveDispatchVerification = deriveDispatchVerificationModule;

export async function createMainIpcClient(socketPath, context = "main") {
  return createMainIpcClientCore(socketPath, context, {
    sleep,
  });
}

export async function waitForWorkspaceInstance(cwd, timeoutMs = 8000) {
  return waitForWorkspaceInstanceModule(cwd, timeoutMs, {
    discoverInstances,
    findWorkspaceInstance,
    normalizeWorkspaceId,
    sleep,
  });
}

export async function dispatchToWorkspace(options) {
  return dispatchToWorkspaceModule(options, {
    buildDispatchArgs,
    buildExtensionServerSnapshot,
    createMainIpcClient,
    deriveDispatchVerification,
    deriveProfileName,
    diffActiveCascadeIds,
    diffBrainActivity,
    discoverInstances,
    env: process.env,
    findMainIpcHandle,
    findWorkspaceInstance,
    listBrainActivity,
    listSidebarWorkspacePaths,
    normalizeWorkspaceId,
    sleep,
  });
}

export function postJson(port, csrfToken, method, payload, timeoutMs = TOPIC_REQUEST_TIMEOUT_MS) {
  return postJsonModule(port, csrfToken, method, payload, timeoutMs, {
    extensionServerService: EXTENSION_SERVER_SERVICE,
    httpRequest: defaultHttpRequest,
  });
}

export function subscribeTopicInitialState(port, csrfToken, topic, timeoutMs = TOPIC_REQUEST_TIMEOUT_MS) {
  return subscribeTopicInitialStateModule(port, csrfToken, topic, timeoutMs, {
    extensionServerService: EXTENSION_SERVER_SERVICE,
    frameConnectJson,
    httpRequest: defaultHttpRequest,
    parseConnectJsonResponse,
  });
}

export async function buildExtensionServerSnapshot(instance, tasks) {
  return buildExtensionServerSnapshotCore(instance, tasks, {
    extractPrintableStrings,
    postJson,
    subscribeTopicInitialState,
    TOPICS,
  });
}

export const fileUriToPath = fileUriToPathCore;
export const readArtifactPreview = readArtifactPreviewCore;

// Snapshot assembly and persistence are exported from the facade for CLI use and compatibility.
export function listArtifacts() {
  return listArtifactsCore(decodeBase64Strings);
}

export function listTasksFromManagerState() {
  return listTasksFromManagerStateCore(decodeBase64Strings);
}

export function readRecentLogSignals() {
  return readRecentLogSignalsCore(LOGS_DIR);
}

export function buildTaskSummaries(cwd) {
  return buildTaskSummariesCore(cwd, {
    decodeBase64Strings,
    recentTaskWindowMs: RECENT_TASK_WINDOW_MS,
  });
}

export function writeSnapshotFiles(outDir, snapshot) {
  return writeSnapshotFilesCore(outDir, snapshot, ensureDir);
}

export async function watch(options) {
  return watchModule(options, {
    buildSnapshot,
    ensureDir,
    writeSnapshotFiles,
  });
}

export function printUsage() {
  return printUsageModule();
}

export async function buildSnapshot(options) {
  return buildSnapshotModule(options, {
    buildExtensionServerSnapshot,
    buildSnapshotSync,
    evaluateAcceptanceChecks,
  });
}

export function buildSnapshotSync(options) {
  return buildSnapshotSyncModule(options, {
    appSupportDir: APP_SUPPORT_DIR,
    stateDbPath: STATE_DB_PATH,
    buildTaskSummaries,
    discoverInstances,
    findWorkspaceInstance,
    normalizeWorkspaceId,
    readRecentLogSignals,
    readStateValue,
  });
}

export async function main(argv = process.argv.slice(2)) {
  return mainModule(argv, {
    buildSnapshot,
    discoverInstances,
    dispatchToWorkspace,
    dispatchViaBridge,
    getRunStatus,
    output: console.log,
    outputJson: (value) => console.log(JSON.stringify(value, null, 2)),
    packageVersion: PACKAGE_VERSION,
    parseArgs,
    printUsage,
    setExitCode: (code) => {
      process.exitCode = code;
    },
    watch,
  });
}

// Direct execution stays here so the published bin can continue pointing at src/index.mjs.
const currentModulePath = fileURLToPath(import.meta.url);
const entryPath = process.argv[1] ? fs.realpathSync.native(process.argv[1]) : null;

if (entryPath === currentModulePath) {
  await main();
}
