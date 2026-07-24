# Perseus Operator Runbook

This is the single consolidated reference for operating Perseus in production.
Procedures that were previously scattered across `CLAUDE.md`,
`deploy-infrastructure.yml` comments, and inline code comments are gathered
here. Each section links to the authoritative source for the full detail.

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
- **Deploy order:** Pulumi Up (creates/provisions resources + publishes
  Workers) → Apply D1 migrations. Workers are live BEFORE migrations run.
- **Preview job** inherits the `production` environment's protection rules.
  TODO: create a `pulumi-preview` GitHub Environment to avoid deadlocks.

**First-deploy D1 gap (zero-downtime):**
On the first-ever production deploy, Pulumi creates the D1 database AND
publishes the Worker in the same `pulumi up`, so the Worker is live before
`wrangler d1 migrations apply` runs. D1-dependent paths can 500 until
migrations complete:

- `POST /api/puzzles/:id/complete` → 500
- `GET /api/player/*` → 500
- `/api/admin/*` D1 operations → 500
- Workflow `setPuzzleStatus` → best-effort, logs and continues

**Zero-downtime first deploy (optional):**

```bash
pulumi stack output d1DatabaseId --cwd packages/infrastructure
sed -i "s/^database_id = .*/database_id = \"<ID>\"/" apps/api/wrangler.production.toml
bunx wrangler d1 migrations apply perseus-player-data --remote \
  --config apps/api/wrangler.production.toml
```

Then trigger the workflow. Subsequent deploys are unaffected.

**Source:** `deploy-infrastructure.yml` (Apply D1 migrations step comment),
`CLAUDE.md` → First-deploy D1 gap.

---

## 2. D1 Migration Safety

The deploy ordering (workers first, migrations second) is safe for
**additive** migrations only (new tables, new columns, new indexes).

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
2. Temporarily restore the `import:` line in `createD1Database`
   (`packages/infrastructure/src/resources.ts`):
   ```typescript
   import: `${accountId}/${existingUuid}`,
   ```
3. Set a Pulumi config value with the existing UUID.
4. Run `pulumi up` to adopt the resource back into state.
5. Remove the `import:` line and config so Pulumi fully owns the resource
   going forward.

**D1 and R2 are `protect: true`** — `pulumi destroy` or a destructive
replacement will refuse without first running
`pulumi state unprotect <resource-urn>` (URNs via `pulumi stack export`).
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
candidates. The reaper checks the workflow status; if the workflow is
dead (`errored`, `terminated`, or `unknown`/never-created), it deletes the
KV metadata, R2 assets, D1 ownership row, and (best-effort) the DO
idempotency reservation. A workflow in `complete` status is explicitly
**skipped** — `complete` means every step succeeded including finalize, so
a KV read that still shows `processing` is eventual-consistency lag, not an
orphan. Reaping would destroy a valid completed puzzle. If KV never catches
up, operator force-delete (§7) is the escape hatch.

**Safety:**

- Deletions are idempotent — safe to run concurrently with normal traffic.
- If the workflow status check fails (transient API error), the puzzle is
  skipped (fail closed).
- R2 deletion failure is logged but does not block KV metadata deletion.
- Batch limit of 50 puzzles per run to avoid exceeding CPU time limits.

**Monitoring:** Check Worker logs for `Reaper:` prefixed messages. Each run
logs `scanned`, `candidates`, `reaped`, and `errors` counts.

**Source:** `apps/api/src/services/reaper.ts`,
`apps/api/src/worker.ts` (scheduled handler).

### Out of scope: avatar staging orphans

The reaper does **not** sweep avatar staging objects (`avatars/staging/<uid>/<uuid>`).
Each player-avatar upload writes to a staging key, then on success best-effort
deletes it (`player.worker.ts`). If that delete fails transiently the staging
object lingers — it is not reachable by the avatar serve route (which reads
only the live key), so this is a storage-cost concern, not a correctness or
security concern. There is **no automated sweep**; staging orphans accumulate
until the next successful upload by the same user (which overwrites nothing —
each staging key is per-upload-unique) or manual cleanup:

```sh
wrangler r2 object list PUZZLES_BUCKET --prefix 'avatars/staging/' | \
  awk '{print $4}' | xargs -I{} wrangler r2 object delete PUZZLES_BUCKET/{}
```

Run this only if R2 listing shows staging orphans have become material.

---

## 7. Stuck Puzzle Manual Cleanup (Force Delete)

If a puzzle is stuck in `processing` and the reaper hasn't cleaned it up
(e.g. the workflow status check is failing), an operator can manually
force-delete it via the admin API:

```
POST /api/admin/puzzle-delete/:id?force=true
```

The `force=true` query parameter bypasses the `processing`-status guard
that normally prevents deletion of in-flight puzzles. This deletes the KV
metadata, R2 original image, and all R2 piece images. The delete route uses
`POST /api/admin/puzzle-delete/:id` (not `DELETE /api/admin/puzzles/:id`) so
it is NOT a sub-path of the narrow CLI Access app's `/api/admin/puzzles`
exact path — a service-token holder cannot reach it at the Access gate.

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
2. **Perseus Admin CLI** (narrow): covers `/api/admin/login` and
   `/api/admin/puzzles`. Policies: email + device posture (browser admin
   still works) AND Service Auth (CLI service token).

**Path scoping (resolved):** Cloudflare Access is path-based, not
method-based. The delete route lives at `POST /api/admin/puzzle-delete/:id`,
which is a sibling of (not a sub-path of) the narrow CLI app's exact path
`/api/admin/puzzles`. It therefore inherits only the broad admin app's
email+posture policy — a service-token holder cannot reach the delete
endpoint at the Access gate even after obtaining a session cookie. See the
full analysis in `packages/infrastructure/src/admin-access.ts` (the
`CLI_ACCESS_PATHS` comment).

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
