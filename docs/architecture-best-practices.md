# antigravity-bus Architecture Best Practices

This document captures the refactoring direction for `antigravity-bus` based on patterns used by mature open-source workflow and CLI systems.

## Why this exists

The current [`src/index.mjs`](../src/index.mjs) has grown into a single-file implementation that mixes:

- CLI argument parsing
- Antigravity process discovery
- bridge queue routing
- supervisor state derivation
- approval/remediation orchestration
- snapshot generation
- git-based result inspection

This works, but it makes future changes harder to reason about and increases the risk of accidentally breaking a neighboring concern.

## Open-source patterns worth adopting

### 1. Model orchestration as an explicit state machine

State-machine tools such as XState treat workflow logic as event-driven transitions between explicit states instead of ad-hoc condition trees. Their docs emphasize predictable transitions, actors, and inspection APIs.

For `antigravity-bus`, that means we should represent supervisor behavior explicitly:

- `idle`
- `dispatched`
- `running`
- `waiting_for_user`
- `auto_approving`
- `remediating`
- `completed`
- `completed_without_acceptance`
- `failed`
- `timeout`

The most important rule: keep transition logic pure and side effects outside the reducer.

### 2. Treat dispatches like jobs with a lifecycle

Queue systems such as BullMQ document a clear lifecycle for work items: `wait -> active -> completed|failed`.

For `antigravity-bus`, every dispatch should become a first-class run record with:

- `requestId`
- `workspace`
- `workerId`
- `createdAt`
- `currentState`
- `events[]`
- `resultSummary`

This is better than inferring everything from scattered snapshots after the fact.

### 3. Persist result summaries even when terminal signals are weak

Durable workflow systems such as Temporal and Trigger.dev focus on preserving execution state, retries, and resumability instead of assuming a clean terminal callback will always arrive.

For us, that means:

- always persist a run summary
- always capture workspace change evidence
- treat “sent prompt successfully” and “finished successfully” as different milestones
- allow completion to degrade gracefully into “execution evidence captured, terminal signal missing”

### 4. Separate observation from control

Inspection tooling in XState distinguishes actor lifecycle, events, snapshots, and microsteps.

We should do the same conceptually:

- observation layer: build snapshots, read bridge status, inspect git changes
- control layer: dispatch prompt, execute approval command, start remediation
- policy layer: infer whether a run is completed, waiting, failed, or timed out

### 5. Split CLI surface into commands/topics, not one giant entrypoint

oclif recommends organizing larger CLIs into commands/topics and shared base error handling instead of one monolithic command file.

Even if we do not migrate to oclif immediately, we should borrow the structure:

- `snapshot`
- `dispatch`
- `bridge`
- `supervisor`
- `doctor`

Each command should call a focused module rather than owning the orchestration logic itself.

## Proposed code structure

Suggested target layout:

```text
src/
  cli/
    main.mjs
    parse-args.mjs
    print-usage.mjs
  antigravity/
    discover.mjs
    ipc.mjs
    topics.mjs
    snapshot.mjs
  bridge/
    paths.mjs
    requests.mjs
    workers.mjs
    responses.mjs
  supervisor/
    machine.mjs
    transitions.mjs
    completion-policy.mjs
    approvals.mjs
    remediation.mjs
    result-summary.mjs
  acceptance/
    checks.mjs
    skin-saas.mjs
  vcs/
    workspace-changes.mjs
  index.mjs
```

## Non-negotiable engineering rules

### Rule 1: Pure transition logic

State derivation should be testable without touching disk, git, sockets, or Antigravity.

Good:

- `deriveSupervisorState(input) -> nextState`
- `shouldAutoApprove(snapshot) -> boolean`
- `summarizeCompletion(snapshot, workspaceChanges) -> result`

Bad:

- state functions that also read files or send bridge commands

### Rule 2: One place for side effects

Bridge writes, command execution, file reads, and git inspection should live in effect modules, not in policy code.

### Rule 3: Every run gets a result artifact

Each dispatch should produce a machine-readable artifact such as:

```json
{
  "requestId": "bridge-...",
  "workspace": "/abs/path",
  "workerId": "pid-...",
  "state": "timeout",
  "reason": "Terminal signal missing, but execution evidence was captured.",
  "workspaceChanges": {
    "dirtyFileCount": 5,
    "dirtyFiles": ["..."]
  },
  "events": []
}
```

This becomes the stable contract for Codex.

### Rule 4: Prefer append-only event history over implicit reconstruction

Instead of only recomputing from the latest snapshot, store run events such as:

- `dispatch_sent`
- `bridge_ack`
- `running_observed`
- `waiting_observed`
- `approval_attempted`
- `approval_resolved`
- `remediation_sent`
- `workspace_changes_observed`
- `terminal_state_observed`

Then derive the latest status from that event stream.

### Rule 5: Keep acceptance checks pluggable

`skin-saas` should remain one acceptance policy, not a hardcoded assumption throughout the supervisor.

We should move toward:

- `evaluateAcceptanceChecks(cwd, tasks, profile?)`
- profile-specific check sets

## Recommended implementation order

### Phase 1: Extract the supervisor machine

- Move completion and remediation policy into `src/supervisor/*`
- Keep current behavior
- Add no new features

### Phase 2: Introduce run artifacts

- Persist one JSON result per dispatch
- Include `workspaceChanges`
- Include approval/remediation attempts

### Phase 3: Split bridge and snapshot modules

- Isolate worker routing
- Isolate bridge request/response logic
- Isolate snapshot assembly

### Phase 4: Simplify the CLI entrypoint

- Make `src/index.mjs` a thin compatibility wrapper
- Move command implementations into dedicated files

### Phase 5: Optional CLI framework migration

- Consider oclif only after the internal module boundaries are stable
- Do not couple refactoring success to framework migration

## What “good” looks like for this repo

When this refactor is done well:

- `src/index.mjs` becomes a thin shell, not the system
- completion logic is understandable as a finite set of transitions
- every dispatch yields a durable result summary
- Codex can consume a run artifact instead of scraping snapshots
- adding a new approval strategy does not require editing unrelated code
- adding a new acceptance profile does not touch bridge routing

## Sources

- XState overview: https://stately.ai/docs/xstate
- XState inspection API: https://stately.ai/docs/inspection
- BullMQ job lifecycle: https://docs.bullmq.io/guide/architecture
- Temporal durable execution overview: https://temporal.io/
- Trigger.dev checkpoint-resume and durable execution: https://trigger.dev/docs/how-it-works
- oclif topics: https://oclif.io/docs/topics/
- oclif error handling: https://oclif.io/docs/error_handling/
- oclif plugins: https://oclif.io/docs/plugins/
