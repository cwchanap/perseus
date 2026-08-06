# Fast Required Browser Gate Design

- **Issue:** HPA-558
- **Date:** 2026-08-05
- **Status:** Review-ready design
- **Implementation prerequisite:** HPA-555 merged to `main`

## Objective

Reduce Perseus browser CI to one fast required check for ordinary code changes while keeping the
existing WebKit, extended, accessibility, and stability suites available as an explicit
pre-release lane.

The change optimizes for fast, inexpensive hobby-project iteration. It changes when existing
coverage runs; it does not delete useful E2E scenarios, redesign the Playwright harness, or add a
new CI orchestration system.

## Current Repository Baseline

`.github/workflows/e2e-test.yml` currently creates three jobs on a normal pull request:

1. `Production bundle safety`
2. `Chromium smoke`
3. `WebKit critical`

Each browser job checks out the repository, installs Bun dependencies, validates the browser
installation contract, and downloads Playwright browsers. A push to `main` also runs the extended
five-project suite and accessibility scans. The local stability command exists but is not part of
an explicit pre-release workflow.

The broad suites and their package scripts are useful. The expensive part is running and
installing them continuously, not their existence.

## Sequencing Constraint

HPA-558 must be implemented after HPA-555.

`apps/web/playwright.config.ts` currently starts the duplicate Bun HTTP API with
`build:bun && start:bun`. HPA-555 replaces that web server with the Worker-backed local runtime.
Simplifying the required E2E gate before that replacement lands would validate and document a CI
shape around a backend command that is intentionally being deleted.

The planning documents may merge before HPA-555, but the implementation branch must start from or
rebase onto a `main` commit containing HPA-555.

## Approaches Considered

### 1. Skip the required workflow with `paths-ignore`

This is the smallest YAML diff, but it is not safe for a required check. GitHub documents that a
workflow skipped by path filtering can leave its required check pending and block the pull
request. This conflicts with the requirement that documentation-only pull requests remain
mergeable.

Rejected.

### 2. Add a path-filter job, a browser job, and a required summary job

This can make a final summary check succeed when the browser job is skipped, but it introduces
three jobs, `needs` wiring, and result aggregation solely to avoid running one browser job. That is
more orchestration than this hobby project needs.

Rejected.

### 3. Keep one required job and skip only its expensive steps

The existing `Chromium smoke` job remains the required status check. It always starts, checks out
the repository, and classifies the changed paths. For a documentation-only change it reports a
successful no-op result without setting up Bun or Playwright. For any code or unknown change it
runs the full required gate.

This preserves one stable required check, avoids GitHub's skipped-workflow behavior, and adds no
extra job or third-party path-filter action.

Chosen.

## Chosen Workflow Shape

Keep one file: `.github/workflows/e2e-test.yml`.

```text
pull_request or push
  |
  v
Chromium smoke (required job; existing check name)
  |
  +-- checkout with enough history for a deterministic diff
  +-- classify changed paths
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

There is no matrix, shard scheduler, dynamic risk score, cache service, retry policy, or suite
selection input.

## Event and Concurrency Model

Retain the current target branches:

- `pull_request` to `main` or `develop`
- `push` to `main` or `develop`
- `workflow_dispatch`

Do not add `paths` or `paths-ignore` to the workflow trigger because the required job must still
report a terminal status for documentation-only pull requests.

Use workflow-level concurrency:

```yaml
concurrency:
  group: e2e-${{ github.workflow }}-${{ github.event_name }}-${{
    github.event.pull_request.number || github.ref
  }}
  cancel-in-progress: true
```

Including the event name prevents a push run from canceling a manually dispatched pre-release
run on the same branch. A newer pull-request event for the same PR cancels its older run. A newer
manual dispatch on the same ref supersedes the older manual run.

## Documentation-Only Classification

The required job uses the repository checkout and `git diff --name-only`; it does not call a
third-party path-filter action.

- Pull request: compare `base.sha...head.sha` so classification follows the PR merge-base diff.
- Push: compare `before..github.sha` so all commits in the push are included.
- A push whose `before` SHA is all zeroes, an empty/unavailable range, or an unknown event is
  treated conservatively as browser-relevant.

A change is documentation-only only when every changed path matches one of:

- `docs/**`
- `**/*.md`
- `**/*.mdx`

Everything else runs the browser gate. A false negative therefore spends extra CI minutes; it
does not skip relevant validation.

The checkout may use `fetch-depth: 0`. The repository is small, and reliable availability of both
comparison commits is preferable to custom shallow-fetch logic.

## Required `Chromium smoke` Job

Keep the job ID and display name `chromium-smoke` / `Chromium smoke` so the surviving branch
protection check remains stable.

For browser-relevant changes, run these steps in order:

1. Checkout repository with credentials disabled.
2. Classify the changed paths.
3. Setup Bun `1.3.14`.
4. Run `bun install` once.
5. Run `bun run --cwd apps/web test:e2e:assert-production-bundle`.
6. Run `bun run --cwd apps/web test:install-browsers:chromium` once.
7. Run `bun run --cwd apps/web test:e2e:smoke -- --retries=0`.
8. Upload `apps/web/test-results` and `apps/web/playwright-report` only on failure.

The production-bundle assertion stays before the browser download so a harness leak fails without
paying the browser-install cost.

For a documentation-only change, steps 3-8 are skipped and the job prints a clear summary that
browser setup and tests were intentionally omitted.

## Manual Pre-Release Job

Add one job in the same workflow with a job-level condition:

```yaml
if: github.event_name == 'workflow_dispatch'
```

The required Chromium job has the inverse condition so a manual dispatch runs only the broad lane.

The manual job installs dependencies once and runs
`bun run --cwd apps/web test:install-browsers` once, then executes these existing commands in
order:

1. `bun run --cwd apps/web test:e2e:webkit -- --retries=0`
2. `bun run --cwd apps/web test:e2e:extended -- --retries=0`
3. `bun run --cwd apps/web test:e2e:a11y -- --retries=0`
4. `bun run --cwd apps/web test:e2e:stability`

The lane is intentionally sequential and fail-fast. Running every remaining suite after a known
failure would require result aggregation or `continue-on-error` plumbing that adds complexity
without improving the required PR feedback loop. Fix the failure and rerun the manual lane.

Upload the standard Playwright result and report directories on failure under one manual-lane
artifact name.

## Browser Installation Contract

`apps/web/package.json` keeps the existing full install command and adds one direct Chromium-only
command:

```json
"test:install-browsers:chromium": "playwright install --with-deps --only-shell chromium",
"test:install-browsers": "playwright install --with-deps --only-shell chromium webkit"
```

Delete:

- `test:install-browsers:dry-run`
- `apps/web/scripts/assert-browser-install.ts`
- `apps/web/scripts/assert-browser-install.test.ts`

The custom parser and its nine tests protect CI setup details rather than product behavior. The
package scripts themselves are an adequate, readable source of truth for which browsers each lane
installs.

Do not remove historical references from the completed HPA-226 design and implementation plan;
those documents describe the decision at the time. Remove active references from the workflow,
package scripts, and `apps/web/e2e/README.md`.

## Documentation

Update `apps/web/e2e/README.md` to describe:

- `test:e2e:smoke` as the only required code-change browser gate;
- `test:e2e:webkit`, `test:e2e:extended`, `test:e2e:a11y`, and
  `test:e2e:stability` as local and manual pre-release commands;
- the Chromium-only and full browser-install commands;
- documentation-only changes as a successful no-op `Chromium smoke` check;
- failure artifacts for the required and manual lanes;
- the removal of the custom browser-install dry-run assertion.

The README should explain operation, not duplicate the full workflow YAML.

## Branch Protection

After the workflow change is available on the default branch, update the repository ruleset or
branch protection settings:

- Require `Chromium smoke`.
- Remove `Production bundle safety` if it is currently required.
- Remove `WebKit critical` if it is currently required.
- Do not require `Manual pre-release suites`.

This is an explicit operator step because required-check configuration lives outside the
repository files. The implementation is not complete until a normal code PR is blocked by a
failing `Chromium smoke` check and a documentation-only PR receives a successful no-op check.

## Failure Behavior and Artifacts

- Production-bundle failure stops before the Chromium install.
- Chromium installation or smoke failure fails the required check.
- Manual suite failure stops later manual steps and fails the manual job.
- Required job failures retain the existing `chromium-smoke-results` artifact name.
- Manual failures use one `manual-pre-release-results` artifact.
- No retries are added. Existing deterministic-test policy remains unchanged.

## Validation

Before implementation is marked complete:

1. Format-check the workflow, package manifest, and E2E README.
2. Confirm no active references remain to the deleted dry-run script or assertion files.
3. Run the production-bundle assertion locally.
4. Install Chromium through the new package command.
5. Run the Chromium desktop/mobile smoke suite with zero retries against the HPA-555
   Worker-backed Playwright server.
6. Use Playwright `--list` to confirm all four broad commands still select tests.
7. Dispatch the manual lane on the implementation branch and confirm it installs browsers once
   before starting the broad commands.
8. Confirm a superseded PR run is canceled.
9. Confirm a documentation-only PR receives a successful `Chromium smoke` check without Bun or
   browser setup.
10. Confirm branch protection requires only the surviving browser check.

## Non-Goals

- Deleting or rewriting E2E scenarios.
- Adding Firefox or physical-device coverage.
- Adding retries, sharding, suite selection inputs, risk scoring, or test-impact analysis.
- Adding dependency or Playwright browser caches.
- Changing Playwright project definitions or test tags.
- Changing the HPA-555 Worker-backed E2E server.
- Preserving the custom browser-install assertion for compatibility.
- Automatically running broad suites on every `main` push.

## Acceptance Mapping

| Acceptance criterion | Design response |
| --- | --- |
| One required browser E2E job | Preserve `Chromium smoke` as the only required job. |
| Production bundle plus Chromium desktop/mobile smoke | Run both sequentially in the required job after one dependency install. |
| Broad suites are manual/pre-release | Run WebKit, extended, accessibility, and stability only on `workflow_dispatch`. |
| Superseded runs cancel | Add workflow-level event/ref concurrency with `cancel-in-progress: true`. |
| Docs-only changes skip browser CI | Keep the required job alive but skip every Bun/browser step after deterministic path classification. |
| Broad commands remain runnable | Preserve all four package commands and document them. |
| No matrix or custom orchestration | Use two mutually exclusive sequential jobs in one workflow and a small inline path classifier. |
| Remove setup-only assertion | Delete the dry-run package script, parser, and parser tests. |
