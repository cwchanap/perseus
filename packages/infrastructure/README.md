# Perseus Infrastructure

This package contains Pulumi infrastructure-as-code definitions for the Perseus Cloudflare Workers deployment.

## Structure

- `src/index.ts` - Main Pulumi program entry point
- `src/config.ts` - Environment configuration and naming conventions
- `src/resources.ts` - Cloudflare resource definitions (R2, KV)
- `src/workers.ts` - Worker script definitions with bindings

## Resources Managed

### Workers

- **API Worker** (`perseus`): Main API with KV and R2 bindings
- **Workflows Worker** (`perseus-workflows`): Background workflow processing with KV and R2 bindings

### Storage

- **R2 Bucket**: `perseus-production` - Stores puzzle assets
- **KV Namespace**: `perseus-kv-production` - Stores puzzle metadata

### Bindings

- **KV Namespaces**: `PUZZLE_METADATA` binding to KV namespace
- **R2 Buckets**: `PUZZLES_BUCKET` binding to R2 bucket
- **Environment Variables**: `NODE_ENV=production` set on both workers

## Usage

### Prerequisites

1. Install Pulumi CLI and login:

```bash
brew install pulumi/tap/pulumi
pulumi login --local
```

2. Configure Cloudflare credentials:

```bash
export CLOUDFLARE_API_TOKEN="your-api-token"
```

### Configuration

Set your Cloudflare Account ID:

```bash
cd packages/infrastructure
pulumi config set cloudflareAccountId YOUR_ACCOUNT_ID
pulumi config set ALLOWED_ORIGINS https://your-production-origin.example
pulumi config set AUTH_REDIRECT_BASE_URL https://your-production-origin.example
```

Configure player Google OAuth callback URLs in Google Cloud Console:

```text
Production callback URL:
https://your-production-origin.example/api/auth/google/callback

Local callback URL:
http://localhost:4690/api/auth/google/callback
```

### Deploy

```bash
# Preview changes
pulumi preview

# Deploy infrastructure
pulumi up

# View outputs
pulumi stack output

# Destroy infrastructure (careful!)
pulumi destroy
```

## Deployment Workflow

This Pulumi setup replaces wrangler for infrastructure management. The complete deployment workflow is:

### 1. Build the Web App

```bash
bun run build --filter=@perseus/web
```

### 2. Deploy Infrastructure with Pulumi

```bash
cd packages/infrastructure
pulumi up
```

This creates/updates:

- R2 bucket (`perseus-production`)
- KV namespace (`perseus-kv-production`)
- API Worker (`perseus`) with bindings
- Workflows Worker (`perseus-workflows`) with bindings

### 3. Upload Puzzle Assets to R2 (Optional)

If you have puzzle assets (images, metadata files), upload them to the R2 bucket:

```bash
# Upload puzzle assets to R2 (using wrangler or AWS S3-compatible CLI)
wrangler r2 object put perseus-production/puzzles/example.png --file ./assets/example.png
```

**Note:**

- **Web static assets** (HTML, CSS, JS) are deployed automatically via Workers Assets when Pulumi deploys the API worker (configured via `assets: { directory: paths.webAssets }`)
- **Puzzle assets** (images, metadata) should be uploaded to the R2 bucket separately using wrangler, AWS CLI (S3-compatible), or a custom script

## Migration from Wrangler

This Pulumi setup completely replaces:

- `apps/api/wrangler.production.toml`
- `apps/workflows/wrangler.production.toml`

### What was migrated:

| Wrangler Config          | Pulumi Equivalent                       |
| ------------------------ | --------------------------------------- |
| `name = "perseus"`       | `naming.workerApi` in config            |
| `main = "src/worker.ts"` | Worker code read from `paths.apiWorker` |
| `compatibility_date`     | `compatibility.date` in config          |
| `compatibility_flags`    | `compatibility.flags` in config         |
| `[[r2_buckets]]`         | `r2BucketBindings` in WorkersScript     |
| `[[kv_namespaces]]`      | `kvNamespaceBindings` in WorkersScript  |
| `[vars] NODE_ENV`        | `plainTextBindings` in WorkersScript    |
| `[assets]`               | Manual upload to R2 (see step 3 above)  |

### What requires wrangler (runtime features):

- **Durable Objects**: Migrations and class definitions
- **Workflows**: Class definitions and triggers
- **Secrets**: Use `wrangler secret put` or Pulumi config

## Secrets

For sensitive environment variables (secrets), use Pulumi config with secrets:

```bash
pulumi config set --secret jwtSecret YOUR_JWT_SECRET
pulumi config set --secret adminPasskey YOUR_ADMIN_PASSKEY
pulumi config set --secret googleClientId YOUR_GOOGLE_CLIENT_ID
pulumi config set --secret googleClientSecret YOUR_GOOGLE_CLIENT_SECRET
```

### Zero Trust Admin Protection

The production admin portal is protected by a Cloudflare Zero Trust Access
application managed by Pulumi. The Access app covers only:

- `https://perseus.cwchanap.dev/admin`
- `https://perseus.cwchanap.dev/admin/*`
- `https://perseus.cwchanap.dev/api/admin`
- `https://perseus.cwchanap.dev/api/admin/*`

Public puzzle routes and player auth routes remain outside this Access app.

Configure the required admin Access values as Pulumi secrets:

```bash
cd packages/infrastructure
pulumi config set --secret adminAccessEmail "you@example.com"
pulumi config set --secret adminDeviceSerials '["DEVICE_SERIAL_1","DEVICE_SERIAL_2"]'
```

`adminDeviceSerials` must be a JSON array string. To add or remove a trusted device,
update the secret value and redeploy infrastructure.
`adminAccessEmail` must be a single email address.

On macOS, you can populate `adminDeviceSerials` for the current device without printing
the serial number:

```bash
scripts/admin-device-serial.sh --set-pulumi-secret
```

Use `scripts/admin-device-serial.sh --print-json` when you need to collect serials from
multiple devices before setting the JSON array secret.

Access session duration defaults to `12h`. Optionally override it with:

```bash
cd packages/infrastructure
pulumi config set adminAccessSessionDuration 4h
```

GitHub Actions deploys require these repository secrets:

- `ADMIN_ACCESS_EMAIL`
- `ADMIN_DEVICE_SERIALS`

`ADMIN_DEVICE_SERIALS` uses the same JSON array string format.

Manual verification after deploy:

- Allowed WARP-enrolled device and matching identity: `/admin` reaches the existing
  Perseus passkey page.
- Device without passing the serial-number posture check: `/admin` is denied by
  Cloudflare Access before Perseus loads.
- `/`, `/api/puzzles`, and `/api/auth/session` remain reachable without Cloudflare Access.
- After Access allows the request, the existing Perseus admin passkey still rejects
  invalid login attempts.

### CLI Service Token Rotation

The non-interactive CLI service token (`Perseus Admin CLI`) has a default lifetime
of **1 year** (`8760h`). Override it at deploy time:

```bash
cd packages/infrastructure
pulumi config set adminCliServiceTokenDuration 720h   # e.g. 30 days
```

Cloudflare Access expires the token automatically once the duration elapses —
requests using the stale `CF-Access-Client-Id` / `CF-Access-Client-Secret` pair
will start receiving 403. Rotate **before** expiry to avoid an outage:

```bash
cd packages/infrastructure

# 1. Taint the token resource so Pulumi recreates it with a fresh client_id + secret
pulumi state taint "$(pulumi stack export --json | jq -r \
  '.deployment.resources[] | select(.type=="cloudflare:index:zeroTrustAccessServiceToken") | .urn')"

# 2. Recreate the token
pulumi up

# 3. Read the new credentials (client_secret is masked unless --show-secrets is passed)
pulumi stack output --show-secrets adminCliAccessClientId
pulumi stack output --show-secrets adminCliAccessClientSecret
```

Update downstream consumers with the new values:

- **GitHub Actions secrets**: `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`
- **Local CLI env** (`apps/api/.env` or shell): `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`

## Complete Wrangler Replacement

To eliminate wrangler.toml files:

1. ✅ Move resource definitions to Pulumi (done)
2. ✅ Move environment variables to Pulumi (done)
3. ⏳ Static assets - use R2 upload script or keep wrangler for this
4. ⏳ Secrets - use Pulumi secrets or `wrangler secret`
5. ⏳ Durable Object migrations - still require wrangler

For a complete wrangler-free deployment, create an upload script:

```bash
# scripts/deploy-assets.sh
#!/bin/bash
cd apps/web
find build -type f | while read file; do
  key="${file#build/}"
  wrangler r2 object put perseus-production/$key --file "$file"
done
```
