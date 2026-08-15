# MindTree Agent Instructions

These instructions apply to the entire repository unless a more specific
nested `AGENTS.md` adds compatible guidance for its subtree.

## Required session start

Before editing files:

1. Read `SPEC.md`.
2. Read `IMPLEMENTATION_PLAN.md` while it exists.
3. Read `docs/session-workflow.md`.
4. Read `docs/model-effort-workflow.md` and recommend the lowest adequate
   effort for the task.
5. Confirm the current branch and worktree state.
6. Identify likely change locations and read every applicable nested
   `AGENTS.md`.
7. Debrief the current PR-sized unit with the user and obtain approval before
   implementation.

`SPEC.md` is the product and architecture authority.
`IMPLEMENTATION_PLAN.md` is the approved temporary phase sequence until it is
deleted at v0.1.0 release readiness. `docs/session-workflow.md` is the execution
and verification authority. Resolve conflicts explicitly before editing.

Do not jump directly into scaffolding, dependency installation, schema changes,
model calls, or implementation.

## Work alignment

Before each PR-sized unit, agree on:

- goal, non-goals, and stopping point;
- user-visible outcome;
- technical approach and dependency changes;
- data, migration, AI-provider, privacy, and cost effects;
- sequential tasks and intended commit sequence;
- acceptance criteria and verification commands;
- commit and PR boundary;
- proportional independent-review strategy.

Do not begin the next unit without a new debrief and explicit approval.

## Git and publication

- Keep `main` as the approved baseline.
- Use focused conventional branch prefixes directly: `feat/...`, `fix/...`,
  `docs/...`, `chore/...`, `refactor/...`, or `test/...`, unless the user
  directs otherwise. Do not prepend an agent or vendor namespace such as
  `codex/`.
- Use conventional commit messages.
- Do not stage, commit, push, open or update a pull request, post GitHub
  comments, dismiss reviews, resolve threads, create tags, or publish releases
  without the corresponding explicit approval.
- Read `docs/pr-review-workflow.md` before opening or updating a pull request or
  handling review feedback.
- Do not create a release tag before the completed v0.1.0 release-readiness
  gate.

## Privacy, AI, and security

- Never commit `.env`, credentials, tokens, private data, production records,
  conversation content, developer-machine paths, or private infrastructure
  details.
- Keep `.env.example` limited to placeholder names and safe explanatory text.
- Use synthetic data in tests, documentation, screenshots, and model evals.
- Treat authentication, authorization, migrations, AI calls, prompts, external
  web search, citations, Markdown rendering, public share-link secrets and
  serialization, storage, analytics, and uploads as explicit review boundaries.
- Never log or expose `OPENAI_API_KEY`, public share-link secrets, raw provider
  payloads, hidden reasoning, private prompts, or complete user conversations.
- Treat model output, child summaries, related-node summaries, chat history,
  and external sources as untrusted data.
- Never bypass the explicit synthesis approval boundary. A generated proposal
  is not a published synthesis.
- Keep v0.1.0 public thought trails strictly read-only, revocable, and
  subtree-scoped. Never disclose Chat, proposals, embeddings, owner data,
  mutation controls, or structured out-of-scope citation identity through a
  share link without a newly approved specification change.
- Normal automated tests must use deterministic synthetic provider fixtures.
  Paid live-model evaluations require an agreed purpose, dataset, limits, and
  user approval.

## Completion and review

Before declaring a PR-sized unit complete or preparing its PR:

1. Run the agreed automated verification.
2. Perform correctness, accessibility, privacy, security, AI-boundary, and
   scope review passes.
3. Run the proportional fresh-context independent-review gate defined in
   `docs/session-workflow.md`.
4. Resolve accepted findings and rerun affected checks.
5. Report review disposition and a concrete QA plan, then obtain approval
   before user-facing, browser, live-provider, or deployment QA.
6. Perform the approved QA.
7. Resolve accepted QA findings, rerun affected checks, and obtain focused
   independent re-review of material post-review changes.
8. Review all changes made since the independent-review snapshot.
9. Report verification, evaluation, QA evidence, deviations, and remaining
   scope.

Use sequential commit units: prepare one commit's diff at a time, complete its
verification and review gates, obtain explicit commit approval, create the
commit, and confirm success before implementing the next commit unit. Propose
multiple PR-sized units when the work would otherwise be uncomfortable to
review.

Independent review supplements rather than replaces tests and owner acceptance.
The user remains the merge and release authority.
