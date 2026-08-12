# Pull Request Review Workflow

Use this workflow when inspecting or addressing GitHub pull-request feedback.

## Safety and authority

- Never expose credentials, private data, production records, conversations,
  syntheses, prompts, provider payloads, or local infrastructure details in
  chat, logs, commits, tests, screenshots, or GitHub replies.
- Prefer repository-scoped credentials with the minimum required permissions.
- Keep authentication in approved local tooling, environment variables, or
  ignored files.
- Do not stage, commit, push, post GitHub comments, dismiss reviews, resolve
  threads, merge, tag, or release without the corresponding explicit user
  approval.

## Flow

1. Fetch all unresolved review threads.
   - Preserve thread IDs, file paths, line anchors, resolution state, and
     outdated state.
   - Do not rely only on flat comment lists when thread state matters.

2. Summarize the review map before editing.
   - List each actionable thread.
   - Explain what it claims, whether it appears accurate, and the intended
     response.
   - Separate duplicates, outdated comments, informational notes, and ambiguous
     requests from actionable findings.

3. Validate each finding against the approved contract.
   - Inspect `SPEC.md`, the active phase in `IMPLEMENTATION_PLAN.md` while it
     exists, relevant code, tests, migrations, prompts, and provider fixtures.
   - Do not assume the reviewer is correct.
   - Pause when feedback would broaden the approved phase or weaken the human
     synthesis-approval, citation, ownership, privacy, or security boundary.

4. Fix approved findings locally.
   - Keep each change traceable to its review thread.
   - Prefer cohesive fixes and verification over one commit per comment.
   - Do not update model versions, prompts, dependencies, schemas, or external
     behavior merely because a reviewer suggests it; validate the change
     against the approved scope.

5. Verify the selected fixes.
   - Run focused tests for narrow changes.
   - Run broader checks for shared behavior, migrations, authentication,
     authorization, synthesis approval, citations, Markdown, web search,
     provider handling, or data integrity.
   - Use deterministic synthetic provider fixtures unless a live evaluation is
     separately approved.
   - Record exactly which checks passed and which could not run.

6. Report local results before publication.
   - List fixed threads.
   - List intentionally unchanged or partially addressed threads with reasons.
   - List changed files and verification evidence.
   - Ask before staging, committing, pushing, or replying on GitHub.

7. Reply only after approval and publication.
   - When code changed, reply after the fix is pushed.
   - Include the commit SHA when available.
   - State what changed and what verification supports it, or why no change was
     made.
   - Leave resolution to the user unless explicitly delegated.

## AI-specific review questions

For changes touching chat or synthesis, reviewers verify that:

- generated output cannot update the published synthesis without explicit
  approval;
- approval checks the current base and every recorded source revision;
- internal citations reference only supplied, owner-scoped approved evidence;
- external links come from validated web-search annotations or exact visible
  spans mapped to the one authorized provider-fetched PDF URL;
- child summaries, chat, web results, and direct PDF content are treated as
  untrusted data;
- failures, refusals, malformed output, retries, and concurrency remain safe;
- prompts, conversations, provider payloads, and secrets are absent from logs;
- deterministic tests cover the behavior and any live evaluation was approved.

## Agent-access review questions

For changes touching scoped agent access, reviewers verify that:

- the agent surface exposes only the documented `GET` route and cannot mutate
  nodes, archive state, chat, proposals, syntheses, credentials, or any other
  application state;
- the credential is hashed at rest, shown only once, revocable and rotatable,
  and never reaches browser logs, server logs, tracked files, URLs, or error
  bodies;
- every request rechecks the credential, owner, selected root, and current
  subtree membership before serialization;
- the response is built from an explicit field allowlist and contains only
  tree structure and current approved synthesis data;
- chat, pending or historical proposals, embeddings, owner identity, model
  metadata, credential records, and structured out-of-scope node identities
  cannot leak;
- internal citation targets outside the credential scope are redacted without
  stable identifiers, titles, revision details, or inference-friendly error
  differences;
- approved synthesis prose is returned verbatim and is not misrepresented as
  semantic data-loss prevention;
- every non-GET method receives the specified `405`, and bounded
  node/citation/text/JSON ceilings prevent an authorized request from
  materializing unbounded work;
- one-time plaintext is no-store, never persisted, and cannot return through
  navigation or back/forward-cache restoration;
- deterministic tests cover creation, one-time display, dynamic scope after
  moves, archive visibility, rotation, revocation, malformed credentials,
  unsupported methods, size ceilings, and citation redaction.

## Reply style

Good replies are brief and evidenced:

- `Addressed in abc1234 by checking the proposal's source revisions inside the approval transaction. Verified with the focused integration race test.`
- `Leaving this unchanged because SPEC.md requires web access to remain explicitly enabled per turn; the browser test covers that boundary.`
- `Partially addressed: the UI now blocks the invalid citation, while the server validator remains the authoritative guard.`

Avoid vague replies such as `Fixed`, unnecessary implementation narration,
sensitive values, or resolving threads without permission.
