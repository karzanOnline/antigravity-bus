export function parseArgs(argv, deps) {
  const [rawCommand = "snapshot", ...rest] = argv;
  const command =
    rawCommand === "-h" || rawCommand === "--help"
      ? "help"
      : rawCommand === "-v" || rawCommand === "--version"
        ? "version"
        : rawCommand;
  const options = {
    command,
    cwd: deps.cwd(),
    intervalMs: 4000,
    outDir: deps.defaultStoreDir,
    addFiles: [],
    profile: null,
    mode: "agent",
    prompt: null,
    waitMs: 8000,
    waitForNewCascade: false,
    bridgeDir: deps.defaultBridgeDir,
    waitForCompletion: false,
    completionTimeoutMs: 120000,
    autoRemediate: null,
    autoApprove: false,
    approvalTimeoutMs: 30000,
    maxRemediations: 1,
    supervisorLoopTimeoutMs: 300000,
    runId: null,
    refresh: false,
  };

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    const next = rest[index + 1];

    if (value === "--cwd" && next) {
      options.cwd = deps.resolvePath(next);
      index += 1;
    } else if (value === "--interval" && next) {
      options.intervalMs = Number.parseInt(next, 10) || options.intervalMs;
      index += 1;
    } else if (value === "--out-dir" && next) {
      options.outDir = deps.resolvePath(next);
      index += 1;
    } else if (value === "--add-file" && next) {
      options.addFiles.push(deps.resolvePath(next));
      index += 1;
    } else if (value === "--profile" && next) {
      options.profile = next;
      index += 1;
    } else if (value === "--mode" && next) {
      options.mode = next;
      index += 1;
    } else if (value === "--prompt" && next) {
      options.prompt = next;
      index += 1;
    } else if (value === "--wait-ms" && next) {
      options.waitMs = Number.parseInt(next, 10) || options.waitMs;
      index += 1;
    } else if (value === "--wait-for-new-cascade") {
      options.waitForNewCascade = true;
    } else if (value === "--bridge-dir" && next) {
      options.bridgeDir = deps.resolvePath(next);
      index += 1;
    } else if (value === "--wait-for-completion") {
      options.waitForCompletion = true;
    } else if (value === "--completion-timeout-ms" && next) {
      options.completionTimeoutMs = Number.parseInt(next, 10) || options.completionTimeoutMs;
      index += 1;
    } else if (value === "--auto-remediate") {
      options.autoRemediate = true;
    } else if (value === "--auto-approve") {
      options.autoApprove = true;
    } else if (value === "--approval-timeout-ms" && next) {
      options.approvalTimeoutMs = Number.parseInt(next, 10) || options.approvalTimeoutMs;
      index += 1;
    } else if (value === "--max-remediations" && next) {
      options.maxRemediations = Number.parseInt(next, 10) || options.maxRemediations;
      index += 1;
    } else if (value === "--supervisor-loop-timeout-ms" && next) {
      options.supervisorLoopTimeoutMs =
        Number.parseInt(next, 10) || options.supervisorLoopTimeoutMs;
      index += 1;
    } else if (value === "--run-id" && next) {
      options.runId = next;
      index += 1;
    } else if (value === "--refresh") {
      options.refresh = true;
    } else if (!value.startsWith("--") && !options.prompt) {
      options.prompt = value;
    }
  }

  return options;
}
