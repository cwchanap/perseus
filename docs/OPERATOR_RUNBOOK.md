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
- **Deploy order (subsequent deploys):** Apply D1 migrations to the
  existing database BEFORE `pulumi up` publishes the new Worker code.
  Migrations run first, workers second. This ensures new columns/tables
  are present by the time the new Worker version is live.
- **Deploy order (first deploy):** `pulumi up` creates the D1 database AND
  publishes the Worker in the same step, so the Worker is live before
  `wrangler d1 migrations apply` runs (see the first-deploy gap below).
- **Preview job** inherits the `production` environment's protection rules.
  TODO: create a `pulumi-preview` GitHub Environment to avoid deadlocks.

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

```
POST /api/admin/puzzle-delete/:id?force=true
```

The `force=true` query parameter bypasses the `processing`-status guard
that normally prevents deletion of in-flight puzzles. The delete route
follows the same safe lifecycle as the reaper and the commit-conflict
cleanup path:

1. **Terminate and await the workflow stopped** (processing puzzles only).
   If termination cannot be confirmed, the DO is tombstoned best-effort,
   a cleanup record is written, and R2/KV cleanup is deferred to the
   reaper — a live workflow can still write R2 objects, so deleting
   assets prematurely would leave orphans the reaper cannot discover.
2. **Tombstone the metadata DO** before any R2/KV deletion, so a dead
   workflow's post-termination step cannot resurrect stale metadata in
   KV via the DO's KV sync.
3. **Delete R2 assets** (original + thumbnail + generated pieces). On
   partial failure, KV is preserved and a cleanup record is written so
   the reaper retries R2 cleanup (returns 207 Multi-Status).
4. **Delete KV metadata** only after R2 fully succeeds. On failure, the
   cleanup record is preserved for a reaper retry.
5. **Release the idempotency reservation** and **delete D1 ownership +
   stats** rows (best-effort).
6. **Delete the cleanup record** (best-effort) only after every required
   step succeeds.

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
