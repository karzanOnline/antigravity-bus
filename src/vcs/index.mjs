import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function listDirtyFiles(cwd, deps) {
  const output = deps.run("git", ["-C", cwd, "status", "--short", "--untracked-files=all"]);
  if (!output) {
    return [];
  }

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[A-Z?]{1,2}\s+/, ""))
    .map((filePath) => path.resolve(cwd, filePath));
}

export function hashWorkspaceFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return null;
    }

    const contents = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(contents).digest("hex");
  } catch {
    return null;
  }
}

export function captureWorkspaceBaseline(cwd, deps) {
  const dirtyFiles = deps.listDirtyFiles(cwd);
  return {
    cwd: path.resolve(cwd),
    capturedAt: new Date().toISOString(),
    dirtyFiles,
    dirtyFileHashes: Object.fromEntries(
      dirtyFiles.map((filePath) => [filePath, deps.hashWorkspaceFile(filePath)])
    ),
  };
}

export function diffWorkspaceAgainstBaseline(baseline, cwd, maxFiles = 20, deps) {
  const currentDirtyFiles = deps.listDirtyFiles(cwd);
  const baselineDirtyFiles = Array.isArray(baseline?.dirtyFiles) ? baseline.dirtyFiles : [];
  const baselineDirtySet = new Set(baselineDirtyFiles);
  const currentDirtySet = new Set(currentDirtyFiles);
  const newDirtyFiles = currentDirtyFiles.filter((filePath) => !baselineDirtySet.has(filePath));
  const resolvedDirtyFiles = baselineDirtyFiles.filter((filePath) => !currentDirtySet.has(filePath));
  const changedDirtyFiles = currentDirtyFiles.filter((filePath) => {
    if (!baselineDirtySet.has(filePath)) {
      return false;
    }

    return deps.hashWorkspaceFile(filePath) !== (baseline?.dirtyFileHashes?.[filePath] ?? null);
  });
  const changedFiles = [...newDirtyFiles, ...changedDirtyFiles];

  return {
    cwd: path.resolve(cwd),
    producedChanges: changedFiles.length > 0,
    changedFileCount: changedFiles.length,
    changedFiles: changedFiles.slice(0, maxFiles),
    truncatedChangedFiles: changedFiles.length > maxFiles,
    newDirtyFiles: newDirtyFiles.slice(0, maxFiles),
    changedDirtyFiles: changedDirtyFiles.slice(0, maxFiles),
    resolvedDirtyFiles: resolvedDirtyFiles.slice(0, maxFiles),
  };
}

export function summarizeWorkspaceChanges(cwd, maxFiles = 20, deps) {
  const dirtyFiles = deps.listDirtyFiles(cwd);
  const diffStat = deps.run("git", ["-C", cwd, "diff", "--stat", "--no-ext-diff"]);
  const stagedDiffStat = deps.run("git", ["-C", cwd, "diff", "--cached", "--stat", "--no-ext-diff"]);

  return {
    cwd: path.resolve(cwd),
    dirtyFileCount: dirtyFiles.length,
    dirtyFiles: dirtyFiles.slice(0, maxFiles),
    truncatedDirtyFiles: dirtyFiles.length > maxFiles,
    diffStat: diffStat || null,
    stagedDiffStat: stagedDiffStat || null,
  };
}
