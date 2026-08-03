# Integration tests

PostgreSQL-backed integration tests use the migrated database selected by
`DATABASE_URL_UNPOOLED` or `DATABASE_URL`. The configuration runs serially;
tests use synthetic identities and either roll back their work or remove the
records they created.

Apply the committed migrations before running the suite:

```sh
corepack pnpm db:migrate
corepack pnpm test:integration
```
