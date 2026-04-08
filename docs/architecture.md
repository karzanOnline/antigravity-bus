# Architecture

## Design Goal

`antigravity-bus` exists to turn local Antigravity runtime state into stable, machine-readable snapshots.

The project does not assume privileged integration points. Instead, it builds an observability model from data that already exists on the developer's machine.

## Current Data Sources

The MVP combines five sources:

1. Process discovery
2. SQLite state
3. Artifact files
4. Language server logs
5. Extension-server topic subscriptions

### 1. Process Discovery

The CLI scans `ps` output for `language_server_macos_arm` processes and extracts runtime flags such as:

- `pid`
- `workspace_id`
- `extension_server_port`
- `csrf_token`
- `cloud_code_endpoint`
- `app_data_dir`

This gives the bus a live view of what Antigravity instances exist right now.

### 2. SQLite State

Antigravity persists local state under:

```text
~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb
```

The current implementation reads a small number of keys, including:

- `jetskiStateSync.agentManagerInitState`
- `antigravityUnifiedStateSync.artifactReview`
- `antigravityUnifiedStateSync.userStatus`
- `antigravityAuthStatus`

Some values are base64-encoded opaque payloads. The MVP decodes them conservatively and extracts printable strings instead of pretending to fully understand the schema.

### 3. Artifact Files

Decoded state often points at files under local Antigravity brain directories. Those files are useful because they contain the most human-readable task evidence:

- task markdown
- artifact metadata
- lightweight progress signals

The current artifact reader only infers a small set of fields:

- file path
- updated time
- preview text
- simple checklist-derived status guesses

### 4. Language Server Logs

The CLI inspects recent `ls-main.log` lines from the latest Antigravity log directory and keeps a short list of relevant diagnostic signals.

This is intentionally narrow. The bus is trying to provide useful hints, not mirror every log line.

### 5. Extension-Server Topic Subscriptions

For workspace-backed instances, the CLI can now use the same local extension-server port Antigravity wires into its own app runtime.

The bus extracts:

- `workspace_id`
- `extension_server_port`
- `extension_server_csrf_token`

It then calls:

- unary JSON methods such as `Heartbeat`
- `SubscribeToUnifiedStateSyncTopic` with framed `application/connect+json` payloads

The current topic set is intentionally small and supervisor-oriented:

- `uss-activeCascadeIds`
- `trajectorySummaries`
- `uss-userStatus`
- `uss-lsClientMachineInfos`

This gives the bus a direct signal for whether a workspace currently has an active cascade, without depending on UI scraping.

## Snapshot Flow

Each `snapshot` call follows this rough sequence:

1. Discover running instances
2. Read selected SQLite state keys
3. Decode artifact references
4. Probe the workspace extension server when available
5. Build task summaries for the requested workspace
6. Normalize the result into one JSON payload

`watch` repeats that flow on an interval and persists two files:

- `latest.json`
- `events.jsonl`

`latest.json` is the newest full snapshot.

`events.jsonl` is a lightweight append-only stream that records change events only when the full normalized payload differs from the previous cycle.

## Attribution Strategy

Task-to-workspace attribution is conservative.

The manager-state payloads are not fully decoded yet, so the bus uses:

- direct workspace hints when present
- nearby local file URIs as fallback hints
- recent artifact activity as a final fallback

That means the system is intentionally biased toward under-reporting rather than inventing certainty.

## Why Local-First

The local-first design has a few benefits:

- easy to inspect
- easy to test
- no remote dependency required
- safer for early reverse-engineering
- simpler to plug into other supervisor tools

It also keeps the project useful even before any official API or RPC integration is available.

The new extension-server observer still follows that principle: it is local-only, workspace-scoped, and built around ephemeral ports and CSRF tokens that already exist on the machine.

## Planned Evolution

The likely next layer is broader runtime connectivity through more Connect-RPC methods and a stronger mapping from topic payloads to normalized supervisor states.

That future layer should sit on top of the current snapshot model, not replace it. The local snapshot is the stable substrate that downstream tools can already depend on.
