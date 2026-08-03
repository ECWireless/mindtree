# MindTree

MindTree is a private, self-hostable workspace for developing thoughts, ideas,
and concepts in an infinitely nestable tree. Each node will pair a persistent
conversation with a concise synthesis that only the owner can approve.

The project is in its application-foundation phase. The current runtime is a
signed-out responsive shell; persistence, Google authentication, node editing,
chat, and AI behavior arrive in later reviewed phases.

MindTree adapts the general stack, interaction restraint, and visual language of
[ECWireless/TimeTree](https://github.com/ECWireless/timetree) at commit
[`51641ef1bc5de3e0f1d1a2ead168945d33fad47d`](https://github.com/ECWireless/timetree/commit/51641ef1bc5de3e0f1d1a2ead168945d33fad47d).
TimeTree is MIT-licensed, copyright 2026 Coopa LLC.

Intentional Phase 1 divergences from that baseline are narrow and explicit:

- MindTree copy, metadata, and the synthetic dashboard describe thought
  organization and synthesis rather than time tracking.
- Better Auth, Drizzle, PostgreSQL, DnD Kit, and d3-force are deferred until
  the phases that introduce their behavior.
- The signed-out page has no simulated sign-in path; real Google authentication
  begins in Phase 2.
- The visual system keeps TimeTree's tokens, density, focus treatment, and
  responsive breakpoint while using the same favicon and MindTree-specific
  content.

## Requirements

- Node.js 22.12 or newer in the 22.x line, or Node.js 24 or newer
- Corepack and pnpm 11.13.1

PostgreSQL 15+, Google OAuth credentials, and an OpenAI API key will be needed
only when their corresponding phases land.

## Local setup

Install dependencies and start the development server:

```sh
corepack pnpm install
corepack pnpm dev
```

Open `http://localhost:3000`. The Phase 1 shell does not require secrets or a
database connection.

`.env.example` documents the eventual server environment names. Copy it to an
ignored `.env` only when working on a phase that needs those services. Never
commit credentials or private content.

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

The integration command intentionally passes with no integration files during
Phase 1. PostgreSQL-backed cases and database migration commands arrive with
the Phase 2 persistence work.

## Deployment shape

The canonical target is a standard Next.js Node.js application on Vercel with
PostgreSQL on Neon. Builds never run migrations automatically. Deployment,
OAuth callbacks, database credentials, and AI-provider access remain outside
the current foundation unit.

## License

MindTree is available under the [MIT License](./LICENSE).
