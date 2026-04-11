import path from "node:path";

export function buildDispatchArgs(options) {
  const args = {
    _: [path.resolve(options.cwd)],
    "reuse-window": true,
    chat: {
      _: [options.prompt],
      "reuse-window": true,
      mode: options.mode,
    },
  };

  if (options.profile) {
    args.profile = options.profile;
    args.chat.profile = options.profile;
  }

  if (options.addFiles?.length) {
    args.chat["add-file"] = options.addFiles.map((filePath) => path.resolve(filePath));
  }

  return args;
}

export function diffActiveCascadeIds(beforeIds, afterIds) {
  const previous = new Set(beforeIds ?? []);
  return (afterIds ?? []).filter((id) => !previous.has(id));
}

export function deriveDispatchVerification({
  waitForNewCascade,
  workspaceReady,
  sidebarIncludesWorkspace,
  changedTrajectories,
  newCascadeIds,
}) {
  // A newly observed cascade is the strongest proof that dispatch hit the intended agent flow.
  if (newCascadeIds.length > 0) {
    return {
      state: "confirmed_new_cascade",
      targetHit: true,
      reasons: ["Observed new active cascade IDs after dispatch."],
    };
  }

  if (waitForNewCascade) {
    return {
      state: "delivered_but_unconfirmed",
      targetHit: false,
      reasons: ["No new active cascade IDs were observed before the dispatch timeout expired."],
    };
  }

  if (workspaceReady || sidebarIncludesWorkspace || changedTrajectories.length > 0) {
    return {
      state: "confirmed_existing_workspace_only",
      targetHit: true,
      reasons: ["Dispatch hit a ready workspace, but no new cascade was observed."],
    };
  }

  return {
    state: "delivered_but_unconfirmed",
    targetHit: false,
    reasons: ["Dispatch returned without new cascade, workspace, or trajectory evidence."],
  };
}

export async function waitForWorkspaceInstance(cwd, timeoutMs = 8000, deps) {
  const workspaceId = deps.normalizeWorkspaceId(cwd);
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const instance = deps.findWorkspaceInstance(deps.discoverInstances(), workspaceId);
    if (instance?.workspaceId === workspaceId) {
      return instance;
    }
    await deps.sleep(400);
  }

  return null;
}

export async function dispatchToWorkspace(options, deps) {
  const cwd = path.resolve(options.cwd);
  const profile = options.profile || deps.deriveProfileName(cwd);
  const prompt = options.prompt;
  const beforeBrain = deps.listBrainActivity();
  const dispatchStartedAt = Date.now();
  const workspaceId = deps.normalizeWorkspaceId(cwd);
  const socketPath = deps.findMainIpcHandle();
  if (!socketPath) {
    throw new Error("Could not find Antigravity main IPC socket.");
  }

  const beforeInstance = deps.findWorkspaceInstance(deps.discoverInstances(), workspaceId);
  const beforeExtensionServer = await deps.buildExtensionServerSnapshot(beforeInstance, []);
  const beforeActiveCascadeIds = beforeExtensionServer.activeCascadeIds ?? [];

  const dispatchArgs = deps.buildDispatchArgs({
    ...options,
    cwd,
    profile,
    prompt,
  });

  const client = await deps.createMainIpcClient(socketPath, "main");
  let launchReply = null;
  try {
    launchReply = await client.call("launch", "start", [dispatchArgs, deps.env]);
  } finally {
    await client.close();
  }

  const deadline = Date.now() + options.waitMs;
  let changedTrajectories = [];
  let workspaceInstance = null;
  let currentActiveCascadeIds = beforeActiveCascadeIds;
  let newCascadeIds = [];
  while (Date.now() <= deadline) {
    workspaceInstance = deps.findWorkspaceInstance(deps.discoverInstances(), workspaceId);
    if (workspaceInstance) {
      const extensionServer = await deps.buildExtensionServerSnapshot(workspaceInstance, []);
      currentActiveCascadeIds = extensionServer.activeCascadeIds ?? [];
      newCascadeIds = deps.diffActiveCascadeIds(beforeActiveCascadeIds, currentActiveCascadeIds);
    }
    // Brain activity is a weaker fallback signal: it tells us work moved, even if no new cascade was exposed.
    changedTrajectories = deps.diffBrainActivity(
      beforeBrain,
      deps.listBrainActivity(),
      dispatchStartedAt
    );
    if (newCascadeIds.length > 0) {
      break;
    }
    if (!options.waitForNewCascade && changedTrajectories.length > 0) {
      break;
    }
    await deps.sleep(500);
  }

  const sidebarIncludesWorkspace = deps.listSidebarWorkspacePaths().includes(cwd);
  const verification = deps.deriveDispatchVerification({
    waitForNewCascade: options.waitForNewCascade,
    workspaceReady: Boolean(workspaceInstance),
    sidebarIncludesWorkspace,
    changedTrajectories,
    newCascadeIds,
  });

  return {
    cwd,
    profile,
    socketPath,
    dispatchArgs,
    launchReply,
    workspaceReady: Boolean(workspaceInstance),
    workspaceId,
    targetHit: verification.targetHit,
    verification,
    activeCascadeIdsBefore: beforeActiveCascadeIds,
    activeCascadeIdsAfter: currentActiveCascadeIds,
    newCascadeIds,
    changedTrajectories: changedTrajectories.slice(0, 8).map((entry) => ({
      trajectoryId: entry.trajectoryId,
      updatedAt: new Date(entry.updatedAtMs).toISOString(),
      latestFile: entry.latestFile?.filePath ?? null,
    })),
    sidebarIncludesWorkspace,
  };
}
