export function parseInstanceLine(line) {
  if (!line.includes("language_server_macos_arm")) {
    return null;
  }

  const trimmed = line.trim();
  const [pidToken, ...commandParts] = trimmed.split(/\s+/);
  const command = commandParts.join(" ");
  const readFlag = (flag) =>
    command.match(new RegExp(`--${flag}\\s+(.+?)(?=\\s+--[a-z_]+\\s|\\s+--[a-z_]+$|$)`))?.[1] ??
    null;
  const csrfToken = readFlag("csrf_token");
  const extensionServerPort = readFlag("extension_server_port");
  const extensionServerCsrfToken = readFlag("extension_server_csrf_token");
  const workspaceId = readFlag("workspace_id");
  const cloudCodeEndpoint = readFlag("cloud_code_endpoint");
  const appDataDir = readFlag("app_data_dir");

  return {
    pid: Number.parseInt(pidToken, 10),
    command,
    csrfToken,
    extensionServerPort: extensionServerPort ? Number.parseInt(extensionServerPort, 10) : null,
    extensionServerCsrfToken,
    workspaceId,
    cloudCodeEndpoint,
    appDataDir,
    supportsLsp: command.includes("--enable_lsp"),
  };
}

export function discoverInstances(run) {
  const output = run("ps", ["-axo", "pid=,command="]);
  const lines = output.split("\n").filter(Boolean);
  return lines.map(parseInstanceLine).filter(Boolean);
}

export function findWorkspaceInstance(instances, workspaceId, options = {}) {
  const exactMatch = instances.find((instance) => instance.workspaceId === workspaceId) ?? null;
  if (exactMatch || options.strict !== false) {
    return exactMatch;
  }

  return instances.find((instance) => instance.supportsLsp) ?? null;
}
