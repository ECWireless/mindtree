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

## Public-sharing review questions

For changes touching shareable thought trails, reviewers verify that:

- share-link creation and revocation require the authorized owner session, and
  the plaintext capability secret is unguessable, never stored, and excluded
  from logs, analytics, tracked files, and error bodies;
- every public request validates the link, selected root, revocation state, and
  current subtree membership before rendering;
- the public representation uses an explicit field allowlist and contains only
  current in-scope node structure, titles, approved Summaries, Branch Outlines,
  validated external links, and published References;
- Chat, proposal and synthesis history, diffs, embeddings, owner identity,
  model metadata, share records, and mutation or generation controls cannot
  leak through markup, serialized props, browser data, or errors;
- internal links remain clickable only for current in-scope targets;
  out-of-scope or deleted targets retain plain text without target identifiers,
  titles, revision details, destinations, or inference-friendly errors;
- scope changes after moves and root deletion, plus concurrent read/revoke
  behavior, follow the approved dynamic-subtree contract;
- approved Summary and Branch Outline prose is not misrepresented as semantic
  data-loss prevention over content the owner deliberately shared;
- cache, indexing, referrer, archive-visibility, response-size, absent/revoked
  state, and deep-tree decisions match the approved phase contract; and
- deterministic tests cover creation, copy, public navigation, dynamic scope,
  external References, malformed and revoked links, response bounds, privacy
  exclusions, and revocation.

## Reply style

Good replies are brief and evidenced:

- `Addressed in abc1234 by checking the proposal's source revisions inside the approval transaction. Verified with the focused integration race test.`
- `Leaving this unchanged because SPEC.md requires web access to remain explicitly enabled per turn; the browser test covers that boundary.`
- `Partially addressed: the UI now blocks the invalid citation, while the server validator remains the authoritative guard.`

Avoid vague replies such as `Fixed`, unnecessary implementation narration,
sensitive values, or resolving threads without permission.
