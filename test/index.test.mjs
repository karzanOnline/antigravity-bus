import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  buildDispatchArgs,
  createBridgeRequestPayload,
  deriveDispatchVerification,
  buildRemediationPrompt,
  decodeIpcParts,
  encodeIpcParts,
  PACKAGE_VERSION,
  deriveSupervisorState,
  evaluateAcceptanceChecks,
  extractPrintableStrings,
  extractActiveCascadeIds,
  findMainIpcHandle,
  frameIpcMessage,
  frameConnectJson,
  getBridgePaths,
  main,
  parseArgs,
  parseConnectJsonResponse,
  parseInstanceLine,
  readArtifactPreview,
  waitForBridgeResponse,
  writeBridgeRequest,
  writeSnapshotFiles,
} from "../src/index.mjs";

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
  });

  assert.match(payload.id, /^bridge-/);
  assert.equal(payload.cwd, "/Users/demo/repo");
  assert.equal(payload.prompt, "hello bridge");
  assert.equal(payload.commandCandidates[0], "antigravity.sendPromptToAgentPanel");
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
