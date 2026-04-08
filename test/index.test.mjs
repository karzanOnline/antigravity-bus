import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  PACKAGE_VERSION,
  extractPrintableStrings,
  main,
  parseArgs,
  parseInstanceLine,
  readArtifactPreview,
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
    events.map((entry) => entry.taskCount),
    [0, 1]
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
