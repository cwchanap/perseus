# Perseus

Single-player jigsaw puzzle arcade built with SvelteKit, a Hono API on Cloudflare Workers, and Cloudflare Workflows for piece generation.

## Development

```bash
bun install
cd apps/api && bun run db:migrate:local
cd ../..
bun run dev
```

The API development server runs on `http://localhost:4690`.

## Documentation

- Contributor guide: [`CLAUDE.md`](CLAUDE.md) (`AGENTS.md` is a symlink to the same guide)
- Production/admin operations: [`docs/OPERATOR_RUNBOOK.md`](docs/OPERATOR_RUNBOOK.md)
