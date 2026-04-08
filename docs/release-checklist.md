# Release Checklist

Use this checklist before publishing any new `antigravity-bus` release.

The goal is not just to cut a tag. The goal is to ship a version that is internally consistent across code, docs, tests, and GitHub metadata.

## 1. Scope And Readiness

- Confirm the release scope is intentionally small and reviewable
- Confirm the release has a clear user-facing purpose
- Confirm there are no unrelated local changes in the worktree
- Confirm any risky or incomplete follow-up work is explicitly documented as out of scope

## 2. Versioning

- Update the version in [package.json](../package.json)
- Confirm the planned tag matches the package version, for example `v0.1.1`
- Decide whether the release is:
  - a patch release
  - a minor release
  - a pre-release

If the project behavior changes in a user-visible way, make sure the version bump reflects that.

## 3. Quality Checks

- Run the test suite:

```bash
npm test
```

- Run a local CLI sanity check:

```bash
node ./src/index.mjs discover
node ./src/index.mjs snapshot --cwd /absolute/path/to/workspace
```

- Confirm recent CI runs are green on GitHub Actions
- If a parsing bug was fixed, make sure a regression test was added

## 4. Documentation Review

- Confirm [README.md](../README.md) matches the current CLI behavior
- Confirm examples still reflect real output shape
- Confirm [docs/architecture.md](./architecture.md) still matches the current data flow
- Confirm [CONTRIBUTING.md](../CONTRIBUTING.md) and [SECURITY.md](../SECURITY.md) still reflect project policy
- If the release changes usage or scope, add a short note to the release body

## 5. Repository Hygiene

- Confirm `CODEOWNERS`, issue templates, and PR template still make sense for the current maintainer model
- Confirm repository description and topics still match the project positioning
- Confirm the default branch is clean and pushed

## 6. Git And Tagging

- Commit the release-ready changes
- Create an annotated tag:

```bash
git tag -a vX.Y.Z -m "vX.Y.Z"
```

- Push the branch and the tag:

```bash
git push origin main
git push origin vX.Y.Z
```

## 7. GitHub Release

- Create or update the GitHub release for the new tag
- Use a release title that matches the tag, for example `v0.1.1`
- Include:
  - a one-paragraph summary
  - the main highlights
  - known limitations
  - any migration or upgrade notes if relevant

Suggested structure:

- What changed
- Why it matters
- Known limitations
- Quick start or verification notes

## 8. Post-Release Verification

- Open the release page and confirm the tag, title, and notes are correct
- Confirm the README badge still renders correctly
- Confirm the latest CI run for the release commit is green
- Confirm the repository landing page still presents the project clearly to a first-time visitor

## 9. If Something Goes Wrong

- If the issue is documentation-only, ship a follow-up patch release quickly
- If the issue is a broken tag or release note, fix the GitHub release metadata immediately
- If the issue is a functional regression, open a public issue and prepare a patch release
- If the issue involves sensitive output or disclosure risk, follow [SECURITY.md](../SECURITY.md) before discussing details publicly

## Maintainer Notes

For early-stage releases, it is better to ship smaller, clearer versions more often than to batch too much uncertain work into one tag.
