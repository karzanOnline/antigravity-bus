import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function writeSnapshotFiles(outDir, snapshot, ensureDir) {
  ensureDir(outDir);
  const latestPath = path.join(outDir, "latest.json");
  const eventsPath = path.join(outDir, "events.jsonl");

  const serialized = JSON.stringify(snapshot, null, 2);
  const hash = crypto.createHash("sha256").update(serialized).digest("hex");

  let previousHash = null;
  if (fs.existsSync(latestPath)) {
    previousHash = crypto
      .createHash("sha256")
      .update(fs.readFileSync(latestPath, "utf8"))
      .digest("hex");
  }

  fs.writeFileSync(latestPath, serialized);

  if (hash !== previousHash) {
    fs.appendFileSync(
      eventsPath,
      `${JSON.stringify({
        generatedAt: snapshot.generatedAt,
        hash,
        cwd: snapshot.cwd,
        taskCount: snapshot.tasks.length,
        supervisorState: snapshot.supervisor?.state ?? null,
        acceptanceState: snapshot.supervisor?.acceptance?.state ?? null,
      })}\n`
    );
  }

  return { latestPath, eventsPath, changed: hash !== previousHash };
}
