export async function main(argv, deps) {
  const options = deps.parseArgs(argv);

  if (options.command === "help") {
    deps.printUsage();
    return;
  }

  if (options.command === "version") {
    deps.output(deps.packageVersion);
    return;
  }

  if (options.command === "discover") {
    deps.outputJson({ instances: deps.discoverInstances() });
    return;
  }

  if (options.command === "snapshot") {
    deps.outputJson(await deps.buildSnapshot(options));
    return;
  }

  if (options.command === "watch") {
    await deps.watch(options);
    return;
  }

  if (options.command === "dispatch") {
    deps.outputJson(await deps.dispatchViaBridge(options));
    return;
  }

  if (options.command === "run-status") {
    deps.outputJson(await deps.getRunStatus(options));
    return;
  }

  if (options.command === "ipc-dispatch") {
    deps.outputJson(await deps.dispatchToWorkspace(options));
    return;
  }

  deps.printUsage();
  deps.setExitCode(1);
}
