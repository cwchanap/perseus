# HPA-915 — One-PR implementation and acceptance plan

Linear: https://linear.app/cwchanap/issue/HPA-915/maintenance-stage-ignored-lint-and-mobile-dependency-majors

Design: [2026-11-18-hpa-915-eslint10-globals17-design.md](../specs/2026-11-18-hpa-915-eslint10-globals17-design.md)

**Rule:** Implement, test and close this migration in **draft PR #182** (later marked ready); no separate PR for each workspace. Current PR is documentation-only; no new migration or acceptance result is claimed.

## Already-established prerequisites (no repeat investigation)

- Existing root, API, web, workflows manifest versions: `eslint ^9.39.1`, `globals ^16.5.0`, and compatible lint peers. `@eslint/js` is already v10.
- Dependabot PRs **#159** (ESLint 10.14.0) and **#160** (globals 17.13.0) each touched the four manifests plus the root lockfile and passed Build & Lint, Unit Tests and E2E on their individual commits. Both closed after explicit major-version ignore; neither was rejected because of a failed migration. See [#159 Build & Lint](https://github.com/cwchanap/perseus/actions/runs/41480151320), [Unit](https://github.com/cwchanap/perseus/actions/runs/41480151211), [E2E](https://github.com/cwchanap/perseus/actions/runs/41480151234); [#160 Build & Lint](https://github.com/cwchanap/perseus/actions/runs/41480191064), [Unit](https://github.com/cwchanap/perseus/actions/runs/41480190589), [E2E](https://github.com/cwchanap/perseus/actions/runs/41480190607).
- Existing ESLint flat configs cover API, web, workflows and scripts; `bun run lint:scripts` explicitly passes its config. All four disable `no-undef`. No new config or Node setup is planned.
- Those previous passing workflows are baseline evidence only; they do not replace checking the **combined upgrade** on #182's implementation commit.

## Implementation (one small patch)

- [ ] Confirm latest `main` hasn't already upgraded either dependency. Update only `eslint` to `^10.15.0` and `globals` to `^17.14.0` **if those versions are still current/available** in `package.json`, `apps/api/package.json`, `apps/web/package.json`, `apps/workflows/package.json`. No `apps/mobile` changes.
- [ ] Run **`bun install` in place**. **Do not remove or regenerate `bun.lock` from scratch.** Inspect `git diff -- bun.lock` and ensure all changed packages are ESLint/globals or their exclusively related transitive dependencies (e.g. `@eslint/*`, `espree`, `eslint-scope`, `eslint-visitor-keys`, `@humanfs/*`, relevant transitive utilities). Restore or constrain **unrelated runtime dependency changes** rather than letting them into this PR. Use #159/#160 lockfile diffs as reference, not a fixed line-count target.
- [ ] Verify `bun install --frozen-lockfile` succeeds from the updated lockfile.
- [ ] Update **only** the ESLint/globals major-ignore explanatory comment in `.github/dependabot.yml`. Retain those major ignores and all Vitest-family holds.
- [ ] Keep all four `eslint.config.js` files, existing script entry points, and web import guardrails. Only make targeted source/config fixes if new lint evidence demands them; avoid unnecessary peer upgrades and lint refactors.

## Focused local verification

- [ ] **All entry points:** `bun run lint` and `bun run lint:scripts` succeed.
- [ ] **No silent lint-scope loss:** Capture and compare counts before vs. after (without full `--print-config` sweeps):
  - `cd apps/api && bunx eslint . -f json | jq length`
  - `cd apps/web && bunx eslint . -f json | jq length`
  - `cd apps/workflows && bunx eslint . -f json | jq length`
  - `bunx eslint --config scripts/eslint.config.js scripts/ -f json | jq length` from the repository root.
  
  Record the four counts on the PR. Use a pipeline with `pipefail` or equivalent so a failed ESLint invocation isn't hidden by `jq`. If a necessary source fix changes file count, justify the difference rather than claiming equality.
- [ ] **Production import guard must remain active:** From `apps/web`, run:

  ~~~sh
  printf "import 'virtual:perseus-gameplay-runtime-override';\n" |
    bunx eslint --stdin --stdin-filename src/routes/probe.ts
  ~~~

  Confirm a **non-zero ESLint exit with the intended `no-restricted-imports` message**, not a parse/config error. The existing production-bundle E2E harness assertion remains in CI.
- [ ] Compare lockfile diff with the baseline: zero unrelated runtime-package upgrades. Do not weaken lint errors, expand ignores, or introduce a new lint config package.

## Acceptance after implementation

- [ ] Mark **this same PR** ready for review to enable CI. Require **Build & Lint** (includes `lint`, `lint:scripts`, `check`, `check:scripts` and build), **Unit Tests**, and **Chromium smoke E2E** successful **on the implementation SHA**. Record exact run URLs in the PR and HPA-915. Draft PRs skip these jobs; **skipped does not pass**.
- [ ] Perform **one MCP-controlled end-to-end browser smoke** on the implemented app/preview: Gallery data loads over existing API path, open one puzzle, select/place a piece, and confirm progress updates with no unexpected console/network errors. Use one desktop Chromium platform only. This is the only separate browser exercise; do **not** build a new E2E fixture framework.
- [ ] **Visual acceptance:** Capture one fixed-viewport puzzle/board screenshot (and Gallery if available in the same navigation) during that MCP run. Compare visually to the existing Galaxy Arcade UI, not to an invented mockup; HPA-915 has no attached UI mockup. Look for unexpected missing pieces, toolbar, tray, artwork or layout changes. No baseline pixel-diff system or cross-platform captures.
- [ ] Attach concise lint counts, negative-guard output, lockfile-scope summary, CI links, MCP smoke result and screenshot(s) to PR #182. Do not require human review/sign-off as an acceptance gate.

## Done conditions

- [ ] One PR changes only the four manifests, root `bun.lock`, Dependabot ignore comment, and any provably required narrow corrections plus these docs.
- [ ] Frozen install and all four lint entry points pass, linted-file counts do not shrink, and the web production-import negative probe fails for the **correct reason**.
- [ ] The actual implementation SHA has green CI Build & Lint, Unit Tests and Chromium smoke.
- [ ] MCP-driven E2E and screenshot visual inspection completed on one platform.
- [ ] Holds are documented, unchanged: TypeScript 7, mobile Svelte 5, sass-loader, canvas PR #177 / HPA-26, Vitest lockstep, and future ESLint/globals majors. No mobile/art/SFX work.
- [ ] Link the evidence to HPA-915 and mark complete only after implementation acceptance.

**No-goals:** Runtime/gameplay/backend/schema changes; additional CI jobs, multi-platform testing, lint configuration architecture, TypeScript/Svelte/Vitest/NativeScript major upgrades, compatibility code or generated art/SFX.

**Review disposition (2026-11-19):** Accept factual correction on #159/#160, lockfile-scope guard, narrow lint-count/negative-rule checks and local/CI de-duplication. Partially accept the suggestion to remove browser/visual acceptance: keep a **single minimal MCP E2E and screenshot check** to meet the project's automated end-to-end and visual acceptance convention, without the original multi-step baseline capture and broad screenshot comparison.
