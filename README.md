# MindTree

MindTree is a private, self-hostable workspace for developing thoughts, ideas,
and concepts in an infinitely nestable tree. Each node will pair a persistent
conversation with a concise synthesis that only the owner can approve.

The project is in its persistence and authentication phase. The current
runtime supports the configured single Google account, an empty authenticated
dashboard, and sign-out. Node editing, chat, and AI behavior arrive in later
reviewed phases.

MindTree adapts the general stack, interaction restraint, and visual language of
[ECWireless/TimeTree](https://github.com/ECWireless/timetree) at commit
[`51641ef1bc5de3e0f1d1a2ead168945d33fad47d`](https://github.com/ECWireless/timetree/commit/51641ef1bc5de3e0f1d1a2ead168945d33fad47d).
TimeTree is MIT-licensed, copyright 2026 Coopa LLC.

Intentional Phase 1 divergences from that baseline are narrow and explicit:

- MindTree copy, metadata, and the synthetic dashboard describe thought
  organization and synthesis rather than time tracking.
- DnD Kit and d3-force remain deferred until the phases that introduce their
  behavior.
- Better Auth, Drizzle, and PostgreSQL follow the pinned TimeTree foundation,
  while MindTree's first migration deliberately contains authentication tables
  only.
- The visual system keeps TimeTree's tokens, density, focus treatment, and
  responsive breakpoint while using the same favicon and MindTree-specific
  content.

## Requirements

- Node.js 22.12 or newer in the 22.x line, or Node.js 24 or newer
- Corepack and pnpm 11.13.1
- PostgreSQL 15 or newer
- Google OAuth credentials

An OpenAI API key is not needed until the later model-integration phase.

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
   - `ALLOWED_EMAIL`: the one verified Google account allowed to sign in.

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
synthetic authentication configuration and do not contact Google.

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
database credentials, and AI-provider access remain separate operational
approval boundaries.

## License

MindTree is available under the [MIT License](./LICENSE).
