# Fast Required Browser Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Perseus's three-job required browser path with one fast `Chromium smoke` check,
move all broad suites to one manual pre-release job, and remove CI-only browser-install assertion
maintenance.

**Architecture:** Keep `.github/workflows/e2e-test.yml` as the single browser workflow. Its
existing `Chromium smoke` job remains the required check and uses an inline Git diff classifier to
skip Bun and Playwright steps for documentation-only changes without skipping the required
workflow itself. A mutually exclusive `workflow_dispatch` job installs Chromium and WebKit once
and runs the existing WebKit, extended, accessibility, and stability commands sequentially.

**Tech Stack:** GitHub Actions, Bash, Bun 1.3.14, Playwright 1.57, TypeScript, Markdown.

## Global Constraints

- Implement only after HPA-555 is merged to `main` and Playwright uses the Worker-backed API
  server.
- Preserve the required job ID `chromium-smoke` and display name `Chromium smoke`.
- Do not use trigger-level `paths` or `paths-ignore` for the required workflow.
- Treat only `docs/**`, `**/*.md`, and `**/*.mdx` as documentation-only.
- Treat unknown events, unavailable diffs, and an all-zero push `before` SHA as browser-relevant.
- Use Bun `1.3.14` and the repository's pinned GitHub Action SHAs.
- Keep zero Playwright retries in required and broad CI commands.
- Keep WebKit, extended, accessibility, and stability test scenarios and package commands.
- Do not add a matrix, shard scheduler, cache service, path-filter dependency, dynamic risk score,
  test-impact analysis, or manual suite-selection inputs.
- Do not edit the completed HPA-226 design and implementation-plan history.
- Do not preserve the custom browser-install parser for compatibility.

## Dependency Order

```text
HPA-555 merged
  -> Task 1 simplify browser install scripts
  -> Task 2 collapse the GitHub Actions workflow
  -> Task 3 update active E2E documentation
  -> Task 4 verify CI behavior and update required checks
```

## File Map

| Path | Responsibility after HPA-558 |
| --- | --- |
| `apps/web/package.json` | Local Playwright suite commands plus Chromium-only and full browser install commands. |
| `.github/workflows/e2e-test.yml` | One required fast gate and one manual broad-suite lane. |
| `apps/web/e2e/README.md` | Contributor instructions for required, manual, and local browser validation. |
| `apps/web/scripts/assert-browser-install.ts` | Deleted; no product responsibility remains. |
| `apps/web/scripts/assert-browser-install.test.ts` | Deleted with the CI-only parser. |

---

### Task 1: Simplify the Browser Installation Contract

**Files:**

- Modify: `apps/web/package.json`
- Delete: `apps/web/scripts/assert-browser-install.ts`
- Delete: `apps/web/scripts/assert-browser-install.test.ts`

**Produces:**

```json
"test:install-browsers:chromium": "playwright install --with-deps --only-shell chromium",
"test:install-browsers": "playwright install --with-deps --only-shell chromium webkit"
```

- [ ] **Step 1: Confirm the implementation prerequisite**

```bash
git switch main
git pull --ff-only
git log --oneline --all --grep='HPA-555\|duplicate Bun HTTP API runtime' -n 5
rg "build:bun|start:bun" apps/web/playwright.config.ts apps/api/package.json
```

Expected:

- HPA-555 is present in `main` history.
- `apps/web/playwright.config.ts` no longer boots `build:bun && start:bun`.
- If either condition is false, stop and rebase only after HPA-555 lands.

- [ ] **Step 2: Record active dry-run references before deletion**

```bash
rg -n "test:install-browsers:dry-run|assert-browser-install" \
  .github/workflows/e2e-test.yml \
  apps/web/package.json \
  apps/web/e2e/README.md \
  apps/web/scripts
```

Expected: references in the workflow, package manifest, README, parser, and parser test.

- [ ] **Step 3: Replace the package scripts**

In `apps/web/package.json`, keep every `test:e2e:*` command unchanged. Replace the browser install
entries with:

```json
"test:install-browsers:chromium": "playwright install --with-deps --only-shell chromium",
"test:install-browsers": "playwright install --with-deps --only-shell chromium webkit"
```

Remove `test:install-browsers:dry-run` completely.

- [ ] **Step 4: Delete the custom parser and its tests**

```bash
rm apps/web/scripts/assert-browser-install.ts
rm apps/web/scripts/assert-browser-install.test.ts
```

Do not move the parser or retain a compatibility export. It exists only to assert which files the
Playwright CLI plans to download.

- [ ] **Step 5: Validate both direct install commands without downloading**

```bash
bun run --cwd apps/web test:install-browsers:chromium -- --dry-run
bun run --cwd apps/web test:install-browsers -- --dry-run
```

Expected:

- The Chromium command lists the Chromium headless shell and its supporting assets, not WebKit.
- The full command also lists WebKit.
- No repository parser consumes or validates this output.

- [ ] **Step 6: Verify formatting and active-reference cleanup for this task**

```bash
bunx prettier --check apps/web/package.json
test ! -e apps/web/scripts/assert-browser-install.ts
test ! -e apps/web/scripts/assert-browser-install.test.ts
! rg -n "test:install-browsers:dry-run|assert-browser-install" \
  apps/web/package.json apps/web/scripts
```

Expected: every command exits zero.

- [ ] **Step 7: Commit**

```bash
git add apps/web/package.json \
  apps/web/scripts/assert-browser-install.ts \
  apps/web/scripts/assert-browser-install.test.ts
git commit -m "test(web): simplify Playwright browser installs"
```

---

### Task 2: Collapse Browser CI into Required and Manual Lanes

**Files:**

- Modify: `.github/workflows/e2e-test.yml`

**Produces:**

- Required job: `chromium-smoke` / `Chromium smoke`
- Manual job: `manual-pre-release` / `Manual pre-release suites`

- [ ] **Step 1: Replace the trigger and concurrency header**

Keep the existing branch targets and do not add path filters:

```yaml
name: E2E Tests

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]
  workflow_dispatch:

concurrency:
  group: e2e-${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

permissions:
  contents: read
```

The event name isolates manual dispatches from push and pull-request cancellation groups.

- [ ] **Step 2: Replace the three automatic jobs with one required job**

Start the job with:

```yaml
jobs:
  chromium-smoke:
    name: Chromium smoke
    if: github.event_name != 'workflow_dispatch'
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          persist-credentials: false
          fetch-depth: 0
```

Delete the standalone `production-bundle-safety` and `webkit-critical` jobs. Remove every `needs:
production-bundle-safety` reference.

- [ ] **Step 3: Add conservative path classification**

Immediately after checkout, add:

```yaml
      - name: Detect browser-relevant changes
        id: scope
        shell: bash
        env:
          EVENT_NAME: ${{ github.event_name }}
          PR_BASE_SHA: ${{ github.event.pull_request.base.sha }}
          PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}
          PUSH_BEFORE_SHA: ${{ github.event.before }}
          CURRENT_SHA: ${{ github.sha }}
        run: |
          set -euo pipefail

          case "$EVENT_NAME" in
            pull_request)
              range="${PR_BASE_SHA}...${PR_HEAD_SHA}"
              ;;
            push)
              if [[ -z "$PUSH_BEFORE_SHA" || "$PUSH_BEFORE_SHA" =~ ^0+$ ]]; then
                echo "run_browser=true" >> "$GITHUB_OUTPUT"
                echo "No reliable push base SHA; running the browser gate."
                exit 0
              fi
              range="${PUSH_BEFORE_SHA}..${CURRENT_SHA}"
              ;;
            *)
              echo "run_browser=true" >> "$GITHUB_OUTPUT"
              echo "Unknown event type; running the browser gate."
              exit 0
              ;;
          esac

          changed_files="$(git diff --name-only "$range")"
          if [[ -z "$changed_files" ]]; then
            echo "run_browser=true" >> "$GITHUB_OUTPUT"
            echo "No changed paths were resolved; running the browser gate."
          elif grep -Ev '(^docs/|\.mdx?$)' <<< "$changed_files" >/dev/null; then
            echo "run_browser=true" >> "$GITHUB_OUTPUT"
            echo "Browser-relevant changes detected."
          else
            echo "run_browser=false" >> "$GITHUB_OUTPUT"
            echo "Documentation-only change; skipping Bun and Playwright setup."
          fi
```

Do not extract this into a repository script. The classifier is intentionally small and belongs
to the workflow that consumes it.

- [ ] **Step 4: Gate every expensive required-job step**

Add this condition to Setup Bun, dependency installation, production-bundle safety, Chromium
installation, smoke execution, and failure artifact upload:

```yaml
if: steps.scope.outputs.run_browser == 'true'
```

For artifact upload, combine it with failure handling:

```yaml
if: failure() && steps.scope.outputs.run_browser == 'true'
```

The required sequence is:

```yaml
      - name: Setup Bun
        if: steps.scope.outputs.run_browser == 'true'
        uses: oven-sh/setup-bun@735343b667d3e6f658f44d0eca948eb6282f2b76 # v2.0.2
        with:
          bun-version: '1.3.14'

      - name: Install dependencies
        if: steps.scope.outputs.run_browser == 'true'
        run: bun install

      - name: Verify production bundle excludes E2E harness
        if: steps.scope.outputs.run_browser == 'true'
        run: bun run --cwd apps/web test:e2e:assert-production-bundle

      - name: Install Chromium
        if: steps.scope.outputs.run_browser == 'true'
        run: bun run --cwd apps/web test:install-browsers:chromium

      - name: Run smoke E2E tests
        if: steps.scope.outputs.run_browser == 'true'
        run: bun run --cwd apps/web test:e2e:smoke -- --retries=0
```

Keep the existing `chromium-smoke-results` artifact name and seven-day retention.

- [ ] **Step 5: Replace the automatic broad job with one manual job**

Add:

```yaml
  manual-pre-release:
    name: Manual pre-release suites
    if: github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          persist-credentials: false

      - name: Setup Bun
        uses: oven-sh/setup-bun@735343b667d3e6f658f44d0eca948eb6282f2b76 # v2.0.2
        with:
          bun-version: '1.3.14'

      - name: Install dependencies
        run: bun install

      - name: Install Playwright browsers
        run: bun run --cwd apps/web test:install-browsers

      - name: Run WebKit critical E2E tests
        run: bun run --cwd apps/web test:e2e:webkit -- --retries=0

      - name: Run extended E2E tests
        run: bun run --cwd apps/web test:e2e:extended -- --retries=0

      - name: Run accessibility E2E tests
        run: bun run --cwd apps/web test:e2e:a11y -- --retries=0

      - name: Run stability E2E tests
        run: bun run --cwd apps/web test:e2e:stability
```

Add one failure-only artifact upload named `manual-pre-release-results`, using the same result and
report paths and seven-day retention as the required job.

Do not use `continue-on-error`, a matrix, or a final result-aggregation step. This lane is
sequential and fail-fast.

- [ ] **Step 6: Validate the documentation-only regex independently**

```bash
if printf '%s\n' docs/guide.md README.md docs/config/example.json |
  grep -Ev '(^docs/|\.mdx?$)' >/dev/null; then
  echo 'docs-only classifier incorrectly selected browser CI' >&2
  exit 1
fi

printf '%s\n' apps/web/package.json README.md |
  grep -Ev '(^docs/|\.mdx?$)' >/dev/null
```

Expected: the first classifier test exits zero through the explicit guard; the second `grep`
finds `apps/web/package.json` and exits zero.

- [ ] **Step 7: Format-check and inspect the workflow diff**

```bash
bunx prettier --check .github/workflows/e2e-test.yml
git diff --check
git diff -- .github/workflows/e2e-test.yml
```

Confirm the diff contains exactly two jobs, no `strategy`, no `matrix`, no trigger-level path
filter, one `bun install` per job, one browser-install command per job, and no dry-run assertion.

- [ ] **Step 8: Commit**

```bash
git add .github/workflows/e2e-test.yml
git commit -m "ci: reduce browser checks to one fast gate"
```

---

### Task 3: Update Active E2E Contributor Documentation

**Files:**

- Modify: `apps/web/e2e/README.md`

- [ ] **Step 1: Update the project command table**

Make these responsibilities explicit:

| Command | Documented role |
| --- | --- |
| `test:e2e:assert-production-bundle` | First assertion in the required code-change job. |
| `test:install-browsers:chromium` | Chromium-only installation used by the required job. |
| `test:e2e:smoke` | Only required browser suite for code changes; desktop and mobile Chromium. |
| `test:install-browsers` | Chromium and WebKit installation for local/manual broad validation. |
| `test:e2e:webkit` | Manual pre-release WebKit critical coverage. |
| `test:e2e:extended` | Manual pre-release five-project coverage. |
| `test:e2e:a11y` | Manual pre-release accessibility scans. |
| `test:e2e:stability` | Manual pre-release ten-repeat Chromium stability sweep. |

Remove the `test:install-browsers:dry-run` row.

- [ ] **Step 2: Replace stale automatic-CI wording**

Remove statements that WebKit runs on every PR or that extended/accessibility run automatically on
`main`. Document the two lanes:

```text
Code pull request or push:
  Chromium smoke check
  -> docs-only: successful no-op after path classification
  -> code: production bundle assertion + Chromium smoke

Manual workflow dispatch:
  WebKit critical -> extended -> accessibility -> stability
```

State that the manual lane is fail-fast and can be rerun after a failure is corrected.

- [ ] **Step 3: Remove the custom dry-run section**

Delete the section that describes parsing `playwright install --dry-run` output. Replace it with a
short browser-install section that points contributors to the two direct package commands.

Do not edit historical HPA-226 planning documents.

- [ ] **Step 4: Update artifact guidance**

Document:

- `chromium-smoke-results` for required-gate failures;
- `manual-pre-release-results` for manually dispatched broad-suite failures;
- both retain `apps/web/test-results` and `apps/web/playwright-report` for seven days.

- [ ] **Step 5: Verify active documentation**

```bash
bunx prettier --check apps/web/e2e/README.md
! rg -n "test:install-browsers:dry-run|assert-browser-install" \
  .github/workflows/e2e-test.yml \
  apps/web/package.json \
  apps/web/e2e/README.md \
  apps/web/scripts
rg -n "Chromium smoke|Manual pre-release|test:e2e:stability" apps/web/e2e/README.md
```

Expected: no active dry-run references and all three new lane concepts are present.

- [ ] **Step 6: Commit**

```bash
git add apps/web/e2e/README.md
git commit -m "docs(web): document fast and pre-release E2E lanes"
```

---

### Task 4: Verify Runtime Behavior and Required-Check Settings

**Files:**

- No repository file changes expected.
- Operator configuration: GitHub branch protection or repository ruleset.

- [ ] **Step 1: Run static repository checks**

```bash
bunx prettier --check \
  .github/workflows/e2e-test.yml \
  apps/web/package.json \
  apps/web/e2e/README.md

git diff --check main...HEAD
! rg -n "test:install-browsers:dry-run|assert-browser-install" \
  .github/workflows/e2e-test.yml \
  apps/web/package.json \
  apps/web/e2e/README.md \
  apps/web/scripts
```

Expected: every command exits zero.

- [ ] **Step 2: Run the required lane locally**

```bash
bun install
bun run --cwd apps/web test:e2e:assert-production-bundle
bun run --cwd apps/web test:install-browsers:chromium
bun run --cwd apps/web test:e2e:smoke -- --retries=0
```

Expected:

- Production bundle scan passes.
- Chromium is installed through the new direct command.
- Chromium desktop/mobile smoke passes with zero retries against the Worker-backed HPA-555
  Playwright server.

- [ ] **Step 3: Confirm broad suite selection remains intact**

```bash
bun run --cwd apps/web test:e2e:webkit -- --list
bun run --cwd apps/web test:e2e:extended -- --list
bun run --cwd apps/web test:e2e:a11y -- --list
bun run --cwd apps/web test:e2e:stability -- --list
```

Expected: every command lists at least one test and exits zero. No test or project configuration is
changed by HPA-558.

- [ ] **Step 4: Push and inspect the implementation PR**

```bash
git push -u origin HEAD
```

On the code-changing PR, confirm:

- only `Chromium smoke` is an automatic E2E job;
- `Manual pre-release suites` is skipped;
- the required job installs dependencies once and Chromium once;
- production-bundle safety runs before the browser install;
- a superseding push cancels the older PR run.

- [ ] **Step 5: Dispatch the manual lane on the implementation branch**

From GitHub Actions, run `E2E Tests` with `workflow_dispatch` against the implementation branch.
Confirm:

- `Chromium smoke` is skipped;
- `Manual pre-release suites` is the only running job;
- dependency and full browser installation each occur once;
- WebKit, extended, accessibility, and stability commands run in that order;
- a failure uploads `manual-pre-release-results`.

- [ ] **Step 6: Update required-check configuration**

In the branch protection rule or repository ruleset for `main` and `develop`:

1. Add or retain `Chromium smoke` as required.
2. Remove `Production bundle safety` from required checks.
3. Remove `WebKit critical` from required checks.
4. Do not require `Manual pre-release suites`.

Required-check configuration is outside git and must be verified separately from the workflow
diff.

- [ ] **Step 7: Verify a documentation-only pull request**

After the workflow is available on the default branch, open a short-lived PR whose diff contains
only a Markdown file or a path under `docs/`. Confirm:

- `Chromium smoke` reaches success rather than remaining pending;
- its log says the change is documentation-only;
- Setup Bun, dependency installation, browser installation, and Playwright execution are skipped;
- the PR remains mergeable with the required check enabled.

Close the probe PR if it is not a real documentation change.

- [ ] **Step 8: Record verification in the implementation PR body**

Add the exact local command results, the manual workflow run link, the docs-only probe result, and
the final required-check names. Do not claim a suite passed without the corresponding fresh run.

## Final Acceptance Checklist

- [ ] A code PR reports one automatic E2E check named `Chromium smoke`.
- [ ] The check runs production-bundle safety before one Chromium install and desktop/mobile smoke.
- [ ] A docs-only PR reports the same check as a successful no-op without Bun or Playwright setup.
- [ ] A newer PR push cancels the older in-progress E2E run.
- [ ] `workflow_dispatch` runs WebKit, extended, accessibility, and stability in one sequential job.
- [ ] All broad commands remain documented and locally runnable.
- [ ] The custom dry-run package script, parser, and parser test are deleted.
- [ ] The workflow contains no matrix, retries, dynamic scoring, sharding, or new caching layer.
- [ ] Branch protection requires `Chromium smoke` and no removed/manual E2E checks.
