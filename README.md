# Perseus

Single-player jigsaw puzzle arcade: SvelteKit web app, Hono API (Bun / Cloudflare Workers), and Cloudflare Workflows for piece generation.

## Development

```bash
bun install
cd apps/api && bun run db:migrate:local
bun run dev
```

See `CLAUDE.md` / `AGENTS.md` for monorepo layout, env vars, and testing.

## Admin CLI: upload puzzles

Production admin routes (`/api/admin/*`) sit behind **Cloudflare Access**. Interactive browser login is for humans; scripts should use an **Access service token** (Client ID + Client Secret) plus the app admin passkey.

### Credentials

| Variable                  | Purpose                                                 |
| ------------------------- | ------------------------------------------------------- |
| `ADMIN_PASSKEY`           | Perseus admin passkey (same as admin UI login)          |
| `CF_ACCESS_CLIENT_ID`     | Access service token client id → `CF-Access-Client-Id`  |
| `CF_ACCESS_CLIENT_SECRET` | Access service token secret → `CF-Access-Client-Secret` |

**Local API** (`http://127.0.0.1:3000`): only `ADMIN_PASSKEY` is required. Use `--skip-access` if needed.

**Production** (`https://perseus.cwchanap.dev`): all three are required for the CLI.

After infrastructure deploy, load the service token from Pulumi stack outputs (or paste them into `apps/api/.env` next to `ADMIN_PASSKEY`):

```bash
export CF_ACCESS_CLIENT_ID="$(cd packages/infrastructure && pulumi stack output adminCliAccessClientId)"
export CF_ACCESS_CLIENT_SECRET="$(cd packages/infrastructure && pulumi stack output --show-secrets adminCliAccessClientSecret)"
export ADMIN_PASSKEY='your-admin-passkey'
# or rely on apps/api/.env for ADMIN_PASSKEY / CF_ACCESS_*
```

Check readiness:

```bash
bun run admin:startup:status
```

### Single puzzle

Upload one image with name, piece count, optional aspect ratio and category.

```bash
# Local
bun run admin:upload -- \
  --image ./my-puzzle.jpg \
  --name "My Puzzle" \
  --pieces 100 \
  --aspect 1:1 \
  --category Nature

# Production
bun run admin:upload -- \
  --server https://perseus.cwchanap.dev \
  --image ./my-puzzle.jpg \
  --name "My Puzzle" \
  --pieces 100 \
  --aspect 1:1 \
  --category Nature
```

| Flag         | Description                                                          |
| ------------ | -------------------------------------------------------------------- |
| `--server`   | API base URL (default `http://127.0.0.1:3000`)                       |
| `--passkey`  | Admin passkey (or `ADMIN_PASSKEY`)                                   |
| `--image`    | Path to JPEG/PNG/WebP                                                |
| `--name`     | Puzzle display name                                                  |
| `--pieces`   | Piece count (must be valid for the aspect ratio)                     |
| `--aspect`   | `1:1`, `4:3`, or `3:4`                                               |
| `--category` | Optional: Animals, Nature, Art, Architecture, Abstract, Food, Travel |

**Valid piece counts (examples):**

- `1:1`: 4, 9, 16, 25, 36, 49, 64, 81, 100, 121, 144, 169, 196, 225
- `4:3` / `3:4`: 12, 48, 108, 192

Image pixel aspect must match `--aspect` (the API validates dimensions).

### Bulk / startup catalog

Catalog + images under `scripts/startup-seed/` (or `data/startup-puzzles/` for local generation work).

```bash
# Dry-run first 5
bun run admin:startup:upload -- --dry-run --limit 5

# Production: first 5
bun run admin:startup:upload -- --limit 5

# Range
bun run admin:startup:upload -- --from 6 --to 10

# Custom paths
bun run admin:startup:upload -- \
  --server https://perseus.cwchanap.dev \
  --catalog scripts/startup-seed/catalog.json \
  --images scripts/startup-seed/images \
  --limit 5
```

| Command                        | Description                        |
| ------------------------------ | ---------------------------------- |
| `bun run admin:startup:status` | Check Access credentials + passkey |
| `bun run admin:startup:upload` | Upload catalog entries             |

Useful options: `--from`, `--to`, `--limit`, `--delay-ms`, `--dry-run`, `--skip-access` (local only).

Catalog entries need matching image files named `{id}-*.jpg` (e.g. `01-alpine-lake-mirror.jpg`).

### CI seed workflow

Without local Pulumi credentials, seed from GitHub Actions (uses stack outputs + secrets in the `production` environment):

```bash
gh workflow run seed-startup-puzzles.yml -f limit=5
```

### Notes

- Prefer **Access service tokens** for automation. Do not rely on copying `CF_Authorization` cookies or `cloudflared access login` for scripts (device posture / edge token transfer is unreliable for headless use).
- Uploaded puzzles start as `processing` until the workflow finishes; they appear in the gallery when `status` is `ready`.
- Keep service token secrets out of git. `apps/api/.env` is gitignored.
