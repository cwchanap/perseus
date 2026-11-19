# HPA-915 — One-PR implementation and acceptance plan

Linear: https://linear.app/cwchanap/issue/HPA-915/maintenance-stage-ignored-lint-and-mobile-dependency-majors

Design: [2026-11-18-hpa-915-eslint10-globals17-design.md](../specs/2026-11-18-hpa-915-eslint10-globals17-design.md)

**Rule:** Implement, test and close this migration in **draft PR #182** (later marked ready); no separate PR for each workspace. The implementation is committed on this PR; CI and browser acceptance remain pending, so no acceptance result is claimed yet.

## Already-established prerequisites (no repeat investigation)

- Existing root, API, web, workflows manifest versions: `eslint ^9.39.1`, `globals ^16.5.0`, and compatible lint peers. `@eslint/js` is already v10.
- Dependabot PRs **#159** (ESLint 10.14.0) and **#160** (globals 17.13.0) each touched the four manifests plus the root lockfile and passed Build & Lint, Unit Tests and E2E on their individual commits. Both closed after explicit major-version ignore; neither was rejected because of a failed migration. See [#159 Build & Lint](https://github.com/cwchanap/perseus/actions/runs/41480151320), [Unit](https://github.com/cwchanap/perseus/actions/runs/41480151211), [E2E](https://github.com/cwchanap/perseus/actions/runs/41480151234); [#160 Build & Lint](https://github.com/cwchanap/perseus/actions/runs/41480191064), [Unit](https://github.com/cwchanap/perseus/actions/runs/41480190589), [E2E](https://github.com/cwchanap/perseus/actions/runs/41480190607).
- Existing ESLint flat configs cover API, web, workflows and scripts; `bun run lint:scripts` explicitly passes its config. All four disable `no-undef`. No new config or Node setup is planned.
- Those previous passing workflows are baseline evidence only; they do not replace checking the **combined upgrade** on #182's implementation commit.

## Implementation (one small patch)

- [ ] **Before editing package manifests or running `bun install`, capture baseline linted-file counts** for all four entry points with the exact commands under "Focused local verification" (with `pipefail`). Record API, web, workflows and scripts counts on the PR; after the upgrade, compare against these figures. This must be first, to avoid reverting the upgrade just to measure the baseline.
- [ ] Confirm latest `main` hasn't already upgraded either dependency. Update only `eslint` to `^10.15.0` and `globals` to `^17.14.0` **if those versions are still current/available** in `package.json`, `apps/api/package.json`, `apps/web/package.json`, `apps/workflows/package.json`. No `apps/mobile` changes.
- [ ] Run **`bun install` in place**. **Do not remove or regenerate `bun.lock` from scratch.** Inspect `git diff -- bun.lock` and ensure all changed packages are ESLint/globals or their exclusively related transitive dependencies (e.g. `@eslint/*`, `espree`, `eslint-scope`, `eslint-visitor-keys`, `@humanfs/*`, relevant transitive utilities). Restore or constrain **any unrelated dependency changes**, including runtime packages and non-ESLint dev tooling such as Vitest, TypeScript or Wrangler. `eslint-plugin-svelte@3.23.1` itself depends on `globals ^16.0.0`, so retaining a legitimate nested `globals@16` resolution alongside root `globals@17` is expected, not accidental churn. Use #159/#160 lockfile diffs as reference, not a fixed line-count target.
- [ ] Verify `bun install --frozen-lockfile` succeeds from the updated lockfile.
- [ ] **Retain** the ESLint/globals major-version ignores and all Vitest-family ignores in `.github/dependabot.yml`. Its current ESLint/globals comment is already version-agnostic, so **do not edit the file unless a short comment clarification is genuinely useful**. No policy or configuration change is needed.
- [ ] Keep all four `eslint.config.js` files, existing script entry points, and web import guardrails. Only make targeted source/config fixes if new lint evidence demands them; avoid unnecessary peer upgrades and lint refactors.

## Focused local verification

- [ ] **All entry points:** `bun run lint` and `bun run lint:scripts` succeed.
- [ ] **No silent lint-scope loss:** Compare updated counts to the four baseline counts captured **before the manifest edits** (without full `--print-config` sweeps):
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
- [ ] Compare lockfile diff with the baseline: zero unrelated package changes, including unrelated devDependencies. Do not weaken lint errors, expand ignores, or introduce a new lint config package.

## Acceptance after implementation

- [ ] Mark **this same PR** ready for review to enable CI. Require **Build & Lint** (includes `lint`, `lint:scripts`, `check`, `check:scripts` and build), **Unit Tests**, and **Chromium smoke E2E** successful **on the implementation SHA**. Record exact run URLs in the PR and HPA-915. Draft PRs skip these jobs; **skipped does not pass**.
- [ ] Perform **one MCP-controlled end-to-end browser smoke** on the implemented app/preview: Gallery data loads over existing API path, open one puzzle, select/place a piece, and confirm progress updates with no unexpected console/network errors. Use one desktop Chromium platform only. This is the only separate browser exercise; do **not** build a new E2E fixture framework.
- [ ] **Visual acceptance:** Have MCP-controlled automation capture one fixed-viewport puzzle/board screenshot (and Gallery if available in the same navigation) during that same run. Have the agent inspect the screenshot against the existing Galaxy Arcade UI, not an invented mockup; HPA-915 has no attached UI mockup. Look for unexpected missing pieces, toolbar, tray, artwork or layout changes. No baseline pixel-diff system or cross-platform captures.
- [ ] Attach concise lint counts, negative-guard output, lockfile-scope summary, CI links, MCP smoke result and screenshot(s) to PR #182. Do not require human review/sign-off as an acceptance gate.

## Done conditions

- [ ] One PR changes only the four manifests, root `bun.lock`, these docs, and any provably required narrow corrections. An optional Dependabot **comment-only** clarification is allowed, but is not a required file change; all ignore rules remain unchanged.
- [ ] Frozen install and all four lint entry points pass, linted-file counts do not shrink, and the web production-import negative probe fails for the **correct reason**.
- [ ] The actual implementation SHA has green CI Build & Lint, Unit Tests and Chromium smoke.
- [ ] MCP-driven E2E and screenshot visual inspection completed on one platform.
- [ ] Holds are documented, unchanged: TypeScript 7, mobile Svelte 5, sass-loader, canvas PR #177 / HPA-26, Vitest lockstep, and future ESLint/globals majors. No mobile/art/SFX work.
- [ ] Link the evidence to HPA-915 and mark complete only after implementation acceptance.

**No-goals:** Runtime/gameplay/backend/schema changes; additional CI jobs, multi-platform testing, lint configuration architecture, TypeScript/Svelte/Vitest/NativeScript major upgrades, compatibility code or generated art/SFX.

**Review disposition (2026-11-19, second pass):** Capture lint counts before upgrades; reject unrelated runtime **and devDependency** lockfile drift; allow a nested `globals@16` for `eslint-plugin-svelte`; skip the already-sufficient Dependabot comment edit. The suggestion to remove all browser/visual verification is only partially accepted: keep **one MCP-driven E2E with screenshot inspection** for the project's automated end-to-end/visual acceptance requirements, without a baseline capture program, pixel-diff infrastructure or multiple platforms.
