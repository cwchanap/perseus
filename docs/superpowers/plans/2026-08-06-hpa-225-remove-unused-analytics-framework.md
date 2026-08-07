# HPA-225 Remove Unused Analytics Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the unused HPA-532 analytics framework and its repository-level rollout assumptions without changing gallery, gameplay, completion, persistence, or deployment behavior.

**Architecture:** Treat this as a pure deletion. Remove the self-contained browser analytics runtime and shared event contract, then align product documentation with the decision to defer analytics until real usage or a concrete product question justifies collection. Keep shared gameplay/completion primitives and dependencies that have non-analytics consumers; do not introduce a replacement telemetry layer or compatibility wrapper.

**Tech Stack:** TypeScript 5.9, Svelte 5, SvelteKit, Vitest, Playwright, Bun 1.3, Turborepo.

## Global Constraints

- Do not replace the deleted framework with another analytics provider abstraction, collector, sink, queue, ledger, dashboard, counter service, consent system, or event schema.
- Do not preserve compatibility exports or wrapper modules for the deleted analytics API.
- Product behavior must remain unchanged; analytics was never wired into gallery or puzzle routes and no data migration is required.
- Keep `packages/types/src/completion.ts`, `packages/types/src/core.ts`, and `packages/types/src/puzzle-limits.ts`; they have gameplay responsibilities independent of HPA-532.
- Keep `@noble/hashes` in `apps/web/package.json`; gameplay session persistence uses it independently of analytics.
- Preserve generic roadmap/non-goal wording such as “do not add analytics” when it protects gameplay scope. Remove only obsolete implementation/rollout assumptions.
- HPA-533, HPA-534, and HPA-535 stay canceled. Do not recreate their collector, instrumentation, dashboard, or baseline work under a different name.
- Future analytics work starts from a new, smaller ticket only when real users exist and a specific decision needs usage data, operating cost/reliability needs production measurement, or an experiment has a defined metric and action threshold.

---

## File Structure

### Delete

- `apps/web/src/lib/services/analytics/` — entire unused client, context projection, queue, ledger, transports, barrel, and colocated tests.
- `packages/types/src/analytics.ts` — unused shared analytics event contract and validators.
- `packages/types/src/analytics.test.ts` — tests for the deleted analytics contract.
- `docs/analytics/client-delivery.md` — obsolete client delivery/collector handoff design.
- `docs/analytics/event-catalog.md` — obsolete fixed event catalog.
- `docs/analytics/privacy.md` — privacy/consent decisions that only support the deleted analytics architecture.
- `docs/superpowers/plans/2026-08-02-hpa-532-analytics-contract-client-adapters.md` — superseded implementation plan.
- `docs/superpowers/plans/2026-08-03-hpa-532-third-pass-contract-amendments.md` — superseded analytics contract amendments.

### Modify

- `packages/types/src/index.ts` — remove the `./analytics` barrel export and leave the existing gameplay/domain exports intact.
- `docs/PRD.md` — remove analytics-first near-term roadmap assumptions and replace the fixed event recommendation with HPA-225 revisit criteria.

### Intentionally unchanged

- `apps/web/package.json` — current dependency inventory shows no analytics-only dependency. In particular, keep `@noble/hashes` because gameplay persistence imports it.
- `packages/types/package.json` — no analytics-only dependency or script exists.
- `bun.lock` — should not change because no dependency removal is planned.
- Gallery, puzzle route, completion, gameplay session, persistence, API, Worker, and infrastructure source files.

---

### Task 1: Delete the unused browser analytics runtime

**Files:**

- Delete: `apps/web/src/lib/services/analytics/`

**Interfaces:**

- Consumes: no product-facing interface. Current code search shows no imports of `apps/web/src/lib/services/analytics/` outside its own documentation/planning material.
- Produces: no replacement interface. Product routes continue to operate without analytics wiring.

- [ ] **Step 1: Reconfirm the deletion boundary on the implementation branch**

Run from the repository root:

```bash
rg -n "services/analytics|createAnalyticsClient|createAnalyticsRunLedger|AnalyticsTransport|AnalyticsScheduler" \
  apps packages \
  --glob '!apps/web/src/lib/services/analytics/**'
```

Expected: no product/runtime consumers of the browser analytics module. If a match appears only in a comment or deleted-plan reference, remove that stale reference in Task 3; do not create an adapter to preserve it.

- [ ] **Step 2: Delete the analytics runtime and its tests**

Run:

```bash
git rm -r apps/web/src/lib/services/analytics
```

This removes the client facade, context projection, queue, run ledger, transport interface, HTTP/memory/no-op transports, barrel export, and all colocated analytics tests in one operation.

- [ ] **Step 3: Verify no web source imports the removed runtime**

Run:

```bash
rg -n "services/analytics|createAnalyticsClient|createAnalyticsRunLedger|AnalyticsTransport|AnalyticsScheduler" apps/web/src
```

Expected: no matches.

- [ ] **Step 4: Run the web type/build boundary check**

Run:

```bash
(cd apps/web && bun run check)
```

Expected: exit code `0` with no missing analytics imports or Svelte/TypeScript errors.

- [ ] **Step 5: Commit the browser-runtime deletion**

```bash
git add -A apps/web/src/lib/services/analytics
git commit -m "chore(web): remove unused analytics runtime"
```

---

### Task 2: Remove the shared analytics contract and public export

**Files:**

- Delete: `packages/types/src/analytics.ts`
- Delete: `packages/types/src/analytics.test.ts`
- Modify: `packages/types/src/index.ts`

**Interfaces:**

- Consumes: existing non-analytics exports from `packages/types/src/core.ts`, `completion.ts`, and the rest of the package.
- Produces: the same `@perseus/types` public surface minus analytics-only constants, event unions, validators, and helpers.

- [ ] **Step 1: Reconfirm analytics symbols have no consumers after Task 1**

Run:

```bash
rg -n "ANALYTICS_|Analytics[A-Z]|isAnalytics|buildAnalyticsRunEventIdV1" apps packages \
  --glob '!packages/types/src/analytics.ts' \
  --glob '!packages/types/src/analytics.test.ts'
```

Expected: no runtime/test consumers outside the analytics files being deleted.

Then confirm the remaining barrel reference:

```bash
rg -n "['\"]\./analytics['\"]" packages/types/src
```

Expected: only `packages/types/src/index.ts`.

- [ ] **Step 2: Delete the analytics contract and tests**

Run:

```bash
git rm packages/types/src/analytics.ts packages/types/src/analytics.test.ts
```

- [ ] **Step 3: Remove the analytics barrel export**

Change `packages/types/src/index.ts` from:

```ts
// Barrel re-export: shared types and validation functions are defined in the
// appropriate domain modules (e.g. core.ts for puzzle/run types, analytics.ts
// for analytics contracts) and aggregated here for the `@perseus/types` entry.
export * from './core';
export * from './analytics';
```

to:

```ts
// Barrel re-export: shared types and validation functions are defined in the
// appropriate domain modules and aggregated here for the `@perseus/types` entry.
export * from './core';
```

Do not move analytics types into `core.ts`, `completion.ts`, or another compatibility module.

- [ ] **Step 4: Verify shared gameplay primitives remain untouched**

Run:

```bash
git diff -- packages/types/src/completion.ts packages/types/src/core.ts packages/types/src/puzzle-limits.ts
```

Expected: empty diff.

- [ ] **Step 5: Run the shared-types test gate**

Run:

```bash
(cd packages/types && bun run test:unit)
```

Expected: exit code `0`; existing completion, puzzle, player, and shared validation tests remain green without analytics tests.

- [ ] **Step 6: Commit the shared-contract deletion**

```bash
git add packages/types/src/index.ts
git add -u packages/types/src/analytics.ts packages/types/src/analytics.test.ts
git commit -m "chore(types): remove analytics contract"
```

---

### Task 3: Delete obsolete analytics docs, align the PRD, and verify the repository

**Files:**

- Delete: `docs/analytics/client-delivery.md`
- Delete: `docs/analytics/event-catalog.md`
- Delete: `docs/analytics/privacy.md`
- Delete: `docs/superpowers/plans/2026-08-02-hpa-532-analytics-contract-client-adapters.md`
- Delete: `docs/superpowers/plans/2026-08-03-hpa-532-third-pass-contract-amendments.md`
- Modify: `docs/PRD.md`

**Interfaces:**

- Consumes: HPA-225's deletion-first decision and revisit criteria.
- Produces: repository documentation that accurately says analytics is deferred rather than an active prerequisite or near-term platform initiative.

- [ ] **Step 1: Delete the obsolete analytics documentation**

Run:

```bash
git rm -r docs/analytics
git rm \
  docs/superpowers/plans/2026-08-02-hpa-532-analytics-contract-client-adapters.md \
  docs/superpowers/plans/2026-08-03-hpa-532-third-pass-contract-amendments.md
```

Keep this HPA-225 implementation plan; it records why the framework was removed and how to verify the deletion.

- [ ] **Step 2: Change the PRD near-term roadmap from analytics-first to deferred analytics**

In `docs/PRD.md`, replace the current `Now: strengthen the current single-player product` analytics row:

```markdown
| Add real product analytics | Not started | The repo currently has no code-backed DAU, retention, or funnel metrics |
```

with:

```markdown
| Defer product analytics | Deferred | Revisit only when real usage or a concrete product decision needs measurement |
```

Do not add an alternate collector, vendor, dashboard, or event schema to the roadmap.

- [ ] **Step 3: Remove the dashboard prerequisite from the immediate `Next` roadmap**

Replace:

```markdown
| Admin analytics dashboard    | Not started | Depends on product analytics instrumentation                                |
```

with:

```markdown
| Product analytics / reporting | Deferred | Revisit with real usage and a specific decision; prefer a managed low-maintenance surface |
```

This keeps analytics visible as a future possibility without making it a prerequisite for current gameplay work.

- [ ] **Step 4: Replace the fixed first-event catalog with explicit revisit criteria**

In `## Metrics & Analytics Status`, keep the factual current-status table showing that aggregated product metrics are unavailable. Replace the `### Recommended first analytics events` section and its fixed event list with:

```markdown
### Revisit criteria

Do not build product analytics yet. Open a new, smaller analytics ticket only when at least one
of these is true:

- Real users exist and a specific product decision depends on usage data.
- Operating cost or reliability needs production measurement.
- A release experiment has a defined metric and action threshold.

When analytics is revisited, start with only the few events needed for that decision and prefer a
managed, low-maintenance collection/reporting surface over a custom analytics platform.
```

Do not preserve the old HPA-532 event names as a future compatibility contract.

- [ ] **Step 5: Check for stale rollout-specific references**

Run:

```bash
rg -n "HPA-53[2345]|Analytics Engine|Add real product analytics|Admin analytics dashboard|Recommended first analytics events" \
  apps packages docs \
  --glob '!docs/superpowers/plans/2026-08-06-hpa-225-remove-unused-analytics-framework.md'
```

Expected: no matches. Generic statements such as “do not add analytics” or “analytics is deferred” are intentionally allowed.

Also verify the retained hash dependency still has a real consumer:

```bash
rg -n "@noble/hashes" apps/web/src apps/web/package.json
```

Expected: `apps/web/package.json` plus gameplay session persistence usage. Do not remove the dependency or regenerate `bun.lock`.

- [ ] **Step 6: Format-check the changed documentation**

Run:

```bash
bunx prettier --check \
  docs/PRD.md \
  docs/superpowers/plans/2026-08-06-hpa-225-remove-unused-analytics-framework.md
```

Expected: both files pass without changes.

- [ ] **Step 7: Run the full repository verification gate**

Run from the repository root:

```bash
bun run check
bun run lint
bun run test:unit
bun run build
git diff --check
```

Expected: every command exits `0`.

Then run the existing representative browser smoke suite:

```bash
(cd apps/web && bun run test:e2e:smoke)
```

Expected: the existing gallery/gameplay smoke paths remain green. Do not add analytics-specific E2E coverage to replace deleted tests.

- [ ] **Step 8: Commit documentation alignment after all verification passes**

```bash
git add docs/PRD.md docs/superpowers/plans/2026-08-06-hpa-225-remove-unused-analytics-framework.md
git add -u docs/analytics \
  docs/superpowers/plans/2026-08-02-hpa-532-analytics-contract-client-adapters.md \
  docs/superpowers/plans/2026-08-03-hpa-532-third-pass-contract-amendments.md
git commit -m "docs: defer product analytics"
```

---

## Final Acceptance Audit

After Task 3, run:

```bash
rg -n "services/analytics|ANALYTICS_EVENT_SCHEMA_VERSION|createAnalyticsClient|createAnalyticsRunLedger" apps packages
```

Expected: no matches.

Run:

```bash
test ! -d apps/web/src/lib/services/analytics
test ! -e packages/types/src/analytics.ts
test ! -d docs/analytics
```

Expected: all commands exit `0`.

Review the final diff and confirm:

- only analytics-specific code/tests/contracts/docs plus PRD wording were removed or changed;
- no gallery, puzzle route, completion, persistence, API, Worker, or infrastructure behavior changed;
- no replacement analytics architecture exists;
- `apps/web/package.json`, `packages/types/package.json`, and `bun.lock` are unchanged;
- the remaining repository documentation treats analytics as deferred rather than a prerequisite.

## Linear Cleanup After the Implementation PR Merges

Keep this outside the code commits:

1. Mark HPA-225 Done only after the deletion PR merges and the final verification gate is green.
2. Keep HPA-533, HPA-534, and HPA-535 Canceled.
3. Remove stale `relatedTo` links to HPA-534/HPA-535 from active gameplay tickets such as HPA-218, HPA-220, HPA-222, and HPA-224 if those relations are still present.
4. Keep concise “do not add analytics” non-goals on gameplay tickets; those guardrails remain useful.
5. Unblock HPA-555/HPA-556 according to the existing High-priority chain once HPA-225 is complete.
