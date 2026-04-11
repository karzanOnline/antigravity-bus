export function run(command, args, options = {}, deps) {
  try {
    return deps
      .execFileSync(command, args, {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
        ...options,
      })
      .trim();
  } catch {
    return "";
  }
}

export function ensureDir(dirPath, deps) {
  deps.mkdirSync(dirPath, { recursive: true });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
