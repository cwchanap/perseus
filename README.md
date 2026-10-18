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

- Contributor guide: [`AGENTS.md`](AGENTS.md)
- Production/admin operations: [`.agents/skills/perseus-operations/SKILL.md`](.agents/skills/perseus-operations/SKILL.md)
