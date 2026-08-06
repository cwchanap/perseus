# Fast Required Browser Gate Design

- **Issue:** HPA-558
- **Date:** 2026-08-05
- **Revised:** 2026-08-06
- **Status:** Review-ready design
- **Implementation prerequisite:** HPA-555 merged to `main`

## Objective

Reduce Perseus's automatic CI cost for ordinary development while preserving one fast Chromium
E2E lane and keeping broader browser coverage available before releases.

The final shape is deliberately small:

- documentation-only changes skip all three automatic code workflows at the trigger;
- browser-mode unit tests install Chromium only;
- one automatic E2E job runs production-bundle safety plus Chromium desktop/mobile smoke;
- one manual job runs WebKit, extended, accessibility, and stability suites;
- the CI-only browser-install dry-run parser and its tests are deleted.

This changes when existing tests run. It does not delete product scenarios, add a scheduler, add
caching infrastructure, or create a path-classification framework.

## Current Repository Baseline

Three workflows run on every pull request to `main` or `develop`:

1. `.github/workflows/build-lint.yml`
2. `.github/workflows/unit-test.yml`
3. `.github/workflows/e2e-test.yml`

A documentation-only pull request therefore still performs a full build/lint pass, installs
Playwright browsers for browser-mode unit tests, and starts the E2E workflow.

The current browser costs are broader than the original HPA-558 plan accounted for:

- `unit-test.yml` runs `test:install-browsers`, which installs Chromium and WebKit;
- `apps/web/vite.config.ts` declares only a Chromium Vitest browser instance;
- `e2e-test.yml` separately installs Chromium and WebKit in its browser jobs;
- `production-bundle-safety` duplicates checkout, Bun setup, and dependency installation;
- the install dry-run parser is executed repeatedly to protect CI configuration rather than
  product behavior.

At planning time, authenticated repository-admin API checks reported no repository rulesets and no
branch protection on `main`. No check is currently required by GitHub settings.

## Sequencing Constraint

HPA-558's E2E workflow implementation must follow HPA-555.

`apps/web/playwright.config.ts` currently starts the duplicate Bun HTTP API. HPA-555 replaces that
server with the Worker-backed local runtime. The implementation branch must start from or rebase
onto a `main` commit where:

- Playwright no longer runs `build:bun && start:bun`;
- the Worker-backed E2E server passes Chromium smoke; and
- the deleted Bun HTTP scripts are absent.

The planning documents may merge before HPA-555.

`AGENTS.md` requires no separate handling in HPA-558. It is a symlink to `CLAUDE.md`, so editing the
canonical guide updates what both entry points expose.

## Approaches Considered

### 1. Inline Git diff classifier inside the E2E job

This keeps the E2E workflow present for documentation-only pull requests and conditionally skips
its expensive steps. It requires full-history checkout, custom Bash, duplicated fixture tests, and
an always-on summary step.

That machinery was originally justified by required-check pending behavior. This repository has no
required checks or branch protection, so the complexity provides no current value.

Rejected.

### 2. Committed reusable path-classifier script

A committed shell script and shell tests would be preferable to copying classifier logic into a
temporary file, and it would follow the repository's existing tested-shell convention. It is still
unnecessary because trigger-level path filtering fully solves the current problem.

Rejected under YAGNI.

### 3. Trigger-level documentation filters plus direct browser commands

Add the same `paths-ignore` rules to all three automatic code workflows. Add a Chromium-only
browser-install script, use it in browser-mode unit tests and the automatic Chromium E2E lane, and
keep the full Chromium+WebKit install for the manual pre-release lane.

This is the smallest implementation, removes more CI cost than an E2E-only classifier, and matches
the repository's actual lack of required-check enforcement.

Chosen.

## Documentation-Only Trigger Policy

Apply this policy to `push` and `pull_request` in:

- `.github/workflows/build-lint.yml`
- `.github/workflows/unit-test.yml`
- `.github/workflows/e2e-test.yml`

```yaml
paths-ignore:
  - 'docs/**'
  - '**/*.md'
  - '**/*.mdx'
```

A change is skipped only when every changed path is ignored by GitHub's trigger filter. Mixed
documentation and code changes still run all applicable workflows.

This policy intentionally covers all three workflows rather than only E2E:

- Unit Tests is browser CI because it installs Playwright and runs browser-mode Vitest.
- Build & Lint performs no useful validation for the ignored documentation paths and would remain a
  large share of docs-only CI cost if left automatic.
- One shared trigger policy is easier to understand than different definitions of
  "documentation-only" in each workflow.

Do not add a custom path action, shell classifier, `fetch-depth: 0`, summary job, or classifier
fixture harness.

### Future branch-protection note

If required checks or repository rulesets are added later, revisit this policy before making a
path-filtered workflow required. A skipped required workflow can remain pending. That future
configuration change should solve the problem when it exists; HPA-558 does not add protection
machinery preemptively.

## Browser Installation Contract

`apps/web/package.json` exposes two direct commands:

```json
"test:install-browsers:chromium": "playwright install --with-deps --only-shell chromium",
"test:install-browsers": "playwright install --with-deps --only-shell chromium webkit"
```

Use the Chromium-only command in:

- `.github/workflows/unit-test.yml`
- automatic `Chromium smoke` E2E job

Use the full command only in:

- the manual pre-release E2E job;
- local development when a contributor explicitly wants broad Chromium+WebKit coverage.

Delete:

- `test:install-browsers:dry-run`
- `apps/web/scripts/assert-browser-install.ts`
- `apps/web/scripts/assert-browser-install.test.ts`

The package commands are the source of truth. No repository parser validates Playwright CLI
dry-run output.

## Automatic E2E Lane

Keep `.github/workflows/e2e-test.yml` as one workflow with mutually exclusive automatic and manual
jobs.

The automatic job keeps ID and display name:

```text
chromium-smoke / Chromium smoke
```

For code changes, run in order:

1. checkout;
2. setup Bun `1.3.14`;
3. install dependencies once;
4. run `bun run --cwd apps/web test:e2e:assert-production-bundle`;
5. run `bun run --cwd apps/web test:install-browsers:chromium`;
6. run `bun run --cwd apps/web test:e2e:smoke -- --retries=0`;
7. upload failure artifacts as `chromium-smoke-results`.

The production-bundle assertion stays before browser installation so harness leakage fails without
paying the browser-download cost.

Remove the standalone `production-bundle-safety` and `webkit-critical` jobs. Remove automatic
extended/accessibility execution on `main`.

The job is the repository's single automatic **E2E** browser lane. Browser-mode unit tests remain
in `unit-test.yml` and use Chromium only.

## Manual Pre-Release Lane

Repurpose the existing broad-suite job into:

```text
manual-pre-release / Manual pre-release suites
```

Run it only for `workflow_dispatch`.

The job performs one checkout, one Bun setup, one dependency install, and one full
Chromium+WebKit browser install. It then runs sequentially:

1. WebKit critical with zero retries;
2. extended five-project coverage with zero retries;
3. accessibility coverage with zero retries;
4. Chromium stability repeats.

The lane remains fail-fast. Do not add:

- a matrix;
- `continue-on-error`;
- result aggregation;
- suite-selection inputs;
- retries;
- sharding.

Use the repository's pinned artifact action and upload one failure artifact:
`manual-pre-release-results`.

## Concurrency

Add workflow-level concurrency to E2E:

```yaml
concurrency:
  group: e2e-${{ github.workflow }}-${{ github.event_name }}-${{
    github.event.pull_request.number || github.ref
  }}
  cancel-in-progress: true
```

Including `event_name` prevents a push run from canceling a manual dispatch on the same branch.
Newer events for the same PR cancel older automatic E2E work. Newer manual dispatches on the same
ref supersede older manual runs.

No concurrency change is needed for Build & Lint or Unit Tests in HPA-558.

## Active Documentation

Update:

- `apps/web/e2e/README.md`
- `CLAUDE.md`
- `docs/OPERATOR_RUNBOOK.md`

Do not edit `AGENTS.md` separately; it is a symlink to `CLAUDE.md`.

The active docs must state:

- documentation-only changes skip Build & Lint, Unit Tests, and E2E workflows;
- `test:e2e:smoke` is the automatic Chromium desktop/mobile E2E lane;
- the production-bundle assertion runs in the same automatic E2E job;
- browser-mode unit tests install Chromium only;
- WebKit, extended, accessibility, and stability are local/manual pre-release commands;
- the dry-run assertion no longer exists;
- operators dispatch the manual lane before a planned production release.

Do not edit completed HPA-226 design or implementation-plan history.

## Release Habit

Before a planned production release or before merging a release candidate to `main`, dispatch:

```text
E2E Tests -> Manual pre-release suites
```

Require the manual run to pass on the candidate branch or commit.

This is a deliberate human release checkpoint. HPA-558 does not add a weekly schedule or wire broad
tests into every deploy. A scheduled lane would reintroduce automatic cost and is unnecessary while
releases are occasional and controlled by one operator.

## Risks and Tradeoffs

### Broad browser regressions can live longer between releases

WebKit, accessibility, extended layout, and stability regressions will not be detected on every
commit. The accepted mitigation is the documented manual pre-release run.

If release frequency grows or manual runs are repeatedly missed, a scheduled broad lane can be
considered in a later ticket with evidence that the operator habit is insufficient.

### Trigger filters assume no required checks

The chosen `paths-ignore` approach is correct for the repository's current unprotected branches.
Adding required checks later requires revisiting path filtering.

### Documentation-only changes receive no automatic code checks

The ignored paths are Markdown/MDX and `docs/**`; current code workflows do not provide meaningful
documentation-specific validation for them. A dedicated docs lint workflow can be introduced later
only if documentation validation becomes valuable.

## Validation

Before implementation is complete:

1. Confirm HPA-555 is merged and Playwright uses the Worker-backed API.
2. Format-check the three workflows, package manifest, E2E README, canonical guide, and runbook.
3. Confirm all three automatic workflows contain identical docs-only `paths-ignore` patterns.
4. Confirm `unit-test.yml` and automatic E2E install Chromium only.
5. Confirm the manual lane installs Chromium+WebKit once.
6. Confirm no active references remain to the dry-run command or parser.
7. Run the production-bundle assertion locally.
8. Run browser-mode unit tests with the Chromium-only install.
9. Run Chromium desktop/mobile smoke with zero retries.
10. Use Playwright `--list` to confirm all four broad commands still select tests.
11. Dispatch the manual lane on the implementation branch and confirm the four suites run
    sequentially.
12. After merge, open a documentation-only probe PR and confirm Build & Lint, Unit Tests, and E2E
    are not created.
13. Confirm a mixed docs+code PR still starts all three automatic workflows.
14. Confirm a superseded automatic E2E run is canceled.

## Non-Goals

- adding branch protection or repository rulesets;
- adding a custom path classifier or committed classifier tests;
- adding a weekly broad-suite schedule;
- deleting or rewriting E2E scenarios;
- adding Firefox or physical-device coverage;
- adding retries, sharding, matrices, caches, risk scoring, or test-impact analysis;
- changing Playwright projects or test tags;
- changing the HPA-555 Worker-backed E2E server;
- preserving the browser-install parser for compatibility.

## Acceptance Mapping

| Acceptance criterion | Design response |
| --- | --- |
| One automatic browser E2E job | Preserve `Chromium smoke`; browser-mode unit tests remain separate. |
| Production bundle plus Chromium smoke | Run both sequentially after one dependency install. |
| Broad suites are manual/pre-release | Run WebKit, extended, accessibility, and stability only on dispatch. |
| Superseded E2E runs cancel | Add event/ref concurrency with `cancel-in-progress: true`. |
| Docs-only changes skip browser CI | Apply trigger filters to E2E and browser-mode Unit Tests. |
| Docs-only changes avoid wasted code CI | Apply the same filter to Build & Lint. |
| Broad commands remain runnable | Preserve all commands and document a release habit. |
| No matrix or orchestration layer | Use direct trigger filters and two sequential E2E jobs. |
| Remove setup-only assertion | Delete the dry-run command, parser, and parser tests. |
| Unit tests do not download WebKit | Use the Chromium-only install command in `unit-test.yml`. |
