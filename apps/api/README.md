# Perseus API

Hono API running on Cloudflare Workers for local development and production. Bun remains the package manager and test runner; it is not a second HTTP runtime.

## Development

From the repository root:

```bash
cd apps/api && bun run db:migrate:local
cd ../..
bun run dev --filter=@perseus/api
```

The normal local API port is `4690`. Local D1, KV, R2, Durable Object, and Workflow bindings are provided by Wrangler.

For repository layout, environment variables, testing, and contributor conventions, see [`../../CLAUDE.md`](../../CLAUDE.md). For deployment and admin procedures, use the [`perseus-operations`](../../.agents/skills/perseus-operations/SKILL.md) skill.
