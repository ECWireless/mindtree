# MindTree Specification

Status: Approved v0.1.0 release specification with post-release amendments

This specification is the durable product and architecture authority for
MindTree v0.1.0. The temporary implementation plan is retired as part of the
reviewed v0.1.0 release-readiness change.

## Source reference

[ECWireless/TimeTree](https://github.com/ECWireless/timetree) at commit
[`51641ef1bc5de3e0f1d1a2ead168945d33fad47d`](https://github.com/ECWireless/timetree/commit/51641ef1bc5de3e0f1d1a2ead168945d33fad47d)
is MindTree's immutable primary source baseline for general UX, visual
language, application stack, and repository conventions. Relevant
implementation phases compare against that baseline and adapt its simple
interaction patterns rather than redesigning them without cause. Updating the
pin requires an approved specification change and a fresh divergence review.
MindTree's thought tree, chat, synthesis approval, citation, public
thought-trail sharing, and privacy contracts remain governed by this
specification when the products differ. TimeTree is MIT-licensed, copyright
2026 Coopa LLC;
adapted code, assets, and documentation preserve required license notices and
attribution.

## Product definition

MindTree is a private, self-hostable workspace for organizing thoughts, ideas,
and concepts as an infinitely nestable tree. Every node combines a persistent
conversation with a concise, explicitly approved synthesis and may have a
separately generated Branch Outline.

The tree is the primary interface. Chat helps the owner develop a thought and
propose changes, but the owner decides what becomes part of the published
synthesis. MindTree is not a general-purpose notes app, document editor, or
autonomous research agent.

## Product principles

- **Extremely simple:** the core loop is select a node, discuss it, review a
  proposed synthesis change, and approve or reject it.
- **Human-published:** only an explicitly approved Summary becomes published
  knowledge. Chat output and explicitly generated Branch Outlines remain
  advisory application context.
- **Recursive, not uncontrolled:** a Branch Outline recursively composes the
  node's approved Summary with current child summaries and child outlines.
  Generation is always owner-initiated, never a background model-call cascade,
  and child changes make affected artifacts stale instead of silently
  rewriting them.
- **Traceable:** published claims can link to exact MindTree nodes and exact
  approved node revisions; externally researched claims retain clickable
  source citations.
- **Tree-first:** nodes, breadcrumbs, movement, search, archive visibility, and
  the final constellation view all reflect one ordered hierarchy.
- **Private by default:** one configured account manages a deployment in
  v0.1.0. A branch becomes publicly readable only through an explicit,
  revocable share link; conversations and drafts remain private.

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
  collaborative permissions, or account switching.
- MindTree is intended to be MIT-licensed and self-hostable.

## v0.1.0 scope

The authenticated owner can:

- Create, rename, move, reorder, archive, unarchive, and permanently delete
  nodes and subtrees.
- Create any number of root nodes and nest child nodes without a product-level
  depth limit.
- Expand, collapse, search, and navigate the tree using linkable node URLs.
- Open one persistent chat per node.
- Ask questions, develop ideas, and explicitly request external sources in
  chat.
- Review an assistant response and an optional proposed synthesis revision.
- Compare a proposed synthesis with the currently published synthesis.
- Continue refining, reject, or explicitly approve a proposal.
- Generate or regenerate a Branch Outline beneath the current Summary.
- Let Chat use the current Branch Outline as context when discussing the node
  or proposing a Summary revision.
- See which approved child and related-node revisions support a synthesis.
- Follow inline internal links to their target nodes.
- Follow external citations and view them in a References section.
- See when a published synthesis is stale because an input node changed.
- Request a refresh proposal for a stale synthesis through Chat without
  automatically publishing it.
- Create and revoke a shareable public link scoped to a selected node's current
  subtree.
- Let anyone with that link follow the current thought trail through its node
  structure, approved Summaries, Branch Outlines, internal links that remain
  in scope, and published external References without exposing Chat or any
  mutation authority.
- Switch to a read-only Node Constellation after the core tree and synthesis
  experience is complete.

## Explicit non-goals

v0.1.0 does not include:

- Autonomous publication or automatic approval of generated Summary content.
- Background ancestor regeneration, recursive model-call cascades, cron jobs,
  queues, or workers.
- A coding-agent API, MCP server, public developer platform, OAuth API clients,
  general-purpose access tokens, or automatic external automation.
- Public writes, Chat, outline generation, proposal decisions, node mutations,
  raw conversations, pending/rejected synthesis access, embeddings, or owner
  identity through a share link.
- Real-time multi-user collaboration, comments, mentions, or notifications.
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

## Approved post-v0.1.0 additions

### Operational analytics

- The canonical Vercel deployment may use Vercel Web Analytics for anonymous,
  aggregate pageviews on only the signed-out landing page and successfully
  resolved public thought trails.
- The authenticated owner dashboard, invalid or revoked public links, API
  routes, authentication routes, and every other application surface remain
  uninstrumented.
- The landing page is reported only as `/`. Every public thought-trail URL is
  reported only as `/share/[secret]`; the client removes the actual capability
  secret, query parameters, and fragments before an event can leave the
  browser. Events for any other path are discarded.
- Analytics never receives a share-link secret, node ID, share-record ID,
  owner identity, email address, thought content, Chat content, Summary,
  Branch Outline, citation, model data, or other application record.
- The application records no custom analytics events, adds no analytics
  datastore or in-product dashboard, and does not attempt to identify an
  individual visitor. Vercel's aggregate route, referrer, geography, browser,
  operating-system, and device reporting is the intended boundary.
- Analytics enablement and plan-level event billing remain deployment-operator
  concerns in Vercel. No analytics environment variable or application
  credential is introduced.

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
  internal-link annotations retain the linked node and revision even when the
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
- A clear **Use external sources** control is off by default and applies only to the
  next submitted turn. Natural-language requests may explain that the control
  must be enabled; they do not silently authorize external access.
- An authorized turn may use web search or ingest exactly one non-local HTTPS
  PDF URL supplied in that turn. MindTree resolves every DNS answer, rejects
  non-global addresses, pins the validated address during TLS, and repeats the
  checks for at most five HTTPS redirects. It downloads at most 20 MiB for at
  most 20 seconds, verifies an unencoded PDF response and signature, sends
  transient base64 data as a low-detail provider file input, and never stores
  PDF bytes or extracted document text.
- Assistant messages may contain ordinary discussion, numbered clickable
  external citations, and at most one inline synthesis proposal with its full
  diff, application-owned internal node links, and explicit decision controls.
- Chat history is not the published synthesis and is never inherited upward.
  Branch Outline generation may inherit only the node's approved synthesis and
  its explicitly generated current, non-stale Branch Outline.
- Chat receives the node's current Branch Outline, when one exists, as
  explicitly delimited untrusted context. A stale outline is disclosed as
  stale rather than represented as current evidence.
- The application stores conversation messages locally. v0.1.0 does not rely
  on OpenAI-hosted conversation state as its canonical history.
- Raw chain-of-thought is never requested, stored, or displayed.

## Synthesis lifecycle

### Published synthesis

- A node may have no published synthesis or exactly one current published
  synthesis version.
- The current published version is rendered as the **Summary** at the top of
  the node's content surface. Validated **References** follow when the Summary
  cites external sources, then **Branch Outline** provides branch context. No
  speculative empty References section is shown before then.
- Every approval creates a new immutable synthesis version; prior approved
  versions remain available to integrity checks and future history UI.
- The current version is selected by an explicit pointer on the node rather
  than inferred from timestamps.
- Published synthesis content uses a deliberately small Markdown subset:
  paragraphs, headings, lists, emphasis, and application-rendered citations.
- External References are rendered from validated citation records, not trusted
  from arbitrary model-authored Markdown URLs.

### Proposal generation

- The assistant may propose a synthesis only in response to an owner Chat turn.
  A stale Summary directs the owner into Chat rather than exposing a separate
  Summary-generation control.
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
4. Verifies the recorded Branch Outline input, when present, is still the
   node's current non-stale outline version and every related-node input still
   points to the same approved source revision used during generation.
5. Marks the proposal approved, updates the node's current synthesis pointer,
   and clears that node's stale marker.
6. Marks the target node's current Branch Outline and every current ancestor
   Summary and Branch Outline stale without generating or publishing text.
7. Supersedes any other pending proposal for the same node.

If any checked input changed, approval fails safely and asks the owner to
generate a new proposal. Two concurrent approvals cannot both become current.

Rejecting a proposal changes only its status. It does not alter the published
synthesis or ancestor state.

### Branch Outline

- Branch Outline is a generated node artifact separate from Chat and the
  published Summary. It appears as a normal product section below Summary and
  is never represented as approved or published synthesis content.
- A node with no outline shows a compact **Generate** button. A node with an
  outline shows **Regenerate** together with ordinary current, stale,
  generating, and retryable-failure states.
- Each explicit Generate or Regenerate action makes at most one model request.
  It never starts generation for a child or ancestor and never creates a
  background or recursive model-call cascade.
- Generation uses the node's current approved Summary, if present, only as
  framing context. It produces exactly one concise line for each direct child
  in sibling order and never represents the selected node as an outline entry.
  Each line treats the child's current approved Summary as primary evidence and
  its current non-stale Branch Outline as secondary relationship context. That
  child outline recursively compresses deeper branch context without another
  model call; descendants never become separate entries in the parent's
  outline and receive progressively less emphasis at each composition step.
- The model returns one single-line description for each stable direct-child
  ordinal rather than rendering node titles or Markdown. The server requires
  the exact ordered ordinal set, rejects extra or state-boilerplate output, and
  assembles the final list with title-safe labels derived from trusted node
  records. Structurally impossible branches fail before a provider request.
- Exact child archive, Summary-presence, and Branch Outline state remain part
  of server-side provenance and installation validation. Provider-visible
  context supplies usable evidence or a null value, and generated prose never
  reports archive, missing, stale, or unavailable-state boilerplate. When a
  child has no approved Summary, generation uses its title and any current
  child outline cautiously without inventing unsupported detail.
- The resulting outline becomes the node's current visible Branch Outline when
  generation completes successfully. It does not require a synthesis approval,
  move the published Summary pointer, or authorize any other mutation.
- Outline content uses the same bounded Markdown subset as Summary content and
  cannot contain HTML, arbitrary links, images, code, or citations in Phase 8.
- Branch Outline versions are immutable and record their exact Summary, child
  Summary, and child Branch Outline input versions and state fingerprints.
  Replacing the current outline does not itself mark the node's Summary stale.
- Branch Outline output and every supplied title, Summary, and child outline are
  untrusted data, never model instructions. Outline generation has no web-search
  access in v0.1.0.
- Chat may use the current Branch Outline when discussing the node or generating
  a Summary proposal. A stale outline remains available for discussion, but a
  Summary request does not create a proposal until the owner regenerates it.
  A proposal using an outline records its exact version and can be approved only
  while that outline remains current and non-stale.

### Branch-outline and related-node inputs

- Every synthesis proposal receives the target node's title, breadcrumb,
  current published synthesis, relevant recent chat, and current pending
  proposal when refining it.
- It receives the target node's current Branch Outline when one exists. Direct
  child summaries reach Summary generation deterministically through that
  explicitly generated outline rather than every child Summary being appended
  to the Summary surface or injected as a second hidden bulk channel. Bounded
  semantic retrieval may also supply an exact approved direct-child Summary
  revision when it is relevant and therefore eligible for an internal link.
- It may receive a bounded set of semantically related nodes retrieved from
  current approved syntheses across the owner's tree, including direct children.
- The target, ancestor path, current Branch Outline, and explicitly mentioned
  node IDs are resolved deterministically before semantic retrieval.
- Related-node retrieval excludes the target and its ancestor path, deduplicates
  explicit deterministic exclusions, and keeps direct children eligible.
  Archived nodes remain eligible as evidence but their archive state is
  disclosed to the model and user.
- Internal links can target only node revisions actually supplied to the
  generation request. The server rejects unknown or mismatched evidence
  identifiers.
- Branch Outlines and related-node summaries are untrusted evidence, never
  model instructions.

### Staleness

- Approving a node synthesis marks that node's current Branch Outline stale and
  marks all current ancestor Summaries and Branch Outlines stale.
- Creating a child marks the parent's ancestor path of Summaries and Branch
  Outlines stale because the branch structure changed.
- Moving a node marks both its former and new ancestor paths stale because
  their child structure changed.
- Archiving, unarchiving, or permanently deleting a subtree marks affected
  surviving ancestor-path Summaries and Branch Outlines stale.
- Renaming a node marks its current Branch Outline and ancestors stale and marks
  any current synthesis that links to the renamed node stale so visible link
  labels can be reconsidered.
- A stale synthesis remains readable and published. The UI explains why it may
  need review and directs the owner to Chat to request a refresh proposal.
- A stale Branch Outline remains readable and offers **Regenerate**. Successful
  regeneration clears only that outline's stale state; it does not publish or
  refresh a Summary.
- Staleness never initiates a model request by itself.

## Links, citations, and references

### Internal links

- An internal link annotation stores the target node ID and exact approved synthesis
  version used as evidence while those records exist, plus immutable snapshot
  metadata sufficient to identify an unavailable historical reference after
  explicit subtree deletion.
- The application renders the exact supported phrase as an underlined wiki-style
  link to `/?node=<nodeId>`. The model supplies only an opaque evidence alias and
  a bounded exact phrase; it never authors the destination URL or database ID.
- Internal links do not use numbered citation markers and do not appear in an
  external References section. Numbered markers and References are reserved for
  validated external sources.
- Exact revision provenance remains stored outside generated Markdown. Available
  links expose renamed, moved, archived, or changed-revision status accessibly;
  deleted targets retain bounded unavailable styling and snapshot context without
  creating a working link.
- A proposal cannot link to a draft, rejected proposal, chat message, or node
  revision that was not supplied as evidence.

### External citations

- External research uses the OpenAI Responses API only when the owner enables
  external sources for the turn. Ordinary research uses `web_search`; exactly
  one non-local HTTPS PDF URL explicitly present in the current message is
  instead fetched through the bounded, redirect-aware public-address path and
  sent as transient base64 data in a low-detail `input_file`.
- The application preserves returned URL-citation annotations for web search.
  For a direct PDF, it accepts only structured exact citation phrases that occur
  once in the visible answer and maps them to the final application-validated
  public HTTPS URL reached from the owner-supplied destination.
- External URLs are normalized and validated as HTTP or HTTPS before storage
  and rendering.
- Inline citations are clearly visible and clickable.
- A References section lists cited sources once in first-citation order.
- Model-authored URLs that are not backed by returned web annotations or the
  single validated PDF destination are rendered as plain text or rejected from
  a synthesis proposal.
- MindTree stores citation metadata, not scraped pages, PDF bytes, or extracted
  document text.

## AI configuration

v0.1.0 intentionally uses a fixed, quality-first OpenAI stack:

- Interactive chat: `gpt-5.6-sol` through the Responses API in standard mode
  with `reasoning.effort: "high"`.
- Synthesis proposals, Branch Outline generation, and requested external
  research: `gpt-5.6-sol` through the Responses API with
  `reasoning.mode: "pro"` and `reasoning.effort: "high"`. Branch Outline
  generation never enables web search.
- Related-node embeddings: `text-embedding-3-large`.
- External research: the Responses API `web_search` tool or one owner-supplied
  HTTPS PDF fetched through MindTree's bounded public-address path and sent as
  a transient low-detail base64 `input_file`.

This selection was reviewed on 2026-08-02 against OpenAI's
[latest-model guidance](https://developers.openai.com/api/docs/guides/latest-model),
[web-search citation contract](https://developers.openai.com/api/docs/guides/tools-web-search#output-and-citations),
the [file-input guide](https://developers.openai.com/api/docs/guides/file-inputs),
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

## Public read-only thought trails

MindTree lets the owner deliberately share the current published thought trail
beneath one selected node without granting dashboard access or exposing the
private process used to create it.

- The authenticated owner can create, recover, copy, share, and revoke one
  stable share link for a selected node. The active URL remains available to
  the owner after reload; revocation makes it unavailable without changing the
  branch.
- Anyone with the link can read the selected scope root and its current
  descendants. The scope root's real parent, ancestors, siblings, and other
  branches remain private.
- Anyone with the link can switch between the thought-trail reader and a
  read-only Node Constellation of exactly that same current shared subtree.
  The selected mode and thought use URL query state so either view can be
  reloaded, bookmarked, or shared without creating another capability.
- The shared view is dynamic rather than a snapshot. Current node titles,
  hierarchy, approved Summaries, Branch Outlines, and published external
  References are read when the page is requested, so later owner changes are
  reflected without generating a new link.
- Scope follows the current tree. Moving a descendant out removes it from the
  shared view; moving a node in adds it; moving the scope root preserves the
  link without revealing its new ancestors or siblings.
- Internal node links remain clickable only when their live target is inside
  the shared subtree. An out-of-scope or deleted target keeps its supported
  phrase as plain text without a destination or structured target identity.
- External links and published References remain visible and clickable with
  the same application validation and safe new-tab behavior as the owner view.
- Chat history, the Chat action and composer, pending/rejected/superseded
  proposals, diffs, synthesis history, Branch Outline generation or
  regeneration, node actions, embeddings, owner identity, and private
  operational metadata never appear in the shared view.
- The public surface is strictly read-only. Possession of a link grants no
  mutation, generation, authentication, invitation, collaboration, API, or
  account authority.
- The public constellation permits only local camera and layout interactions:
  pan, zoom, reset, selection, and temporary bubble nudging. It never exposes
  archived thoughts, archive or synthesis state, empty-workspace creation,
  dashboard navigation, persistent coordinates, or owner-only controls.
- Shared titles, Summaries, Branch Outlines, link labels, and external source
  metadata remain untrusted rendered data. Markdown and URL allowlists remain
  application-controlled.
- Approved prose and generated Branch Outline prose may themselves describe
  ideas outside the subtree. The scope boundary prevents structured navigation
  and record disclosure; it is not semantic data-loss prevention over content
  the owner deliberately shares.

Exact link-token lifecycle, URL shape, archive visibility, response limits,
cache policy, indexing controls, and concurrent revoke/read behavior are
security and privacy decisions for the dedicated implementation-phase debrief.

## Node Constellation

Node Constellation is the final authenticated workspace feature before public
thought-trail sharing and v0.1.0 release readiness.

- A graph icon in the tree toolbar switches between the primary tree workspace
  and a read-only, full-workspace constellation without changing the route.
- The **Show archived** state applies to both views.
- Each visible node is a bubble connected to its current parent. Root visual
  radius is largest, and each deeper layer is 75% of its parent layer down to a
  small visual floor. A separate transparent minimum touch target stays at
  least 44 pixels across every zoom level and keeps tiny deep nodes directly
  manipulable. Bubble size communicates hierarchy depth
  only, never importance, activity, or staleness.
- Zoom behaves like a design-canvas camera across a broad 15%–1200% range.
  Bubble borders, labels, archived dashes, and links remain fixed in world space
  and scale uniformly with their nodes. Every node
  retains a proportionally fitted label that naturally becomes legible when the
  user zooms in; zoom never swaps or enlarges visual styles independently.
  Invisible hit targets and the keyboard/selection locator are camera UI rather
  than node art: they retain usable screen-space dimensions, and overview-scale
  pointer input resolves to the nearest node instead of SVG paint order.
- Root nodes use brand blue, archived nodes are muted, and yellow remains
  reserved for focus and selection. Staleness does not change bubble styling;
  the selected-node card may report synthesis state quietly without turning
  the constellation into a status dashboard.
- Interaction quality is the feature's leading experience goal. The graph has
  a lively initial settle, responsive physical nudging, natural link movement,
  direct panning, cursor-centered zoom, and satisfying selection and reset
  feedback while remaining calm and legible.
- The force-directed layout settles instead of animating indefinitely and can
  be reset. The owner may pan, zoom, and locally nudge bubbles without
  persisting coordinates or changing the tree.
- Selecting a bubble opens a compact card with its breadcrumb, archive state,
  synthesis state, and **Open in tree** action.
- Graph nodes are keyboard-focusable with complete accessible names.
- Reduced-motion preferences use a stable deterministic layout.
- Desktop and mobile layouts retain recovery actions for empty and
  archived-only states.
- The visible workspace heading is **Thought Constellation** with no subtitle.
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
- The published **Summary**, validated **References** when it cites external
  sources, then **Branch Outline**, whose empty state offers **Generate** and
  whose current or stale state offers **Regenerate**. No empty References
  section is shown.
- A prominent **Chat** action opening persistent history and the composer,
  including any pending proposal, full diff, and explicit decision controls as
  inline conversation artifacts.
- **Use external sources** for the next message.
- Share-link creation/revocation plus add-child, archive/unarchive,
  **Move To…**, and delete actions.

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
- Route handlers stream OpenAI-backed Chat and Branch Outline responses because
  generation is a long-lived, incremental operation rather than a conventional
  form mutation.
- Better Auth exposes `/api/auth/[...all]`.
- A dedicated public page renders only an explicitly shared current subtree;
  it does not expose a general-purpose data API.
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
- Nullable `currentBranchOutlineVersionId`, `branchOutlineStaleAt`, and bounded
  outline stale reason metadata.

Parent/child ownership, title length, self-parenting, positions, current
synthesis ownership, and current Branch Outline ownership are protected by
constraints and transaction checks.

### `chatMessages`

- UUID `id`, `userId`, `nodeId`, ordered creation timestamp, and `role`.
- Message content, lifecycle status, optional model and response metadata, and
  whether external sources were authorized.
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

- Synthesis version ID, source node ID, nullable exact source synthesis or
  Branch Outline version, source-state fingerprint, relation (`outline` or
  `related`), and stable ordering. Exactly one compatible source-version field
  is present for each relation.

These rows support approval-time source validation, provenance display, and
staleness diagnosis.

### `branchOutlineVersions`

- UUID `id`, `userId`, `nodeId`, unique client request ID, nullable exact base
  Summary version ID, lifecycle status, bounded generated outline content,
  model and reasoning profile, input fingerprint, bounded failure code, and
  timestamps.
- At most one generation is active per node. Completed versions are immutable,
  and a node points explicitly to at most one completed current version;
  replacing that pointer does not publish a Summary. Failed attempts never
  replace the prior current outline.

### `branchOutlineInputs`

- Branch Outline version ID, direct-child node ID, nullable exact child Summary
  version ID, nullable exact child Branch Outline version ID, source-state
  fingerprint, and stable sibling ordering.
- Explicit no-summary and no-outline states are stored rather than inferred
  from missing rows.

These rows support deterministic recursive composition, stale diagnosis, and
safe retries without initiating child generation.

### `citations`

- Citation owner: assistant chat message or synthesis version, with exactly one
  present.
- Citation kind: internal node or external URL.
- Internal fields: nullable live target node and synthesis-version references,
  immutable target node ID/title/revision snapshots, and deletion state.
- External fields: normalized URL and title from a web-search annotation or the
  one application-validated owner-supplied PDF URL.
- Stable ordinal and bounded text-location metadata for rendering.

Live internal references use deletion behavior that preserves the immutable
snapshot while clearing unavailable foreign-key targets. Database checks
enforce the appropriate field combination for each citation kind. Application
validation ensures citations correspond to supplied evidence, returned
web-search annotations, or exact response spans mapped to the single supplied
PDF.

### `nodeEmbeddings`

- Owner and node IDs, exact source synthesis version ID, embedding model,
  dimensions, vector, and timestamps.
- At most one current embedding per node.

The embedding is refreshed only after synthesis approval. Missing or failed
embeddings do not block publication; they make that node temporarily
unavailable to semantic related-node retrieval and remain visibly retryable in
operational logs rather than the main interface.

### `branchShareLinks`

- UUID `id`, `userId`, `rootNodeId`, fixed-length random-secret digest,
  nullable authenticated-encryption envelope, and `createdAt`.
- A unique owner/root constraint permits at most one active share link per
  selected node.
- A composite foreign key guarantees that the share and scope root have the
  same owner; deleting the scope root deletes the share.
- The plaintext link secret is never stored. New links store an AES-256-GCM
  envelope encrypted with a dedicated deployment key so the authenticated
  owner can recover the same URL after reload. Existing digest-only links stay
  publicly valid but remain owner-unrecoverable until replaced.

### Derived data

- Breadcrumbs, descendant lists, visible tree rows, archive-filtered trees,
  ancestor paths, reference labels, stale presentation, diffs, and constellation
  coordinates are derived.
- Published synthesis content, proposals, Branch Outline versions, input
  revision provenance, conversations, citations, and embeddings are stored.
- The database does not store recursive path strings, nested-set boundaries,
  graph coordinates, or model chain-of-thought.

## Server boundaries

Every protected read and mutation uses one centralized owner authorization
guard that validates the Better Auth session and rechecks the verified email
against the current configured allowlist.

### Server-only reads

- Dashboard tree, archive state, synthesis state, and selected-node metadata.
- Paginated chat history for the selected node.
- Current published synthesis, current Branch Outline and stale state, current
  pending proposal, diff inputs, provenance, citations, and References.
- Constellation data derived from the same authorized tree.
- Current share-link state for the selected node, excluding its secret.
- Owner-authorized recovery of an active share-link secret only when the
  sharing surface is opened; the initial dashboard payload excludes it.

### Server Actions

- Create, rename, move, archive, unarchive, and delete nodes.
- Approve, reject, and supersede synthesis proposals.
- Retry a failed embedding refresh if an owner-facing control proves necessary.
- Create, recover, and revoke the selected node's public share link.

Every action validates with Zod, owner-scopes reads and writes, uses a
transaction for multi-record changes, returns a small typed result, and
revalidates affected application data.

### Public share route

- The public route strictly validates the opaque link secret before resolving
  its current subtree.
- It reads only allowlisted shared fields and applies internal-link scope
  filtering before rendering.
- Its trail and constellation modes are alternate presentations of the same
  bounded allowlisted response; constellation mode does not add a data field,
  read path, or broader scope.
- It does not require or reveal an owner session, perform a product mutation,
  expose a general-purpose JSON contract, or call OpenAI.

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

### Branch Outline route

- Accepts a client-generated request ID and node ID for one explicit Generate
  or Regenerate action.
- Authenticates before returning validation detail, claims the request
  idempotently with a persistent generation placeholder, and loads one bounded
  deterministic Summary/child snapshot.
- Calls the fixed synthesis profile once, with web search disabled, validates
  the bounded outline output, and atomically installs one immutable current
  version with its exact inputs.
- Leaves the prior outline readable on retryable failure and never creates a
  Summary proposal, changes a published Summary pointer, or invokes generation
  for another node.

## Security and privacy boundaries

- `.env` and local variants are ignored; `.env.example` contains names and safe
  descriptions only.
- `OPENAI_API_KEY`, database credentials, OAuth secrets, auth secrets,
  share-link digests, encrypted share-link secrets, and
  `SHARE_LINK_ENCRYPTION_KEY` are deployment server-only. Share-link secrets
  are unguessable, revocable capabilities; plaintext exists only during
  owner-authorized creation or recovery and public-link validation, and is
  never written to storage, logs, or analytics.
- External web results, Branch Outlines, child summaries, related summaries,
  node titles, and chat history are untrusted model inputs and never
  instructions.
- Rendered Markdown is sanitized with an allowlist. Application-owned internal
  link and external-citation components create links.
- Server-side URL validation permits only HTTP and HTTPS external citations and
  prevents script or local-file schemes.
- Direct-PDF ingestion permits HTTPS only, rejects any non-global DNS answer,
  pins one validated address for each TLS connection, revalidates every bounded
  redirect, and enforces response type, signature, byte, encoding, and timeout
  limits before transient provider submission.
- Authorization occurs before resource-specific validation where validation
  could reveal private data.
- Node IDs supplied by the model are accepted only from the server-created
  evidence map for that generation.
- Approval uses optimistic input-version checks and row locks.
- Destructive subtree deletion is transactional and confirmed.
- Logs exclude prompts, message bodies, synthesis content, API keys, OAuth
  material, and raw provider responses by default.
- Public share responses cannot disclose structured out-of-scope citation
  identities, Chat, proposal history, embeddings, share records, owner records,
  or mutation controls.
- v0.1.0 shipped without analytics or third-party error reporting. The narrow
  post-release Vercel Web Analytics boundary defined above is the only approved
  analytics exception; third-party error reporting remains absent.

## Quality boundary

### Automated verification

- Unit tests cover iterative deep-tree assembly, breadcrumbs, archive
  filtering, search, move destinations, Summary and Branch Outline staleness
  propagation, context selection, input fingerprints, diff presentation,
  citation normalization, References ordering, and constellation layout.
- PostgreSQL integration tests cover ownership, sibling-order races, cycle
  prevention, archive behavior, cascade deletion, persistent chat replay,
  proposal state transitions, approval concurrency, Branch Outline generation
  replay, source-version conflicts, stale ancestor marking, citation
  constraints, embedding ownership, share-link lifecycle, dynamic public
  subtree reads, revocation, and internal-link scope filtering.
- AI-boundary tests use deterministic synthetic provider fixtures for streamed
  chat, Summary proposals, Branch Outlines, refusals, invalid structured
  output, invalid citations, web-search annotations, direct-PDF provenance,
  retries, and timeouts.
  Normal automated tests do not call paid external models.
- A small opt-in evaluation suite calls the configured real models with
  synthetic knowledge trees to measure instruction following, Summary proposal
  quality, Branch Outline composition, citation precision, unsupported-claim
  rate, and approval-boundary compliance.
- Playwright covers sign-in, responsive tree navigation, chat persistence,
  proposal refinement/approval/rejection, Branch Outline generation and
  regeneration, stale parent refresh through Chat, external citations,
  archive/delete behavior, drag-and-drop with Move To parity, public share-link
  creation/revocation and read-only subtree viewing, plus Node Constellation at
  desktop and mobile widths.
- CI runs lint, typecheck, unit tests, integration tests, production build, and
  deterministic browser tests. Live-model evaluations are deliberate release
  evidence, not an uncontrolled per-commit requirement.

### Accessibility baseline

- Interactive controls have accessible names and visible keyboard focus.
- Tree, Chat, Branch Outline, proposal, approval, archive, movement, public
  thought-trail navigation, and constellation recovery flows are
  keyboard-operable.
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
  Chat, Branch Outline generation, proposal approval and rejection,
  child-driven staleness, web citations, archive/delete recovery, public
  thought-trail sharing and revocation, responsive layout, and constellation
  navigation with synthetic data.
- v0.1.0 is the first tag. No release tags are created during implementation.
- The final reviewed release-readiness change deletes
  `IMPLEMENTATION_PLAN.md`, confirms `package.json` version `0.1.0`, and leaves
  this specification plus the workflow documents as the durable authorities.
