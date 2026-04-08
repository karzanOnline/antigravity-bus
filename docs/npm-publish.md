# npm Publish Guide

Use this guide when publishing `antigravity-bus` to npm for the first time or for later updates.

## Current Status

- Package name: `antigravity-bus`
- Registry availability: currently unclaimed at the time this guide was prepared
- Publish visibility: public

## Preconditions

Before publishing, make sure:

- you are on a clean `main` branch
- the intended version is already set in [package.json](../package.json)
- the GitHub release flow is complete or nearly complete
- you are logged into npm on the machine you are using

You can check npm auth with:

```bash
npm whoami
```

If that fails, log in with:

```bash
npm login
```

## Local Validation

Run the pre-publish checks:

```bash
npm run release:check
```

This currently does two things:

- runs the test suite
- builds an npm tarball in dry-run mode

The project also enforces this via `prepublishOnly`, so `npm publish` will fail fast if these checks do not pass.

## First Publish

For the initial public publish:

```bash
npm publish
```

Because [package.json](../package.json) already includes:

```json
"publishConfig": {
  "access": "public"
}
```

you do not need to pass `--access public` manually.

## Subsequent Releases

For each later release:

1. Update the version in [package.json](../package.json)
2. Run `npm run release:check`
3. Commit and tag the release
4. Push `main` and the release tag
5. Publish with `npm publish`
6. Update the GitHub release notes if needed

## Recommended Maintainer Flow

```bash
npm test
npm run pack:dry-run
git status
npm whoami
npm publish
```

## Post-Publish Verification

After publishing:

- confirm the package page exists on npm
- confirm `npm view antigravity-bus version` returns the expected version
- confirm the README renders correctly on npm
- confirm the CLI install path works from a clean shell
- confirm `npx antigravity-bus --help` prints usage
- confirm `antigravity-bus --version` returns the published version

Example verification:

```bash
npm view antigravity-bus version
```

## Common Failure Modes

### Not logged in

`npm whoami` fails with `ENEEDAUTH`.

Fix:

```bash
npm login
```

### Version already exists

npm will reject publishing the same version twice.

Fix:

- bump the version in [package.json](../package.json)
- retag or create a new release if needed

### Unexpected files in tarball

`npm pack --dry-run` shows files you do not want to publish.

Fix:

- tighten the `files` list in [package.json](../package.json)
- rerun `npm run pack:dry-run`

## Notes

At the time this guide was written, local dry-run packaging succeeded, but npm auth was not yet configured on the machine. That means the repository is publish-ready, but the actual publish step still depends on a valid npm login.
