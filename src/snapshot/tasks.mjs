import fs from "node:fs";
import path from "node:path";

export function fileUriToPath(fileUri) {
  if (!fileUri.startsWith("file://")) {
    return null;
  }

  try {
    return decodeURIComponent(fileUri.replace("file://", ""));
  } catch {
    return null;
  }
}

export function readArtifactPreview(filePath) {
  try {
    const extension = path.extname(filePath).toLowerCase();
    const textLikeExtensions = new Set([
      ".md",
      ".txt",
      ".json",
      ".yml",
      ".yaml",
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
    ]);
    if (!textLikeExtensions.has(extension)) {
      return {
        preview: null,
        statusGuess: "artifact",
        checked: 0,
        unchecked: 0,
      };
    }

    const content = fs.readFileSync(filePath, "utf8");
    const lines = content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const preview = lines.slice(0, 4).join(" ").slice(0, 240);

    const checked = (content.match(/- \[x\]/gi) ?? []).length;
    const unchecked = (content.match(/- \[ \]/g) ?? []).length;
    let statusGuess = "unknown";
    if (unchecked > 0) {
      statusGuess = checked > 0 ? "in_progress" : "pending";
    } else if (checked > 0) {
      statusGuess = "completed";
    } else if (content.length > 0) {
      statusGuess = "written";
    }

    return {
      preview,
      statusGuess,
      checked,
      unchecked,
    };
  } catch {
    return {
      preview: null,
      statusGuess: "missing",
      checked: 0,
      unchecked: 0,
    };
  }
}

export function listArtifacts(decodeBase64Strings) {
  const artifactStrings = decodeBase64Strings("antigravityUnifiedStateSync.artifactReview");
  const artifacts = [];

  for (let index = 0; index < artifactStrings.length; index += 1) {
    const current = artifactStrings[index]?.value ?? "";
    if (!current.startsWith("file:///")) {
      continue;
    }

    const filePath = fileUriToPath(current);
    if (!filePath) {
      continue;
    }

    const match = filePath.match(/\/brain\/([0-9a-f-]+)\/([^/]+)$/i);
    if (!match) {
      continue;
    }

    const [, trajectoryId, fileName] = match;
    const metadataString = artifactStrings[index + 1]?.value ?? "";
    let metadata = null;
    if (metadataString.startsWith("{")) {
      try {
        metadata = JSON.parse(metadataString);
      } catch {
        metadata = null;
      }
    }

    const stats = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
    const preview = readArtifactPreview(filePath);

    artifacts.push({
      trajectoryId,
      fileName,
      fileUri: current,
      filePath,
      exists: Boolean(stats),
      updatedAt: stats?.mtime.toISOString() ?? null,
      preview: preview.preview,
      statusGuess: preview.statusGuess,
      checklist: {
        checked: preview.checked,
        unchecked: preview.unchecked,
      },
      review: metadata,
    });
  }

  return artifacts.sort((left, right) => {
    const leftTime = left.updatedAt ? new Date(left.updatedAt).getTime() : 0;
    const rightTime = right.updatedAt ? new Date(right.updatedAt).getTime() : 0;
    return rightTime - leftTime;
  });
}

export function listTasksFromManagerState(decodeBase64Strings) {
  const stateStrings = decodeBase64Strings("jetskiStateSync.agentManagerInitState");
  const tasks = new Map();

  for (let index = 0; index < stateStrings.length; index += 1) {
    const current = stateStrings[index]?.value ?? "";
    const fileMatch = current.match(/^file:\/\/\/.*\/brain\/([0-9a-f-]+)\/([^/]+)$/i);

    if (fileMatch) {
      const [, trajectoryId, fileName] = fileMatch;
      const task = tasks.get(trajectoryId) ?? {
        trajectoryId,
        taskFile: null,
        workspaceHints: [],
        messages: [],
      };
      task.taskFile ??= current;
      task.files = Array.from(new Set([...(task.files ?? []), fileName]));
      tasks.set(trajectoryId, task);
      continue;
    }

    if (current.startsWith("file:///") && current.includes("/Users/")) {
      for (const task of tasks.values()) {
        if (task.workspaceHints.length >= 4) {
          continue;
        }
        if (!task.workspaceHints.includes(current)) {
          task.workspaceHints.push(current);
        }
      }
      continue;
    }

    if (
      current.length >= 12 &&
      /[A-Za-z\u4e00-\u9fff]/u.test(current) &&
      !/^[A-Za-z0-9+/=:_-]+$/.test(current) &&
      !current.startsWith("{")
    ) {
      const lastTask = Array.from(tasks.values()).at(-1);
      if (lastTask && lastTask.messages.length < 6) {
        lastTask.messages.push(current);
      }
    }
  }

  return Array.from(tasks.values());
}

export function readRecentLogSignals(logsDir) {
  if (!fs.existsSync(logsDir)) {
    return [];
  }

  const logDirs = fs
    .readdirSync(logsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const latestDir = logDirs.at(-1);
  if (!latestDir) {
    return [];
  }

  const logFile = path.join(logsDir, latestDir, "ls-main.log");
  if (!fs.existsSync(logFile)) {
    return [];
  }

  const content = fs.readFileSync(logFile, "utf8");
  return content
    .split("\n")
    .filter(
      (line) =>
        line.includes("planner_generator.go") ||
        line.includes("fetchAvailableModels") ||
        line.includes("loadCodeAssist") ||
        line.includes("TLS handshake error")
    )
    .slice(-12);
}

export function buildTaskSummaries(cwd, deps) {
  const { decodeBase64Strings, recentTaskWindowMs } = deps;
  const artifacts = listArtifacts(decodeBase64Strings);
  const managerTasks = listTasksFromManagerState(decodeBase64Strings);
  const groupedArtifacts = new Map();
  const now = Date.now();

  for (const artifact of artifacts) {
    const bucket = groupedArtifacts.get(artifact.trajectoryId) ?? [];
    bucket.push(artifact);
    groupedArtifacts.set(artifact.trajectoryId, bucket);
  }

  const result = [];

  for (const task of managerTasks) {
    const taskArtifacts = groupedArtifacts.get(task.trajectoryId) ?? [];
    const latestArtifact = taskArtifacts[0] ?? null;
    const workspaceHints = task.workspaceHints
      .map(fileUriToPath)
      .filter(Boolean)
      .filter((hint) => hint === cwd || hint.startsWith(cwd));
    const statusGuess =
      latestArtifact?.statusGuess ??
      (task.messages.some((message) => /complet|done|finished|完成/u.test(message))
        ? "completed"
        : "running");

    result.push({
      trajectoryId: task.trajectoryId,
      statusGuess,
      taskFile: task.taskFile ? fileUriToPath(task.taskFile) : null,
      workspaceHints,
      messages: task.messages,
      latestArtifact: latestArtifact
        ? {
            fileName: latestArtifact.fileName,
            filePath: latestArtifact.filePath,
            updatedAt: latestArtifact.updatedAt,
            preview: latestArtifact.preview,
          }
        : null,
      artifacts: taskArtifacts.slice(0, 8),
    });
  }

  return result
    .filter((task) => {
      if (task.workspaceHints.length > 0) {
        return true;
      }

      const latestTime = task.latestArtifact?.updatedAt
        ? new Date(task.latestArtifact.updatedAt).getTime()
        : 0;

      return latestTime > 0 && now - latestTime <= recentTaskWindowMs;
    })
    .sort((left, right) => {
      const leftTime = left.latestArtifact?.updatedAt
        ? new Date(left.latestArtifact.updatedAt).getTime()
        : 0;
      const rightTime = right.latestArtifact?.updatedAt
        ? new Date(right.latestArtifact.updatedAt).getTime()
        : 0;
      return rightTime - leftTime;
    });
}
