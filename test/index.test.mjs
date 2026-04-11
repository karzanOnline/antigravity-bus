import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  buildAutoApprovalCommandPlans,
  createBridgeListCommandsPayload,
  createBridgeCommandPayload,
  buildDispatchArgs,
  buildRemediationPayload,
  createBridgeRequestPayload,
  dispatchBridgeRequest,
  deriveDispatchVerification,
  deriveAsyncRunOutcome,
  buildRemediationPrompt,
  isRemediationTerminal,
  shouldAutoRemediateCompletion,
  summarizeWaitingInteraction,
  summarizeSnapshotForCompletion,
  decodeIpcParts,
  encodeIpcParts,
  PACKAGE_VERSION,
  deriveSupervisorState,
  evaluateAcceptanceChecks,
  extractPrintableStrings,
  extractActiveCascadeIds,
  findWorkspaceInstance,
  findMainIpcHandle,
  frameIpcMessage,
  frameConnectJson,
  getBridgePaths,
  readBridgeWorkerStatuses,
  selectBridgeWorker,
  main,
  parseArgs,
  parseConnectJsonResponse,
  parseInstanceLine,
  readArtifactPreview,
  summarizeWorkspaceChanges,
  waitForBridgeResponse,
  writeBridgeRequest,
  writeSnapshotFiles,
} from "../src/index.mjs";
import {
  dispatchViaBridge as dispatchViaBridgeRuntime,
  waitForCompletionResult as waitForCompletionResultRuntime,
} from "../src/supervisor/runtime.mjs";

test("parseArgs reads command and option flags", () => {
  const options = parseArgs([
    "watch",
    "--cwd",
    "examples",
    "--interval",
    "2500",
    "--out-dir",
    "tmp/out",
  ]);

  assert.equal(options.command, "watch");
  assert.equal(options.intervalMs, 2500);
  assert.equal(options.cwd, path.resolve("examples"));
  assert.equal(options.outDir, path.resolve("tmp/out"));
});

test("buildDispatchArgs shapes launch.start payload for workspace chat dispatch", () => {
  const args = buildDispatchArgs({
    cwd: "/Users/demo/skin-saas",
    prompt: "做到哪里",
    mode: "agent",
    profile: "agbus-demo",
    addFiles: ["/Users/demo/skin-saas/README.md"],
  });

  assert.deepEqual(args, {
    _: ["/Users/demo/skin-saas"],
    "reuse-window": true,
    profile: "agbus-demo",
    chat: {
      _: ["做到哪里"],
      "reuse-window": true,
      mode: "agent",
      profile: "agbus-demo",
      "add-file": ["/Users/demo/skin-saas/README.md"],
    },
  });
});

test("parseArgs enables strict cascade verification when requested", () => {
  const options = parseArgs(["dispatch", "--cwd", "examples", "--prompt", "ping", "--wait-for-new-cascade"]);

  assert.equal(options.command, "dispatch");
  assert.equal(options.waitForNewCascade, true);
});

test("parseArgs reads bridge-dispatch options", () => {
  const options = parseArgs([
    "bridge-dispatch",
    "--cwd",
    "examples",
    "--prompt",
    "ping",
    "--bridge-dir",
    "/tmp/ag-bridge",
  ]);

  assert.equal(options.command, "bridge-dispatch");
  assert.equal(options.bridgeDir, "/tmp/ag-bridge");
  assert.equal(options.prompt, "ping");
});

test("parseArgs reads run-status options", () => {
  const options = parseArgs([
    "run-status",
    "--run-id",
    "run-123",
    "--refresh",
  ]);

  assert.equal(options.command, "run-status");
  assert.equal(options.runId, "run-123");
  assert.equal(options.refresh, true);
});

test("parseArgs enables completion wait for default dispatch", () => {
  const options = parseArgs([
    "dispatch",
    "--cwd",
    "examples",
    "--prompt",
    "ping",
    "--wait-for-completion",
    "--completion-timeout-ms",
    "45000",
  ]);

  assert.equal(options.command, "dispatch");
  assert.equal(options.waitForCompletion, true);
  assert.equal(options.completionTimeoutMs, 45000);
});

test("parseArgs enables automatic remediation loop", () => {
  const options = parseArgs([
    "dispatch",
    "--cwd",
    "examples",
    "--prompt",
    "ping",
    "--auto-remediate",
    "--max-remediations",
    "2",
  ]);

  assert.equal(options.autoRemediate, true);
  assert.equal(options.maxRemediations, 2);
});

test("parseArgs enables automatic approval loop", () => {
  const options = parseArgs([
    "dispatch",
    "--cwd",
    "examples",
    "--prompt",
    "ping",
    "--auto-approve",
    "--approval-timeout-ms",
    "12000",
  ]);

  assert.equal(options.autoApprove, true);
  assert.equal(options.approvalTimeoutMs, 12000);
});

test("parseArgs reads supervisor loop timeout", () => {
  const options = parseArgs([
    "dispatch",
    "--cwd",
    "examples",
    "--prompt",
    "ping",
    "--supervisor-loop-timeout-ms",
    "60000",
  ]);

  assert.equal(options.supervisorLoopTimeoutMs, 60000);
});

test("deriveDispatchVerification distinguishes confirmed and unconfirmed dispatches", () => {
  assert.deepEqual(
    deriveDispatchVerification({
      waitForNewCascade: true,
      workspaceReady: true,
      sidebarIncludesWorkspace: true,
      changedTrajectories: [],
      newCascadeIds: ["new-cascade-id"],
    }),
    {
      state: "confirmed_new_cascade",
      targetHit: true,
      reasons: ["Observed new active cascade IDs after dispatch."],
    }
  );

  assert.deepEqual(
    deriveDispatchVerification({
      waitForNewCascade: true,
      workspaceReady: true,
      sidebarIncludesWorkspace: true,
      changedTrajectories: [],
      newCascadeIds: [],
    }),
    {
      state: "delivered_but_unconfirmed",
      targetHit: false,
      reasons: ["No new active cascade IDs were observed before the dispatch timeout expired."],
    }
  );
});

test("createBridgeRequestPayload captures prompt dispatch metadata", () => {
  const payload = createBridgeRequestPayload({
    cwd: "/Users/demo/repo",
    prompt: "hello bridge",
    mode: "agent",
    addFiles: ["/Users/demo/repo/README.md"],
    profile: "demo-profile",
    runId: "run-123",
  });

  assert.match(payload.id, /^bridge-/);
  assert.equal(payload.runId, "run-123");
  assert.equal(payload.cwd, "/Users/demo/repo");
  assert.equal(payload.prompt, "hello bridge");
  assert.equal(payload.commandCandidates[0], "antigravity.sendPromptToAgentPanel");
});

test("buildRemediationPayload turns failed acceptance into a bridge request", () => {
  const payload = buildRemediationPayload(
    {
      cwd: "/Users/demo/skin-saas",
      mode: "agent",
      addFiles: [],
      profile: null,
    },
    {
      cwd: "/Users/demo/skin-saas",
      supervisor: {
        acceptance: {
          state: "failed",
          dirtyRelevantFiles: ["/Users/demo/skin-saas/apps/admin/src/app/appointments/[id]/page.tsx"],
          failedChecks: [
            {
              label: "Skin SaaS appointment status update chain",
              reasons: ["Appointments controller does not expose a status-update route."],
            },
          ],
        },
      },
    }
  );

  assert.ok(payload);
  assert.match(payload.prompt, /does not pass supervisor acceptance/i);
  assert.match(payload.prompt, /status-update route/i);
  assert.equal(payload.remediation.source, "supervisor.acceptance.failed");
});

test("buildRemediationPayload turns no_observable_output into a follow-up bridge request", () => {
  const payload = buildRemediationPayload(
    {
      cwd: "/Users/demo/skin-saas",
      prompt: "请在会员详情页补最近预约空态和预约入口。",
      mode: "agent",
      addFiles: [],
      profile: null,
      completion: {
        state: "no_observable_output",
        workspaceDelta: {
          changedFiles: [],
        },
      },
    },
    {
      cwd: "/Users/demo/skin-saas",
      tasks: [],
      supervisor: {
        state: "idle",
        acceptance: {
          state: "passed",
          failedChecks: [],
        },
      },
    }
  );

  assert.ok(payload);
  assert.match(payload.prompt, /did not produce any observable output/i);
  assert.match(payload.prompt, /Do not restate the plan or paste the original request again/i);
  assert.doesNotMatch(payload.prompt, /Original request:/i);
  assert.equal(payload.remediation.source, "supervisor.no_observable_output");
  assert.equal(payload.remediation.previousCompletionState, "no_observable_output");
});

test("createBridgeCommandPayload captures command execution metadata", () => {
  const payload = createBridgeCommandPayload(
    {
      cwd: "/Users/demo/repo",
    },
    {
      commandCandidates: ["chatEditing.acceptAllFiles"],
      interaction: {
        source: "supervisor.waiting",
      },
    }
  );

  assert.match(payload.id, /^bridge-/);
  assert.equal(payload.type, "executeCommand");
  assert.equal(payload.runId, null);
  assert.equal(payload.cwd, "/Users/demo/repo");
  assert.deepEqual(payload.commandCandidates, ["chatEditing.acceptAllFiles"]);
  assert.equal(payload.interaction.source, "supervisor.waiting");
});

test("createBridgeListCommandsPayload captures command listing metadata", () => {
  const payload = createBridgeListCommandsPayload(
    {
      cwd: "/Users/demo/repo",
    },
    {
      pattern: "plan|review|proceed",
      flags: "i",
    }
  );

  assert.match(payload.id, /^bridge-/);
  assert.equal(payload.type, "listCommands");
  assert.equal(payload.runId, null);
  assert.equal(payload.cwd, "/Users/demo/repo");
  assert.equal(payload.pattern, "plan|review|proceed");
  assert.equal(payload.flags, "i");
});

test("isRemediationTerminal recognizes passing terminal states only", () => {
  assert.equal(isRemediationTerminal({ state: "completed" }), true);
  assert.equal(isRemediationTerminal({ state: "completed_without_acceptance" }), true);
  assert.equal(isRemediationTerminal({ state: "completed_chat_only" }), true);
  assert.equal(isRemediationTerminal({ state: "failed" }), false);
  assert.equal(isRemediationTerminal({ state: "timeout" }), false);
});

test("shouldAutoRemediateCompletion retries failed and no-output runs only", () => {
  assert.equal(shouldAutoRemediateCompletion({ state: "failed" }), true);
  assert.equal(shouldAutoRemediateCompletion({ state: "no_observable_output" }), true);
  assert.equal(shouldAutoRemediateCompletion({ state: "completed" }), false);
  assert.equal(shouldAutoRemediateCompletion({ state: "completed_chat_only" }), false);
});

test("waitForCompletionResult returns completed_chat_only for reply-only probes", async () => {
  const snapshots = [
    {
      generatedAt: "2026-04-11T00:00:00.000Z",
      tasks: [],
      extensionServer: { topicSignals: [] },
      supervisor: {
        state: "idle",
        activeCascadeIds: [],
        acceptance: { state: "unknown", failedChecks: [] },
      },
    },
    {
      generatedAt: "2026-04-11T00:00:01.000Z",
      tasks: [],
      extensionServer: { topicSignals: [] },
      supervisor: {
        state: "idle",
        activeCascadeIds: [],
        acceptance: { state: "unknown", failedChecks: [] },
      },
    },
  ];
  let snapshotIndex = 0;

  const result = await waitForCompletionResultRuntime(
    {
      cwd: "/Users/demo/repo",
      prompt: "请不要修改任何代码、不要创建文件，只回复一句：已收到回执测试。",
      completionTimeoutMs: 5000,
      autoApprove: false,
    },
    {
      buildSnapshot: async () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)],
      createBridgeCommandPayload: () => {
        throw new Error("createBridgeCommandPayload should not be called");
      },
      dispatchBridgeRequest: async () => {
        throw new Error("dispatchBridgeRequest should not be called");
      },
      sleep: async () => {},
      summarizeWorkspaceChanges: () => ({ cwd: "/Users/demo/repo", dirtyFileCount: 0, dirtyFiles: [] }),
    }
  );

  assert.equal(result.state, "completed_chat_only");
  assert.match(result.reason, /without observable task artifacts/i);
  assert.deepEqual(result.snapshot.taskResults, []);
});

test("waitForCompletionResult does not treat ordinary prompts as chat-only completions", async () => {
  const snapshots = [
    {
      generatedAt: "2026-04-11T00:00:00.000Z",
      tasks: [],
      extensionServer: { topicSignals: [] },
      supervisor: {
        state: "idle",
        activeCascadeIds: [],
        acceptance: { state: "unknown", failedChecks: [] },
      },
    },
    {
      generatedAt: "2026-04-11T00:00:01.000Z",
      tasks: [],
      extensionServer: { topicSignals: [] },
      supervisor: {
        state: "idle",
        activeCascadeIds: [],
        acceptance: { state: "unknown", failedChecks: [] },
      },
    },
  ];
  let snapshotIndex = 0;

  const result = await waitForCompletionResultRuntime(
    {
      cwd: "/Users/demo/repo",
      prompt: "请继续实现 supervisor 的结果回传。",
      completionTimeoutMs: 0,
      autoApprove: false,
    },
    {
      buildSnapshot: async () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)],
      createBridgeCommandPayload: () => {
        throw new Error("createBridgeCommandPayload should not be called");
      },
      dispatchBridgeRequest: async () => {
        throw new Error("dispatchBridgeRequest should not be called");
      },
      sleep: async () => {},
      summarizeWorkspaceChanges: () => ({ cwd: "/Users/demo/repo", dirtyFileCount: 0, dirtyFiles: [] }),
    }
  );

  assert.equal(result.state, "timeout");
});

test("deriveAsyncRunOutcome marks idle runs without new output as no_observable_output", () => {
  const completion = deriveAsyncRunOutcome(
    {
      createdAt: "2026-04-11T00:00:00.000Z",
      completion: null,
      approvals: [],
      latestWorkspaceChanges: { cwd: "/Users/demo/repo" },
    },
    {
      supervisorState: "idle",
      taskResults: [],
    },
    {
      producedChanges: false,
      changedFileCount: 0,
      changedFiles: [],
    }
  );

  assert.equal(completion.state, "no_observable_output");
});

test("deriveAsyncRunOutcome marks idle runs with baseline delta as completed_with_changes", () => {
  const completion = deriveAsyncRunOutcome(
    {
      createdAt: "2026-04-11T00:00:00.000Z",
      completion: null,
      approvals: [],
      latestWorkspaceChanges: { cwd: "/Users/demo/repo" },
    },
    {
      supervisorState: "idle",
      taskResults: [],
    },
    {
      producedChanges: true,
      changedFileCount: 1,
      changedFiles: ["/Users/demo/repo/README.md"],
    }
  );

  assert.equal(completion.state, "completed_with_changes");
});

test("dispatchViaBridgeRuntime auto-remediates no_observable_output completions", async () => {
  const dispatchCalls = [];
  const result = await dispatchViaBridgeRuntime(
    {
      cwd: "/Users/demo/skin-saas",
      prompt: "请补会员详情页最近预约空态。",
      mode: "agent",
      addFiles: [],
      autoRemediate: true,
      maxRemediations: 1,
      supervisorLoopTimeoutMs: 10000,
    },
    {
      buildRemediationPrompt: () => null,
      buildSnapshot: async () => ({
        cwd: "/Users/demo/skin-saas",
        tasks: [],
        supervisor: {
          state: "idle",
          acceptance: {
            state: "passed",
            failedChecks: [],
          },
        },
      }),
      dispatchBridgeRequest: async (_options, payload = null) => {
        dispatchCalls.push(payload);
        if (dispatchCalls.length === 1) {
          return {
            requestId: "bridge-1",
            responded: true,
            response: { ok: true },
            completion: {
              state: "no_observable_output",
              workspaceDelta: {
                producedChanges: false,
                changedFiles: [],
              },
            },
          };
        }

        return {
          requestId: "bridge-2",
          responded: true,
          response: { ok: true },
          completion: {
            state: "completed_with_changes",
          },
        };
      },
      recordRunEvent: () => {},
    }
  );

  assert.equal(dispatchCalls.length, 2);
  assert.match(dispatchCalls[1].prompt, /did not produce any observable output/i);
  assert.doesNotMatch(dispatchCalls[1].prompt, /Original request:/i);
  assert.equal(result.remediations.length, 1);
  assert.equal(result.final.completion.state, "completed_with_changes");
});

test("summarizeSnapshotForCompletion keeps terminal-state signals compact", () => {
  const summary = summarizeSnapshotForCompletion({
    generatedAt: "2026-04-11T00:00:00.000Z",
    tasks: [{ trajectoryId: "t-1" }],
    supervisor: {
      state: "running",
      activeCascadeIds: ["cascade-1"],
      acceptance: {
        state: "failed",
        failedChecks: [{ id: "check-1" }],
      },
    },
  });

  assert.deepEqual(summary, {
    generatedAt: "2026-04-11T00:00:00.000Z",
    supervisorState: "running",
    acceptanceState: "failed",
    activeCascadeIds: ["cascade-1"],
    topicSignals: [],
    taskCount: 1,
    taskResults: [
      {
        trajectoryId: "t-1",
        statusGuess: null,
        taskFile: null,
        latestArtifact: null,
        messages: [],
        artifactCount: 0,
      },
    ],
    failedChecks: [{ id: "check-1" }],
  });
});

test("summarizeSnapshotForCompletion keeps latest task result details compact", () => {
  const summary = summarizeSnapshotForCompletion({
    generatedAt: "2026-04-11T00:00:00.000Z",
    tasks: [
      {
        trajectoryId: "t-1",
        statusGuess: "completed",
        taskFile: "/tmp/task.md",
        messages: ["done", "summary", "extra", "ignored"],
        latestArtifact: {
          fileName: "artifact.md",
          filePath: "/tmp/artifact.md",
          updatedAt: "2026-04-11T00:00:01.000Z",
          preview: "Finished the requested work.",
        },
        artifacts: [{}, {}],
      },
    ],
    supervisor: {
      state: "done",
      activeCascadeIds: [],
      acceptance: {
        state: "passed",
        failedChecks: [],
      },
    },
  });

  assert.deepEqual(summary.taskResults, [
    {
      trajectoryId: "t-1",
      statusGuess: "completed",
      taskFile: "/tmp/task.md",
      latestArtifact: {
        fileName: "artifact.md",
        filePath: "/tmp/artifact.md",
        updatedAt: "2026-04-11T00:00:01.000Z",
        preview: "Finished the requested work.",
      },
      messages: ["done", "summary", "extra"],
      artifactCount: 2,
    },
  ]);
});

test("summarizeWorkspaceChanges reports dirty files and diff stats", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ag-bus-changes-"));
  spawnSync("git", ["init"], { cwd, encoding: "utf8" });
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "one\n");
  spawnSync("git", ["add", "tracked.txt"], { cwd, encoding: "utf8" });
  spawnSync("git", ["commit", "-m", "init"], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Codex",
      GIT_AUTHOR_EMAIL: "codex@example.com",
      GIT_COMMITTER_NAME: "Codex",
      GIT_COMMITTER_EMAIL: "codex@example.com",
    },
  });

  fs.writeFileSync(path.join(cwd, "tracked.txt"), "one\ntwo\n");
  fs.writeFileSync(path.join(cwd, "new.txt"), "fresh\n");

  const summary = summarizeWorkspaceChanges(cwd);
  assert.equal(summary.cwd, cwd);
  assert.equal(summary.dirtyFileCount, 2);
  assert.equal(summary.diffStat?.includes("tracked.txt"), true);
  assert.deepEqual(
    summary.dirtyFiles.map((filePath) => path.basename(filePath)).sort(),
    ["new.txt", "tracked.txt"]
  );
});

test("summarizeWaitingInteraction extracts waiting-related topic signals", () => {
  const interaction = summarizeWaitingInteraction({
    supervisor: {
      state: "waiting",
    },
    extensionServer: {
      topicSignals: ["BlockedOnUser", "OtherSignal"],
    },
  });

  assert.equal(interaction.waiting, true);
  assert.deepEqual(interaction.signals, ["BlockedOnUser"]);
});

test("buildAutoApprovalCommandPlans prioritizes file acceptance for edit waits", () => {
  const plans = buildAutoApprovalCommandPlans({
    supervisor: {
      state: "waiting",
    },
    extensionServer: {
      topicSignals: ["BlockedOnUser", "edit file approval"],
    },
  });

  assert.deepEqual(
    plans.map((plan) => plan.commandCandidates[0]),
    [
      "chatEditing.acceptAllFiles",
      "antigravity.prioritized.agentAcceptAllInFile",
      "workbench.action.chat.editToolApproval",
      "antigravity.acceptAgentStep",
      "notification.acceptPrimaryAction",
    ]
  );
});

test("buildAutoApprovalCommandPlans prioritizes plan approval commands for review waits", () => {
  const plans = buildAutoApprovalCommandPlans({
    supervisor: {
      state: "waiting",
    },
    extensionServer: {
      topicSignals: ["BlockedOnUser", "Implementation Plan review", "Proceed required"],
    },
  });

  assert.deepEqual(
    plans.map((plan) => plan.commandCandidates[0]).slice(0, 4),
    [
      "antigravity.acceptAgentStep",
      "notification.acceptPrimaryAction",
      "workbench.action.chat.editToolApproval",
      "chatEditing.acceptAllFiles",
    ]
  );
});

test("getBridgePaths scopes worker directories under workers/<id>", () => {
  const paths = getBridgePaths("/tmp/agbus", "pid-123");

  assert.equal(paths.workerDir, "/tmp/agbus/workers/pid-123");
  assert.equal(paths.inboxDir, "/tmp/agbus/workers/pid-123/inbox");
  assert.equal(paths.statusPath, "/tmp/agbus/workers/pid-123/status.json");
});

test("selectBridgeWorker picks the worker whose workspace roots match cwd", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "antigravity-bus-workers-"));
  const workerA = getBridgePaths(tempDir, "worker-a");
  const workerB = getBridgePaths(tempDir, "worker-b");
  await fs.promises.mkdir(path.dirname(workerA.statusPath), { recursive: true });
  await fs.promises.mkdir(path.dirname(workerB.statusPath), { recursive: true });
  await fs.promises.writeFile(workerA.statusPath, JSON.stringify({ workspaceRoots: ["/Users/demo/skin-saas"] }));
  await fs.promises.writeFile(workerB.statusPath, JSON.stringify({ workspaceRoots: ["/Users/demo/antigravity-bus"] }));

  const workers = readBridgeWorkerStatuses(tempDir);
  assert.equal(workers.length, 2);
  assert.equal(selectBridgeWorker(tempDir, "/Users/demo/antigravity-bus")?.workerId, "worker-b");
  assert.equal(selectBridgeWorker(tempDir, "/Users/demo/missing"), null);
});

test("selectBridgeWorker ignores dead pid workers", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "antigravity-bus-workers-dead-"));
  const deadWorker = getBridgePaths(tempDir, "pid-999999");
  const liveWorker = getBridgePaths(tempDir, "worker-live");
  await fs.promises.mkdir(path.dirname(deadWorker.statusPath), { recursive: true });
  await fs.promises.mkdir(path.dirname(liveWorker.statusPath), { recursive: true });
  const updatedAt = new Date().toISOString();
  await fs.promises.writeFile(
    deadWorker.statusPath,
    JSON.stringify({ updatedAt, workspaceRoots: ["/Users/demo/skin-saas"] })
  );
  await fs.promises.writeFile(
    liveWorker.statusPath,
    JSON.stringify({ updatedAt, workspaceRoots: ["/Users/demo/skin-saas"] })
  );

  const selected = selectBridgeWorker(tempDir, "/Users/demo/skin-saas");
  assert.equal(selected?.workerId, "worker-live");
});

test("dispatchBridgeRequest returns no_live_worker when only stale matching workers remain", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "antigravity-bus-dispatch-"));
  const deadWorker = getBridgePaths(tempDir, "pid-999999");
  await fs.promises.mkdir(path.dirname(deadWorker.statusPath), { recursive: true });
  await fs.promises.writeFile(
    deadWorker.statusPath,
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      workspaceRoots: ["/Users/demo/skin-saas"],
    })
  );

  const result = await dispatchBridgeRequest({
    bridgeDir: tempDir,
    cwd: "/Users/demo/skin-saas",
    prompt: "ping",
    mode: "agent",
    addFiles: [],
    profile: null,
    waitMs: 50,
    waitForCompletion: false,
  });

  assert.equal(result.responded, false);
  assert.equal(result.requestPath, null);
  assert.equal(result.bridgeError?.code, "no_live_worker");
});

test("writeBridgeRequest creates inbox file and waitForBridgeResponse reads outbox response", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "antigravity-bus-bridge-"));
  const payload = {
    id: "bridge-test-1",
    cwd: "/Users/demo/repo",
    prompt: "ping",
  };

  const writeResult = writeBridgeRequest(tempDir, payload);
  const paths = getBridgePaths(tempDir);
  const requestContent = JSON.parse(await fs.promises.readFile(writeResult.filePath, "utf8"));

  assert.deepEqual(requestContent, payload);
  assert.equal(writeResult.inboxDir, paths.inboxDir);

  const responseBody = { id: payload.id, ok: true, commandUsed: "antigravity.sendPromptToAgentPanel" };
  await fs.promises.writeFile(path.join(paths.outboxDir, `${payload.id}.json`), JSON.stringify(responseBody), "utf8");

  const waited = await waitForBridgeResponse(tempDir, payload.id, 1000);
  assert.deepEqual(waited.response, responseBody);
});

test("encodeIpcParts round-trips channel payloads", () => {
  const encoded = encodeIpcParts([100, 7, "launch", "start"], [
    { _: ["/Users/demo/skin-saas"], chat: { _: ["做到哪里"] } },
    { PATH: "/usr/bin" },
  ]);

  assert.deepEqual(decodeIpcParts(encoded), {
    first: [100, 7, "launch", "start"],
    second: [
      { _: ["/Users/demo/skin-saas"], chat: { _: ["做到哪里"] } },
      { PATH: "/usr/bin" },
    ],
  });
});

test("frameIpcMessage writes the expected 13-byte IPC envelope", () => {
  const payload = Buffer.from("hello");
  const framed = frameIpcMessage(payload, 1, 11, 3);

  assert.equal(framed.readUInt8(0), 1);
  assert.equal(framed.readUInt32BE(1), 11);
  assert.equal(framed.readUInt32BE(5), 3);
  assert.equal(framed.readUInt32BE(9), 5);
  assert.equal(framed.slice(13).toString("utf8"), "hello");
});

test("findMainIpcHandle returns the latest main socket when present", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "antigravity-bus-ipc-"));
  const first = path.join(tempDir, "1.09-main.sock");
  const second = path.join(tempDir, "1.10-main.sock");
  await fs.promises.writeFile(first, "");
  await fs.promises.writeFile(second, "");

  assert.equal(findMainIpcHandle(tempDir), second);
});

test("findWorkspaceInstance prefers exact workspace matches by default", () => {
  const instances = [
    { workspaceId: "file_Users_demo_other", supportsLsp: true, pid: 1 },
    { workspaceId: "file_Users_demo_target", supportsLsp: true, pid: 2 },
  ];

  assert.deepEqual(
    findWorkspaceInstance(instances, "file_Users_demo_target"),
    instances[1]
  );
  assert.equal(findWorkspaceInstance(instances, "file_Users_demo_missing"), null);
});

test("findWorkspaceInstance only falls back to any LSP instance when strict mode is disabled", () => {
  const instances = [
    { workspaceId: "file_Users_demo_other", supportsLsp: true, pid: 1 },
  ];

  assert.equal(findWorkspaceInstance(instances, "file_Users_demo_missing"), null);
  assert.deepEqual(
    findWorkspaceInstance(instances, "file_Users_demo_missing", { strict: false }),
    instances[0]
  );
});

test("parseArgs normalizes help and version flags", () => {
  assert.equal(parseArgs(["--help"]).command, "help");
  assert.equal(parseArgs(["-h"]).command, "help");
  assert.equal(parseArgs(["--version"]).command, "version");
  assert.equal(parseArgs(["-v"]).command, "version");
});

test("parseInstanceLine extracts Antigravity language server metadata", () => {
  const parsed = parseInstanceLine(
    "1099 /Applications/Antigravity.app/Contents/MacOS/language_server_macos_arm --enable_lsp --csrf_token abc123 --extension_server_port 49514 --extension_server_csrf_token ext456 --workspace_id file_Users_demo_repo --app_data_dir /Users/demo/Library/Application Support/Antigravity"
  );

  assert.deepEqual(parsed, {
    pid: 1099,
    command:
      "/Applications/Antigravity.app/Contents/MacOS/language_server_macos_arm --enable_lsp --csrf_token abc123 --extension_server_port 49514 --extension_server_csrf_token ext456 --workspace_id file_Users_demo_repo --app_data_dir /Users/demo/Library/Application Support/Antigravity",
    csrfToken: "abc123",
    extensionServerPort: 49514,
    extensionServerCsrfToken: "ext456",
    workspaceId: "file_Users_demo_repo",
    cloudCodeEndpoint: null,
    appDataDir: "/Users/demo/Library/Application Support/Antigravity",
    supportsLsp: true,
  });
});

test("extractPrintableStrings keeps long printable runs only", () => {
  const buffer = Buffer.from([0, 65, 66, 67, 68, 69, 70, 71, 72, 0, 1, 120, 121, 122, 0]);
  const result = extractPrintableStrings(buffer, 4);

  assert.deepEqual(result, [
    {
      offset: 1,
      value: "ABCDEFGH",
    },
  ]);
});

test("parseConnectJsonResponse decodes framed JSON payloads", () => {
  const framed = frameConnectJson({
    initialState: {
      data: {
        "1": {
          value: "GiQyNTMyZGNjYi1mZjJiLTQzOWYtOGZhYS02ZTJlYWZmOTI4Nzg=",
        },
      },
    },
  });

  assert.deepEqual(parseConnectJsonResponse(framed), {
    initialState: {
      data: {
        "1": {
          value: "GiQyNTMyZGNjYi1mZjJiLTQzOWYtOGZhYS02ZTJlYWZmOTI4Nzg=",
        },
      },
    },
  });
});

test("extractActiveCascadeIds finds UUIDs inside protobuf-backed topic payloads", () => {
  const topicPayload = {
    initialState: {
      data: {
        "1": {
          value: "GiQyNTMyZGNjYi1mZjJiLTQzOWYtOGZhYS02ZTJlYWZmOTI4Nzg=",
        },
      },
    },
  };

  assert.deepEqual(extractActiveCascadeIds(topicPayload), [
    "2532dccb-ff2b-439f-8faa-6e2eaff92878",
  ]);
});

test("deriveSupervisorState prefers waiting signals over active execution", () => {
  assert.equal(
    deriveSupervisorState({
      activeCascadeIds: ["2532dccb-ff2b-439f-8faa-6e2eaff92878"],
      trajectorySignals: ["BlockedOnUser", "ShouldAutoProceed"],
      tasks: [],
    }),
    "waiting"
  );

  assert.equal(
    deriveSupervisorState({
      activeCascadeIds: ["2532dccb-ff2b-439f-8faa-6e2eaff92878"],
      trajectorySignals: [],
      tasks: [],
    }),
    "running"
  );

  assert.equal(
    deriveSupervisorState({
      activeCascadeIds: [],
      trajectorySignals: [],
      tasks: [{ statusGuess: "completed" }],
    }),
    "done"
  );
});

test("evaluateAcceptanceChecks fails when skin-saas only ships status UI without a backend chain", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "antigravity-bus-acceptance-fail-"));
  const detailDir = path.join(tempDir, "apps", "admin", "src", "app", "appointments", "[id]");
  const apiDir = path.join(tempDir, "apps", "api", "src", "appointments");

  await fs.promises.mkdir(detailDir, { recursive: true });
  await fs.promises.mkdir(apiDir, { recursive: true });

  await fs.promises.writeFile(
    path.join(detailDir, "page.tsx"),
    `
      export default function AppointmentDetailPage() {
        const label = "更新状态";
        return <button>{label}</button>;
      }
    `,
    "utf8"
  );
  await fs.promises.writeFile(
    path.join(apiDir, "appointments.controller.ts"),
    `
      @Get(":appointmentId")
      getOne() {}
    `,
    "utf8"
  );
  await fs.promises.writeFile(
    path.join(apiDir, "appointments.service.ts"),
    `
      export class AppointmentsService {
        getOne() {}
      }
    `,
    "utf8"
  );

  const acceptance = evaluateAcceptanceChecks(tempDir, [
    {
      trajectoryId: "t-1",
      statusGuess: "written",
    },
  ]);

  assert.equal(acceptance.state, "failed");
  assert.equal(acceptance.failedChecks.length, 1);
  assert.match(acceptance.failedChecks[0].reasons.join(" "), /status-update route/i);
});

test("evaluateAcceptanceChecks passes when skin-saas wires frontend and backend status updates", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "antigravity-bus-acceptance-pass-"));
  const detailDir = path.join(tempDir, "apps", "admin", "src", "app", "appointments", "[id]");
  const apiDir = path.join(tempDir, "apps", "api", "src", "appointments");

  await fs.promises.mkdir(detailDir, { recursive: true });
  await fs.promises.mkdir(apiDir, { recursive: true });

  await fs.promises.writeFile(
    path.join(detailDir, "page.tsx"),
    `
      export default function AppointmentDetailPage() {
        async function handleUpdateStatus() {
          await fetch("/api/appointments/1/status", { method: "PATCH" });
        }
        return <button onClick={handleUpdateStatus}>更新状态</button>;
      }
    `,
    "utf8"
  );
  await fs.promises.writeFile(
    path.join(apiDir, "appointments.controller.ts"),
    `
      @Patch(":appointmentId/status")
      updateStatus() {}
    `,
    "utf8"
  );
  await fs.promises.writeFile(
    path.join(apiDir, "appointments.service.ts"),
    `
      export class AppointmentsService {
        updateStatus() {
          return {};
        }
      }
    `,
    "utf8"
  );

  const acceptance = evaluateAcceptanceChecks(tempDir, [
    {
      trajectoryId: "t-2",
      statusGuess: "written",
    },
  ]);

  assert.equal(acceptance.state, "passed");
  assert.equal(acceptance.failedChecks.length, 0);
});

test("evaluateAcceptanceChecks can fail from dirty relevant files even when manager tasks are empty", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "antigravity-bus-acceptance-dirty-"));
  const detailDir = path.join(tempDir, "apps", "admin", "src", "app", "appointments", "[id]");
  const apiDir = path.join(tempDir, "apps", "api", "src", "appointments");

  await fs.promises.mkdir(detailDir, { recursive: true });
  await fs.promises.mkdir(apiDir, { recursive: true });

  await fs.promises.writeFile(
    path.join(detailDir, "page.tsx"),
    `
      export default function AppointmentDetailPage() {
        const label = "更新状态";
        return <button>{label}</button>;
      }
    `,
    "utf8"
  );
  await fs.promises.writeFile(path.join(apiDir, "appointments.controller.ts"), "export class C {}", "utf8");
  await fs.promises.writeFile(path.join(apiDir, "appointments.service.ts"), "export class S {}", "utf8");

  spawnSync("git", ["init"], { cwd: tempDir, encoding: "utf8" });
  spawnSync("git", ["config", "user.name", "Codex Test"], { cwd: tempDir, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "codex@example.com"], { cwd: tempDir, encoding: "utf8" });
  spawnSync("git", ["add", "."], { cwd: tempDir, encoding: "utf8" });
  spawnSync("git", ["commit", "-m", "init"], { cwd: tempDir, encoding: "utf8" });

  await fs.promises.writeFile(
    path.join(detailDir, "page.tsx"),
    `
      export default function AppointmentDetailPage() {
        return <button>更新状态</button>;
      }
    `,
    "utf8"
  );

  const acceptance = evaluateAcceptanceChecks(tempDir, []);

  assert.equal(acceptance.state, "failed");
  assert.equal(acceptance.taskOutputDetected, false);
  assert.equal(acceptance.dirtyRelevantFiles.length, 1);
  assert.match(acceptance.dirtyRelevantFiles[0], /\[id\]\/page\.tsx$/);
});

test("buildRemediationPrompt turns failed acceptance into a hard corrective prompt", () => {
  const prompt = buildRemediationPrompt({
    cwd: "/Users/demo/skin-saas",
    supervisor: {
      acceptance: {
        state: "failed",
        dirtyRelevantFiles: ["/Users/demo/skin-saas/apps/admin/src/app/appointments/[id]/page.tsx"],
        failedChecks: [
          {
            label: "Skin SaaS appointment status update chain",
            reasons: ["Appointments controller does not expose a status-update route."],
          },
        ],
      },
    },
  });

  assert.match(prompt, /does not pass supervisor acceptance/i);
  assert.match(prompt, /Appointments controller does not expose a status-update route/i);
  assert.match(prompt, /Do not stop at UI changes/i);
  assert.match(prompt, /When finished, summarize the exact files you changed/i);
});

test("readArtifactPreview infers checklist progress from markdown artifacts", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "antigravity-bus-preview-"));
  const filePath = path.join(tempDir, "task.md");

  await fs.promises.writeFile(
    filePath,
    "# Membership flow\n\n- [x] Model updated\n- [ ] Admin page refresh\n- [ ] Appointment detail page\n",
    "utf8"
  );

  const preview = readArtifactPreview(filePath);

  assert.equal(preview.statusGuess, "in_progress");
  assert.equal(preview.checked, 1);
  assert.equal(preview.unchecked, 2);
  assert.match(preview.preview, /Membership flow/);
});

test("writeSnapshotFiles writes latest output and appends events only when payload changes", async () => {
  const outDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "antigravity-bus-snapshot-"));
  const snapshot = {
    generatedAt: "2026-04-08T00:00:00.000Z",
    cwd: "/tmp/workspace",
    activeWorkspaceId: "file_tmp_workspace",
    antigravity: { running: true, instances: [] },
    workspaceInstance: null,
    extensionServer: { available: false, healthy: false, state: "idle", activeCascadeIds: [], topicSignals: [] },
    supervisor: {
      state: "idle",
      activeCascadeIds: [],
      healthy: false,
      acceptance: { state: "unknown", failedChecks: [] },
    },
    userStatusAvailable: true,
    authStatusAvailable: true,
    recentLogSignals: [],
    tasks: [],
  };

  const firstWrite = writeSnapshotFiles(outDir, snapshot);
  const secondWrite = writeSnapshotFiles(outDir, snapshot);
  const thirdWrite = writeSnapshotFiles(outDir, { ...snapshot, tasks: [{ trajectoryId: "t-1" }] });

  assert.equal(firstWrite.changed, true);
  assert.equal(secondWrite.changed, false);
  assert.equal(thirdWrite.changed, true);

  const latest = JSON.parse(await fs.promises.readFile(path.join(outDir, "latest.json"), "utf8"));
  const events = (await fs.promises.readFile(path.join(outDir, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  assert.equal(latest.tasks.length, 1);
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((entry) => ({
      taskCount: entry.taskCount,
      supervisorState: entry.supervisorState,
      acceptanceState: entry.acceptanceState,
    })),
    [
      { taskCount: 0, supervisorState: "idle", acceptanceState: "unknown" },
      { taskCount: 1, supervisorState: "idle", acceptanceState: "unknown" },
    ]
  );
});

test("main prints the package version for version requests", async () => {
  const originalLog = console.log;
  const lines = [];

  console.log = (...args) => {
    lines.push(args.join(" "));
  };

  try {
    await main(["--version"]);
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(lines, [PACKAGE_VERSION]);
});

test("cli entrypoint works when invoked through a symlinked binary path", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "antigravity-bus-bin-"));
  const symlinkPath = path.join(tempDir, "antigravity-bus");
  await fs.promises.symlink(
    path.resolve("/Users/caozheng/cowork-flie/antigravity-bus/src/index.mjs"),
    symlinkPath
  );

  const result = spawnSync(process.execPath, [symlinkPath, "--version"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), PACKAGE_VERSION);
});
