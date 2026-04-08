# Contributing

Thanks for helping improve `antigravity-bus`.

This project is still early and intentionally small. Good contributions are usually the ones that make the tool more observable, more predictable, or easier to validate.

## What We Value

- Small, reviewable changes
- Clear behavior over cleverness
- Conservative parsing over overconfident inference
- Good docs for any new capability
- Tests for logic that is easy to regress

## Local Setup

```bash
git clone https://github.com/karzanOnline/antigravity-bus.git
cd antigravity-bus
npm test
```

The repository currently has no npm runtime dependencies, so the setup should stay lightweight.

## Before You Open A PR

- Make sure the relevant tests pass with `npm test`
- Add or update tests when touching parsing or snapshot-writing logic
- Keep comments concise and only where the code would otherwise be hard to follow
- Update `README.md` if the user-facing behavior changes
- Update [docs/architecture.md](./docs/architecture.md) if the data flow or trust boundaries change

## Scope Guidance

Changes that fit the current project well:

- process discovery improvements
- safer or more accurate local state decoding
- better task attribution heuristics
- clearer snapshot semantics
- improved test coverage
- documentation and contributor tooling

Changes that should usually start as an issue or design discussion:

- remote execution or control features
- behavior that writes back into Antigravity state
- cross-platform support with significantly different storage layouts
- schema assumptions that depend on undocumented internals

## Pull Request Notes

Please keep pull requests focused.

If a change spans implementation and docs, that is fine. If it also adds a new subsystem, split it unless the parts are tightly coupled.

Useful PR descriptions usually include:

- the problem being solved
- the observable behavior change
- how you tested it
- any local Antigravity assumptions you relied on

## Reporting Bugs

If possible, include:

- macOS version
- Node.js version
- whether `sqlite3` is available on your machine
- the command you ran
- a redacted snapshot sample or log excerpt if relevant

Please remove any secrets, account data, or sensitive local paths before sharing output.
