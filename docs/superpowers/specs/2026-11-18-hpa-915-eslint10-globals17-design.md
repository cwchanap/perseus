# HPA-915 — Coordinated ESLint 10 and globals 17 migration

Linear: https://linear.app/cwchanap/issue/HPA-915/maintenance-stage-ignored-lint-and-mobile-dependency-majors

Planning baseline: **main @ 30b7bf7ef7116d0238ffd43d3ebd02473f62b1cd**, reviewed 2026-11-18. This is a design-only PR; implementation and acceptance have not been run.

## Outcome

Move Perseus's existing Bun/Turborepo lint toolchain from **ESLint 9 to 10** and **globals 16 to 17** in one coordinated implementation of HPA-915. Keep effective lint coverage, project-specific import guardrails, type checks and runtime behavior intact. Do not introduce a shared lint package, new rules framework, or cross-workspace tooling refactor.

The other major-upgrade items in HPA-915 receive explicit hold/retain decisions in this same ticket and are **not** implemented in this PR. Any future independently approved mobile migration gets a separate Linear ticket and its own single PR.

## Evidence from current main

- The root **package.json** declares ESLint ^9.39.1, globals ^16.5.0, @eslint/js ^10.0.1, typescript-eslint ^8.72.1 and a Bun 1.3.14 toolchain.
- **apps/api/package.json**, **apps/web/package.json** and **apps/workflows/package.json** each declare their own ESLint ^9.39.1 and globals ^16.5.0. All four manifests plus the **root bun.lock** must be upgraded as one coherent install.
- ESLint configs already exist for **apps/api/eslint.config.js**, **apps/web/eslint.config.js**, **apps/workflows/eslint.config.js**, and **scripts/eslint.config.js**. There is no root eslint.config.js. The root script lint entry point explicitly passes **--config scripts/eslint.config.js**.
- **bun run lint** uses Turbo to lint the API, web and workflows packages; it does **not** cover the root **scripts/** tree. **bun run lint:scripts** covers that fourth entry point. Other packages and standalone **apps/mobile** have no lint script; do not add one as part of this migration.
- The web config has important **no-restricted-imports** protections around the E2E-only gameplay reader and virtual override module. The API/workflows configs have their own ignore/TypeScript parser setup. Preserve all of these.
- **.github/workflows/build-lint.yml** runs both lint commands, workspace/check scripts, and the build, but skips the job for **draft PRs**. Unit and browser CI likewise skip draft PRs. A documentation-only draft will not be CI-verified.
- Previously opened individual Dependabot ESLint 10 PRs #159, #161, #164, #166 were closed without merge. This task deliberately avoids repeating fragmented work.
- **@eslint/js 10** is already present; source fixes for its new rules landed in #116 and #117. Do not redo those fixes absent a fresh failure.
- The mobile project is isolated from root Bun workspaces and pins Svelte 4 and TypeScript 5.9; web uses Svelte 5 and TypeScript 6. A lint migration must not change either app's Svelte/TS generation.

## Compatibility and migration decisions

1. **Only upgrade ESLint and globals as coordinated major versions.** Prefer current compatible ESLint 10.x and globals 17.x releases at implementation time, update the root + API + web + workflows manifests in one patch, and regenerate the root lockfile once. Keep already-compatible @eslint/js 10. Peer-compatibility checking is an installation gate, not justification for speculative plugin upgrades.
2. **Preserve flat config and workspace-local resolution.** ESLint 10 discovers configuration starting from each linted file rather than the process working directory. Keep the three workspace configs and the explicitly configured scripts lint command; verify each entry point resolves the intended file and applies its intended ignore patterns. Do not consolidate configs merely for style.
3. **Preserve useful rules.** Confirm TypeScript parser behavior and Svelte preprocess/project-service handling, and explicitly test web import restrictions. ESLint 10 and globals 17 can change reported violations: fix real issues narrowly. No blanket rule deactivation, broad ignore, or lint-staged bypass.
4. **Keep environment expectations narrow.** ESLint 10 requires Node >=20.19 / >=22.13 / >=24 on supported lines; check local and CI launchers, and only adjust CI runtime setup if proven necessary. Do not invent a new bootstrap layer.
5. **Leave runtime packages alone.** No changes to API/workflows HTTP behavior, puzzle engine, persistence, web UI, NativeScript dependencies, production configuration or existing test architecture.
6. **Dependabot future majors stay gated.** Retain the eslint and globals semver-major ignore entries after the coordinated upgrade, with comments reflecting the new versions: future major jumps must again be coordinated. Do not bulk-unignore or dismiss alerts.

ESLint upstream migration notes: https://eslint.org/docs/latest/use/migrate-to-10.0.0
typescript-eslint supported dependency ranges: https://typescript-eslint.com/users/dependency-versions/
Ticket background: https://linear.app/cwchanap/issue/HPA-913/tracking-dependabot-major-upgrade-plan-by-project

## Explicit decisions for remaining HPA-915 items

| Dependency stream | Current decision | Evidence needed before changing |
| --- | --- | --- |
| TypeScript majors | **Hold**; #144 closed without merge | Support confirmed across typescript-eslint, svelte-check, web TypeScript 6, and mobile compiler/NativeScript before considering TypeScript 7. No upgrade in this task. |
| Mobile Svelte major | **Hold** Svelte 4 in mobile while web uses Svelte 5 | Svelte Native compatibility and an actual iOS device/simulator build with rendered puzzle and working view updates. |
| sass-loader major | **Hold** | Verify the NativeScript webpack integration and an iOS device/simulator build, not just dependency resolution. |
| @nativescript/canvas 3 (#177) | **Keep separate**, not auto-merge | Resolve HPA-26's existing iOS native draw/update/layout failures with device evidence. It is not an ESLint change. |
| Vitest family (core, browser, browser-playwright, coverage-v8) | **Retain all four ignores** | Keep the v5 packages in lockstep; evaluate future bumps as a separate explicit coordinated migration. |
| ESLint and globals future majors | **Retain major-only ignores** after this manual migration | Future ESLint 11/globals 18 upgrades should be coordinated across all four manifests rather than independent Dependabot PRs. |

See also HPA-26: https://linear.app/cwchanap/issue/HPA-26

## Non-goals and boundaries

- No web UI design changes, image/audio assets or SFX.
- No mobile simulator work bundled into lint tooling.
- No TypeScript/Svelte/webpack/Vitest major migrations.
- No new lint config abstraction, plugin framework, backend service, or compatibility shim.
- No separate implementation PRs for different HPA-915 workspaces.

## Definition of success

One **implementation PR** (the draft PR created for this ticket) contains the coordinated manifest/lockfile change and only proven fixes; all four lint entry points pass; web/API/workflows checks, build and relevant unit tests pass; MCP-driven browser E2E confirms Gallery to puzzle and its API request path; screenshot comparison at the same viewport confirms no unintended visual change. The other major streams have the documented decisions above, not merged upgrades. Record CI and MCP evidence on the implementation commit before marking ready for merge. No manual/human sign-off is an acceptance gate.
