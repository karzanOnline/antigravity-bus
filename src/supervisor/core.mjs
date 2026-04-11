export function summarizeTaskResults(snapshot, maxTasks = 3, maxMessages = 3) {
  const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];

  return tasks.slice(0, maxTasks).map((task) => ({
    trajectoryId: task.trajectoryId ?? null,
    statusGuess: task.statusGuess ?? null,
    taskFile: task.taskFile ?? null,
    latestArtifact: task.latestArtifact
      ? {
          fileName: task.latestArtifact.fileName ?? null,
          filePath: task.latestArtifact.filePath ?? null,
          updatedAt: task.latestArtifact.updatedAt ?? null,
          preview: task.latestArtifact.preview ?? null,
        }
      : null,
    messages: Array.isArray(task.messages) ? task.messages.slice(0, maxMessages) : [],
    artifactCount: Array.isArray(task.artifacts) ? task.artifacts.length : 0,
  }));
}

export function summarizeSnapshotForCompletion(snapshot) {
  return {
    generatedAt: snapshot.generatedAt,
    supervisorState: snapshot.supervisor?.state ?? null,
    acceptanceState: snapshot.supervisor?.acceptance?.state ?? null,
    activeCascadeIds: snapshot.supervisor?.activeCascadeIds ?? [],
    topicSignals: snapshot.extensionServer?.topicSignals ?? [],
    taskCount: snapshot.tasks?.length ?? 0,
    taskResults: summarizeTaskResults(snapshot),
    failedChecks: snapshot.supervisor?.acceptance?.failedChecks ?? [],
  };
}

// Chat-only probes do not always create task artifacts, so we need an explicit
// intent hint before treating "returned to idle with no work" as a terminal result.
export function isChatOnlyPrompt(prompt) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    return false;
  }

  const noCodeSignals =
    /不要修改任何代码|不要改代码|不要创建文件|不要创建任何文件|不要写代码|do not modify any code|don't modify any code|do not create files|don't create files/i;
  const replyOnlySignals =
    /只回复|只回|回复一句|只确认已收到|确认已收到|reply only|respond only|just reply|just respond|confirm you received/i;

  return noCodeSignals.test(prompt) && replyOnlySignals.test(prompt);
}

export function summarizeWaitingInteraction(snapshot) {
  const topicSignals = snapshot?.extensionServer?.topicSignals ?? [];
  const waitingSignals = topicSignals.filter((signal) =>
    /BlockedOnUser|ShouldAutoProceed|waiting|confirm|approval|user interaction/i.test(signal)
  );

  return {
    waiting: waitingSignals.length > 0 || snapshot?.supervisor?.state === "waiting",
    signals: waitingSignals,
  };
}

export function buildAutoApprovalCommandPlans(snapshot) {
  const interaction = summarizeWaitingInteraction(snapshot);
  const signals = interaction.signals.join(" ");
  const topicSignals = snapshot?.extensionServer?.topicSignals ?? [];
  const fullSignalText = topicSignals.join(" ");
  const plans = [];

  if (/plan|proceed|review|implementation/i.test(fullSignalText)) {
    plans.push({
      label: "accept-agent-step",
      commandCandidates: ["antigravity.acceptAgentStep"],
    });
    plans.push({
      label: "accept-primary-notification",
      commandCandidates: ["notification.acceptPrimaryAction"],
    });
  }

  if (/edit|file|diff/i.test(signals)) {
    plans.push({
      label: "accept-all-files",
      commandCandidates: ["chatEditing.acceptAllFiles"],
    });
    plans.push({
      label: "accept-current-file",
      commandCandidates: ["antigravity.prioritized.agentAcceptAllInFile"],
    });
  }

  plans.push({
    label: "edit-tool-approval",
    commandCandidates: ["workbench.action.chat.editToolApproval"],
  });

  if (!plans.some((plan) => plan.commandCandidates.includes("chatEditing.acceptAllFiles"))) {
    plans.push({
      label: "accept-all-files",
      commandCandidates: ["chatEditing.acceptAllFiles"],
    });
  }

  if (
    !plans.some((plan) =>
      plan.commandCandidates.includes("antigravity.prioritized.agentAcceptAllInFile")
    )
  ) {
    plans.push({
      label: "accept-current-file",
      commandCandidates: ["antigravity.prioritized.agentAcceptAllInFile"],
    });
  }

  if (!plans.some((plan) => plan.commandCandidates.includes("antigravity.acceptAgentStep"))) {
    plans.push({
      label: "accept-agent-step",
      commandCandidates: ["antigravity.acceptAgentStep"],
    });
  }

  if (
    !plans.some((plan) => plan.commandCandidates.includes("notification.acceptPrimaryAction"))
  ) {
    plans.push({
      label: "accept-primary-notification",
      commandCandidates: ["notification.acceptPrimaryAction"],
    });
  }

  return plans;
}

export function buildRemediationPayload(options, snapshot, buildRemediationPrompt) {
  const completionState = options.completion?.state ?? null;
  let prompt = null;

  if (completionState === "no_observable_output") {
    const changedFiles = options.completion?.workspaceDelta?.changedFiles ?? [];
    const lines = [
      `Continue working in ${options.cwd}.`,
      "Your last delivery did not produce any observable output for this run.",
      "Do not restate the plan or paste the original request again.",
      "Continue the same task and make the concrete change now.",
      "",
      "Observed result:",
      "- completion state: no_observable_output",
      `- supervisor state: ${snapshot?.supervisor?.state ?? "unknown"}`,
      `- task count: ${snapshot?.tasks?.length ?? 0}`,
      changedFiles.length > 0
        ? `- changed files since baseline: ${changedFiles.join(", ")}`
        : "- changed files since baseline: none",
      "",
      "Hard requirements:",
      "- Do not stop at analysis.",
      "- Make the concrete code or content change required by the current task.",
      "- Keep unrelated files unchanged.",
      "",
      "Completion rule:",
      "- Only stop after you have produced an observable result in the workspace.",
      "- When finished, summarize the exact files you changed.",
    ];
    prompt = lines.join("\n");
  } else {
    prompt = buildRemediationPrompt(snapshot);
  }

  if (!prompt) {
    return null;
  }

  return {
    id: `bridge-${Date.now()}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2, 10)}`,
    createdAt: new Date().toISOString(),
    cwd: options.cwd,
    prompt,
    mode: options.mode,
    addFiles: options.addFiles ?? [],
    profile: options.profile ?? null,
    commandCandidates: ["antigravity.sendPromptToAgentPanel"],
    remediation: {
      source:
        completionState === "no_observable_output"
          ? "supervisor.no_observable_output"
          : "supervisor.acceptance.failed",
      previousCompletionState: completionState,
      failedChecks: snapshot?.supervisor?.acceptance?.failedChecks ?? [],
    },
  };
}

export function shouldAutoRemediateCompletion(completion) {
  return completion?.state === "failed" || completion?.state === "no_observable_output";
}

export function isRemediationTerminal(completion) {
  return (
    completion?.state === "completed" ||
    completion?.state === "completed_without_acceptance" ||
    completion?.state === "completed_chat_only" ||
    completion?.state === "waiting_for_user"
  );
}
