# MindTree

MindTree is a private, self-hostable workspace for developing thoughts, ideas,
and concepts in an infinitely nestable tree. Each thought pairs a persistent
conversation with a concise Summary that only the owner can explicitly publish.

The current runtime supports the configured single Google account, an ordered
and archivable tree, responsive keyboard-accessible editing, persistent streamed
Chat, reviewable Summary proposals, recursive Branch Outlines, semantic
related-thought evidence, and validated internal and external citations.

MindTree adapts the general stack, interaction restraint, and visual language of
[ECWireless/TimeTree](https://github.com/ECWireless/timetree) at commit
[`51641ef1bc5de3e0f1d1a2ead168945d33fad47d`](https://github.com/ECWireless/timetree/commit/51641ef1bc5de3e0f1d1a2ead168945d33fad47d).
TimeTree is MIT-licensed, copyright 2026 Coopa LLC.

MindTree intentionally keeps the baseline's restrained interaction and visual
principles while using MindTree-specific product behavior:

- The tree supports pointer drag-and-drop plus a keyboard-accessible **Move
  To…** workflow.
- Generated Summary proposals remain unpublished until the owner uses the
  explicit approval control.
- Branch Outlines compose direct-child evidence without becoming a second
  editable document.
- Archive is reversible; permanent subtree deletion is the history-removal
  boundary.

## Requirements

- Node.js 22.12 or newer in the 22.x line, or Node.js 24 or newer
- Corepack and pnpm 11.13.1
- PostgreSQL 15 or newer
- Google OAuth credentials
- An OpenAI API key for runtime assistant generation

## Local setup

1. Install dependencies:

   ```sh
   corepack pnpm install
   ```

2. Copy `.env.example` to the ignored `.env` and configure:

   - `DATABASE_URL`: pooled PostgreSQL connection used by the application;
   - `DATABASE_URL_UNPOOLED`: optional direct connection for migrations;
   - `BETTER_AUTH_SECRET`: a random secret containing at least 32 characters;
   - `BETTER_AUTH_URL`: the application origin, such as `http://localhost:3000`;
   - `BETTER_AUTH_TRUSTED_ORIGINS`: optional comma-separated additional origins
     allowed to submit authentication requests;
   - `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`;
   - `ALLOWED_EMAIL`: the one verified Google account allowed to sign in;
   - `OPENAI_API_KEY`: server-only Responses and Embeddings API access for
     Chat, Summary proposals, Branch Outlines, requested research, and semantic
     related-thought retrieval.

   Local PostgreSQL may use the same connection for both database URL fields.
   Keep local environment files ignored and never commit credentials.

3. Register the local Google OAuth callback:

   ```text
   <BETTER_AUTH_URL>/api/auth/callback/google
   ```

4. Apply the committed migration and start the server:

   ```sh
   corepack pnpm db:migrate
   corepack pnpm dev
   ```

Open `http://localhost:3000` and continue with the configured Google account.
Changing `ALLOWED_EMAIL` immediately removes dashboard access from a retained
session for the previous account. MindTree retains the Google account identity
but discards provider access, refresh, and ID tokens because it does not call
Google APIs after authentication.

## Models, research, and retention

MindTree uses fixed reviewed profiles rather than runtime-selectable models:

- `gpt-5.6-sol` handles Chat, Summary proposals, requested web/PDF research,
  and Branch Outlines;
- `text-embedding-3-large` with 3,072 dimensions supports semantic
  related-thought retrieval.

Every provider request uses bounded application context. Responses API requests
set `store: false`; embedding requests use the fixed reviewed profile and remain
subject to separately reviewed provider retention controls. MindTree keeps its
own canonical conversations and generated artifacts in PostgreSQL; it does not
persist or display raw reasoning output or raw provider payloads. Node titles,
conversations, summaries, outlines, and research excerpts are treated as
untrusted model input.

External access is off by default. **Use external sources** authorizes only the
next message to use requested web research or one explicitly supplied HTTPS PDF.
MindTree validates citation provenance and stores the cited URL, title, and text
location needed to render durable inline markers and References. Ordinary Chat
and deterministic tests never search externally. Chat messages and generated
versions are immutable; permanently deleting their node or subtree removes that
stored history.

## Verification

Run each available check independently:

```sh
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:integration
corepack pnpm build
corepack pnpm test:e2e
```

Install the Chromium binary used by Playwright when needed:

```sh
corepack pnpm exec playwright install chromium
```

Integration tests require the migrated PostgreSQL database. Browser tests use
synthetic authentication and deterministic provider fixtures at 320px small
mobile, 375px mobile, 768px tablet, and 1440px desktop widths. Normal automated
verification does not contact Google or OpenAI.

## Database changes

Schema changes belong in `src/db/schema.ts` and ship as reviewed SQL
migrations:

```sh
corepack pnpm db:generate
corepack pnpm db:check
corepack pnpm db:migrate
```

Prefer `DATABASE_URL_UNPOOLED` for migration tooling. Review generated SQL and
confirm the target database before applying it. Builds never run migrations.

## Deployment shape

The canonical target is a standard Next.js Node.js application on Vercel with
PostgreSQL on Neon. Builds never run migrations automatically. Arbitrary Vercel
preview origins do not initiate Google OAuth; they direct visitors to the
configured canonical origin instead. Production deployment, OAuth callbacks,
database credentials, migrations, and AI-provider access remain separate
operational approval boundaries. Keep `OPENAI_API_KEY` server-only and review
provider data controls independently before enabling a production deployment.

## License

MindTree is available under the [MIT License](./LICENSE).
