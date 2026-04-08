# Security

## Supported Versions

Security fixes currently target the latest state of the default branch.

Because the project is still in an early MVP stage, older snapshots or unpublished local copies should not be assumed to receive fixes.

## What This Tool Reads

`antigravity-bus` reads local machine state from Antigravity-related sources, including:

- process command lines
- Antigravity SQLite state
- local artifact file paths
- local language server logs

That means snapshot output can expose sensitive information such as:

- absolute paths
- workspace names
- task summaries
- auth-adjacent state flags
- machine-local metadata

## Safe Usage Guidance

- Treat generated snapshots as sensitive by default
- Redact paths, IDs, and task text before publishing examples
- Avoid committing real machine snapshots into public repositories
- Review `events.jsonl` and `latest.json` before sharing them with others

## Reporting A Vulnerability

For now, please report vulnerabilities privately to the maintainer before opening a public issue.

A useful report should include:

- affected version or commit
- impact summary
- reproduction steps
- whether sensitive local state can be exposed, modified, or misattributed

## Current Security Boundaries

The current MVP is read-only with respect to Antigravity state.

It does not attempt to:

- mutate Antigravity local storage
- impersonate user actions
- upload data to a remote service

That said, incorrect parsing can still lead to accidental disclosure if users share snapshots without reviewing them first. Documentation and output hygiene matter just as much as code correctness here.
