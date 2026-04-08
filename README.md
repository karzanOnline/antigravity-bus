# antigravity-bus

`antigravity-bus` is a local event and state bus for Antigravity.

It is built for the workflow where one agent delegates work to Antigravity, then needs a reliable way to:

- discover running language server instances
- identify the active workspace
- read local state from Antigravity's SQLite store
- collect artifact and trajectory snapshots
- persist snapshots into machine-readable JSON files for review loops

This project is not an official Antigravity integration. It is a local-first supervisor primitive for orchestration, observability, and post-task review.

## What It Does

- `discover`
  - Finds local `language_server_macos_arm` processes and extracts `pid`, `workspace_id`, `extension_server_port`, `csrf_token`, and related runtime fields.
- `snapshot`
  - Builds a single JSON snapshot for one workspace by combining:
  - running LS processes
  - Antigravity local state in `state.vscdb`
  - local artifact files under Antigravity brain directories
  - recent local log signals
- `watch`
  - Continuously writes:
  - `latest.json`
  - `events.jsonl`
  so an external reviewer or orchestrator can consume updates.

## Why

Launching `antigravity chat ...` is not enough for orchestration. If you want a real delegation loop, you need a bus that lets you answer:

- Is Antigravity currently running?
- Which workspace is active?
- Did it generate artifacts?
- What is the latest local task snapshot?
- Has the snapshot changed since the last poll?

`antigravity-bus` focuses on that layer first.

## Installation

```bash
git clone <your-repo-url>
cd antigravity-bus
```

No external runtime dependencies are required for the current MVP. It uses Node.js built-ins plus macOS local files and `sqlite3`.

## Usage

### Discover instances

```bash
node ./src/index.mjs discover
```

### Snapshot one workspace

```bash
node ./src/index.mjs snapshot --cwd /absolute/path/to/workspace
```

### Watch continuously

```bash
node ./src/index.mjs watch \
  --cwd /absolute/path/to/workspace \
  --interval 4000 \
  --out-dir /absolute/path/to/output
```

## Output

`snapshot` returns JSON shaped roughly like:

```json
{
  "generatedAt": "2026-04-08T13:17:41.726Z",
  "cwd": "/absolute/workspace",
  "activeWorkspaceId": "file_absolute_workspace",
  "antigravity": {
    "running": true,
    "instances": []
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

## Current Scope

The MVP currently relies on local observability sources:

- process discovery via `ps`
- local Antigravity state in `~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb`
- local Antigravity logs
- local artifact files

This is deliberate. It gives a stable local-first bus before deeper RPC support is added.

## Roadmap

- Decode more trajectory and artifact structures cleanly instead of using printable-string extraction.
- Add Connect-RPC probing for richer runtime state.
- Improve task-to-workspace attribution.
- Add a higher-level supervisor API on top of the bus.
- Add Linux and Windows support where possible.

## Safety Notes

- The current implementation reads local Antigravity app state from your machine.
- It does not upload that state anywhere by itself.
- Be careful before sharing snapshots publicly, because local paths and account metadata may be present.

## Example

See [sample-snapshot.json](/Users/caozheng/cowork-flie/antigravity-bus/examples/sample-snapshot.json).
