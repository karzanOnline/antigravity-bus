import {
  buildAutoApprovalCommandPlans,
  buildRemediationPayload,
  isRemediationTerminal,
  isChatOnlyPrompt,
  shouldAutoRemediateCompletion,
  summarizeSnapshotForCompletion,
  summarizeWaitingInteraction,
} from "./core.mjs";

export async function attemptAutoApprove(options, snapshot, deps) {
  const {
    buildSnapshot,
    createBridgeCommandPayload,
    dispatchBridgeRequest,
    recordRunEvent,
    sleep,
  } = deps;
  const startedAt = Date.now();
  const plans = buildAutoApprovalCommandPlans(snapshot);
  const attempts = [];
  let latestSnapshot = snapshot;

  for (const plan of plans) {
    if (Date.now() - startedAt >= options.approvalTimeoutMs) {
      break;
    }

    const payload = createBridgeCommandPayload(options, {
      commandCandidates: plan.commandCandidates,
      interaction: {
        source: "supervisor.waiting",
        signals: summarizeWaitingInteraction(latestSnapshot).signals,
        label: plan.label,
      },
    });
    const response = await dispatchBridgeRequest(
      { ...options, waitForCompletion: false },
      payload
    );

    await sleep(750);
    latestSnapshot = await buildSnapshot(options);
    const waiting = summarizeWaitingInteraction(latestSnapshot).waiting;

    attempts.push({
      label: plan.label,
      requestId: response.requestId,
      responded: response.responded,
      response: response.response,
      waitingAfterAttempt: waiting,
    });

    recordRunEvent?.("supervisor.approval_attempted", {
      label: plan.label,
      requestId: response.requestId,
      responded: response.responded,
      waitingAfterAttempt: waiting,
    });

    if (!waiting) {
      recordRunEvent?.("supervisor.approval_resolved", {
        label: plan.label,
        requestId: response.requestId,
      });
      return {
        resolved: true,
        attempts,
        snapshot: summarizeSnapshotForCompletion(latestSnapshot),
      };
    }
  }

  return {
    resolved: false,
    attempts,
    snapshot: summarizeSnapshotForCompletion(latestSnapshot),
  };
}

export async function waitForCompletionResult(options, deps) {
  const {
    attemptAutoApproveImpl = attemptAutoApprove,
    buildSnapshot,
    createBridgeCommandPayload,
    dispatchBridgeRequest,
    recordRunEvent,
    sleep,
    summarizeWorkspaceChanges,
  } = deps;
  const deadline = Date.now() + options.completionTimeoutMs;
  const expectChatOnlyCompletion = isChatOnlyPrompt(options.prompt);
  let latestSnapshot = await buildSnapshot(options);
  let observedRunning = latestSnapshot.supervisor?.state === "running";
  let chatOnlyIdleStreak = 0;
  const approvals = [];
  const buildResult = (state, reason) => ({
    state,
    reason,
    snapshot: summarizeSnapshotForCompletion(latestSnapshot),
    approvals,
    workspaceChanges: summarizeWorkspaceChanges(options.cwd),
  });

  while (Date.now() <= deadline) {
    const acceptanceState = latestSnapshot.supervisor?.acceptance?.state ?? "unknown";
    const supervisorState = latestSnapshot.supervisor?.state ?? "idle";
    const waitingInteraction = summarizeWaitingInteraction(latestSnapshot);
    const noObservableWork =
      supervisorState === "idle" &&
      !waitingInteraction.waiting &&
      (latestSnapshot.tasks?.length ?? 0) === 0 &&
      (latestSnapshot.supervisor?.activeCascadeIds?.length ?? 0) === 0 &&
      (latestSnapshot.extensionServer?.topicSignals?.length ?? 0) === 0;

    if (acceptanceState === "failed") {
      recordRunEvent?.("supervisor.failed", {
        reason: "Supervisor acceptance failed.",
        snapshot: summarizeSnapshotForCompletion(latestSnapshot),
      });
      return buildResult("failed", "Supervisor acceptance failed.");
    }

    if (supervisorState === "waiting" || waitingInteraction.waiting) {
      if (options.autoApprove) {
        const approval = await attemptAutoApproveImpl(options, latestSnapshot, {
          buildSnapshot,
          createBridgeCommandPayload,
          dispatchBridgeRequest,
          recordRunEvent,
          sleep,
        });
        approvals.push(approval);
        latestSnapshot = await buildSnapshot(options);
        observedRunning ||= latestSnapshot.supervisor?.state === "running";

        if (approval.resolved) {
          continue;
        }
      }

      recordRunEvent?.("supervisor.waiting", {
        reason:
          options.autoApprove
            ? "Supervisor detected a user interaction and automatic approval did not resolve it."
            : "Supervisor detected a user interaction that needs approval.",
        snapshot: summarizeSnapshotForCompletion(latestSnapshot),
      });
      return buildResult(
        "waiting_for_user",
        options.autoApprove
          ? "Supervisor detected a user interaction and automatic approval did not resolve it."
          : "Supervisor detected a user interaction that needs approval."
      );
    }

    if (expectChatOnlyCompletion && acceptanceState !== "failed" && noObservableWork) {
      chatOnlyIdleStreak += 1;

      // Require two quiet snapshots so we do not classify a prompt as completed
      // before Antigravity has had a chance to transition out of the initial idle state.
      if (chatOnlyIdleStreak >= 2) {
        recordRunEvent?.("supervisor.completed_chat_only", {
          snapshot: summarizeSnapshotForCompletion(latestSnapshot),
        });
        return buildResult(
          "completed_chat_only",
          "Chat-only prompt was delivered and Antigravity returned to idle without observable task artifacts."
        );
      }
    } else {
      chatOnlyIdleStreak = 0;
    }

    if (acceptanceState === "passed" && supervisorState !== "running") {
      recordRunEvent?.("supervisor.completed", {
        snapshot: summarizeSnapshotForCompletion(latestSnapshot),
      });
      return buildResult(
        "completed",
        "Supervisor acceptance passed and Antigravity is no longer running."
      );
    }

    if (observedRunning && supervisorState !== "running" && acceptanceState !== "failed") {
      recordRunEvent?.("supervisor.completed_without_acceptance", {
        snapshot: summarizeSnapshotForCompletion(latestSnapshot),
      });
      return buildResult(
        "completed_without_acceptance",
        "Antigravity stopped running before a passing acceptance signal was observed."
      );
    }

    await sleep(1000);
    latestSnapshot = await buildSnapshot(options);
    observedRunning ||= latestSnapshot.supervisor?.state === "running";
  }

  recordRunEvent?.("supervisor.timeout", {
    snapshot: summarizeSnapshotForCompletion(latestSnapshot),
  });
  return buildResult(
    "timeout",
    "Completion wait timed out before Antigravity reached a terminal state."
  );
}

export async function dispatchViaBridge(options, deps) {
  const {
    buildRemediationPrompt,
    buildSnapshot,
    dispatchBridgeRequest,
    recordRunEvent,
  } = deps;
  const initial = await dispatchBridgeRequest(options);
  const remediations = [];
  const loopStartedAt = Date.now();

  let latest = initial;
  for (let attempt = 0; attempt < options.maxRemediations; attempt += 1) {
    if (!options.autoRemediate) {
      break;
    }

    if (Date.now() - loopStartedAt >= options.supervisorLoopTimeoutMs) {
      break;
    }

    if (isRemediationTerminal(latest.completion)) {
      break;
    }

    if (!shouldAutoRemediateCompletion(latest.completion)) {
      break;
    }

    const snapshot = await buildSnapshot(options);
    const remediationPayload = buildRemediationPayload(
      {
        ...options,
        cwd: options.cwd,
        addFiles: options.addFiles ?? [],
        completion: latest.completion ?? null,
      },
      snapshot,
      buildRemediationPrompt
    );
    if (!remediationPayload) {
      break;
    }

    recordRunEvent?.("supervisor.remediation_requested", {
      prompt: remediationPayload.prompt,
      failedChecks: remediationPayload.remediation?.failedChecks ?? [],
    });
    const remediationResult = await dispatchBridgeRequest(options, remediationPayload);
    remediations.push({
      attempt: attempt + 1,
      requestId: remediationResult.requestId,
      responded: remediationResult.responded,
      response: remediationResult.response,
      completion: remediationResult.completion,
      remediationPrompt: remediationPayload.prompt,
    });
    recordRunEvent?.("supervisor.remediation_dispatched", {
      requestId: remediationResult.requestId,
      completion: remediationResult.completion,
    });
    latest = remediationResult;
  }

  return {
    ...initial,
    supervisorLoop: {
      autoRemediate: options.autoRemediate,
      maxRemediations: options.maxRemediations,
      supervisorLoopTimeoutMs: options.supervisorLoopTimeoutMs,
      exhaustedRemediations:
        options.autoRemediate &&
        remediations.length >= options.maxRemediations &&
        shouldAutoRemediateCompletion(latest.completion),
      timedOut:
        options.autoRemediate &&
        Date.now() - loopStartedAt >= options.supervisorLoopTimeoutMs &&
        shouldAutoRemediateCompletion(latest.completion),
    },
    remediations,
    final: latest,
  };
}
