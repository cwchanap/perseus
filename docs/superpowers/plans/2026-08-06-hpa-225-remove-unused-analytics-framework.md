# HPA-225 Remove Unused Analytics Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the unused HPA-532 analytics framework and its repository-level rollout assumptions without changing gallery, gameplay, completion, persistence, or deployment behavior.

**Architecture:** Treat this as a pure deletion. Remove the self-contained browser analytics runtime and shared event contract, then align the full product-documentation surface with the decision to defer analytics until real usage or a concrete product question justifies collection. Keep shared gameplay/completion primitives and dependencies that have non-analytics consumers; do not introduce a replacement telemetry layer or compatibility wrapper.

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
- The main documentation risk is stale PRD language silently re-establishing analytics as a near-term prerequisite. Task 3 therefore performs an explicit full PRD defer sweep and ends with residual searches that must leave only deliberate defer/future-scope language.

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
- `docs/PRD.md` — perform the complete analytics-defer posture change: current-status row, Now/Next roadmap rows, metrics wording, fixed event/KPI recommendations, risk mitigation, future dependency wording, appendix scope, version/date, and document history.

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

### Task 3: Delete obsolete analytics docs, fully defer analytics in the PRD, and verify the repository

**Files:**

- Delete: `docs/analytics/client-delivery.md`
- Delete: `docs/analytics/event-catalog.md`
- Delete: `docs/analytics/privacy.md`
- Delete: `docs/superpowers/plans/2026-08-02-hpa-532-analytics-contract-client-adapters.md`
- Delete: `docs/superpowers/plans/2026-08-03-hpa-532-third-pass-contract-amendments.md`
- Modify: `docs/PRD.md`

**Interfaces:**

- Consumes: HPA-225's deletion-first decision and revisit criteria.
- Produces: repository documentation that consistently says analytics is deferred rather than an active prerequisite, growth mitigation, or already-designed future platform.

- [ ] **Step 1: Delete the obsolete analytics documentation**

Run:

```bash
git rm -r docs/analytics
git rm \
  docs/superpowers/plans/2026-08-02-hpa-532-analytics-contract-client-adapters.md \
  docs/superpowers/plans/2026-08-03-hpa-532-third-pass-contract-amendments.md
```

Keep this HPA-225 implementation plan; it records why the framework was removed and how to verify the deletion.

- [ ] **Step 2: Update the PRD version and current platform status**

At the top of `docs/PRD.md`, change:

```markdown
> **Version:** 2.1
> **Last Updated:** 2026-04-25
```

to:

```markdown
> **Version:** 2.2
> **Last Updated:** 2026-08-06
```

In `### 7. Backend and platform operations`, change:

```markdown
| Product analytics / event tracking   | Not implemented | No analytics SDK or event pipeline exists |
```

to:

```markdown
| Product analytics / event tracking   | Deferred        | HPA-225 removes the unused framework; no SDK or event pipeline is enabled |
```

This records the deliberate defer decision rather than presenting the absence as an implementation gap.

- [ ] **Step 3: Rewrite both roadmap rows that still make analytics near-term work**

In `### Now: strengthen the current single-player product`, replace:

```markdown
| Add real product analytics                 | Not started | The repo currently has no code-backed DAU, retention, or funnel metrics |
```

with:

```markdown
| Defer product analytics                    | Deferred    | Revisit only when real usage or a concrete product decision needs measurement |
```

In `### Next: add repeat-play loops and server-backed competition`, replace:

```markdown
| Admin analytics dashboard    | Not started | Depends on product analytics instrumentation |
```

with:

```markdown
| Product analytics / reporting | Deferred | Revisit with real usage and a specific decision; prefer a managed low-maintenance surface |
```

Do not add an alternate collector, vendor, dashboard, or event schema to either roadmap section.

- [ ] **Step 4: Replace the fixed analytics catalog and dashboard/KPI prescription with revisit criteria**

Under `## Metrics & Analytics Status`, keep `### Current status` and the factual table of what is measurable today.

Change the two unavailable rows from:

```markdown
| Product funnel metrics   | Not available          | Requires analytics implementation |
| Retention / DAU          | Not available          | Requires analytics implementation |
```

to:

```markdown
| Product funnel metrics   | Not available          | Unavailable until analytics is revisited |
| Retention / DAU          | Not available          | Unavailable until analytics is revisited |
```

Delete the entire `### Recommended first analytics events` section and its event list.

Delete the entire `### Suggested first measurable KPIs` section and its dashboard questions.

Replace both sections with exactly:

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

Do not preserve the old HPA-532 event names or dashboard questions as a future compatibility contract.

- [ ] **Step 5: Align risk, future-dependency, appendix, and history wording with the defer decision**

In `### Product risks`, replace:

```markdown
| No analytics baseline | Product prioritization remains guess-driven | Implement analytics before setting user growth targets |
```

with:

```markdown
| No usage baseline | Product prioritization relies on direct observation and support feedback | Continue solo-gameplay decisions without analytics until the Metrics revisit criteria are met |
```

In `### Technical dependencies for future roadmap`, replace:

```markdown
- **Advanced analytics** needs event collection, storage, privacy policy, and dashboarding
  choices
```

with:

```markdown
- **Product analytics** is intentionally deferred; if the Metrics revisit criteria are met,
  choose the smallest managed collection/reporting surface needed for the decision
```

In `### Explicitly out of current scope`, replace:

```markdown
- Admin analytics dashboard
```

with:

```markdown
- Product analytics / reporting until the Metrics revisit criteria are met
```

At the top of `## Document History`, add this row before `2.1`:

```markdown
| 2.2     | 2026-08-06   | Product + Engineering | Deferred product analytics under HPA-225; removed the fixed event/KPI rollout assumptions and documented explicit revisit criteria |
```

Do not alter unrelated roadmap risks or future feature descriptions in this task.

- [ ] **Step 6: Run the residual analytics-rollout searches**

First, fail on exact obsolete rollout language:

```bash
rg -n "Analytics Engine|Add real product analytics|Admin analytics dashboard|Recommended first analytics events|Suggested first measurable KPIs|Implement analytics before setting user growth targets|Requires analytics implementation" \
  apps packages docs \
  --glob '!docs/superpowers/plans/2026-08-06-hpa-225-remove-unused-analytics-framework.md'
```

Expected: no matches.

Then review all remaining HPA-532/533/534/535 references rather than deleting legitimate historical/canceled context blindly:

```bash
rg -n "HPA-53[2345]" docs
```

Expected: no live rollout plan or active prerequisite. Historical/defer references are allowed only when they clearly state that HPA-532 is superseded or HPA-533/HPA-534/HPA-535 are canceled.

Finally review all remaining analytics wording in the PRD:

```bash
rg -n "analytics|event tracking|dashboard" docs/PRD.md
```

Expected: only deliberate current-state/defer/future-scope language consistent with the Metrics revisit criteria. There must be no wording that makes analytics a prerequisite for current solo gameplay, prescribes the deleted HPA-532 event catalog, or requires a custom analytics platform.

Also verify the retained hash dependency still has a real consumer:

```bash
rg -n "@noble/hashes" apps/web/src apps/web/package.json
```

Expected: `apps/web/package.json` plus gameplay session persistence usage. Do not remove the dependency or regenerate `bun.lock`.

- [ ] **Step 7: Format-check the changed documentation**

Run:

```bash
bunx prettier --check \
  docs/PRD.md \
  docs/superpowers/plans/2026-08-06-hpa-225-remove-unused-analytics-framework.md
```

Expected: both files pass without changes.

- [ ] **Step 8: Run the full repository verification gate**

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

- [ ] **Step 9: Commit documentation alignment after all verification passes**

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

- only analytics-specific code/tests/contracts/docs plus the explicit PRD defer sweep were removed or changed;
- no gallery, puzzle route, completion, persistence, API, Worker, or infrastructure behavior changed;
- no replacement analytics architecture exists;
- `apps/web/package.json`, `packages/types/package.json`, and `bun.lock` are unchanged;
- the remaining repository documentation treats analytics as deferred rather than a prerequisite, growth mitigation, or predesigned event/dashboard platform.

## Linear Cleanup After the Implementation PR Merges

Keep this outside the code commits:

1. Mark HPA-225 Done only after the deletion PR merges and the final verification gate is green.
2. Keep HPA-533, HPA-534, and HPA-535 Canceled.
3. Remove stale `relatedTo` links to HPA-534/HPA-535 from active gameplay tickets such as HPA-218, HPA-220, HPA-222, and HPA-224 if those relations are still present.
4. Keep concise “do not add analytics” non-goals on gameplay tickets; those guardrails remain useful.
5. Unblock HPA-555/HPA-556 according to the existing High-priority chain once HPA-225 is complete.
