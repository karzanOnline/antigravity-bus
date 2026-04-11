import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseArgs } from "../src/cli/args.mjs";
import {
  buildDispatchArgs,
  deriveDispatchVerification,
} from "../src/antigravity/workspace-dispatch.mjs";
import {
  getBridgePaths,
  selectBridgeWorker,
} from "../src/bridge/index.mjs";
import {
  captureWorkspaceBaseline,
  diffWorkspaceAgainstBaseline,
} from "../src/vcs/index.mjs";
import {
  buildExtensionServerSnapshot,
  deriveSupervisorState,
} from "../src/snapshot/extension-server.mjs";
import { evaluateAcceptanceChecks } from "../src/acceptance/index.mjs";
import {
  createRunRecord,
  readRunLatest,
  recordRunEvent,
} from "../src/runs/index.mjs";

test("cli args module parses dispatch defaults directly", () => {
  const options = parseArgs(["dispatch", "--cwd", "examples", "--prompt", "ping"], {
    cwd: () => "/tmp/default",
    defaultBridgeDir: "/tmp/bridge",
    defaultStoreDir: "/tmp/store",
    resolvePath: (value) => `/abs/${value}`,
  });

  assert.equal(options.command, "dispatch");
  assert.equal(options.cwd, "/abs/examples");
  assert.equal(options.bridgeDir, "/tmp/bridge");
  assert.equal(options.outDir, "/tmp/store");
});

test("workspace dispatch helpers stay usable without the facade", () => {
  assert.deepEqual(
    buildDispatchArgs({
      cwd: "/Users/demo/project",
      prompt: "ship it",
      mode: "agent",
      profile: "agbus-demo",
      addFiles: ["/Users/demo/project/README.md"],
    }),
    {
      _: ["/Users/demo/project"],
      "reuse-window": true,
      profile: "agbus-demo",
      chat: {
        _: ["ship it"],
        "reuse-window": true,
        mode: "agent",
        profile: "agbus-demo",
        "add-file": ["/Users/demo/project/README.md"],
      },
    }
  );

  assert.equal(
    deriveDispatchVerification({
      waitForNewCascade: false,
      workspaceReady: true,
      sidebarIncludesWorkspace: false,
      changedTrajectories: [],
      newCascadeIds: [],
    }).state,
    "confirmed_existing_workspace_only"
  );
});

test("bridge module routes worker paths directly", async () => {
  const paths = getBridgePaths("/tmp/agbus", "worker-123");
  assert.equal(paths.inboxDir, "/tmp/agbus/workers/worker-123/inbox");

  const selected = selectBridgeWorker("/tmp/agbus-missing", "/Users/demo/project");
  assert.equal(selected, null);
});

test("vcs helpers detect changes relative to a dirty baseline", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agbus-vcs-"));
  fs.mkdirSync(path.join(cwd, ".git"));
  const tracked = path.join(cwd, "tracked.txt");
  fs.writeFileSync(tracked, "one\n", "utf8");

  const baseline = captureWorkspaceBaseline(cwd, {
    listDirtyFiles: () => [tracked],
    hashWorkspaceFile: (filePath) => fs.readFileSync(filePath, "utf8"),
  });

  fs.writeFileSync(tracked, "two\n", "utf8");
  const delta = diffWorkspaceAgainstBaseline(
    baseline,
    cwd,
    20,
    {
      listDirtyFiles: () => [tracked],
      hashWorkspaceFile: (filePath) => fs.readFileSync(filePath, "utf8"),
    }
  );

  assert.equal(delta.producedChanges, true);
  assert.deepEqual(delta.changedDirtyFiles, [tracked]);
});

test("extension-server module exposes direct supervisor semantics", async () => {
  assert.equal(
    deriveSupervisorState({
      activeCascadeIds: ["cascade-1"],
      trajectorySignals: ["BlockedOnUser"],
      tasks: [],
    }),
    "waiting"
  );

  const snapshot = await buildExtensionServerSnapshot(
    {
      extensionServerPort: 57000,
      extensionServerCsrfToken: "csrf",
    },
    [{ statusGuess: "completed" }],
    {
      extractPrintableStrings: (buffer) => [{ value: buffer.toString("utf8") }],
      postJson: async () => ({ ok: false }),
      subscribeTopicInitialState: async (_port, _token, topic) => {
        if (topic === "uss-activeCascadeIds") {
          return {
            initialState: {
              data: {
                one: {
                  value: Buffer.from("2532dccb-ff2b-439f-8faa-6e2eaff92878").toString("base64"),
                },
              },
            },
          };
        }

        return {
          initialState: {
            data: {
              one: {
                value: Buffer.from("BlockedOnUser").toString("base64"),
              },
            },
          },
        };
      },
      TOPICS: {
        activeCascadeIds: "uss-activeCascadeIds",
        trajectorySummaries: "trajectorySummaries",
        userStatus: "uss-userStatus",
        machineInfos: "uss-lsClientMachineInfos",
      },
    }
  );

  assert.equal(snapshot.healthy, false);
  assert.equal(snapshot.state, "waiting");
  assert.equal(snapshot.activeCascadeIds.length, 1);
});

test("acceptance module can be exercised directly with injected deps", () => {
  const result = evaluateAcceptanceChecks("/Users/demo/skin-saas", [{ statusGuess: "written" }], {
    listDirtyFiles: () => ["/Users/demo/skin-saas/apps/admin/src/app/appointments/[id]/page.tsx"],
    evaluateSkinSaasAppointmentStatusChain: () => ({
      id: "skin-saas.appointment-status-chain",
      label: "Skin SaaS appointment status update chain",
      applicable: true,
      passed: false,
      failed: true,
      reasons: ["Appointments controller does not expose a status-update route."],
      evidence: {
        detailPagePath: "/Users/demo/skin-saas/apps/admin/src/app/appointments/[id]/page.tsx",
      },
    }),
  });

  assert.equal(result.state, "failed");
  assert.equal(result.failedChecks.length, 1);
});

test("run store persists latest state and append-only events", () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "agbus-runs-"));
  const ensureDir = (dirPath) => fs.mkdirSync(dirPath, { recursive: true });
  const created = createRunRecord(
    outDir,
    {
      runId: "run-123",
      cwd: "/Users/demo/repo",
      prompt: "Continue the task",
      profile: "demo-profile",
      bridgeDir: "/tmp/bridge",
      waitMs: 9000,
      autoRemediate: true,
      maxRemediations: 2,
      supervisorLoopTimeoutMs: 60000,
      workspaceChanges: {
        cwd: "/Users/demo/repo",
        dirtyFileCount: 0,
        dirtyFiles: [],
      },
    },
    ensureDir
  );

  const updated = recordRunEvent(
    outDir,
    created.runId,
    {
      type: "bridge.requested",
      data: { requestId: "bridge-1" },
      patch: { status: "dispatching", requestId: "bridge-1" },
    },
    ensureDir
  );

  const latest = readRunLatest(outDir, "run-123");
  const eventsPath = path.join(outDir, "runs", "run-123", "events.jsonl");
  const events = fs
    .readFileSync(eventsPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.equal(updated.status, "dispatching");
  assert.equal(created.latest.autoRemediate, true);
  assert.equal(created.latest.maxRemediations, 2);
  assert.equal(created.latest.profile, "demo-profile");
  assert.equal(latest.requestId, "bridge-1");
  assert.equal(latest.eventCount, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "bridge.requested");
});
