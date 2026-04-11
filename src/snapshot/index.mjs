export async function watch(options, deps) {
  const { buildSnapshot, ensureDir } = deps;
  ensureDir(options.outDir);
  for (;;) {
    const snapshot = await buildSnapshot(options);
    const writeResult = deps.writeSnapshotFiles(options.outDir, snapshot);
    process.stdout.write(
      `${JSON.stringify({
        generatedAt: snapshot.generatedAt,
        changed: writeResult.changed,
        taskCount: snapshot.tasks.length,
        latestPath: writeResult.latestPath,
        acceptanceState: snapshot.supervisor?.acceptance?.state ?? null,
      })}\n`
    );
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  }
}

export async function buildSnapshot(options, deps) {
  const baseSnapshot = deps.buildSnapshotSync(options);
  const extensionServer = await deps.buildExtensionServerSnapshot(
    baseSnapshot.workspaceInstance,
    baseSnapshot.tasks
  );
  const acceptance = deps.evaluateAcceptanceChecks(baseSnapshot.cwd, baseSnapshot.tasks);

  return {
    ...baseSnapshot,
    extensionServer,
    supervisor: {
      state: extensionServer.state,
      activeCascadeIds: extensionServer.activeCascadeIds,
      healthy: extensionServer.healthy,
      acceptance,
    },
  };
}

export function buildSnapshotSync(options, deps) {
  const instances = deps.discoverInstances();
  const logSignals = deps.readRecentLogSignals();
  const tasks = deps.buildTaskSummaries(options.cwd);
  const activeWorkspaceId = deps.normalizeWorkspaceId(options.cwd);
  const workspaceInstance = deps.findWorkspaceInstance(instances, activeWorkspaceId);

  return {
    generatedAt: new Date().toISOString(),
    cwd: options.cwd,
    activeWorkspaceId,
    antigravity: {
      appSupportDir: deps.appSupportDir,
      stateDbPath: deps.stateDbPath,
      running: instances.length > 0,
      instances,
    },
    workspaceInstance,
    userStatusAvailable: Boolean(
      deps.readStateValue("antigravityUnifiedStateSync.userStatus")
    ),
    authStatusAvailable: Boolean(deps.readStateValue("antigravityAuthStatus")),
    recentLogSignals: logSignals,
    tasks,
  };
}
