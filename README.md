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

- Catalog (tracked): `scripts/startup-seed/catalog.json`
- Images (**not** committed): put rasters next to the catalog under `scripts/startup-seed/images/`, or use a local dir such as `data/startup-puzzles/images/` (`data/` is gitignored)

Each catalog entry needs a matching file named `{id}-*.{jpg,jpeg,png,webp}` (e.g. `01-alpine-lake-mirror.jpg`).

```bash
# Dry-run first 5 (defaults: scripts/startup-seed catalog + images)
bun run admin:startup:upload -- --dry-run --limit 5

# Production: first 5
bun run admin:startup:upload -- --limit 5

# Range
bun run admin:startup:upload -- --from 6 --to 10

# Local-generated assets under data/
bun run admin:startup:upload -- \
  --server https://perseus.cwchanap.dev \
  --catalog data/startup-puzzles/catalog.json \
  --images data/startup-puzzles/images \
  --limit 5
```

| Command                        | Description                        |
| ------------------------------ | ---------------------------------- |
| `bun run admin:startup:status` | Check Access credentials + passkey |
| `bun run admin:startup:upload` | Upload catalog entries             |

Useful options: `--from`, `--to`, `--limit`, `--delay-ms`, `--dry-run`, `--skip-access` (local only).

### CI seed workflow

`gh workflow run seed-startup-puzzles.yml` uses Pulumi stack outputs + secrets to upload directly to production. The workflow is triggered manually (`workflow_dispatch`), not on release. Seed images are not committed to git — provide them via a GitHub release tarball:

```bash
# Create a release with the seed tarball (catalog.json + images/ at the root)
tar -czf perseus-seed.tgz -C scripts/startup-seed catalog.json images
gh release create seed-v1 perseus-seed.tgz

# Run the workflow, pointing it at the release
gh workflow run seed-startup-puzzles.yml -f asset_release=seed-v1 -f from=1 -f to=70
```

Alternatively, place files under `scripts/startup-seed/` in the checkout (e.g., via a private mirror). Prefer local CLI upload for operator-held assets so binaries stay out of git.

### Service token blast radius

The admin CLI service token (provisioned by Pulumi, 1-year lifetime) is scoped to the same Cloudflare Access application that protects **all** admin routes (`/admin/*`, `/api/admin/*`). This means the token can reach any admin endpoint — not just puzzle upload, but also list, delete, and login. The token is `non_identity` Service Auth, so it bypasses the email + device posture check but still requires the `ADMIN_PASSKEY` for the admin session.

To narrow the blast radius, create a separate Access application covering only `POST /api/admin/puzzles` with the service token, and exclude that path from the main admin application. This is not currently implemented — the single-operator tradeoff was documented instead.

### Token rotation

The service token expires after 1 year (`DEFAULT_ADMIN_CLI_SERVICE_TOKEN_DURATION = '8760h'`). To adjust the expiration:

1. `cd packages/infrastructure && pulumi config set adminCliServiceTokenDuration 4380h` (6 months, or leave unset for the 1-year default)
2. `pulumi up` — Pulumi updates the token's expiration in-place (client_id/secret stay the same)

To rotate credentials (new client_id + client_secret):

1. `cd packages/infrastructure && pulumi up --target-replace "urn:pulumi:production::perseus-infrastructure::cloudflare:index/zeroTrustAccessServiceToken:ZeroTrustAccessServiceToken::admin-access-cli-service-token"`
2. Update `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` in CI secrets and `apps/api/.env`:
   ```
   CF_ACCESS_CLIENT_ID=$(pulumi stack output adminCliAccessClientId)
   CF_ACCESS_CLIENT_SECRET=$(pulumi stack output --show-secrets adminCliAccessClientSecret)
   ```
3. Verify: `bun run admin:startup:status`

### Idempotency

The upload script fetches existing puzzle names from `GET /api/admin/puzzles` before uploading and skips entries whose name already exists on the server. This prevents duplicate puzzles on rerun. If the fetch fails, the script proceeds without the dedup check (with a warning).

### Notes

- Prefer **Access service tokens** for automation. Do not rely on copying `CF_Authorization` cookies or `cloudflared access login` for scripts (device posture / edge token transfer is unreliable for headless use).
- Uploaded puzzles start as `processing` until the workflow finishes; they appear in the gallery when `status` is `ready`.
- Keep service token secrets and seed images out of git. `apps/api/.env` and `data/` are gitignored; `scripts/startup-seed/images/*` ignores raster files.
