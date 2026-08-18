# Release Tagging Workflow

MindTree releases use [Semantic Versioning](https://semver.org/) with a
`v`-prefixed Git tag such as `v0.1.0`.

This policy is adapted from TimeTree's release workflow, which was itself
adapted from RaidGuild Accounting.

## Policy

- MindTree creates no tags before the completed v0.1.0 release-readiness gate.
- Release tags point only to reviewed commits on `main`.
- The version in `package.json` matches the tag without the `v` prefix.
- Release tags are annotated and immutable after publication.
- Tags are intentional release actions, not automatic results of merges.
- Push the exact tag rather than `git push --tags`.
- Staging, committing, pushing `main`, creating a tag, pushing a tag, and
  creating a GitHub Release each require explicit approval unless the user
  explicitly combines named actions.

Ordinary feature, fix, documentation, and maintenance branches do not increment
the version independently. Before a later release tag, use a dedicated reviewed
release-preparation change to:

1. choose the next version;
2. set or confirm it in `package.json`;
3. add migration, compatibility, model, or release notes;
4. pass normal verification, review, evaluation, and QA gates;
5. confirm the durable specification matches shipped behavior.

While the project remains on `0.x`:

- increment patch for backward-compatible fixes and documentation;
- increment minor for new product capabilities or breaking changes;
- use prerelease identifiers such as `v0.2.0-rc.1` when useful.

## Prepare v0.1.0

The final v0.1.0 release-readiness unit must:

1. Complete the agreed v0.1.0 scope and release gates.
2. Confirm durable product behavior in `SPEC.md` and maintained documentation.
3. Run the full automated suite and proportional independent reviews. Complete
   or explicitly waive additional owner QA and synthetic live-model evaluation
   based on the release evidence.
4. Confirm no secret, private content, provider payload, or developer-machine
   data is tracked.
5. Set or confirm `package.json` version `0.1.0`.
6. Delete `IMPLEMENTATION_PLAN.md` in the reviewed release-readiness diff.
7. Merge the approved release-readiness commit to `main`.

The plan's deletion marks implementation-plan completion; it does not create or
authorize the tag.

## Prepare later releases

1. Create a dedicated release-preparation branch from current reviewed `main`.
2. Choose and set the next version.
3. Include required release, migration, model, or compatibility notes.
4. Pass repository verification and review gates.
5. Merge the reviewed release commit to `main`.
6. Fast-forward a clean local `main` after approval:

   ```bash
   git switch main
   git pull --ff-only origin main
   ```

## Verify tag preconditions

Set the intended tag explicitly, then verify branch, version, remote parity,
and tag absence. For v0.1.0:

```bash
TAG=v0.1.0
test "$(git branch --show-current)" = "main"
test "$(node -p "require('./package.json').version")" = "${TAG#v}"
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test -z "$(git tag --list "$TAG")"
test -z "$(git ls-remote --tags origin "refs/tags/$TAG")"
```

Each command must succeed. Confirm the exact reviewed commit and final release
evidence with the user before creating the tag.

## Create and verify an annotated tag

After explicit approval:

```bash
TAG=v0.1.0
git tag -a "$TAG" -m "Release $TAG"
```

Verify the annotation and target:

```bash
TAG=v0.1.0
test "$(git cat-file -t "$TAG")" = "tag"
git show --no-patch --decorate "$TAG"
git rev-list -n 1 "$TAG"
git rev-parse HEAD
```

The final two commands must identify the same commit.

## Publish

After separate publication approval, push reviewed `main` and then the exact
tag:

```bash
TAG=v0.1.0
git push origin main
git push origin "refs/tags/$TAG"
```

Create a GitHub Release only when separately approved. Release notes mention
material migrations, compatibility limits, model configuration, and known
issues without exposing operational secrets.

## Correcting mistakes

If an incorrect tag has not been pushed, delete it locally and recreate it
after approval:

```bash
TAG=v0.1.0
git tag -d "$TAG"
```

Do not silently move or force-push a published release tag. Correct released
code with a new reviewed commit and next patch version. Exceptional published
tag removal requires explicit coordination and documentation.
