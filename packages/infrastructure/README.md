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
```

Then access in code via:

```typescript
const config = new pulumi.Config();
const jwtSecret = config.requireSecret('jwtSecret');
```

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
