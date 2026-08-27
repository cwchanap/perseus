# Perseus Operations Reference

This is the detailed reference for the repo-local `perseus-operations` skill.
All paths and commands are relative to the Perseus repository root unless noted.
Each section links to the authoritative source for details that may drift.

---

## 1. Deploy Infrastructure

**Trigger:** push to `main` touching `packages/infrastructure/**`,
`packages/types/**`, `packages/shared/**`, `apps/api/**`,
`apps/workflows/**`, `apps/web/**`, or `.github/workflows/deploy-infrastructure.yml`.
Also available via `workflow_dispatch`.

**Workflow:** `.github/workflows/deploy-infrastructure.yml`

**Key behaviors:**

- `concurrency: cancel-in-progress: false` — deploys queue, never cancel
  mid-flight. See the workflow's inline comment for the rationale.
- **Deploy order (subsequent deploys):** Apply D1 migrations to the
  existing database BEFORE `pulumi up` publishes the new Worker code.
  Migrations run first, workers second. This ensures new columns/tables
  are present by the time the new Worker version is live.
- **Deploy order (first deploy):** `pulumi up` creates the D1 database AND
  publishes the Worker in the same step, so the Worker is live before
  `wrangler d1 migrations apply` runs (see the first-deploy gap below).
- **Preview job** inherits the `production` environment's protection rules
  (required reviewers, wait timers). A stuck or pending preview blocks
  deploys because the deploy job has `needs: [build, preview]`.
  **Workaround until resolved:** operators must approve the pending preview
  review for deploys to proceed. Tracked in
  [issue #67](https://github.com/cwchanap/perseus/issues/67) — create a
  `pulumi-preview` GitHub Environment that mirrors production secrets but
  has no required reviewers, then switch the preview job to
  `environment: pulumi-preview`.

**First-deploy D1 gap (zero-downtime):**
On the first-ever production deploy, the D1 database does not exist yet, so
the pre-publish migration step is skipped and `pulumi up` creates the
database and publishes the Worker in the same step. The Worker is live
before `wrangler d1 migrations apply` runs. D1-dependent paths can 500
until migrations complete:

- `POST /api/puzzles/:id/complete` → 500
- `GET /api/player/*` → 500
- `/api/admin/*` D1 operations → 500
- Workflow `setPuzzleStatus` → best-effort, logs and continues

**Zero-downtime first deploy (optional):**

With the production stack/config initialized, build the apps and pre-provision
only the D1 resource before triggering the workflow:

```bash
bun run build
PULUMI_CONFIG_PASSPHRASE='' pulumi up \
  --target 'urn:pulumi:production::perseus-infrastructure::cloudflare:index/d1Database:D1Database::player-data' \
  -s cwchanap/perseus-infrastructure/production \
  -C packages/infrastructure
```

Then trigger the workflow. **Read existing D1 database ID from stack** reads
`d1DatabaseId`; **Apply D1 migrations (before Worker publish)** synchronizes
`database_id` in both `apps/api/wrangler.production.toml` and
`apps/workflows/wrangler.production.toml`, then applies migrations before
**Pulumi Up** publishes either Worker. Subsequent deploys are unaffected.

**Source:** `deploy-infrastructure.yml` (Apply D1 migrations step comment),
`CLAUDE.md` → First-deploy D1 gap.

---

## Manual Pre-Release Browser Validation

Before a planned production release or before merging a release candidate to
`main`, dispatch **E2E Tests** on the candidate branch or tag. Require
**Manual pre-release suites** to pass.

The lane runs WebKit critical, extended five-project coverage, accessibility,
and Chromium stability sequentially. Ordinary pushes do not run this broad
lane automatically.

Accepted tradeoff: broad browser regressions can live until the pre-release run.

---

## 2. D1 Migration Safety

The deploy ordering (migrations first, workers second on subsequent
deploys) is safe for **additive** migrations only (new tables, new columns,
new indexes).

**Non-additive migrations (column rename, type change, column drop, table
drop):** adopt an expand/contract flow:

1. Ship the expand migration + backward-compatible Worker code first.
2. Ship the contract migration after the old Worker version is no longer
   live.

**Source:** `CLAUDE.md` → D1 migration safety,
`deploy-infrastructure.yml` (MIGRATION SAFETY comment).

---

## 3. D1 Database ID Sync

The `database_id` in `apps/api/wrangler.production.toml` and
`apps/workflows/wrangler.production.toml` must match the Pulumi-managed D1
database (exported as `d1DatabaseId` from the infrastructure stack).

**If the Pulumi stack is destroyed and recreated:**

1. Update both wrangler configs with the new database ID.
2. The deploy workflow overrides this value at runtime with the Pulumi stack
   output, so CI always targets the bound database. The static value is only
   used by manual `bun run db:migrate` operator runs.

**Source:** `CLAUDE.md` → D1 database ID.

---

## 4. D1 State-Loss Recovery (Re-adoption)

If Pulumi state is lost/corrupted but the D1 database still exists in
Cloudflare, do NOT let `pulumi up` create a fresh database (it would get a
new UUID and lose all data). Instead, re-adopt the existing database:

1. Find the existing UUID: `wrangler d1 list` or the Cloudflare dashboard.
2. Temporarily add an `import:` option to the existing resource-options
   object in `createD1Database` (`packages/infrastructure/src/resources.ts`),
   replacing `<UUID>` with the UUID from step 1:
   ```typescript
   import: `${accountId}/<UUID>`,
   ```
3. Run `pulumi up` to adopt the resource back into state:
   ```bash
   PULUMI_CONFIG_PASSPHRASE='' pulumi up \
     -s cwchanap/perseus-infrastructure/production \
     -C packages/infrastructure
   ```
4. Remove the temporary `import:` option so Pulumi fully owns the resource
   going forward.

**D1 and R2 are `protect: true`** — `pulumi destroy` or a destructive
replacement will refuse without first running
`PULUMI_CONFIG_PASSPHRASE='' pulumi state unprotect <resource-urn> \
-s cwchanap/perseus-infrastructure/production -C packages/infrastructure`
(URNs via `PULUMI_CONFIG_PASSPHRASE='' pulumi stack export -s \
cwchanap/perseus-infrastructure/production -C packages/infrastructure`).
This is intentional: it prevents a typo or wrong-cwd `pulumi destroy` from
nuking prod data. Re-protect after any legitimate destructive operation.

**History:** The original adoption procedure was introduced in `fd43f33`
and removed in `e3229c9` after adoption completed. Consult those commits if
the lines above are stale.

**Source:** `CLAUDE.md` → D1 state-loss recovery.

---

## 5. Seed Startup Puzzles

**Trigger:** `workflow_dispatch` only.
**Workflow:** `.github/workflows/seed-startup-puzzles.yml`

**Inputs:**

- `limit` — max catalog entries to upload (0 = no limit)
- `from` / `to` — catalog id range
- `asset_release` — optional GitHub release tag with seed tarball
  (catalog.json + images/)
- `asset_name` — tarball filename (default `perseus-seed.tgz`)
- `asset_sha256` — required when `asset_release` is set; verified before
  extraction

**Concurrency:** `cancel-in-progress: false` — a seed upload in flight must
not be cancelled by a later dispatch (mid-upload cancellation could leave
partially-seeded state).

**Requires:** Access CLI service token stack outputs after infrastructure
deploy. The workflow reads `adminCliAccessClientId` and
`adminCliAccessClientSecret` from the Pulumi stack.

**Source:** `seed-startup-puzzles.yml`.

---

## 6. Orphan Reaper (Automated Cleanup)

**What:** A cron-triggered scheduled handler in the API Worker that cleans
up orphaned puzzle metadata (KV) and original images (R2) left behind when
a puzzle create dies mid-flight or a workflow errors/terminates.

**Schedule:** Hourly (`0 * * * *`), configured in
`apps/api/wrangler.production.toml` `[triggers]`.

**Threshold:** Puzzles stuck in `processing` status for > 2 hours are
candidates. The stuck-processing scan (`reapStuckPuzzles`) checks the
workflow status; if the workflow is dead (`errored`, `terminated`, or
`unknown`/never-created), it deletes the KV metadata, R2 assets, D1
ownership row, and (best-effort) the DO idempotency reservation. A workflow
in `complete` status is explicitly **skipped** in this scan — `complete`
means every step succeeded including finalize, so a KV read that still
shows `processing` is eventual-consistency lag, not an orphan. Reaping
would destroy a valid completed puzzle. If KV never catches up, operator
force-delete (§7) is the escape hatch.

**Cleanup-record scan (`reapCleanupRecords`):** A separate reaper processes
durable cleanup records persisted by the commit-conflict path
(`cleanupOrphanedWorkflow` in the admin route). Unlike the stuck-processing
scan, this scan **does** process `complete` workflows: the durable cleanup
record confirms the puzzle's idempotency reservation was reclaimed by a
retry, so a completed workflow behind a reclaimed reservation is a
duplicate that must be removed. The `complete`-skip above applies
exclusively to the stuck-processing scan, where no durable record vouches
for duplication. (The reclaimed-reservation reaper `reapOrphanedReservations`
also processes `complete` workflows, using an idempotency-key ownership
mismatch as its durable orphan signal — see `reaper.ts` for details.)

**Safety:**

- Deletions are idempotent — safe to run concurrently with normal traffic.
- If the workflow status check fails (transient API error), the puzzle is
  skipped (fail closed).
- R2 deletion failure (partial or total) PRESERVES KV metadata — the
  failed R2 keys would become invisible orphans with no metadata to
  discover them. KV is retained so the next reaper run retries R2 cleanup.
  The DO is tombstoned before R2 deletion so a dead workflow cannot
  resurrect stale metadata via KV sync.
- Batch limit of 50 puzzles per run bounds destructive cleanup. The
  candidate catalog scan and reservation-DO lookups run over the full
  catalog (a persisted-cursor scale fix is tracked as a TODO in
  `reaper.ts`); mismatches are collected in deterministic input order so
  a fast-failing subset cannot starve older orphans.

**Monitoring:** Check Worker logs for `Reaper:` prefixed messages. Each run
logs `scanned`, `candidates`, `reaped`, and `errors` counts.

**Source:** `apps/api/src/services/reaper.ts`,
`apps/api/src/worker.ts` (scheduled handler).

### Avatar versioned-key orphans (automated GC)

The reaper sweeps avatar objects via `reapOrphanedAvatars`
(`apps/api/src/services/reaper.ts`). Each player-avatar upload writes to
a versioned key (`avatars/{playerId}/{token}`); D1's `avatarUpdateToken`
selects which version the serve route reads. After a successful upload,
the route re-reads D1 and deletes whichever versioned object is
definitively no longer authoritative — the previous token's object if
this upload is still authoritative, or this upload's own object if a
concurrent upload overwrote it. Concurrent overlapping uploads can still
orphan a loser's object (the authority check is a TOCTOU window, and
first-time concurrent uploads that both read `null` skip cleanup
entirely). The reaper closes that gap with delayed GC.

**Behavior:**

- Lists one bounded page of objects under `avatars/` per run
  (`limit: AVATAR_GC_BATCH_LIMIT` = 200), resuming from the persisted R2
  cursor `reaper:cursor:orphaned-avatars-r2`. It batch-queries D1 for
  each player's authoritative `avatarUpdateToken`, and deletes every
  versioned object in that page whose token is not authoritative AND
  whose age exceeds `AVATAR_GC_AGE_MS` (1 hour). The age threshold
  ensures in-flight uploads have completed before their objects are
  considered garbage.
- The R2 list cursor is the single progression mechanism: every eligible
  orphan in a listed page is processed before the cursor advances, so no
  orphan is starved. When a page is not truncated, the cursor is cleared
  so the next run starts a fresh sweep.
- **Fail-closed on D1 unavailability:** if D1 is unreachable, the reaper
  skips all deletion and records an `avatar-gc-d1-unavailable` detail —
  it cannot determine which objects are orphaned without the
  authoritative token. A future run catches them once D1 recovers.
- The legacy unversioned key (`avatars/{playerId}`) is **never deleted**;
  it serves as the D1-unavailable fallback in the serve route.

**Detail actions** in `result.details`:

- `avatar-gc-reaped` — object deleted successfully.
- `avatar-gc-delete-failed` — R2 delete threw; `error` field has details.
- `avatar-gc-d1-unavailable` — D1 query failed; no deletions attempted.

**Monitoring:** check Worker logs for `Reaper avatar GC:` messages and
the scheduled run's `scanned`/`candidates`/`reaped`/`errors` counts.

**Source:** `apps/api/src/services/reaper.ts` (`reapOrphanedAvatars`),
`apps/api/src/worker.ts` (scheduled handler).

**Manual cleanup:** the automated sweep makes manual cleanup unnecessary
in normal operation. If a manual sweep is ever required (e.g. D1 was
unavailable for an extended period and orphans accumulated beyond what
the per-run page reclaims quickly), use a token-aware, dry-run-first
procedure: list `avatars/` objects, cross-reference each
`avatars/{playerId}/{token}` against D1's `avatarUpdateToken`, and
delete only objects whose token is not authoritative AND whose age
exceeds `AVATAR_GC_AGE_MS`. Never bulk-delete the entire `avatars/`
prefix — the legacy unversioned key and any authoritative versioned
keys must be preserved.

---

## 7. Stuck Puzzle Manual Cleanup (Force Delete)

If a puzzle is stuck in `processing` and the reaper hasn't cleaned it up
(e.g. the workflow status check is failing), an operator can manually
force-delete it via the admin API:

```http
POST /api/admin/puzzle-delete/:id?force=true
```

The `force=true` query parameter bypasses the `processing`-status guard
that normally prevents deletion of in-flight puzzles. The delete route
follows the same safe lifecycle as the reaper and the commit-conflict
cleanup path:

1. **Pass read-only eligibility gates** before choosing deletion.
2. **Persist the cleanup record first** once deletion is chosen. This
   durable retry state must exist before destructive work begins.
3. **Pass the workflow-liveness gate without mutating fence/source state.**
   For a processing puzzle, request termination and confirm that the
   workflow stopped. Unconfirmed liveness causes no permanent D1 fence or
   DO/R2/KV source mutation; the cleanup record remains for a reaper retry.
4. **Establish the permanent D1 deletion fence** before mutating source
   state. Fence failure leaves DO/R2/KV untouched and retains the record.
5. **Mutate DO/R2/KV source state in order:** tombstone the metadata DO,
   delete R2 assets, then delete KV metadata. Any failure retains the
   cleanup record; R2 failure also preserves KV for discoverability.
6. **Finish required completion and ownership cleanup.** A failure keeps
   the permanent fence and cleanup record so a later pass can retry.
7. **Delete the cleanup record as a required final step** only after all
   preceding cleanup succeeds. Failure is retriable and retains the record.

The delete route uses `POST /api/admin/puzzle-delete/:id` (not
`DELETE /api/admin/puzzles/:id`) so it is NOT a sub-path of the narrow CLI
Access app's `/api/admin/puzzles` exact path — a service-token holder
cannot reach it at the Access gate.

**When to use:**

- The reaper is failing to reach the Workflow API.
- A puzzle's workflow is stuck in `running` but producing no progress
  (operator judgment required).
- After a D1 outage that left puzzle ownership/stats records orphaned.

**Source:** `apps/api/src/routes/admin.worker.ts` (POST /puzzle-delete/:id
handler).

---

## 8. Cloudflare Access (Admin Gate)

Two Access applications protect admin routes:

1. **Perseus Admin** (broad): covers `/admin`, `/admin/*`, `/api/admin`,
   `/api/admin/*`. Policy: email + device posture (browser admin).
2. **Perseus Admin CLI** (narrow): covers the exact `/api/admin/puzzles`
   path. Policies: email + device posture (browser admin still works) AND
   Service Auth (CLI service token).

**Path scoping (resolved):** Cloudflare Access is path-based, not
method-based. The delete route lives at `POST /api/admin/puzzle-delete/:id`,
which is a sibling of (not a sub-path of) the narrow CLI app's exact path
`/api/admin/puzzles`. It therefore inherits only the broad admin app's
email+posture policy — a service-token holder cannot reach the delete
endpoint at the Access gate. See the full analysis in
`packages/infrastructure/src/admin-access.ts` (the `CLI_ACCESS_PATHS`
comment).

**Source:** `packages/infrastructure/src/admin-access.ts`.

---

## 9. Idempotency Key Handling

- The `Idempotency-Key` header is a server-side dedup secret. It is never
  exposed on public puzzle reads (`stripIdempotencyKey` in
  `@perseus/types` removes it before returning metadata to clients).
- The `PuzzleMetadataDO` provides strongly consistent reservation state
  (reserve → commit/fail/release). KV is an eventually consistent read
  cache.
- Stale-pending reservations (> 5 min old) are reclaimable by later
  `/reserve` calls. The reclaim path checks workflow liveness and R2
  presence to avoid minting duplicates of live puzzles.
- **Client/server asymmetry:** the server treats `Idempotency-Key` as an
  opaque unique token (regex `^[A-Za-z0-9_-]{1,128}$`) and never decodes it.
  The seed-upload CLI (`scripts/startup/upload.ts`) builds a composite dedup
  key from `name + pieceCount + aspectRatio` joined by NUL bytes (invalid in
  HTTP headers) and SHA-256 hashes it to a hex string before sending. The
  hash is a client-side convenience; dedup correctness comes from the DO
  reservation state machine, not the token's encoding. Any client may supply
  any opaque token that matches the server regex.

**Source:** `apps/api/src/routes/admin.worker.ts` (POST /puzzles handler),
`apps/workflows/src/index.ts` (PuzzleMetadataDO),
`packages/types/src/index.ts` (`stripIdempotencyKey`),
`scripts/startup/upload.ts` (`idempotencyKey`/`idempotencyKeyHeader`).

---

## 10. Completion Usage Reconciliation and Capacity

**Use this operator-only maintenance procedure only when completion usage
counters need repair.** The reconciliation rebuilds
`player_completion_usage` from the retained `puzzle_completion_runs` ledger.

1. Pause or disable all completion writes for the maintenance window. Do not
   continue while any API or workflow can append completion runs.
2. Run this read-only preflight report. Abort and investigate if it returns
   any row; an oversized group cannot be reconciled safely.

   ```sql
   SELECT player_id, COUNT(*) AS retained_runs
   FROM puzzle_completion_runs
   GROUP BY player_id
   HAVING COUNT(*) > 100000;
   ```

3. Execute the checked-in maintenance SQL as one atomic D1 execution:

   ```bash
   bunx wrangler d1 execute perseus-player-data --remote \
     --config apps/api/wrangler.production.toml \
     --file packages/shared/drizzle/maintenance/reconcile_completion_usage.sql
   ```

4. Verify that the following mismatch query returns no rows before resuming
   writes:

   ```sql
   SELECT actual.player_id, actual.retained_runs, usage.retained_runs
   FROM (
   SELECT player_id, COUNT(*) AS retained_runs
   FROM puzzle_completion_runs
   GROUP BY player_id
   ) AS actual
   LEFT JOIN player_completion_usage AS usage
   ON usage.player_id = actual.player_id
   WHERE usage.retained_runs IS NULL
   OR usage.retained_runs != actual.retained_runs
   UNION ALL
   SELECT usage.player_id, 0, usage.retained_runs
   FROM player_completion_usage AS usage
   LEFT JOIN puzzle_completion_runs AS runs
   ON runs.player_id = usage.player_id
   WHERE runs.player_id IS NULL;
   ```

5. Resume completion writes only after the mismatch query returns no rows.
6. Monitor D1 `databaseSizeBytes`, ledger row count, tombstone row count, and
   their growth trend. Escalate before reaching the active plan's D1 size
   limit. Never prune tombstones without another permanent no-reuse mechanism.

**Source:** `packages/shared/drizzle/maintenance/reconcile_completion_usage.sql`,
`packages/shared/drizzle/0004_puzzle_deletion_fence.sql`.

---

## 11. Admin CLI Uploads

Production admin routes (`/api/admin/*`) sit behind **Cloudflare Access**.
Interactive browser login is for humans; scripts should use an **Access
service token** (Client ID + Client Secret). This is the sole credential for
automated list/create requests.
The single-upload CLI is `bun run admin:upload`; the bulk/startup catalog
uploader is `bun run admin:startup:upload`.

### Credentials

| Variable                  | Purpose                                                    |
| ------------------------- | ---------------------------------------------------------- |
| `CF_ACCESS_CLIENT_ID`     | Access service token client id → `CF-Access-Client-Id`     |
| `CF_ACCESS_CLIENT_SECRET` | Access service token secret → `CF-Access-Client-Secret`    |
| `CF_ACCESS_TOKEN`         | Alternative: pre-obtained Access JWT → `--cf-access-token` |

**Local API** (`http://127.0.0.1:4690`): admin routes have no application
authentication. Loopback targets skip Access automatically; `--skip-access`
is also available for explicit local use.

**Production** (`https://perseus.cwchanap.dev`): use **one** of the two Access
authentication methods:

1. **Service token (preferred):** `CF_ACCESS_CLIENT_ID` +
   `CF_ACCESS_CLIENT_SECRET` from Pulumi stack outputs.
2. **Access JWT (alternative):** `CF_ACCESS_TOKEN` env var or
   `--cf-access-token` flag with a pre-obtained `CF_Authorization` JWT.

Pulumi is only the credential lookup for the already-provisioned Cloudflare
Access service token. Pulumi does not upload a puzzle or authenticate the API
request itself.

### Local production authentication bootstrap

Load the Access service-token values into the current shell without printing
them.

First, verify that Pulumi is using the cloud backend:

```bash
pulumi whoami -v
```

The backend URL must be under `https://app.pulumi.com/`, not `file://~`. If it
is the local backend, log into Pulumi Cloud:

```bash
pulumi login https://api.pulumi.com --interactive --default-org cwchanap
```

If login reports that it is using `PULUMI_ACCESS_TOKEN` and then returns
`Unauthorized`, remove the stale variable before retrying:

```bash
# bash/zsh
unset PULUMI_ACCESS_TOKEN

# fish
set -e PULUMI_ACCESS_TOKEN
```

The production stack is `cwchanap/perseus-infrastructure/production`. Its
Pulumi config passphrase is intentionally empty, but the CLI still requires
the variable to be present. From the repository root in bash or zsh:

```bash
export CF_ACCESS_CLIENT_ID="$(
  PULUMI_CONFIG_PASSPHRASE='' pulumi stack output adminCliAccessClientId \
    -s cwchanap/perseus-infrastructure/production \
    -C packages/infrastructure
)"
export CF_ACCESS_CLIENT_SECRET="$(
  PULUMI_CONFIG_PASSPHRASE='' pulumi stack output --show-secrets \
    adminCliAccessClientSecret \
    -s cwchanap/perseus-infrastructure/production \
    -C packages/infrastructure
)"
```

Do not echo either variable. Check readiness before uploading:

```bash
bun run admin:startup:status
```

The successful result reports `Service token: yes`, `Access probe: ok`, and
`Ready`.

| Symptom                                                         | Resolution                                                                                   |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Backend is `file://~`, org must be `organization`, or no output | Log into Pulumi Cloud; the CLI is reading an unrelated local stack.                          |
| Login uses `PULUMI_ACCESS_TOKEN` and returns `Unauthorized`     | Remove the stale environment variable, then repeat interactive login.                        |
| Pulumi says the config passphrase must be set                   | Prefix each stack-output command with `PULUMI_CONFIG_PASSPHRASE=''`.                         |
| Status reports `Service token: no`                              | Load both Access variables into the same shell that runs the upload.                         |
| Access redirects or `/api/admin/puzzles` returns `unauthorized` | Use the service-token bootstrap. WARP and browser cookies do not authenticate the CLI alone. |

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

# Production (requires CF_ACCESS_CLIENT_ID/SECRET, or --cf-access-token)
bun run admin:upload -- \
  --server https://perseus.cwchanap.dev \
  --image ./my-puzzle.jpg \
  --name "My Puzzle" \
  --pieces 100 \
  --aspect 1:1 \
  --category Nature
```

| Flag                | Description                                                          |
| ------------------- | -------------------------------------------------------------------- |
| `--server`          | API base URL (default `http://127.0.0.1:4690`)                       |
| `--image`           | Path to JPEG/PNG/WebP                                                |
| `--name`            | Puzzle display name                                                  |
| `--pieces`          | Piece count (must be valid for the aspect ratio)                     |
| `--aspect`          | `1:1`, `4:3`, or `3:4`                                               |
| `--category`        | Optional: Animals, Nature, Art, Architecture, Abstract, Food, Travel |
| `--cf-access-token` | Access JWT (or `CF_ACCESS_TOKEN`) — service tokens preferred         |
| `--skip-access`     | Local API only (no Access headers)                                   |

**Production Access:** set `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`
env vars (same as the bulk uploader), or pass `--cf-access-token` with a
pre-obtained Access JWT. The script probes the service token before uploading
and aborts on rejection. See "Credentials" above.

**Valid piece counts (examples):**

- `1:1`: 4, 9, 16, 25, 36, 49, 64, 81, 100, 121, 144, 169, 196, 225
- `4:3` / `3:4`: 12, 48, 108, 192

Image pixel aspect must match `--aspect` (the API validates dimensions).

### Bulk / startup catalog

- Catalog (tracked): `scripts/startup-seed/catalog.json`
- Images (**not** committed): put rasters next to the catalog under
  `scripts/startup-seed/images/`, or use a local dir such as
  `data/startup-puzzles/images/` (`data/` is gitignored)

Each catalog entry needs a matching file named `{id}-*.{jpg,jpeg,png,webp}`
(e.g. `01-alpine-lake-mirror.jpg`) or `{id}.{jpg,jpeg,png,webp}` (e.g.
`01.jpg`).

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

| Command                        | Description              |
| ------------------------------ | ------------------------ |
| `bun run admin:startup:status` | Check Access credentials |
| `bun run admin:startup:upload` | Upload catalog entries   |

Useful options: `--from`, `--to`, `--limit`, `--delay-ms`, `--dry-run`,
`--skip-access` (local only).

### CI seed workflow

The `seed-startup-puzzles.yml` workflow uploads the catalog directly to
production using Pulumi stack outputs and secrets. See **§5 Seed Startup
Puzzles** for the trigger, inputs (including the release-tarball asset
handling and `asset_sha256` verification), and concurrency guarantees.

### Service token reach

The admin CLI service token is scoped to a narrow Cloudflare Access
application covering only the CLI-needed paths. The full blast-radius
analysis — why the service token cannot reach the per-id delete route or
other admin endpoints, and why no `/api/admin/puzzles/*` wildcard is used —
is in **§8 Cloudflare Access (Admin Gate)** and
`packages/infrastructure/src/admin-access.ts` (`CLI_ACCESS_PATHS`).

### Token lifetime

The deployed CLI service token has a **one-year lifetime** (`8760h`).
`packages/infrastructure/src/index.ts` passes `cliServiceTokenDuration: '8760h'`
directly into `createAdminAccessResources`; the `adminCliServiceTokenDuration`
Pulumi config key is **not read** in production, so `pulumi config set
adminCliServiceTokenDuration` has no effect on the deployed token. The `2160h`
(90-day) value in `DEFAULT_ADMIN_CLI_SERVICE_TOKEN_DURATION` is only the in-code
default, which the production override bypasses.

Cloudflare rejects shortening an existing service token's expiration in place,
so changing the lifetime requires editing `cliServiceTokenDuration` in
`index.ts` and then rotating the token (see below) so new credentials carry the
new lifetime. To make the duration configurable via Pulumi config instead, wire
`config.get('adminCliServiceTokenDuration')` into `createAdminAccessResources`
and pair it with the rotation step — do not assume a `config set` alone changes
a live token.

### Token rotation

If credentials may be compromised, temporarily disable the service token,
rotate it, revoke/delete it, or remove/disable the Service Auth policy.

To rotate credentials (new client_id + client_secret):

1. `PULUMI_CONFIG_PASSPHRASE='' pulumi up --target-replace "urn:pulumi:production::perseus-infrastructure::cloudflare:index/zeroTrustAccessServiceToken:ZeroTrustAccessServiceToken::admin-access-cli-service-token" --target-dependents -s cwchanap/perseus-infrastructure/production -C packages/infrastructure`
   - **`--target-dependents` is required.** The narrow CLI Access application
     (`admin-access-cli-application`) declares
     `dependsOn: [devicePostureRule, cliServiceToken]` and its Service Auth
     policy embeds `cliServiceToken.id`. A bare `--target-replace` replaces only
     the token and leaves the dependent application bound to the old token ID, so
     the new client_id/secret would be rejected at the Access gate.
     `--target-dependents` forces Pulumi to update the CLI application so its
     policy references the new token ID. If you omit it, follow with a full
     `pulumi up` to reconcile the application before using the new credentials.
2. The CI seed workflow (`seed-startup-puzzles.yml`) reads the new outputs automatically at runtime — no GitHub secret update needed. For local CLI use, update `apps/api/.env` (or your shell env):
   ```bash
   export CF_ACCESS_CLIENT_ID=$(PULUMI_CONFIG_PASSPHRASE='' pulumi stack output adminCliAccessClientId \
     -s cwchanap/perseus-infrastructure/production -C packages/infrastructure)
   export CF_ACCESS_CLIENT_SECRET=$(PULUMI_CONFIG_PASSPHRASE='' pulumi stack output --show-secrets \
     adminCliAccessClientSecret \
     -s cwchanap/perseus-infrastructure/production -C packages/infrastructure)
   ```
3. Verify: `bun run admin:startup:status`

### Idempotency

The upload script fetches existing puzzles from `GET /api/admin/puzzles`
before uploading and skips entries whose **name + piece count + aspect ratio**
all match an existing puzzle. Matching on name alone is fragile because the
API does not enforce unique names — a manually uploaded puzzle sharing a seed
entry's name but with a different piece count or aspect ratio would wrongly
cause the seed entry to be skipped. If the fetch fails (non-OK response or
network error), the script aborts rather than risk creating duplicates —
re-run after verifying the API is reachable. This is the client-side dedup;
the server-side reservation state machine behind the `Idempotency-Key` header
is covered in **§9 Idempotency Key Handling**.

### Notes

- Prefer **Access service tokens** for automation. Do not rely on copying
  `CF_Authorization` cookies or `cloudflared access login` for scripts (device
  posture / edge token transfer is unreliable for headless use).
- Uploaded puzzles start as `processing` until the workflow finishes; they
  appear in the gallery when `status` is `ready`.
- Keep service token secrets and seed images out of git. `apps/api/.env` and
  `data/` are gitignored; `scripts/startup-seed/images/*` ignores raster
  files.

**Source:** `scripts/admin-upload-puzzle.ts`, `scripts/startup/` (bulk
uploader); originally in root `README.md`.

---

## 12. Puzzle Family Production Cutover

**Use this one-shot operator sequence when migrating legacy single-count server
puzzles to puzzle families.** These scripts are operator tooling only — they are
not runtime fallbacks in the Worker.

### Rollout order

```text
PRE-MERGE: D1 export -> legacy content export -> verify backups
MERGE/DEPLOY: migrations + family code
POST-DEPLOY: import families -> wait all ready -> verify -> cleanup old objects
```

### Step 0 — mandatory D1 backup (before merge)

```bash
mkdir -p .migration/puzzle-families
bunx wrangler d1 export perseus-player-data \
  --remote \
  --output .migration/puzzle-families/d1-before-family-cutover.sql \
  --config apps/api/wrangler.production.toml
```

Verify the SQL file is non-empty before proceeding.

### Step 1 — legacy content export (before merge)

Against the **current** production API (still serving `GET /api/puzzles` and
legacy `puzzles/<oldId>/` R2 keys):

```bash
bun scripts/export-legacy-puzzles.ts
```

This writes `.migration/puzzle-families/manifest.json` and
`.migration/puzzle-families/originals/*`. The export is read-only and fails if
any **ready** puzzle cannot export metadata, owner ID (from production D1), or
original bytes.

Verify manifest entry count matches expected ready puzzle count and every
`originals/` file is non-empty.

### Step 2 — merge/deploy

Merge the implementation PR to `main` and let deploy apply D1 migrations plus
family code.

### Accepted empty-gallery window

After family-only code deploys and **before** imported families finish all three
variants, the production gallery is empty. This is accepted pre-release downtime
— not an unnoticed failure mode. Run import immediately after deploy.

### Accepted schema/code mismatch window (`0006_puzzle_progression_reset`)

Deploy applies `0006_puzzle_progression_reset` automatically before `pulumi up`
publishes the new Worker (non-additive exception to the additive-only safety
comment in `.github/workflows/deploy-infrastructure.yml`). From the moment
`0006` finishes until the new Worker version is live, the still-running Worker
expects the dropped legacy tables (`puzzles`, `puzzle_stats`,
`puzzle_completion_runs`) and D1-backed routes can 500:

- `POST /api/puzzles/:id/complete`
- `/api/player/*` (profile, stats, progression, avatar metadata)
- `/api/admin/*` D1 paths (ownership mirror, admin stats)
- Workflow status mirrors that read D1

The window ends when the new Worker version is live. This is accepted alongside
the empty-gallery window above — not an unnoticed failure mode. Production D1
export (Step 0) and legacy content export (Step 1) remain mandatory operator
pre-merge gates; do not merge without verified backups.

### Step 3 — import families (post-deploy)

```bash
bun scripts/import-puzzle-families.ts
```

Each original is POSTed to `/api/admin/puzzle-families` (same Access service
token as other admin CLIs). Admin create inserts `SYSTEM_OWNER_ID`; the
importer then sets `puzzle_families.owner_id` to the exported owner via
`wrangler d1 execute --remote`. The script polls until every imported family is
`ready` or `failed`.

### Step 4 — verify replacements

Confirm `import-results.json` shows every family `ready`, spot-check family
thumbnails/reference assets, and verify gallery counts before cleanup.

### Step 5 — cleanup legacy objects (post-verify only)

```bash
bun scripts/cleanup-legacy-puzzles.ts
```

Deletes legacy `puzzle:*` KV keys and `puzzles/<oldId>/` R2 original/thumbnail/
piece objects. Cleanup refuses to run until every replacement family verifies
`ready` on `GET /api/admin/puzzle-families`. Do **not** call family-delete on
the new families.

Use `--dry-run` to print the wrangler delete plan without mutating remote state.

**Source:** `scripts/export-legacy-puzzles.ts`, `scripts/import-puzzle-families.ts`,
`scripts/cleanup-legacy-puzzles.ts`.
