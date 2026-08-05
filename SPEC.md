# MindTree v0.1.0 Specification

Status: Approved for planning

This specification is the durable product and architecture authority for
MindTree v0.1.0. `IMPLEMENTATION_PLAN.md` describes the temporary delivery
sequence and is deleted when v0.1.0 is complete.

## Source reference

[ECWireless/TimeTree](https://github.com/ECWireless/timetree) at commit
[`51641ef1bc5de3e0f1d1a2ead168945d33fad47d`](https://github.com/ECWireless/timetree/commit/51641ef1bc5de3e0f1d1a2ead168945d33fad47d)
is MindTree's immutable primary source baseline for general UX, visual
language, application stack, and repository conventions. Relevant
implementation phases compare against that baseline and adapt its simple
interaction patterns rather than redesigning them without cause. Updating the
pin requires an approved specification change and a fresh divergence review.
MindTree's thought tree, chat, synthesis approval, citation, scoped
agent-access, and privacy contracts remain governed by this specification when
the products differ. TimeTree is MIT-licensed, copyright 2026 Coopa LLC;
adapted code, assets, and documentation preserve required license notices and
attribution.

## Product definition

MindTree is a private, self-hostable workspace for organizing thoughts, ideas,
and concepts as an infinitely nestable tree. Every node combines a persistent
conversation with a concise, explicitly approved synthesis.

The tree is the primary interface. Chat helps the owner develop a thought and
propose changes, but the owner decides what becomes part of the published
synthesis. MindTree is not a general-purpose notes app, document editor, or
autonomous research agent.

## Product principles

- **Extremely simple:** the core loop is select a node, discuss it, review a
  proposed synthesis change, and approve or reject it.
- **Human-published:** AI output is advisory until the owner explicitly
  approves it.
- **Recursive, not uncontrolled:** parent syntheses use approved child
  syntheses, while child changes make ancestors stale instead of silently
  rewriting them.
- **Traceable:** published claims can link to exact MindTree nodes and exact
  approved node revisions; externally researched claims retain clickable
  source citations.
- **Tree-first:** nodes, breadcrumbs, movement, search, archive visibility, and
  the final constellation view all reflect one ordered hierarchy.
- **Private by default:** one configured account may access a deployment in
  v0.1.0. Secrets, conversations, drafts, and syntheses are server-side data.

## Initial deployment

- The initial canonical deployment is a standard Next.js application hosted
  on Vercel with PostgreSQL hosted on Neon.
- Access is restricted to one configured, verified Google account per
  deployment.
- Runtime URLs, credentials, account allowlists, model identifiers, and
  database connections are environment configuration rather than constants.
- Product records retain a user identifier so the schema does not prevent
  future multi-user support.
- v0.1.0 does not include invitations, organizations, teams, roles,
  permissions, sharing, or account switching.
- MindTree is intended to be MIT-licensed and self-hostable.

## v0.1.0 scope

The authenticated owner can:

- Create, rename, move, reorder, archive, unarchive, and permanently delete
  nodes and subtrees.
- Create any number of root nodes and nest child nodes without a product-level
  depth limit.
- Expand, collapse, search, and navigate the tree using linkable node URLs.
- Open one persistent chat per node.
- Ask questions, develop ideas, and explicitly request external web sources in
  chat.
- Review an assistant response and an optional proposed synthesis revision.
- Compare a proposed synthesis with the currently published synthesis.
- Continue refining, reject, or explicitly approve a proposal.
- See which approved child and related-node revisions support a synthesis.
- Follow internal citations to their target nodes.
- Follow external citations and view them in a References section.
- See when a published synthesis is stale because an input node changed.
- Request a refresh proposal for a stale synthesis without automatically
  publishing it.
- Create, rotate, and revoke a read-only bearer key scoped to a selected node's
  current subtree.
- Let an explicitly connected coding agent read that subtree's structure and
  approved synthesis material without exposing chat or mutation authority.
- Switch to a read-only Node Constellation after the core tree and synthesis
  experience is complete.

## Explicit non-goals

v0.1.0 does not include:

- Autonomous publication or automatic approval of generated content.
- Background ancestor regeneration, recursive model-call cascades, cron jobs,
  queues, or workers.
- Agent API writes of any kind, including node creation, chat, proposal
  submission, approval, rename, movement, archive, or deletion.
- Raw chat access, pending/rejected synthesis access, embedding access, or
  owner identity through the agent API.
- An MCP server, public developer platform, OAuth API clients, general-purpose
  access tokens, or automatic external automation.
- Real-time multi-user collaboration, comments, mentions, notifications, or
  public links.
- Rich block editing, arbitrary files, image uploads, audio, canvases, tables,
  databases, templates, or a plugin system.
- Tags, priorities, due dates, reminders, tasks, kanban boards, or calendars.
- Branching chat conversations, multiple chats per node, or merging nodes.
- User-authored manual edits directly inside published synthesis text. Changes
  are requested in chat and published through the same proposal approval flow.
- Automatic external research. Web access is disabled for a turn unless the
  owner explicitly enables it.
- Training or fine-tuning models on MindTree data.
- A lower-quality automatic model fallback.
- Provider abstraction. v0.1.0 intentionally targets the chosen OpenAI models.
- Import, export, offline mode, native mobile apps, or browser extensions.
- Analytics, billing, token budgets, or cost dashboards.
- Formal visual-regression, load-testing, or broad cross-browser services.

## Tree behavior

### Structure and ordering

- Nodes may be roots or children of another node.
- Root nodes and every sibling group have an explicit owner-controlled order.
- New nodes append after existing siblings.
- Drag-and-drop can place a node before or after a sibling or inside another
  node as its last child.
- A searchable **Move To…** dialog is the keyboard-accessible alternative to
  drag-and-drop.
- A node cannot move beneath itself or one of its descendants.
- Moving a node carries its entire subtree, conversations, proposals,
  syntheses, citations, and embeddings without changing their identity.
- Breadcrumbs and constellation links reflect the current tree. Historical
  synthesis citations retain the cited node and cited revision even when the
  node later moves.
- Sibling position uniqueness is protected by an owner/parent/position
  database constraint. Concurrent creates and moves must not leave gaps or
  duplicate positions.

### Archive and deletion

- Archive is the only non-destructive node lifecycle state in v0.1.0.
- Archiving a node archives every currently unarchived descendant.
- Archived branches are hidden by default; **Show archived** reveals them in
  their original positions.
- Unarchiving a node also unarchives its archived ancestor path so it remains
  reachable when archived nodes are hidden. It does not unarchive descendants.
- An active node cannot move beneath an archived node. The destination must be
  unarchived first.
- Permanent deletion requires explicit confirmation and deletes the selected
  subtree, including its chats, proposals, synthesis history, citations, and
  embeddings, in one transaction.
- Archive is presented as the normal way to remove knowledge from the active
  workspace. Permanent deletion clearly explains that it cannot be undone.

### Search

- The basic tree search is case-insensitive title matching.
- Results include breadcrumb paths and archive state.
- Choosing a result clears search, expands its ancestor path, scrolls to it,
  and selects it.
- Semantic related-node retrieval is an internal synthesis input mechanism,
  not a second user-facing global search UI in v0.1.0.

## Chat behavior

- Each node has one ordered, persistent conversation.
- The selected-node detail surface keeps the current **Summary** as its first
  content section and exposes a prominent **Chat** button near the node header.
  Chat opens in an accessible modal containing the conversation, composer,
  proposals, diffs, and proposal history; those working artifacts do not share
  the main detail surface with the published result.
- Closing and reopening the Chat modal preserves its in-memory conversation
  state, and an active response may continue while the modal is closed. Normal
  closure returns focus to **Chat**. Successful approval closes Chat and moves
  focus to the newly published **Summary** after the refreshed version renders.
- User and assistant messages are immutable after successful creation.
- A failed assistant generation remains visibly retryable without duplicating
  the user message.
- The composer streams assistant text when supported and remains usable without
  requiring the owner to understand model configuration.
- The composer remains anchored inside the conversation viewport. **Enter**
  submits a non-empty message, while **Shift+Enter** inserts a new line.
- A clear **Use web sources** control is off by default and applies only to the
  next submitted turn. Natural-language requests may explain that the control
  must be enabled; they do not silently authorize web use.
- Assistant messages may contain ordinary discussion, clickable internal node
  citations, clickable external citations, and at most one inline synthesis
  proposal with its full diff and explicit decision controls.
- Chat history is not the published synthesis and is not automatically included
  in ancestor context. Only the node's approved synthesis is inherited upward.
- The application stores conversation messages locally. v0.1.0 does not rely
  on OpenAI-hosted conversation state as its canonical history.
- Raw chain-of-thought is never requested, stored, or displayed.

## Synthesis lifecycle

### Published synthesis

- A node may have no published synthesis or exactly one current published
  synthesis version.
- The current published version is rendered as the **Summary** at the top of
  the node's content surface. Validated **References** will be its only sibling
  content section when citation phases add reference data; no speculative empty
  References section is shown before then.
- Every approval creates a new immutable synthesis version; prior approved
  versions remain available to integrity checks and future history UI.
- The current version is selected by an explicit pointer on the node rather
  than inferred from timestamps.
- Published synthesis content uses a deliberately small Markdown subset:
  paragraphs, headings, lists, emphasis, and application-rendered citations.
- External References are rendered from validated citation records, not trusted
  from arbitrary model-authored Markdown URLs.

### Proposal generation

- The assistant may propose a synthesis only in response to an owner chat turn
  or an explicit **Propose refresh** action.
- The owner requests and refines proposals in ordinary conversational language;
  v0.1.0 does not expose a separate proposal or refinement composer mode.
- A proposal is immutable generated content with status `pending`, `approved`,
  `rejected`, or `superseded`.
- A proposal records the current published version on which it is based, the
  exact input revisions it used, model configuration, generating assistant
  message, and citation records.
- A new proposal may supersede an older pending proposal only through an
  explicit refinement flow. Superseded and rejected proposals remain in the
  audit history but are not presented as current drafts.
- The UI shows the proposed synthesis and a readable diff from the currently
  published version. First synthesis proposals compare against an empty state.
- The owner can continue chatting before deciding. Refinement produces a new
  proposal rather than mutating the old proposal.
- Approval and rejection controls are embedded in the proposal's chat artifact.
  Conversational model interpretation may draft or refine a proposal, but it
  never approves, rejects, or publishes one.

### Approval integrity

Approval is a server-side transaction that:

1. Requires the full authorized owner session.
2. Locks the target node and pending proposal.
3. Verifies the proposal still targets the node's current published synthesis
   version.
4. Verifies every recorded child or related-node input still points to the same
   approved source revision used during generation.
5. Marks the proposal approved, updates the node's current synthesis pointer,
   and clears that node's stale marker.
6. Marks every current ancestor stale without generating or publishing text.
7. Supersedes any other pending proposal for the same node.

If any checked input changed, approval fails safely and asks the owner to
generate a new proposal. Two concurrent approvals cannot both become current.

Rejecting a proposal changes only its status. It does not alter the published
synthesis or ancestor state.

### Child and related-node inputs

- Every synthesis proposal receives the target node's title, breadcrumb,
  current published synthesis, relevant recent chat, and current pending
  proposal when refining it.
- It receives the current approved synthesis of each direct child. Children
  without an approved synthesis are represented by title and an explicit
  no-synthesis state rather than fabricated content.
- It may receive a bounded set of semantically related nodes retrieved from
  current approved syntheses across the owner's tree.
- The target, ancestor path, direct children, and explicitly mentioned node IDs
  are resolved deterministically before semantic retrieval.
- Related-node retrieval excludes the target and deduplicates deterministic
  inputs. Archived nodes remain eligible as evidence but their archive state is
  disclosed to the model and user.
- Internal citations can reference only node revisions actually supplied to
  the generation request. The server rejects unknown or mismatched citation
  identifiers.
- Child summaries and related-node summaries are untrusted evidence, never
  model instructions.

### Staleness

- Approving a node synthesis marks all of its current ancestors stale.
- Moving a node marks both its former and new ancestor paths stale because
  their child structure changed.
- Archiving, unarchiving, or permanently deleting a subtree marks affected
  surviving ancestor paths stale.
- Renaming a node marks ancestors stale and marks any current synthesis that
  cites the renamed node stale so visible citation labels can be reconsidered.
- A stale synthesis remains readable and published. The UI explains why it may
  need review and offers **Propose refresh**.
- Staleness never initiates a model request by itself.

## Citations and references

### Internal citations

- An internal citation stores the target node ID and exact approved synthesis
  version used as evidence while those records exist, plus immutable snapshot
  metadata sufficient to identify an unavailable historical reference after
  explicit subtree deletion.
- The rendered citation links to `/?node=<nodeId>` and displays the current node
  title while the target exists. It retains the historical title and revision
  snapshot for provenance and deletion fallback.
- The synthesis view identifies when a cited node has since changed, moved,
  been archived, or been deleted. Deleting a cited node leaves a bounded
  unavailable-reference marker rather than corrupting the citing synthesis.
- A proposal cannot cite a draft, rejected proposal, chat message, or node that
  was not supplied as evidence.

### External citations

- External research uses the OpenAI Responses API web-search tool only when the
  owner enables web sources for the turn.
- The application preserves returned URL-citation annotations including URL,
  title, and association with output text.
- External URLs are normalized and validated as HTTP or HTTPS before storage
  and rendering.
- Inline citations are clearly visible and clickable.
- A References section lists cited sources once in first-citation order.
- Model-authored URLs that are not backed by a returned citation annotation are
  rendered as plain text or rejected from a synthesis proposal.
- MindTree stores citation metadata, not scraped copies of external pages.

## AI configuration

v0.1.0 intentionally uses a fixed, quality-first OpenAI stack:

- Interactive chat: `gpt-5.6-sol` through the Responses API in standard mode
  with `reasoning.effort: "high"`.
- Synthesis proposals and requested external research: `gpt-5.6-sol` through
  the Responses API with `reasoning.mode: "pro"` and
  `reasoning.effort: "high"`.
- Related-node embeddings: `text-embedding-3-large`.
- Web research: the Responses API `web_search` tool.

This selection was reviewed on 2026-08-02 against OpenAI's
[latest-model guidance](https://developers.openai.com/api/docs/guides/latest-model),
[web-search citation contract](https://developers.openai.com/api/docs/guides/tools-web-search#output-and-citations),
and [embedding model guidance](https://developers.openai.com/api/docs/guides/embeddings#embedding-models).
Because model and feature availability can change, the relevant implementation
phase re-verifies the documented API combination and runs a bounded synthetic
smoke before relying on it.

The selected slugs live in centralized server-only configuration and are
documented in `.env.example` only if an operational override is deliberately
supported. v0.1.0 does not silently fall back to another model. A missing key,
unavailable model, safety refusal, timeout, or malformed structured response is
shown as a retryable failure.

The OpenAI API key is server-only. Requests include a stable,
privacy-preserving safety identifier derived from the owner identity. Prompts
state the goal, evidence boundary, approval boundary, required citation
behavior, and output schema once. Representative evaluation fixtures determine
whether the selected reasoning settings remain adequate.

## Scoped read-only agent access

MindTree includes a narrow bearer-key integration for coding agents and other
owner-operated tools that need approved knowledge context. It extends the
private single-owner product; it does not create general users, roles, sharing,
public links, or write-capable automation.

### Credential lifecycle

- The authenticated owner creates agent access for a selected node from its
  dashboard workspace.
- A selected node has at most one active agent API key. Creating a key fails
  when one already exists; rotating replaces it and invalidates the previous
  key; revoking removes access without changing the node.
- A version-one key uses the bounded format
  `mtk_v1.<credential UUID>.<43-character base64url secret>`. The UUID is a
  public lookup selector and the secret encodes exactly 32 random bytes.
- The plaintext key is generated from cryptographically secure random material,
  displayed only once, and never stored by MindTree. The database stores the
  selector and 32-byte SHA-256 digest in `bytea(32)` for authentication.
- Secret verification strictly parses the entire token and compares fixed-size
  digest bytes in constant time.
- The initial key has no automatic expiration. Rotation and revocation are
  explicit owner actions.
- Deleting the scope root deletes its credential. Archiving it preserves the
  key and read access.
- Authentication rechecks that the credential owner is still the deployment's
  configured, verified allowed identity.
- Initial creation, rotation, and revocation require the full authorized owner
  session and identify the expected current credential so stale concurrent
  controls fail safely.
- Credential management uses a consistent owner/node/credential lock order.
  Each agent read starts a read-only `REPEATABLE READ` transaction and makes
  credential lookup/verification its first database operation, establishing
  the authorization and snapshot linearization point. Rotation or revocation
  linearizes at its commit: a read snapshot established earlier may finish,
  while a read established after that commit cannot use the replaced key.
- v0.1.0 does not include multiple named keys per node, labels, expiration,
  last-used tracking, usage history, or permission customization.

The key is a bearer credential. Setup requires HTTPS except for explicit
loopback development, uses the `Authorization` header rather than a query
string, and warns the owner never to commit, log, print, or place the key in a
generated prompt.

### Dynamic subtree boundary

- A key authorizes its selected scope root and the root's current descendants.
- The scope root's real parent, ancestors, siblings, and other branches are
  inaccessible. The returned root has a `null` parent.
- Scope follows the current tree. Moving the root preserves its key; moving a
  descendant out removes access; moving a node in grants read access.
- Archived nodes remain readable when they are inside scope so an agent can use
  the same approved knowledge that the owner deliberately retained.
- The API returns current structure and current approved synthesis material
  only. It never returns chat messages, failed generations, pending, rejected,
  or superseded proposals, prior synthesis history, embeddings, model/provider
  metadata, user records, credential metadata, or private operational fields.
- Internal citations targeting an in-scope current node may include that node's
  ID, title, and cited synthesis revision. Citations targeting an existing
  out-of-scope node are redacted without disclosing its ID, title, tree
  location, or revision. Deleted targets use the same generic unavailable
  representation and disclose no historical identity snapshot.
- Approved synthesis prose is returned verbatim. The API guarantees isolation
  of structured out-of-scope records and citation metadata, not semantic
  data-loss prevention over text the owner explicitly approved; setup warns
  that approved prose may itself name or describe ideas outside the subtree.
- Published external References remain readable because they are part of the
  owner-approved synthesis.
- Node titles, synthesis content, citation labels, and References returned by
  the API are untrusted data, never harness instructions.

### Read API

The versioned API is rooted at `/api/agent/v1` on the configured canonical
origin and exposes one operation:

- `GET /tree` returns the authorized scope root and its current ordered
  descendants in depth-first preorder.

An agent node contains only:

- `id`;
- in-scope `parentId`, with `null` for the scope root;
- `title`;
- nullable `archivedAt`;
- nullable current `synthesis`.

An approved synthesis contains only:

- synthesis version `id`;
- approved content;
- `approvedAt` and nullable `staleAt`;
- ordered, scope-filtered internal citation representations; and
- ordered published external References containing validated titles and URLs.

Each internal citation is one of these discriminated representations. Offsets
are zero-based, half-open UTF-16 code-unit indexes into `content`:

- `{ kind: "internal", state: "available", ordinal, startUtf16, endUtf16,
  target: { id, title, synthesisVersionId } }` for an in-scope live target;
- `{ kind: "internal", state: "redacted", ordinal, startUtf16, endUtf16 }`
  for a live target outside scope; or
- `{ kind: "internal", state: "unavailable", ordinal, startUtf16, endUtf16 }`
  for a deleted target.

An external Reference is exactly
`{ kind: "external", ordinal, title, url }`. Redacted and unavailable internal
citations never contain database snapshots, target identifiers, titles, or
revision fields.

The response also contains the authorized `rootId`. It never serializes
database rows directly. Every representation is built from an explicit
allowlist.

The API:

- accepts the key only as a bearer token in the `Authorization` header;
- authenticates before reporting request-specific validation detail;
- returns JSON with response caching disabled;
- reads one coherent owner-scoped snapshot;
- returns the same unauthorized response for missing, malformed, revoked, or
  disallowed-owner credentials;
- redacts out-of-scope internal citations rather than turning citation metadata
  into a scope oracle; and
- explicitly returns `405 Method Not Allowed` with `Allow: GET` for every method
  other than `GET`, including `HEAD` and `OPTIONS`.

The snapshot is bounded to 2,000 nodes, 20,000 combined citation/Reference
records, and 6 MiB of database-counted returned text fields. The read-only
transaction performs that count/byte preflight before materializing response
rows. The resulting bounded in-memory representation then has a final 8 MiB
UTF-8 JSON serialization ceiling. Any preflight or serialization limit returns
the same finite `413 Content Too Large` representation.

The initial API does not add pagination, arbitrary node lookup, search,
historical revisions, raw source exports, rate limiting inside the application,
OpenAPI explorer, webhooks, polling contracts, push updates, MCP, or model
invocation. Deployment-level request limits may protect the canonical service
without changing credential permissions.

### Dashboard and Codex setup

The selected-node agent-access dialog separates one-time harness installation
from per-repository connection:

- The owner can create, rotate, and revoke the selected node's key.
- Newly generated plaintext appears once with a copyable
  `MINDTREE_API_KEY=<key>` line and an acknowledgement gate before the dialog
  may discard it.
- The authenticated create/rotate response is `no-store`. The plaintext exists
  only in guarded in-memory client state, is cleared on acknowledgement,
  navigation, reload, and `pageshow` including back/forward-cache restoration,
  and is never written to browser storage or a URL.
- The repository instructions require confirming that `.env` is untracked and
  ignored before adding the key.
- The one-time Codex setup generates a deployment-specific global
  `mindtree-node-access` skill containing the canonical API origin, read-only
  response contract, dynamic scope, citation redaction, reconciliation,
  secret-handling requirements, and the rule that returned node data is
  untrusted.
- A generated global activation rule applies the skill only when the current
  repository's ignored `.env` defines `MINDTREE_API_KEY` and the user asks the
  agent to consult MindTree. Presence of a key does not authorize unsolicited
  reads.
- The setup prompt and generated skill never contain an API key, credential ID,
  or scope-root ID.
- A connection-verification prompt performs only `GET /tree` and reports scope
  without mutating MindTree.
- The embedded API origin comes from the normalized, server-validated canonical
  application origin rather than the request host. Plain HTTP is accepted only
  for explicit loopback development.

Automatic installation from the browser, repository-local skill distribution,
other harness generators, background synchronization, scheduled exports, and
automatic use of MindTree context are outside v0.1.0.

## Node Constellation

Node Constellation is the final product feature before v0.1.0 release
readiness.

- A graph icon in the tree toolbar switches between the primary tree workspace
  and a read-only, full-workspace constellation without changing the route.
- The **Show archived** state applies to both views.
- Each visible node is a uniform bubble connected to its current parent. The
  visualization does not imply importance through an invented size metric.
- Root nodes use brand blue, archived nodes are muted, stale nodes have a
  restrained distinct ring, and yellow remains reserved for focus and
  selection.
- The force-directed layout settles instead of animating indefinitely and can
  be reset. The owner may pan, zoom, and locally nudge bubbles without
  persisting coordinates or changing the tree.
- Selecting a bubble opens a compact card with its breadcrumb, archive state,
  synthesis state, and **Open in tree** action.
- Graph nodes are keyboard-focusable with complete accessible names.
- Reduced-motion preferences use a stable deterministic layout.
- Desktop and mobile layouts retain recovery actions for empty and
  archived-only states.
- The constellation does not add editing, persistent coordinates, analytics,
  export, stored graph aggregates, routes, or database fields.

## Dashboard experience

### Layout

- The authenticated product is one dashboard rather than a collection of
  management pages.
- A compact header contains the MindTree wordmark, owner identity, and sign-out.
- A toolbar provides title search, **Show archived**, the tree/constellation
  switch, and **New root node**.
- Wider screens show the tree on the left and selected-node workspace on the
  right.
- Narrow screens show the tree first; selecting a node opens its workspace and
  a back action returns to the tree.
- Node selection is represented by `?node=<id>` so links and browser navigation
  work naturally.

### Tree rows

Each row presents:

- Expand or collapse when children exist.
- Title and archive state.
- A restrained stale or no-synthesis indicator.
- An add-child affordance.
- Drag handle on supported pointer layouts.
- Selection and keyboard-visible focus.

### Selected-node workspace

The selected node contains:

- Breadcrumbs and inline-editable title.
- Persistent chat history and composer, including the published synthesis state
  and any pending proposal, full diff, and explicit decision controls as inline
  conversation artifacts.
- **Use web sources** for the next message.
- Add-child, archive/unarchive, **Move To…**, and delete actions.

Inline interactions are preferred. Modals are reserved for movement and
destructive confirmation. Proposal approval remains inline because it is the
core workflow, not an exceptional interruption.

## Visual direction

MindTree keeps TimeTree's Coopa-derived visual restraint:

- Primary canvas: near-black `#050608`.
- Primary text: off-white `#f7f8ff`.
- Secondary text: muted blue-gray `#9aa6b2`.
- Brand blue: `#1263ad`.
- Brand yellow: `#faf30e`.
- Typeface: Inter with a system sans-serif fallback stack.
- The default appearance is dark with no theme switcher in v0.1.0.
- Surfaces use tonal separation and restrained borders rather than a dashboard
  of elevated cards.
- Blue carries primary actions and selection. Yellow is reserved for keyboard
  focus, active selection, and small brand accents.
- Proposal additions and removals use accessible colors plus non-color cues.
- Motion is short and functional; reduced-motion preferences are respected.
- Controls remain compact, high-contrast, keyboard-visible, and touch-usable.

## Application architecture

- Next.js 16 App Router, React, and strict TypeScript form one full-stack
  application in the standard Node.js runtime.
- Server Components perform authoritative initial reads.
- Typed Server Actions handle node mutations and proposal decisions.
- A route handler streams OpenAI-backed chat responses because generation is a
  long-lived, incremental operation rather than a conventional form mutation.
- Better Auth exposes `/api/auth/[...all]`.
- The scoped read-only integration exposes only
  `GET /api/agent/v1/tree` outside the browser-authenticated dashboard.
- The application does not add GraphQL, tRPC, Redux, React Query, or a separate
  backend service.
- Tailwind CSS supplies utilities while the small accessible primitives needed
  by the product remain locally owned.
- PostgreSQL is the only datastore. Drizzle ORM defines schema and queries
  through `pg`; Drizzle Kit generates reviewed SQL migrations.
- PostgreSQL's `vector` extension stores related-node embeddings. Exact
  similarity search is acceptable for the initial small deployment; an ANN
  index is added only after representative scale measurements justify it.
- The official OpenAI JavaScript SDK is the only AI-provider client dependency
  in v0.1.0.

## Persistence model

Better Auth owns its user, session, account, and verification tables. MindTree
uses the following product records; final names may follow repository naming
conventions while preserving these boundaries.

### `nodes`

- UUID `id`, `userId`, nullable `parentId`, and sibling `position`.
- `title`, nullable `archivedAt`, and timestamps.
- Nullable `publishedSynthesisVersionId`.
- Nullable `synthesisStaleAt` and bounded stale reason metadata.

Parent/child ownership, title length, self-parenting, positions, and current
synthesis ownership are protected by constraints and transaction checks.

### `chatMessages`

- UUID `id`, `userId`, `nodeId`, ordered creation timestamp, and `role`.
- Message content, lifecycle status, optional model and response metadata, and
  whether web sources were authorized.
- Optional link from an assistant message to its generated proposal.

Messages belong to the same owner as their node. User-message creation and
assistant placeholder creation are replay-safe for one submitted client ID.

### `synthesisVersions`

- UUID `id`, `userId`, `nodeId`, nullable `baseVersionId`, and status.
- Generated synthesis content, model and reasoning profile, input fingerprint,
  generating message ID, and timestamps.
- Decision timestamp for approved, rejected, or superseded proposals.

Approved and decided versions are immutable. A node has at most one pending
current proposal and one explicitly pointed-to published version.

### `synthesisInputs`

- Synthesis version ID, source node ID, nullable exact source synthesis version
  ID, source-state fingerprint, relation (`child` or `related`), and stable
  ordering. A nullable source version explicitly records a supplied child with
  no approved synthesis rather than omitting that child from the evidence
  snapshot.

These rows support approval-time source validation, provenance display, and
staleness diagnosis.

### `citations`

- Citation owner: assistant chat message or synthesis version, with exactly one
  present.
- Citation kind: internal node or external URL.
- Internal fields: nullable live target node and synthesis-version references,
  immutable target node ID/title/revision snapshots, and deletion state.
- External fields: normalized URL and title from a web-search annotation.
- Stable ordinal and bounded text-location metadata for rendering.

Live internal references use deletion behavior that preserves the immutable
snapshot while clearing unavailable foreign-key targets. Database checks
enforce the appropriate field combination for each citation kind. Application
validation ensures citations correspond to supplied evidence or returned
web-search annotations.

### `nodeEmbeddings`

- Owner and node IDs, exact source synthesis version ID, embedding model,
  dimensions, vector, and timestamps.
- At most one current embedding per node.

The embedding is refreshed only after synthesis approval. Missing or failed
embeddings do not block publication; they make that node temporarily
unavailable to semantic related-node retrieval and remain visibly retryable in
operational logs rather than the main interface.

### `agentApiKeys`

- UUID selector `id`, `userId`, `rootNodeId`, fixed-length `secretHash`, and
  `createdAt`.
- A unique owner/root constraint permits at most one current key per selected
  node.
- A composite foreign key guarantees that credential and scope root share an
  owner; deleting the scope root deletes the credential.
- The plaintext secret is never stored.

### Derived data

- Breadcrumbs, descendant lists, visible tree rows, archive-filtered trees,
  ancestor paths, citation labels, stale presentation, diffs, and constellation
  coordinates are derived.
- Published synthesis content, proposals, input revision provenance,
  conversations, citations, and embeddings are stored.
- The database does not store recursive path strings, nested-set boundaries,
  graph coordinates, or model chain-of-thought.

## Server boundaries

Every protected read and mutation uses one centralized owner authorization
guard that validates the Better Auth session and rechecks the verified email
against the current configured allowlist.

### Server-only reads

- Dashboard tree, archive state, synthesis state, and selected-node metadata.
- Paginated chat history for the selected node.
- Current published synthesis, current pending proposal, diff inputs,
  provenance, citations, and References.
- Constellation data derived from the same authorized tree.
- Current credential metadata for the selected node, excluding its secret.

### Server Actions

- Create, rename, move, archive, unarchive, and delete nodes.
- Approve, reject, and supersede synthesis proposals.
- Retry a failed embedding refresh if an owner-facing control proves necessary.
- Create, rotate, and revoke the selected node's read-only agent credential.

Every action validates with Zod, owner-scopes reads and writes, uses a
transaction for multi-record changes, returns a small typed result, and
revalidates affected application data.

### Agent read route

- `GET /api/agent/v1/tree` uses a separate centralized bearer-key guard.
- The guard strictly parses and constant-time verifies the secret, rechecks the
  owning allowed identity, resolves the dynamic subtree, and applies citation
  redaction before serialization.
- Credential authorization and the coherent subtree read share the specified
  transaction and lock boundary.
- The route is force-dynamic, no-store, JSON-only, and allowlist-serializes the
  response.
- It performs no product mutation and never calls OpenAI.

### Chat route

- Accepts a client-generated message ID, node ID, bounded text, optional
  refinement target, and explicit web-search authorization.
- Authenticates before returning validation detail.
- Loads a bounded, deterministic context snapshot and records its fingerprint.
- Creates the persistent user message and assistant generation placeholder
  idempotently.
- Calls the configured OpenAI response profile, streams safe assistant text,
  validates structured proposal and citation output, and commits the completed
  assistant message and optional proposal.
- Marks the assistant message failed on recoverable generation errors without
  mutating the published synthesis.
- Does not expose the API key, raw provider payloads, hidden reasoning, other
  users' data, or unvalidated tool output.

## Security and privacy boundaries

- `.env` and local variants are ignored; `.env.example` contains names and safe
  descriptions only.
- `OPENAI_API_KEY`, database credentials, OAuth secrets, auth secrets, and
  agent credential hashes are deployment server-only. `MINDTREE_API_KEY` is a
  connected-repository secret; it is ignored by Git and is browser-visible
  only during the authenticated, no-store, one-time create/rotate display.
- External web results, child summaries, related summaries, node titles, and
  chat history are untrusted model inputs and never instructions.
- Rendered Markdown is sanitized with an allowlist. Application-owned citation
  components create links.
- Server-side URL validation permits only HTTP and HTTPS external citations and
  prevents script or local-file schemes.
- Authorization occurs before resource-specific validation where validation
  could reveal private data.
- Node IDs supplied by the model are accepted only from the server-created
  evidence map for that generation.
- Approval uses optimistic input-version checks and row locks.
- Destructive subtree deletion is transactional and confirmed.
- Logs exclude prompts, message bodies, synthesis content, API keys, OAuth
  material, and raw provider responses by default.
- Agent responses cannot disclose structured out-of-scope citation identities,
  chat, proposal history, embeddings, credential rows, or owner records.
- No analytics or third-party error-reporting service is added in v0.1.0.

## Quality boundary

### Automated verification

- Unit tests cover iterative deep-tree assembly, breadcrumbs, archive
  filtering, search, move destinations, staleness propagation, context
  selection, input fingerprints, diff presentation, citation normalization,
  References ordering, and constellation layout.
- PostgreSQL integration tests cover ownership, sibling-order races, cycle
  prevention, archive behavior, cascade deletion, persistent chat replay,
  proposal state transitions, approval concurrency, source-version conflicts,
  stale ancestor marking, citation constraints, embedding ownership, agent-key
  lifecycle, dynamic subtree reads, revocation/rotation linearization, and
  citation redaction.
- AI-boundary tests use deterministic synthetic provider fixtures for streamed
  chat, proposals, refusals, invalid structured output, invalid citations,
  web-search annotations, retries, and timeouts. Normal automated tests do not
  call paid external models.
- A small opt-in evaluation suite calls the configured real models with
  synthetic knowledge trees to measure instruction following, proposal
  quality, child-summary use, citation precision, unsupported-claim rate, and
  approval-boundary compliance.
- Playwright covers sign-in, responsive tree navigation, chat persistence,
  proposal refinement/approval/rejection, stale parent refresh, external
  citations, archive/delete behavior, drag-and-drop with Move To parity, and
  agent-key create/rotate/revoke/setup, plus Node Constellation at desktop and
  mobile widths.
- CI runs lint, typecheck, unit tests, integration tests, production build, and
  deterministic browser tests. Live-model evaluations are deliberate release
  evidence, not an uncontrolled per-commit requirement.

### Accessibility baseline

- Interactive controls have accessible names and visible keyboard focus.
- Tree, chat, proposal, approval, archive, movement, and constellation recovery
  flows are keyboard-operable.
- **Move To…** provides an alternative to drag-and-drop.
- Dialogs manage and restore focus.
- Streaming updates use restrained live-region behavior and do not repeatedly
  announce partial tokens.
- Proposal diffs do not rely on color alone.
- Reduced-motion preferences disable nonessential motion and continuous graph
  simulation.

## Deployment and release

- Vercel runs the standard Next.js Node.js application.
- Neon supplies pooled application traffic and a separately controlled direct
  connection for migrations.
- Production migrations are deliberate and version-controlled; builds do not
  run migrations automatically.
- Compatibility-sensitive schema changes use expand/deploy/contract sequencing.
- Preview deployments must not silently mutate production data unless that
  risk is explicitly reviewed and accepted for the deployment.
- Release readiness verifies authentication, tree organization, persistent
  chat, proposal approval and rejection, child-driven staleness, web citations,
  archive/delete recovery, scoped read-only agent access and revocation,
  responsive layout, and constellation navigation with synthetic data.
- v0.1.0 is the first tag. No release tags are created during implementation.
- The final reviewed release-readiness change deletes
  `IMPLEMENTATION_PLAN.md`, confirms `package.json` version `0.1.0`, and leaves
  this specification plus the workflow documents as the durable authorities.
