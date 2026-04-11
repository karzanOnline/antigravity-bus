export function decodeTopicStateEntries(topicPayload) {
  const data = topicPayload?.initialState?.data;
  if (!data || typeof data !== "object") {
    return [];
  }

  return Object.entries(data)
    .map(([key, value]) => ({
      key,
      value: value?.value ?? null,
    }))
    .filter((entry) => typeof entry.value === "string");
}

export function decodeBase64PrintableStrings(rawValue, extractPrintableStrings, minLength = 8) {
  try {
    const decoded = Buffer.from(rawValue, "base64");
    return extractPrintableStrings(decoded, minLength).map((item) => item.value);
  } catch {
    return [];
  }
}

export function extractActiveCascadeIds(topicPayload, extractPrintableStrings) {
  const ids = new Set();
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;

  for (const entry of decodeTopicStateEntries(topicPayload)) {
    // Topic payloads are still mostly opaque, so we conservatively mine UUIDs from printable fragments.
    for (const value of decodeBase64PrintableStrings(entry.value, extractPrintableStrings, 4)) {
      const matches = value.match(uuidPattern) ?? [];
      for (const match of matches) {
        ids.add(match);
      }
    }
  }

  return Array.from(ids);
}

export function extractTrajectorySignals(topicPayload, extractPrintableStrings) {
  const strings = [];
  const seen = new Set();

  for (const entry of decodeTopicStateEntries(topicPayload)) {
    // We keep only unique, printable excerpts because the raw protobuf-backed state is noisy and lossy here.
    for (const value of decodeBase64PrintableStrings(entry.value, extractPrintableStrings, 12)) {
      if (!seen.has(value)) {
        strings.push(value);
        seen.add(value);
      }
      if (strings.length >= 80) {
        return strings;
      }
    }
  }

  return strings;
}

export function deriveSupervisorState({ activeCascadeIds, trajectorySignals, tasks }) {
  // Waiting must win over running so the supervisor can surface approvals instead of hiding them behind activity.
  const hasWaitingSignal = trajectorySignals.some((signal) =>
    /BlockedOnUser|ShouldAutoProceed|waiting|confirm|approval|user interaction/i.test(signal)
  );
  if (hasWaitingSignal) {
    return "waiting";
  }

  if (activeCascadeIds.length > 0) {
    return "running";
  }

  if (tasks.some((task) => ["completed", "written"].includes(task.statusGuess))) {
    return "completed";
  }

  return "idle";
}

export async function buildExtensionServerSnapshot(instance, tasks, deps) {
  if (!instance?.extensionServerPort || !instance.extensionServerCsrfToken) {
    return {
      available: false,
      healthy: false,
      state: deriveSupervisorState({
        activeCascadeIds: [],
        trajectorySignals: [],
        tasks,
      }),
      activeCascadeIds: [],
      topicSignals: [],
      rawTopics: {},
    };
  }

  const { extractPrintableStrings, postJson, subscribeTopicInitialState, TOPICS } = deps;
  // Fetch all supervisor-relevant topics together so one snapshot reflects a single observation window.
  const heartbeatPromise = postJson(
    instance.extensionServerPort,
    instance.extensionServerCsrfToken,
    "Heartbeat",
    {}
  );
  const [heartbeat, activeCascadeTopic, trajectoryTopic, userStatusTopic, machineInfosTopic] = await Promise.all([
    heartbeatPromise,
    subscribeTopicInitialState(
      instance.extensionServerPort,
      instance.extensionServerCsrfToken,
      TOPICS.activeCascadeIds
    ),
    subscribeTopicInitialState(
      instance.extensionServerPort,
      instance.extensionServerCsrfToken,
      TOPICS.trajectorySummaries
    ),
    subscribeTopicInitialState(
      instance.extensionServerPort,
      instance.extensionServerCsrfToken,
      TOPICS.userStatus
    ),
    subscribeTopicInitialState(
      instance.extensionServerPort,
      instance.extensionServerCsrfToken,
      TOPICS.machineInfos
    ),
  ]);

  const activeCascadeIds = extractActiveCascadeIds(activeCascadeTopic, extractPrintableStrings);
  const trajectorySignals = extractTrajectorySignals(trajectoryTopic, extractPrintableStrings);

  return {
    available: true,
    healthy: heartbeat.ok,
    state: deriveSupervisorState({
      activeCascadeIds,
      trajectorySignals,
      tasks,
    }),
    activeCascadeIds,
    topicSignals: trajectorySignals,
    rawTopics: {
      activeCascadeIds: activeCascadeTopic,
      trajectorySummaries: trajectoryTopic,
      userStatus: userStatusTopic,
      machineInfos: machineInfosTopic,
    },
  };
}
