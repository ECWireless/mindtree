# Session Workflow

MindTree work may continue across Codex sessions, branches, commits, and pull
requests, so every session rebuilds its context before implementation.

## Sources of truth

- `SPEC.md` defines approved product behavior, boundaries, and architecture.
- `IMPLEMENTATION_PLAN.md` defines the temporary phase and dependency sequence
  until its required deletion at v0.1.0 release readiness.
- This workflow defines planning, verification, review, evaluation, and
  publication for each PR-sized unit.
- Older attachments, handoffs, brainstorms, and chat history are context, not
  authority, unless the user promotes a decision into the specification.

When the implementation plan and specification differ, stop and resolve the
conflict. Update the durable specification before implementing newly approved
product behavior.

## Start every session this way

Before editing files:

1. Read `SPEC.md`, `IMPLEMENTATION_PLAN.md` while present, this workflow, and
   `docs/model-effort-workflow.md`.
2. Recommend the lowest adequate effort level.
3. Confirm the current branch and worktree state.
4. Identify likely change directories and read every applicable nested
   `AGENTS.md`.
5. Identify the current release or change objective, including the active plan
   phase while a plan exists, and confirm the current PR-sized unit with the
   user.
6. Debrief:
   - intended user-visible outcome;
   - explicit non-goals and stopping point;
   - technical approach and open decisions;
   - expected files, schema, migrations, services, dependencies, and model
     profiles;
   - data, privacy, security, provider, and cost effects;
   - verification, deterministic provider tests, live evaluation if any, and
     manual QA;
   - commit and PR boundary;
   - proportional independent-review gate.
7. Break the unit into sequential tasks.
8. Propose the intended commit sequence. Split work into multiple PR-sized
   units when it would otherwise be uncomfortable to review.
9. Wait for explicit approval before implementation.

## Work planning checklist

Before writing code, agree on:

- unit goal, acceptance criteria, and user-visible outcome;
- effort recommendation;
- technical approach;
- dependency and external-service changes;
- schema, migration, compatibility, and rollback effects;
- environment-variable names without secret values;
- prompt, structured-output, tool, and citation contract changes;
- fixtures and synthetic evaluation cases;
- automated verification and manual QA;
- commit strategy and PR boundary;
- independent-review strategy.

Explain and obtain agreement before choosing a new framework, dependency,
external service, datastore, model, reasoning profile, embedding dimension, or
foundational pattern.

## Implementation rules

- Keep work within the agreed PR-sized unit and current release or change
  objective.
- Do not begin the next unit without a new debrief and approval.
- Do not install dependencies until their purpose is agreed.
- Do not start a development server unless the user expects a preview or it is
  required for agreed verification.
- Preserve ignored local configuration.
- Keep tracked documentation generic and synthetic.
- Use deterministic OpenAI-client fixtures for normal tests. Do not make paid
  or data-bearing live calls unless the user approved the exact evaluation.
- Preserve the distinction between assistant chat, pending synthesis proposal,
  and published synthesis at every layer.
- Prefer idempotent request boundaries and explicit version checks over
  optimistic assumptions about long-running generation.
- Use server-side authorization and validation for every owner-scoped resource;
  client UI restrictions are never the only guard.
- Keep `main` as the approved baseline and use a focused conventional branch
  prefix directly: `feat/...`, `fix/...`, `docs/...`, `chore/...`,
  `refactor/...`, or `test/...`, unless the user directs otherwise. Never add
  an agent or vendor namespace such as `codex/`.
- Use conventional commit messages.

## Verification layers

Choose checks in proportion to risk:

1. **Static:** formatting if configured, lint, generated route types, strict
   TypeScript, and production build.
2. **Unit:** pure tree, context, diff, citation, staleness, and rendering logic.
3. **Integration:** PostgreSQL ownership, transactions, constraints, races, and
   mutation behavior.
4. **Provider contract:** deterministic streamed Responses API fixtures,
   structured output, web annotations, refusals, malformed data, and retries.
5. **Browser:** primary owner workflows at agreed desktop and mobile widths.
6. **Live evaluation:** only when separately approved, using synthetic trees,
   bounded calls, explicit success criteria, and no private repository data.
7. **Deployment:** only with explicit target and mutation approval.

Record the exact commands, environment assumptions, passed checks, failures,
and intentional omissions.

## Review and closeout

Before declaring a commit unit complete:

1. Run the agreed verification.
2. Review the diff for correctness, regression risk, accessibility,
   maintainability, unnecessary complexity, and phase compliance.
3. Perform a privacy and security pass:
   - local environments and secrets remain ignored;
   - credentials, prompts, user content, raw provider data, private URLs, and
     machine paths are absent from tracked files and logs;
   - external calls and stored data are intentional;
   - authorization, citation validation, Markdown sanitization, and approval
     boundaries remain server-enforced;
   - public share links stay revocable, subtree-scoped, and read-only; shared
     fields use an explicit allowlist, and structured out-of-scope citation
     identities remain undisclosed.
4. Run the fresh-context independent-review gate below.
5. Resolve accepted findings and rerun affected checks.
6. Report the review disposition and propose exact user-facing, browser,
   live-provider, or deployment QA. Obtain approval before performing it.
7. Perform the approved agent-led QA and resolve accepted findings.
8. For every commit containing a new UI feature, give the user a concrete
   manual QA checklist and wait for them to complete it before requesting
   commit approval. Agent-led browser checks never replace this owner QA gate.
9. Rerun affected verification and obtain focused independent re-review for
   material post-review changes.
10. Review every change made since the independent-review snapshot.
11. Summarize changes, evidence, deviations, and remaining work.
12. Obtain explicit approval before staging or committing.

Prepare one sequential commit unit at a time. Complete its verification,
independent review, approved QA, and commit approval before implementing the
next commit unit. Staging, committing, pushing, PR changes, merging, tagging,
and releasing retain separate approval boundaries.

Read `docs/pr-review-workflow.md` before working with PR feedback.

## Independent-review gate

Run independent review after a commit unit's implementation and automated
verification, before user-facing QA, commit approval, or the next unit.

### Reviewer count

- Use one fresh-context, read-only reviewer for a normal unit.
- Use two reviewers with distinct specialties when work materially changes
  authentication, authorization, privacy, security, migrations, synthesis
  approval, citation provenance, data integrity, external tools, or AI-provider
  behavior.
- Add reviewers only when responsibilities are distinct.

Useful specialties:

- **Technical:** correctness, transactions, failure modes, tests, architecture,
  performance, dependencies, and scope.
- **Security and AI integrity:** auth, ownership, secrets, prompts, untrusted
  evidence, citations, approval boundaries, public share responses, provider
  data, and external calls.
- **Experience:** user behavior, accessibility, responsive layout, keyboard and
  touch use, chat streaming, diff clarity, and recovery states.

### Review procedure

1. Finish implementation and automated verification.
2. Freeze implementation edits during review.
3. Give reviewers the approved goal, acceptance criteria, stopping point,
   relevant specification sections, active plan phase while a plan exists, and
   complete diff.
4. Keep reviewers read-only.
5. Require evidence-based findings with severity, tight file and line
   references where applicable, violated contract or risk, and concise
   correction direction.
6. Classify findings:
   - **P0:** catastrophic or unsafe; blocks acceptance immediately.
   - **P1:** material correctness, security, privacy, data-loss, or approval
     boundary risk; blocks merge.
   - **P2:** important scope, maintainability, testing, accessibility, or
     operational issue; normally fix before merge.
   - **P3:** minor improvement that may be fixed or explicitly deferred.
7. Evaluate every finding rather than accepting it automatically.
8. Apply agreed fixes and rerun affected verification.
9. Request focused re-review of material fixes and disputed findings.
10. Report deferred or unresolved findings to the user. Record them durably
    only when approved.

If independent agents are unavailable, perform a distinct fresh-context review
pass and disclose that it was not independently delegated.

## Plan retirement

`IMPLEMENTATION_PLAN.md` is intentionally temporary. Delete it only in the
final release-readiness commit unit after:

- every implementation phase and acceptance gate is complete;
- durable behavior is represented in `SPEC.md` and maintained documentation;
- deferred work is either removed from v0.1.0 scope or recorded in an approved
  durable location;
- final verification and proportional independent review pass;
- any paid live evaluation or additional owner QA selected for the release is
  complete, or the owner explicitly waives it based on the release evidence;
- the repository version is ready for `0.1.0`.

Its deletion does not authorize a tag. Tagging follows the separate workflow
and explicit approval after the release commit is on reviewed `main`.
