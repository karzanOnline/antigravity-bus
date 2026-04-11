import path from "node:path";

export function readTextFileIfExists(filePath, deps) {
  try {
    return deps.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

export function hasAnyPattern(text, patterns) {
  if (!text) {
    return false;
  }

  return patterns.some((pattern) => pattern.test(text));
}

export function hasTaskOutput(tasks) {
  return tasks.some((task) =>
    ["written", "completed", "in_progress"].includes(task.statusGuess)
  );
}

export function evaluateSkinSaasAppointmentStatusChain(cwd, deps) {
  const detailPagePath = path.join(
    cwd,
    "apps",
    "admin",
    "src",
    "app",
    "appointments",
    "[id]",
    "page.tsx"
  );
  const controllerPath = path.join(cwd, "apps", "api", "src", "appointments", "appointments.controller.ts");
  const servicePath = path.join(cwd, "apps", "api", "src", "appointments", "appointments.service.ts");

  const detailPage = deps.readTextFileIfExists(detailPagePath);
  const controller = deps.readTextFileIfExists(controllerPath);
  const service = deps.readTextFileIfExists(servicePath);

  const hasDetailPage = Boolean(detailPage);
  const hasStatusButton = hasAnyPattern(detailPage, [/更新状态/u, /Update\s+Status/i]);
  const hasFrontendMutation = hasAnyPattern(detailPage, [
    /fetch\s*\(/,
    /axios\./,
    /api(?:Fetch|Client|Request)?\s*\(/,
    /mutation/i,
    /PATCH/i,
    /PUT/i,
    /updateStatus/i,
  ]);
  const hasBackendRoute = hasAnyPattern(controller, [
    /@Patch\s*\(/,
    /@Put\s*\(/,
    /updateStatus/i,
    /updateAppointmentStatus/i,
    /setAppointmentStatus/i,
  ]);
  const hasBackendService = hasAnyPattern(service, [
    /updateStatus/i,
    /updateAppointmentStatus/i,
    /setAppointmentStatus/i,
    /status:\s*[^=]/,
  ]);

  const reasons = [];
  // This check is intentionally narrow: it is meant to catch the common "UI shipped, backend chain missing" failure.
  if (hasStatusButton && !hasFrontendMutation) {
    reasons.push("Appointment detail page exposes a status-update UI but does not send any update request.");
  }
  if (hasStatusButton && !hasBackendRoute) {
    reasons.push("Appointments controller does not expose a status-update route.");
  }
  if (hasStatusButton && hasBackendRoute && !hasBackendService) {
    reasons.push("Appointments service does not implement a status-update handler behind the route.");
  }

  const applicable = hasDetailPage && hasStatusButton;
  const passed = applicable && reasons.length === 0;
  const failed = applicable && reasons.length > 0;

  return {
    id: "skin-saas.appointment-status-chain",
    label: "Skin SaaS appointment status update chain",
    applicable,
    passed,
    failed,
    reasons,
    evidence: {
      detailPagePath,
      controllerPath,
      servicePath,
      hasDetailPage,
      hasStatusButton,
      hasFrontendMutation,
      hasBackendRoute,
      hasBackendService,
    },
  };
}

export function evaluateAcceptanceChecks(cwd, tasks, deps) {
  const dirtyFiles = deps.listDirtyFiles(cwd);
  const checks = [deps.evaluateSkinSaasAppointmentStatusChain(cwd)];
  const applicableChecks = checks.filter((check) => check.applicable);
  const failedChecks = applicableChecks.filter((check) => check.failed);
  const passedChecks = applicableChecks.filter((check) => check.passed);
  const taskOutputDetected = hasTaskOutput(tasks);
  // Dirty relevant files help us distinguish "agent never touched this area" from "agent touched it but left it broken".
  const dirtyRelevantFiles = dirtyFiles.filter((filePath) =>
    failedChecks.some((check) =>
      Object.values(check.evidence)
        .filter((value) => typeof value === "string")
        .includes(filePath)
    )
  );

  let state = "unknown";
  if (failedChecks.length > 0 && (taskOutputDetected || dirtyRelevantFiles.length > 0)) {
    state = "failed";
  } else if (applicableChecks.length > 0 && failedChecks.length === 0 && passedChecks.length === applicableChecks.length) {
    state = "passed";
  } else if (applicableChecks.length > 0) {
    state = "pending";
  }

  return {
    state,
    taskOutputDetected,
    dirtyRelevantFiles,
    checks,
    failedChecks: failedChecks.map((check) => ({
      id: check.id,
      label: check.label,
      reasons: check.reasons,
    })),
  };
}

export function buildRemediationPrompt(snapshot) {
  const acceptance = snapshot?.supervisor?.acceptance;
  if (!acceptance || acceptance.state !== "failed" || acceptance.failedChecks.length === 0) {
    return null;
  }

  const lines = [
    `Continue working in ${snapshot.cwd}.`,
    "Your last delivery does not pass supervisor acceptance.",
    "",
    "Failure reasons:",
  ];

  for (const failedCheck of acceptance.failedChecks) {
    lines.push(`- ${failedCheck.label}`);
    for (const reason of failedCheck.reasons) {
      lines.push(`- ${reason}`);
    }
  }

  const dirtyFiles = acceptance.dirtyRelevantFiles ?? [];
  if (dirtyFiles.length > 0) {
    lines.push("", "Files already touched in this failed delivery:");
    for (const filePath of dirtyFiles) {
      lines.push(`- ${filePath}`);
    }
  }

  lines.push(
    "",
    "Hard requirements:",
    "- Do not stop at UI changes.",
    "- Add the missing backend route and the corresponding service handler.",
    "- Wire the existing status update button to call the real backend endpoint.",
    "- Refresh the appointment detail view after a successful update.",
    "- Keep unrelated files unchanged.",
    "",
    "Completion rule:",
    "- Only stop when the missing route is implemented and the detail page is wired to it.",
    "- If you cannot complete the change, explain exactly which required file or API contract is blocking you.",
    "",
    "When finished, summarize the exact files you changed."
  );

  return lines.join("\n");
}
