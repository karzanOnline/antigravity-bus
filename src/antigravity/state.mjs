import crypto from "node:crypto";
import path from "node:path";

export function normalizeWorkspaceId(cwd) {
  return `file_${cwd.replace(/^\/+/, "").replaceAll(/[/.:-]/g, "_")}`;
}

export function deriveProfileName(cwd) {
  const baseName = path.basename(cwd).replaceAll(/[^a-zA-Z0-9_-]+/g, "-") || "workspace";
  const suffix = crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 8);
  return `agbus-${baseName}-${suffix}`;
}

export function readStateValue(stateDbPath, key, deps) {
  if (!deps.existsSync(stateDbPath)) {
    return null;
  }

  const sql = `select value from ItemTable where key='${key.replaceAll("'", "''")}';`;
  const value = deps.run("sqlite3", [stateDbPath, sql]);
  return value || null;
}

export function extractPrintableStrings(buffer, minLength = 8) {
  const matches = [];
  let start = -1;

  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index];
    const printable = byte >= 32 && byte <= 126;
    if (printable) {
      if (start === -1) {
        start = index;
      }
      continue;
    }

    if (start !== -1 && index - start >= minLength) {
      matches.push({
        offset: start,
        value: buffer.toString("utf8", start, index),
      });
    }
    start = -1;
  }

  if (start !== -1 && buffer.length - start >= minLength) {
    matches.push({
      offset: start,
      value: buffer.toString("utf8", start),
    });
  }

  return matches;
}

export function decodeBase64Strings(key, deps) {
  const raw = deps.readStateValue(key);
  if (!raw) {
    return [];
  }

  try {
    const decoded = Buffer.from(raw, "base64");
    return deps.extractPrintableStrings(decoded);
  } catch {
    return [];
  }
}

export function listSidebarWorkspacePaths(deps) {
  return deps
    .decodeBase64Strings("antigravityUnifiedStateSync.sidebarWorkspaces")
    .map((entry) => entry.value)
    .filter((value) => value.includes("file:///"))
    .map((value) => value.slice(value.indexOf("file:///")))
    .map(deps.fileUriToPath)
    .filter(Boolean);
}
