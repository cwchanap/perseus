# HPA-915 — Coordinated ESLint 10 / globals 17 migration

Linear: https://linear.app/cwchanap/issue/HPA-915/maintenance-stage-ignored-lint-and-mobile-dependency-majors

PR: https://github.com/cwchanap/perseus/pull/182

**Status:** Design/plan only. Do all implementation and verification in **this same PR**, not one PR per workspace. Current planning baseline: main \`30b7bf7\` (2026-11-18); recheck main before changing code.

## Decision

Make one coordinated development-tooling update across the **root**, **apps/api**, **apps/web**, and **apps/workflows** manifests, moving \`eslint\` 9 → 10 and \`globals\` 16 → 17. Preserve the existing lint commands and four flat configs (API, web, workflows, root scripts). No shared config package, new lint rules, CI jobs, or runtime feature changes.

The recommended manifest targets at the 2026-11-19 review are \`eslint: ^10.15.0\` and \`globals: ^17.14.0\`; confirm availability during implementation. Use \`bun install\` **without deleting \`bun.lock\`**, then prove the diff affects only the ESLint/globals dependency subtree. Keep the existing \`eslint\` / \`globals\` semver-major Dependabot ignores, updating their explanation only.

## Verified existing evidence

- \`main\` declares \`eslint ^9.39.1\` and \`globals ^16.5.0\` in all four manifests; \`@eslint/js ^10.0.1\` is already installed. The current peer/plugin stack includes \`typescript-eslint ^8.72.1\`, \`eslint-plugin-svelte ^3.23.1\`, and \`@eslint/compat ^2.1.1\`; the review confirmed ESLint 10 compatibility, and earlier CI exercised it. No speculative upgrades of those packages.
- **PR #159** (ESLint 10.14.0) and **PR #160** (globals 17.13.0) **each changed all four manifests plus \`bun.lock\`**. They were closed by \`@dependabot ignore this major version\`, **not** by a migration failure. PRs #161–#166 were per-directory duplicates; do not repeat them.
- Both #159 and #160 independently passed **Build & Lint**, **Unit Tests**, and **E2E Tests** on their own commits. [#159 CI](https://github.com/cwchanap/perseus/actions/runs/41480151320) · [#160 CI](https://github.com/cwchanap/perseus/actions/runs/41480191064). This is strong baseline evidence, **not** proof the combined upgrade on the new commit passes.
- The four lint entry points are \`bun run lint\` (Turbo runs API/web/workflows) and \`bun run lint:scripts\` (separate explicit config in \`scripts/eslint.config.js\`). The four existing \`eslint.config.js\` files already own their rules; there are no nested config files or root \`eslint.config.js\`.
- The web config's \`no-restricted-imports\` prevents production source from importing test-only gameplay modules or the virtual override. All four configs disable \`no-undef\`, so \`globals\` 17 is unlikely to create direct rule failures.
- CI already uses a runtime capable of running the prior ESLint 10 PRs. Its Build & Lint job covers lint, script lint, checks and build; Unit Tests and Chromium smoke are separate workflows. These jobs **skip draft PRs**, so skipped checks are never called green.

## Smallest meaningful safety checks

1. **Lockfile scope:** Edit only the eight \`eslint\`/\`globals\` version declarations, run \`bun install\` in place, inspect \`git diff -- bun.lock\`, and keep all unrelated runtime/package resolutions unchanged. Compare #159/#160 for expected ESLint dependency churn. Check \`bun install --frozen-lockfile\`.
2. **Effective lint coverage:** \`bun run lint\` and \`bun run lint:scripts\` pass. Compare JSON result counts of \`eslint . -f json\` in API/web/workflows and \`eslint --config scripts/eslint.config.js scripts/ -f json\` at repo root, before and after; no silent reduction in linted files.
3. **Behavioral guard:** From \`apps/web\`, deliberately lint a production-file probe containing \`import 'virtual:perseus-gameplay-runtime-override';\` with \`--stdin-filename src/routes/probe.ts\`; it **must fail** with \`no-restricted-imports\`. This is more useful than a wholesale \`--print-config\` audit. Do not weaken the test-only import restrictions.
4. **Implementation CI:** Transition this same PR out of draft only after the implementation is committed; require successful Build & Lint, Unit Tests, and Chromium smoke on the actual implementation SHA. Record their workflow URLs. Keep the existing production-bundle E2E harness assertion.
5. **Minimal product acceptance:** Run one MCP-controlled web browser flow (Gallery → puzzle → place piece / progress update via existing API-backed fixture or app) and visually inspect one fixed-viewport screenshot against the existing Galaxy Arcade UI. There is no HPA-915 mockup. No separate cross-platform suite, historical baseline-capture exercise, pixel-diff infrastructure, or human sign-off. CI's Chromium smoke provides the broader automated regression coverage.

## Explicit decisions for other HPA-915 majors

| Stream | Decision / gate |
| --- | --- |
| TypeScript 7 | **Hold.** #144 was not merged. Require checker/lint and mobile compiler support before any upgrade. |
| Mobile Svelte 5 | **Hold.** NativeScript Svelte Native currently pins Svelte 4; require compatible runtime and a working iOS render/update build. |
| sass-loader major | **Hold.** Require NativeScript webpack compatibility and a device/simulator build. |
| \`@nativescript/canvas\` 3 (#177) | **Separate HPA-26 validation.** A dependency bump does not establish that native drawing/layout bugs are fixed. |
| Vitest core + three \`@vitest/*\` companion packages | **Retain all four ignores.** Versions must move in lockstep, not by independent Dependabot PRs. |
| ESLint/globals future majors | **Retain major-only ignores** after this coordinated migration. Future major changes need their own compatibility check. |

References: [HPA-913](https://linear.app/cwchanap/issue/HPA-913), [HPA-26](https://linear.app/cwchanap/issue/HPA-26), [Dependabot policy](https://github.com/cwchanap/perseus/blob/main/.github/dependabot.yml).

## Out of scope

No app/mobile manifest or lockfile updates; no TypeScript/Svelte/Vitest/sass-loader/canvas migration, game logic, API/schema change, image/SFX generation, lint refactor, compatibility shim, broad ignore/rule disables, or new CI setup.

**Done:** One PR with coherent version strings and tightly scoped lockfile; four lint entry points and web negative import guard verified; frozen installation; CI Build & Lint/Unit/Chromium smoke green on the implementation SHA; one MCP-driven end-to-end smoke and screenshot visual check completed; major holds recorded. No human acceptance criteria.
