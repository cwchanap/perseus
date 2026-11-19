# HPA-915 — Single-PR implementation and E2E acceptance plan

Linear: https://linear.app/cwchanap/issue/HPA-915/maintenance-stage-ignored-lint-and-mobile-dependency-majors

Design: [2026-11-18-hpa-915-eslint10-globals17-design.md](../specs/2026-11-18-hpa-915-eslint10-globals17-design.md)

**Single PR rule:** Use the HPA-915 draft PR created with these two documents for **all** implementation, regression evidence and acceptance. Do not make one PR per workspace or split the work into multiple PRs. The PR is documentation-only until implementation is committed; no tests are claimed to have passed.

**Baseline reviewed:** main commit 30b7bf7ef7116d0238ffd43d3ebd02473f62b1cd (2026-11-18). Recheck against main before implementation if it advances.

## Implementation sequence

### 1. Baseline and dependency validation

- [ ] Capture versions and baseline results for **bun run lint**, **bun run lint:scripts**, **bun run check**, and **bun run check:scripts**, separating existing failures from newly introduced ones.
- [ ] Verify the installed versions/peer dependency ranges of **typescript-eslint** and **eslint-plugin-svelte** support ESLint 10. The current manifests already use typescript-eslint ^8.72.1 and web eslint-plugin-svelte ^3.23.1; only update peers when installation/actual lint identifies a necessity.
- [ ] Confirm the ESLint launcher runtime satisfies the upstream Node compatibility floor (>=20.19, >=22.13, or >=24); inspect Bun-based CI's runtime rather than adding setup steps preemptively.
- [ ] Confirm all four actual lint entry points and representative file coverage (API, web TS/Svelte, workflows, root scripts) before changing dependencies. Check that root Turbo lint alone omits scripts.

### 2. Upgrade all four manifests together

- [ ] Update **eslint** to compatible 10.x and **globals** to compatible 17.x in:
  - root **package.json**
  - **apps/api/package.json**
  - **apps/web/package.json**
  - **apps/workflows/package.json**
- [ ] Regenerate **root bun.lock** with one coordinated **bun install**, and verify the resulting dependency tree has no conflicting ESLint 9 toolchain in the four lint workspaces. Verify a reproducible frozen-lockfile install.
- [ ] Do **not** edit standalone **apps/mobile/package.json** or **apps/mobile/bun.lock**. It is not part of the root Bun workspace and has no lint entry point.
- [ ] Keep the already-upgraded **@eslint/js 10** and leave Svelte, TypeScript, Vitest, sass-loader and NativeScript majors alone.
- [ ] Keep the **eslint** and **globals** semver-major Dependabot ignore entries as future-major safeguards. Update only their comments to document that ESLint 10/globals 17 have been migrated in lockstep. Preserve all other ignore policies.

### 3. Reconcile only verified ESLint 10 differences

- [ ] Run lint at all four entry points. Preserve existing flat config files: **apps/api/eslint.config.js**, **apps/web/eslint.config.js**, **apps/workflows/eslint.config.js**, **scripts/eslint.config.js**.
- [ ] Test v10 config-from-file discovery using **--print-config** for one representative TS file per API/workflows/scripts plus a TS and Svelte file in web. Validate expected parser, ignore scope and rules, especially the web's production/E2E **no-restricted-imports** protection.
- [ ] Ensure the **scripts/** command continues to pass **--config scripts/eslint.config.js**; it must not silently use an unrelated workspace config.
- [ ] If newly enabled core rules or revised globals reveal legitimate violations, make narrow source corrections in this PR. Do not blanket-disable rules, weaken test-only import fences, reformat unrelated files, or create another lint configuration layer.
- [ ] Check that lint does not mistakenly scan build output or generated code. Preserve existing gitignore/imported ignore intent rather than adding sweeping ignore paths.

### 4. Verification: fast to broad

Run these on the **implementation commit** (not only the planning-only commit):

~~~bash
bun install --frozen-lockfile
bun run lint
bun run lint:scripts
bun run check
bun run check:scripts
bun run build
bun run test:unit
bun run --cwd apps/web test:e2e:smoke -- --retries=0
~~~

- [ ] Compare lint violations and covered file scopes to the baseline. No existing guards silently disappear.
- [ ] Run relevant API/workflows unit suites if not already covered by **bun run test:unit** and identify any pre-existing failures precisely.
- [ ] Do not add a new CI job; **Build & Lint**, **Unit Tests**, and **E2E Tests** already exist and run when the PR is ready for review. Those jobs are intentionally skipped on a draft PR; **skipped is not green**. Before merge, transition the same PR to ready status and record actual CI results.
- [ ] If build/lint runtime changes prove necessary, adjust only the existing relevant CI job(s), then rerun them. Do not add a Node-version matrix or multiple platform gates without evidence.

### 5. End-to-end acceptance via MCP

Use **MCP-controlled browser automation** against the actual implementation branch's locally served web/API stack or an equivalent branch preview. The existing Playwright smoke suite complements, but **does not replace**, the MCP-driven end-to-end acceptance.

- [ ] Launch a clean desktop browser session and confirm that the Gallery loads real/fixture puzzle metadata over the normal app/API path without a failed API request, then open a puzzle.
- [ ] Complete a meaningful interaction: select/place one piece, verify the board and progress update, navigate/restore as supported by the fixture. Assert that no runtime/console errors or unexpected network failures appear. This is a real frontend-to-backend path check; no backend contract change is expected.
- [ ] **Visual check:** capture Gallery and in-puzzle screenshots at fixed desktop viewport(s) on the baseline and implementation, or compare the implementation screenshots against checked-in/available baseline captures. There is **no mockup attached to HPA-915**; compare current Galaxy Arcade UI (layout, toolbar, tray, pieces and artwork) for unintended differences. Attach or link durable screenshots/trace evidence in the PR.
- [ ] One supported desktop browser/platform is sufficient because this ticket makes no platform-specific product change. No human/manual approval criteria; only reproducible MCP/CI evidence.
- [ ] Confirm unit/typecheck/build and the existing automated Chromium smoke gate on the same implementation SHA. If a test fails, distinguish migration regressions from reproducible baseline failures before claiming acceptance.

## End-to-end definition of done

- [ ] Exactly **one PR for HPA-915** contains the ESLint 10 + globals 17 migration, root lockfile, necessary narrow fixes, updated policy comments, and these documents.
- [ ] The API, web, workflows and scripts lint entry points all pass; Svelte/TS rules and the web production/E2E import restrictions remain effective.
- [ ] Fresh frozen install, check/check:scripts, build, relevant unit tests, and CI gates pass on the implemented commit.
- [ ] The MCP-driven browser E2E exercise passes, includes a successful API-backed flow, and has recorded Gallery/puzzle screenshot comparison without visual regressions.
- [ ] The decisions for TypeScript, mobile Svelte, sass-loader, canvas PR #177/HPA-26, Vitest-family and future lint majors remain documented as **holds/retained policy**, with clear validation gates. No extra major-upgrade PR is opened from HPA-915.
- [ ] Attach results and commit SHA to the PR/Linear issue; only then mark HPA-915 complete.

## Expected touched files

**Required implementation:** root, API, web and workflows package manifests; root bun.lock; the Dependabot comment for eslint/globals major ignores.

**Only if proven necessary:** the four current ESLint config files, directly affected source lines, and existing CI workflow runner setup.

**Not touched:** mobile package/lockfile, game-core/persistence, API routes, asset generation, UI presentation, new test frameworks.

## Explicit non-goals / risk management

- No product UI or feature work, backend schema or API behavior change.
- No code-style sweep, lint policy redesign, extra workspace packages or backwards-compatibility layer.
- No broad unignore: the four Vitest-family holds stay intact; no mobile, TypeScript or Svelte major bump.
- If a peer plugin cannot yet run with ESLint 10, record the exact incompatibility and smallest gate on HPA-915 instead of forcing unsupported versions. A clean plan-only PR must never be reported as an implemented migration.

## Status at draft creation

- [x] Target ticket, current manifests and CI/config entry points inspected.
- [x] Design decisions and hold gates written.
- [ ] Migration implementation committed.
- [ ] E2E/visual acceptance performed.
- [ ] All required CI gates verified.
