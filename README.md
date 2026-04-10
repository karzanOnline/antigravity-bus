# antigravity-bus

[![CI](https://github.com/karzanOnline/antigravity-bus/actions/workflows/ci.yml/badge.svg)](https://github.com/karzanOnline/antigravity-bus/actions/workflows/ci.yml)

`antigravity-bus` is a local-first observability bus for Antigravity.

It is built for a very specific but increasingly common workflow: one agent delegates implementation work to Antigravity, then needs a reliable way to observe runtime state, collect artifacts, and close the loop with review or orchestration logic.

This project is not an official Antigravity integration. It is an independent developer tool that turns local Antigravity state into machine-readable snapshots.

## Status

- Current stage: early MVP
- Supported platform: macOS
- Runtime: Node.js 20+
- Integration style: local inspection, extension-server observation, and local main-process chat dispatch

The current release focuses on one narrow promise: if Antigravity is running on your machine, `antigravity-bus` should help you discover it, inspect its local footprint, and persist a stable snapshot that another tool can consume.

## Why This Exists

Starting an agent is easy. Supervising one is harder.

If you want a real delegation loop, you need to answer questions like:

- Is Antigravity currently running?
- Which workspace is it associated with?
- Did it create new local artifacts?
- Has the local state changed since the last poll?
- Can another process consume that state without screen-scraping the UI?

`antigravity-bus` focuses on that observability layer first.

## What It Does

- Discovers local Antigravity language server processes from the host machine
- Extracts runtime hints such as `pid`, `workspace_id`, `extension_server_port`, and CSRF-related flags
- Reads Antigravity local state from the SQLite store under `~/Library/Application Support/Antigravity`
- Decodes artifact and manager state blobs into conservative, review-friendly summaries
- Produces snapshot JSON for a target workspace
- Probes the local extension server with the same CSRF-guarded interfaces Antigravity uses internally
- Subscribes to unified-state topics such as active cascades and trajectory summaries
- Normalizes a lightweight supervisor state such as `idle`, `running`, `waiting`, or `done`
- Evaluates workspace-specific acceptance checks so supervisor loops can fail incomplete deliveries
- Writes append-only change events for downstream review loops and supervisor processes
- Dispatches prompts through Antigravity's local `*-main.sock` handle using the same `launch.start(...)` entry point as the official CLI

## Non-Goals

At this stage, `antigravity-bus` does not try to do the following:

- Replace the Antigravity UI
- Pretend to be a full remote control layer
- Guarantee a lossless decode of every internal state payload
- Upload local state to a hosted backend
- Support Linux or Windows before the macOS data model is stable

Keeping the scope narrow is deliberate. The project should become trustworthy as an observability primitive before it expands into a broader supervisor.

## Architecture

The CLI currently builds snapshots from five local sources:

1. Running processes
2. Antigravity SQLite state
3. Local artifact files
4. Recent language server logs
5. Extension-server topic subscriptions

Those sources are merged into a normalized snapshot with stable top-level fields such as:

- `generatedAt`
- `cwd`
- `activeWorkspaceId`
- `antigravity`
- `workspaceInstance`
- `extensionServer`
- `supervisor`
- `userStatusAvailable`
- `authStatusAvailable`
- `recentLogSignals`
- `tasks`

The snapshot intentionally separates:

- runtime state, under `supervisor.state`
- delivery closure, under `supervisor.acceptance.state`

That distinction matters when an agent is still marked as `running` but has already produced an incomplete change. For example, a detail page might render a status-update button while the backend route is still missing. In that case the runtime can remain active, while acceptance already reports `failed`.

For a deeper breakdown of the internal model, see [docs/architecture.md](./docs/architecture.md).

## Requirements

- macOS with Antigravity installed and used locally at least once
- Node.js 20 or newer
- `sqlite3` available on your `PATH`

You can verify the last requirement with:

```bash
sqlite3 --version
```

## Installation

### Run from source

```bash
git clone https://github.com/karzanOnline/antigravity-bus.git
cd antigravity-bus
```

The current MVP has no npm runtime dependencies.

### Install as a CLI

After the package is published on npm, you can run it either globally or through `npx`:

```bash
npm install -g antigravity-bus
antigravity-bus --help
```

```bash
npx antigravity-bus --help
```

## Quick Start

### Discover active Antigravity instances

```bash
antigravity-bus discover
```

### Build a snapshot for one workspace

```bash
antigravity-bus snapshot --cwd /absolute/path/to/workspace
```

### Watch for changes and persist them

```bash
antigravity-bus watch \
  --cwd /absolute/path/to/workspace \
  --interval 4000 \
  --out-dir /absolute/path/to/output
```

### Dispatch a prompt into Antigravity chat

```bash
antigravity-bus dispatch \
  --cwd /absolute/path/to/workspace \
  --prompt "做到哪里" \
  --wait-ms 5000
```

You can also use the npm scripts:

```bash
npm run discover
npm run snapshot -- --cwd /absolute/path/to/workspace
npm run watch -- --cwd /absolute/path/to/workspace
npm run dispatch -- --cwd /absolute/path/to/workspace --prompt "做到哪里"
```

If you are running directly from source without a global install, replace `antigravity-bus` with `node ./src/index.mjs`.

## CLI Reference

### `discover`

Lists the local Antigravity language server processes visible on the machine.

Example:

```bash
node ./src/index.mjs discover
```

Returns a JSON object with an `instances` array.

### `snapshot`

Builds one workspace-scoped snapshot by combining process discovery, local state, artifacts, logs, and extension-server topic state.

Options:

- `--cwd <path>`: absolute or relative workspace path to normalize against

Example:

```bash
node ./src/index.mjs snapshot --cwd /Users/example/project
```

### `watch`

Continuously rebuilds snapshots and writes change-tracked outputs to disk.

Options:

- `--cwd <path>`: workspace path to observe
- `--interval <ms>`: polling interval in milliseconds, default `4000`
- `--out-dir <path>`: output directory for `latest.json` and `events.jsonl`

Example:

```bash
node ./src/index.mjs watch \
  --cwd /Users/example/project \
  --interval 4000 \
  --out-dir /tmp/antigravity-bus
```

### `dispatch`

Queues a request for the companion Antigravity extension bridge. This is now the default dispatch path because it runs inside the Antigravity extension host and returns an explicit command-execution receipt.

Options:

- `--cwd <path>`: workspace path to target
- `--prompt <text>`: prompt text to send into chat
- `--mode <mode>`: chat mode, default `agent`
- `--add-file <path>`: attach one or more files to the chat request
- `--wait-ms <ms>`: how long to wait for a bridge response file
- `--bridge-dir <path>`: override the local queue directory, default `~/Library/Application Support/Antigravity/antigravity-bus-bridge`

Example:

```bash
node ./src/index.mjs dispatch \
  --cwd /Users/example/project \
  --prompt "做到哪里" \
  --wait-ms 5000
```

### `ipc-dispatch`

Uses the older main-process socket path and calls `launch.start(...)`. Keep this around for reverse-engineering and fallback testing, but it is no longer the default because it does not guarantee runtime chat delivery.

Options:

- `--cwd <path>`: workspace path to target
- `--prompt <text>`: prompt text to send into chat
- `--mode <mode>`: chat mode, default `agent`
- `--profile <name>`: optional Antigravity profile
- `--add-file <path>`: attach one or more files to the chat request
- `--wait-ms <ms>`: how long to wait for workspace or brain-activity signals after dispatch
- `--wait-for-new-cascade`: require a newly observed active cascade before marking the dispatch as confirmed

Example:

```bash
node ./src/index.mjs ipc-dispatch \
  --cwd /Users/example/project \
  --prompt "Continue the task" \
  --wait-for-new-cascade \
  --wait-ms 5000
```

## Companion Bridge Extension

`antigravity-bus` now ships a tiny companion extension under [bridge-extension/package.json](/Users/caozheng/cowork-flie/antigravity-bus/bridge-extension/package.json). The extension polls a local inbox, executes Antigravity runtime commands such as `antigravity.sendPromptToAgentPanel`, and writes a machine-readable response into an outbox.

Bridge layout:

- `~/Library/Application Support/Antigravity/antigravity-bus-bridge/inbox`
- `~/Library/Application Support/Antigravity/antigravity-bus-bridge/outbox`
- `~/Library/Application Support/Antigravity/antigravity-bus-bridge/status.json`

Packaging the extension:

```bash
npm run bridge:pack
```

That produces `antigravity-bus-bridge.vsix` at the repository root. You can then install it into Antigravity with:

```bash
antigravity --install-extension /absolute/path/to/antigravity-bus-bridge.vsix
```

Once the extension is installed and Antigravity is running, you can send a bridge-backed request with:

```bash
npm run dispatch -- --cwd /absolute/path/to/workspace --prompt "Continue the task"
```

## Output Model

`snapshot` returns JSON shaped like:

```json
{
  "generatedAt": "2026-04-08T13:17:41.726Z",
  "cwd": "/absolute/workspace",
  "activeWorkspaceId": "file_absolute_workspace",
  "antigravity": {
    "appSupportDir": "/Users/example/Library/Application Support/Antigravity",
    "stateDbPath": "/Users/example/Library/Application Support/Antigravity/User/globalStorage/state.vscdb",
    "running": true,
    "instances": []
  },
  "workspaceInstance": null,
  "extensionServer": {
    "available": false,
    "healthy": false,
    "state": "idle",
    "activeCascadeIds": [],
    "topicSignals": []
  },
  "supervisor": {
    "state": "idle",
    "activeCascadeIds": [],
    "healthy": false,
    "acceptance": {
      "state": "unknown",
      "taskOutputDetected": false,
      "checks": [],
      "failedChecks": []
    }
  },
  "userStatusAvailable": true,
  "authStatusAvailable": true,
  "recentLogSignals": [],
  "tasks": []
}
```

`watch` writes:

- `latest.json`
- `events.jsonl`

`latest.json` is overwritten on every cycle. `events.jsonl` only appends when the normalized snapshot payload changes.

Each event also includes an `acceptanceState` field so downstream supervisors can react to failed closure checks without re-reading the full snapshot.

When `acceptance.state` is `failed`, the snapshot contains enough evidence to generate a stronger remediation prompt for the agent. The intended pattern is:

- detect a failed closure check
- restate the exact failure reason back to the agent
- require the missing backend or refresh step explicitly
- keep the next supervisor poll focused on whether acceptance moved out of `failed`

See [examples/sample-snapshot.json](./examples/sample-snapshot.json) for a minimal example.

## Data Sources

The MVP reads only local machine state:

- process metadata from `ps`
- Antigravity state from `~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb`
- local artifact files referenced by decoded state
- recent lines from the Antigravity language server logs
- extension-server topic snapshots fetched from the workspace-scoped local port

That local-first design is intentional. It keeps the bus understandable and auditable while the project is still stabilizing.

## Privacy And Safety

`antigravity-bus` reads local application state that may contain:

- absolute filesystem paths
- workspace identifiers
- local artifact names
- task previews
- account or auth-adjacent status markers

The tool does not upload that data anywhere by itself, but snapshots are still sensitive. Review them carefully before sharing or committing them.

Please read [SECURITY.md](./SECURITY.md) before using this project in shared environments.

## Testing

The repository includes Node.js unit tests for core logic that is easy to regress:

- argument parsing
- process line parsing
- printable-string extraction
- artifact preview status inference
- snapshot file write behavior

Run the test suite with:

```bash
npm test
```

The tests avoid depending on a real Antigravity installation so they can run in CI and on contributor machines.

## Development

The project is intentionally small and dependency-light.

Typical workflow:

```bash
npm test
node ./src/index.mjs discover
node ./src/index.mjs snapshot --cwd /absolute/path/to/workspace
```

Contribution guidelines live in [CONTRIBUTING.md](./CONTRIBUTING.md).

The release process lives in [docs/release-checklist.md](./docs/release-checklist.md).

The npm publish flow lives in [docs/npm-publish.md](./docs/npm-publish.md).

## Roadmap

- Add richer state decoding for trajectory and artifact metadata
- Improve workspace attribution when manager state is incomplete
- Add Connect-RPC probing once the local-first model is stable
- Expose a higher-level supervisor API on top of the snapshot layer
- Add Linux and Windows support where practical

## License

MIT. See [LICENSE](./LICENSE).
