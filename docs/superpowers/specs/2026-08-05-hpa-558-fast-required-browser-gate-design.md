# Fast Required Browser Gate Design

- **Issue:** HPA-558
- **Date:** 2026-08-05
- **Revised:** 2026-08-06
- **Status:** Review-ready design
- **Implementation prerequisite:** HPA-555 merged to `main`

## Objective

Reduce Perseus browser CI to one fast required check for ordinary code changes while keeping the
existing WebKit, extended, accessibility, and stability suites available as an explicit
pre-release lane.

This optimizes for fast, inexpensive hobby-project iteration. It changes when existing coverage
runs; it does not delete useful E2E scenarios, redesign the Playwright harness, or add a CI
orchestration framework.

## Current Repository Baseline

`.github/workflows/e2e-test.yml` currently creates three jobs on a normal pull request:

1. `Production bundle safety`
2. `Chromium smoke`
3. `WebKit critical`

Each browser job checks out the repository, installs dependencies, validates the browser install
contract, and downloads Playwright browsers. A push to `main` also runs the five-project extended
suite and accessibility scans. The stability command exists locally but has no explicit operator
cadence.

The broad suites and their package commands are useful. The continuous installation and execution
cost is the part being reduced.

## Sequencing Constraint

HPA-558 must be implemented after HPA-555.

`apps/web/playwright.config.ts` currently boots the duplicate Bun HTTP API. HPA-555 replaces that
server with the Worker-backed local runtime and makes one contributor guide canonical. HPA-558
must start from or rebase onto a `main` commit containing those changes so its workflow and active
documentation describe the runtime that will remain.

The planning documents may merge before HPA-555. The implementation must not begin until:

- Playwright no longer runs `build:bun && start:bun`;
- the Worker-backed E2E server is green; and
- `AGENTS.md` is a short pointer rather than a duplicate of `CLAUDE.md`.

## Approaches Considered

### 1. Skip the required workflow with `paths-ignore`

This is the smallest YAML diff, but a workflow skipped by path filtering can leave a required
check pending and block the pull request. That conflicts with the requirement that documentation-
only pull requests remain mergeable.

Rejected.

### 2. Add a path-filter job, browser job, and required summary job

This can make a final status succeed when the browser job is skipped, but introduces three jobs,
`needs` wiring, and result aggregation solely to avoid one browser run.

Rejected as unnecessary orchestration.

### 3. Keep one required job and skip only its expensive steps

The existing `Chromium smoke` job remains the required status check. It always starts, checks out
the repository, classifies changed paths, and writes a scope summary. Documentation-only changes
finish successfully without Bun or Playwright setup. Any code change, unknown event, missing
comparison SHA, or diff-resolution failure runs the full browser gate.

Chosen.

## Chosen Workflow Shape

Keep one workflow file: `.github/workflows/e2e-test.yml`.

```text
pull_request or push
  |
  v
Chromium smoke (required; existing check name)
  |
  +-- checkout with full history
  +-- classify changed paths conservatively
  +-- write an unconditional job summary
  +-- docs-only -> successful no-op
  +-- otherwise:
        setup Bun
        install dependencies once
        assert the production bundle is harness-free
        install Chromium once
        run Chromium desktop/mobile smoke

workflow_dispatch
  |
  v
Manual pre-release suites
  |
  +-- setup Bun and install dependencies once
  +-- install Chromium + WebKit once
  +-- run WebKit critical
  +-- run extended five-project suite
  +-- run accessibility suite
  +-- run Chromium stability repeats
```

There is no matrix, shard scheduler, dynamic risk score, cache service, retry policy, path-filter
dependency, suite-selection input, or result aggregation layer.

## Event and Concurrency Model

Retain the current target branches:

- `pull_request` to `main` or `develop`
- `push` to `main` or `develop`
- `workflow_dispatch`

Do not add trigger-level `paths` or `paths-ignore`; the required check must still reach a terminal
status for documentation-only pull requests.

Use workflow-level concurrency:

```yaml
concurrency:
  group: e2e-${{ github.workflow }}-${{ github.event_name }}-${{
    github.event.pull_request.number || github.ref
  }}
  cancel-in-progress: true
```

Including `event_name` prevents a push from canceling a manual pre-release run on the same branch.
A newer event for the same PR cancels its older run. A newer manual dispatch on the same ref
supersedes the older manual run.

## Documentation-Only Classification

The required job uses the repository checkout and `git diff --name-only`; it does not call a
third-party path-filter action or a shared repository script.

Comparison ranges:

- pull request: `base.sha...head.sha`;
- push: `before..github.sha`;
- manual dispatch: handled by the mutually exclusive manual job.

A change is documentation-only only when every resolved path matches one of:

- `docs/**`
- `**/*.md`
- `**/*.mdx`

Everything else runs the browser gate.

The classifier is deliberately fail-open toward validation:

- an all-zero or missing push `before` SHA runs the browser gate;
- an unknown event runs the browser gate;
- an empty changed-file list runs the browser gate;
- an invalid or unavailable Git range runs the browser gate;
- any `git diff` failure is caught and converted to `run_browser=true` rather than failing the job.

The checkout uses `fetch-depth: 0`. A false negative in classification therefore spends extra CI
minutes; it does not skip validation or block merging because of classifier mechanics.

## Scope Summary

After classification, one unconditional step writes to `$GITHUB_STEP_SUMMARY`:

- `Browser gate will run.` for browser-relevant or conservatively unresolved changes;
- `Documentation-only change; Bun and Playwright setup skipped.` for a successful no-op.

This makes the outcome visible in the GitHub UI without requiring readers to inspect shell logs.

## Required `Chromium smoke` Job

Keep job ID `chromium-smoke` and display name `Chromium smoke` so the surviving branch-protection
check remains stable.

For browser-relevant changes, run in order:

1. checkout with credentials disabled and `fetch-depth: 0`;
2. classify changed paths;
3. write the scope summary;
4. setup Bun `1.3.14`;
5. run `bun install` once;
6. run `bun run --cwd apps/web test:e2e:assert-production-bundle`;
7. run `bun run --cwd apps/web test:install-browsers:chromium` once;
8. run `bun run --cwd apps/web test:e2e:smoke -- --retries=0`;
9. upload failure artifacts with the existing pinned `upload-artifact` action.

The production-bundle assertion stays before the browser download so a harness leak fails without
paying the browser-install cost.

For documentation-only changes, steps 4-9 are skipped and the job succeeds after the explicit
summary.

## Manual Pre-Release Job

Add one mutually exclusive job in the same workflow:

```yaml
if: github.event_name == 'workflow_dispatch'
```

The required Chromium job uses the inverse condition. A manual dispatch therefore runs only the
broad lane.

The manual job installs dependencies once and runs
`bun run --cwd apps/web test:install-browsers` once, then executes sequentially:

1. `bun run --cwd apps/web test:e2e:webkit -- --retries=0`
2. `bun run --cwd apps/web test:e2e:extended -- --retries=0`
3. `bun run --cwd apps/web test:e2e:a11y -- --retries=0`
4. `bun run --cwd apps/web test:e2e:stability`

The lane is intentionally fail-fast. It does not use `continue-on-error`, a matrix, or a final
result aggregator. One failure stops later suites; fix it and rerun the lane.

Upload failure artifacts as `manual-pre-release-results` with the repository's existing pinned
action:

```yaml
uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
```

## Pre-Release Operator Habit

Moving broad suites out of automatic `main` pushes is an intentional cost tradeoff, but they must
not become forgotten commands.

Update `docs/OPERATOR_RUNBOOK.md` with one explicit habit:

> Before a planned production release or before merging a release candidate to `main`, dispatch
> `E2E Tests` → `Manual pre-release suites` on the candidate branch or commit and require it to
> pass. Ordinary development pushes do not run this lane automatically.

This is a human release checkpoint, not a new automatic deployment dependency. Do not wire the
manual lane into every `main` push or add release orchestration in HPA-558.

## Browser Installation Contract

`apps/web/package.json` keeps the full install command and adds one direct Chromium-only command:

```json
"test:install-browsers:chromium": "playwright install --with-deps --only-shell chromium",
"test:install-browsers": "playwright install --with-deps --only-shell chromium webkit"
```

Delete:

- `test:install-browsers:dry-run`;
- `apps/web/scripts/assert-browser-install.ts`;
- `apps/web/scripts/assert-browser-install.test.ts`.

The parser and its tests defend CI download configuration rather than product behavior. The two
package scripts are the readable source of truth for browser installation.

Do not edit completed HPA-226 design or plan history. Remove stale active references from the
workflow, package manifest, canonical contributor guide, and E2E README.

## Active Documentation

Update these active surfaces:

- `apps/web/e2e/README.md` — full local/required/manual E2E command reference;
- `CLAUDE.md` — concise current cadence table used by coding agents;
- `docs/OPERATOR_RUNBOOK.md` — pre-release dispatch habit.

Because HPA-555 is a prerequisite, `AGENTS.md` should already be a short pointer to the canonical
contributor guide. Do not copy the cadence table back into it. During implementation, search all
non-historical files for `PR gate`, `main only`, and the broad command names; update any remaining
active cadence statement without modifying `docs/superpowers/specs/**` or
`docs/superpowers/plans/**` history.

The active docs must state:

- `test:e2e:smoke` is the only required browser suite for code changes;
- the production-bundle assertion runs in the same required job;
- WebKit, extended, accessibility, and stability are local/manual pre-release commands;
- documentation-only changes receive a successful no-op `Chromium smoke` check;
- the custom browser-install dry-run assertion no longer exists;
- the manual lane is dispatched before planned production releases.

## Branch Protection Hard Gate

After the implementation workflow is merged to the default branch, immediately update the
repository ruleset or branch protection before treating HPA-558 as complete or opening/merging
follow-up pull requests:

- require `Chromium smoke`;
- remove `Production bundle safety` if currently required;
- remove `WebKit critical` if currently required;
- do not require `Manual pre-release suites`.

This ordering is mandatory. If removed jobs remain required, later pull requests can remain
pending forever. The documentation-only probe happens only after the protection settings are
updated.

## Failure Behavior and Artifacts

- classifier resolution failure runs the browser gate instead of failing the classifier step;
- production-bundle failure stops before Chromium installation;
- Chromium installation or smoke failure fails the required check;
- manual-suite failure stops later manual steps and fails the manual job;
- required failures retain `chromium-smoke-results`;
- manual failures use `manual-pre-release-results`;
- no retries are added.

## Validation

Before HPA-558 is complete:

1. Confirm HPA-555 is on `main` and Playwright uses the Worker-backed API server.
2. Format-check the workflow, package manifest, E2E README, canonical guide, and runbook.
3. Confirm no active references remain to the deleted dry-run parser or old CI cadence.
4. Exercise classifier fixtures for docs-only, mixed paths, empty changes, all-zero `before`, and
   an invalid diff range; unresolved cases must select browser CI without failing the step.
5. Run the production-bundle assertion locally.
6. Install Chromium through the new package command.
7. Run Chromium desktop/mobile smoke with zero retries.
8. Use Playwright `--list` to confirm all four broad commands still select tests.
9. Dispatch the manual lane on the implementation branch and confirm one dependency install and
   one browser install precede the four suites.
10. Confirm a superseded PR run is canceled.
11. Merge the implementation workflow.
12. Immediately update branch protection to require only `Chromium smoke` among these browser
    checks.
13. Open a documentation-only probe PR and confirm a successful no-op check with no Bun or browser
    setup.
14. Open or reuse a code PR and confirm a failing `Chromium smoke` blocks merging.

## Non-Goals

- deleting or rewriting E2E scenarios;
- adding Firefox or physical-device coverage;
- adding retries, sharding, suite-selection inputs, risk scoring, or test-impact analysis;
- adding dependency or Playwright browser caches;
- changing Playwright projects or tags;
- changing the HPA-555 Worker-backed E2E server;
- preserving the custom install assertion for compatibility;
- automatically running broad suites on every `main` push;
- creating a release automation system.

## Acceptance Mapping

| Acceptance criterion | Design response |
| --- | --- |
| One required browser E2E job | Preserve `Chromium smoke` as the only required job. |
| Production bundle plus Chromium desktop/mobile smoke | Run both sequentially after one dependency install. |
| Broad suites are manual/pre-release | Run WebKit, extended, accessibility, and stability only on dispatch. |
| Superseded runs cancel | Add event/ref concurrency with `cancel-in-progress: true`. |
| Docs-only changes skip browser setup | Keep the required job alive, classify conservatively, summarize, and gate expensive steps. |
| Classifier failures do not block | Catch invalid ranges and run the browser gate. |
| Broad commands remain runnable | Preserve and document all four commands plus a release cadence. |
| No matrix or custom orchestration | Use two mutually exclusive sequential jobs and one inline classifier. |
| Remove setup-only assertion | Delete the dry-run package command, parser, and parser tests. |
| Required checks remain mergeable | Make branch-protection cleanup an immediate post-merge hard gate. |
