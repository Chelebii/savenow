<!-- Thanks for the PR. Please fill in the sections below. Delete any that don't apply. -->

## What this changes

<!-- One or two sentences. What does this PR do, in user-facing terms? -->

## Why

<!-- The motivation: bug it fixes, feature it adds, doc gap it closes. Link the issue if there is one (Fixes #123). -->

## How to verify

<!-- Concrete steps a reviewer can follow. Include sample input/output if useful. -->

```bash
node tests/run.mjs
```

## Checklist

- [ ] Tests pass locally (`node tests/run.mjs`).
- [ ] Added or updated tests for the change.
- [ ] Updated `CHANGELOG.md` under an `## Unreleased` section if the change is user-visible.
- [ ] Updated `README.md` / `SKILL.md` if behavior or commands changed.
- [ ] No new runtime dependencies (this project is intentionally zero-dependency).
- [ ] Backward compatible with the existing entries JSON shape (`{ title, bullets }`).

## Notes for the reviewer

<!-- Anything else worth knowing: tricky decisions, follow-ups deferred, etc. -->
