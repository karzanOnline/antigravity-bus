import path from "node:path";

export function listBrainActivity(rootDir, deps) {
  if (!deps.existsSync(rootDir)) {
    return [];
  }

  return deps
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "tempmediaStorage")
    .map((entry) => {
      const trajectoryId = entry.name;
      const trajectoryDir = path.join(rootDir, trajectoryId);
      const files = deps
        .readdirSync(trajectoryDir, { withFileTypes: true })
        .filter((child) => child.isFile())
        .map((child) => {
          const filePath = path.join(trajectoryDir, child.name);
          const stats = deps.statSync(filePath);
          return {
            fileName: child.name,
            filePath,
            updatedAtMs: stats.mtimeMs,
          };
        })
        .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
      const latestFile = files[0] ?? null;

      return {
        trajectoryId,
        trajectoryDir,
        updatedAtMs: latestFile?.updatedAtMs ?? deps.statSync(trajectoryDir).mtimeMs,
        latestFile,
      };
    })
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}

export function diffBrainActivity(before, after, sinceMs = 0) {
  const beforeMap = new Map(before.map((entry) => [entry.trajectoryId, entry.updatedAtMs]));

  return after.filter((entry) => {
    const previous = beforeMap.get(entry.trajectoryId) ?? 0;
    return entry.updatedAtMs > previous && entry.updatedAtMs >= sinceMs;
  });
}

export function runAntigravity(args, options = {}, deps) {
  try {
    deps.execFileSync("antigravity", args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      ...options,
    });
    return true;
  } catch {
    return false;
  }
}
