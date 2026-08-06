# Fast Required Browser Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce Perseus CI cost by skipping automatic code workflows for documentation-only changes, using Chromium-only browser installs in automatic tests, collapsing E2E into one automatic Chromium lane plus one manual broad lane, and deleting CI-only install assertions.

**Architecture:** Use native GitHub Actions `paths-ignore` on Build & Lint, Unit Tests, and E2E because the repository currently has no required checks or branch protection. Keep package scripts as the browser-install contract: Chromium-only for automatic Vitest/E2E, Chromium+WebKit for manual pre-release coverage. Rework the existing E2E jobs in place; do not add a classifier, summary job, test matrix, or branch-settings workflow.

**Tech Stack:** GitHub Actions, Bun 1.3.14, Playwright 1.57, Vitest 4 browser mode, Bash, Markdown.

## Global Constraints

- Implement the E2E changes only after HPA-555 is merged to `main` and Playwright uses the Worker-backed API.
- Do not edit `AGENTS.md`; it is a symlink to `CLAUDE.md`.
- Apply identical docs-only path filters to Build & Lint, Unit Tests, and E2E.
- Ignore only `docs/**`, `**/*.md`, and `**/*.mdx`.
- Mixed documentation and code changes must still run all automatic workflows.
- Use `test:install-browsers:chromium` in Unit Tests and automatic Chromium E2E.
- Use the full `test:install-browsers` command only for manual/local broad coverage.
- Keep Bun `1.3.14` and existing pinned GitHub Action SHAs.
- Keep zero Playwright retries in automatic and manual suites.
- Keep the manual lane sequential and fail-fast.
- Do not add a path classifier, classifier tests, `fetch-depth: 0`, a scope-summary step, branch protection changes, a weekly schedule, a matrix, sharding, caching, result aggregation, risk scoring, or suite-selection inputs.
- Do not edit completed HPA-226 design or implementation-plan history.
- Dispatch the manual broad lane before a planned production release.

## Dependency Order

```text
HPA-555 merged
  -> Task 1 simplify browser-install commands
  -> Task 2 reduce all automatic workflow cost
  -> Task 3 collapse E2E into automatic/manual lanes
  -> Task 4 update active documentation
  -> Task 5 run local, CI, and post-merge probes
```

## File Map

| Path | Responsibility after HPA-558 |
| --- | --- |
| `apps/web/package.json` | Chromium-only and full Playwright install commands plus existing E2E commands. |
| `.github/workflows/unit-test.yml` | Docs-only skip and Chromium-only browser-mode unit tests. |
| `.github/workflows/build-lint.yml` | Docs-only skip for code lint/typecheck/build. |
| `.github/workflows/e2e-test.yml` | One automatic Chromium E2E lane and one manual broad lane. |
| `apps/web/e2e/README.md` | Detailed local and CI E2E command reference. |
| `CLAUDE.md` | Canonical agent-facing CI cadence; `AGENTS.md` follows through its symlink. |
| `docs/OPERATOR_RUNBOOK.md` | Manual pre-release dispatch procedure and accepted risk. |
| `apps/web/scripts/assert-browser-install.ts` | Deleted. |
| `apps/web/scripts/assert-browser-install.test.ts` | Deleted. |

---

### Task 1: Simplify Browser-Install Commands

**Files:**

- Modify: `apps/web/package.json`
- Delete: `apps/web/scripts/assert-browser-install.ts`
- Delete: `apps/web/scripts/assert-browser-install.test.ts`

**Produces:**

```json
"test:install-browsers:chromium": "playwright install --with-deps --only-shell chromium",
"test:install-browsers": "playwright install --with-deps --only-shell chromium webkit"
```

- [ ] **Step 1: Confirm the HPA-555 implementation prerequisite**

```bash
git switch main
git pull --ff-only

! rg -n "build:bun|start:bun" apps/web/playwright.config.ts apps/api/package.json
rg -n "wrangler dev" apps/web/playwright.config.ts apps/api/package.json
```

Expected:

- Playwright no longer starts the Bun HTTP API.
- Worker/Wrangler commands are present.

Stop if either assertion fails. Start the HPA-558 implementation branch only after HPA-555 lands.

- [ ] **Step 2: Create the implementation branch**

```bash
git switch -c agent/hpa-558-fast-browser-gate
```

- [ ] **Step 3: Record active install-assertion references**

```bash
rg -n "test:install-browsers:dry-run|assert-browser-install" \
  .github apps CLAUDE.md docs/OPERATOR_RUNBOOK.md \
  --glob '!docs/superpowers/**'
```

Expected: references in the current E2E workflow, package manifest, E2E README, parser, and parser test.

- [ ] **Step 4: Replace the browser-install package scripts**

In `apps/web/package.json`, keep every `test:e2e:*` command unchanged and replace the install
commands with:

```json
"test:install-browsers:chromium": "playwright install --with-deps --only-shell chromium",
"test:install-browsers": "playwright install --with-deps --only-shell chromium webkit"
```

Remove `test:install-browsers:dry-run`.

- [ ] **Step 5: Delete the parser and its tests**

```bash
rm apps/web/scripts/assert-browser-install.ts
rm apps/web/scripts/assert-browser-install.test.ts
```

Do not move the parser or keep a compatibility export.

- [ ] **Step 6: Validate the direct commands without downloading**

```bash
bun run --cwd apps/web test:install-browsers:chromium -- --dry-run
bun run --cwd apps/web test:install-browsers -- --dry-run
```

Expected:

- Chromium command lists Chromium headless shell and supporting assets, not WebKit.
- Full command additionally lists WebKit.
- No repository parser consumes either output.

- [ ] **Step 7: Verify formatting and deletion**

```bash
bunx prettier --check apps/web/package.json

test ! -e apps/web/scripts/assert-browser-install.ts
test ! -e apps/web/scripts/assert-browser-install.test.ts

! rg -n "test:install-browsers:dry-run|assert-browser-install" \
  apps/web/package.json apps/web/scripts
```

Expected: all commands exit zero.

- [ ] **Step 8: Commit**

```bash
git add apps/web/package.json \
  apps/web/scripts/assert-browser-install.ts \
  apps/web/scripts/assert-browser-install.test.ts

git commit -m "test(web): simplify Playwright browser installs"
```

---

### Task 2: Reduce Automatic Workflow Cost

**Files:**

- Modify: `.github/workflows/build-lint.yml`
- Modify: `.github/workflows/unit-test.yml`

**Produces:**

- identical docs-only trigger filters in both workflows;
- Chromium-only Playwright installation for browser-mode unit tests.

- [ ] **Step 1: Add documentation filters to Build & Lint**

Change its triggers to:

```yaml
on:
  push:
    branches: [main, develop]
    paths-ignore:
      - 'docs/**'
      - '**/*.md'
      - '**/*.mdx'
  pull_request:
    branches: [main, develop]
    paths-ignore:
      - 'docs/**'
      - '**/*.md'
      - '**/*.mdx'
```

Do not change its jobs or commands.

- [ ] **Step 2: Add the same filters to Unit Tests**

Use the same trigger block:

```yaml
on:
  push:
    branches: [main, develop]
    paths-ignore:
      - 'docs/**'
      - '**/*.md'
      - '**/*.mdx'
  pull_request:
    branches: [main, develop]
    paths-ignore:
      - 'docs/**'
      - '**/*.md'
      - '**/*.mdx'
```

- [ ] **Step 3: Stop downloading WebKit for Chromium-only Vitest**

Replace:

```yaml
      - name: Install Playwright browsers
        run: bun run --cwd apps/web test:install-browsers
```

with:

```yaml
      - name: Install Chromium
        run: bun run --cwd apps/web test:install-browsers:chromium
```

Do not change `bun run test:unit` or the existing web invariant command. `apps/web/vite.config.ts`
declares Chromium as the only Vitest browser instance.

- [ ] **Step 4: Verify the two workflow diffs**

```bash
bunx prettier --check \
  .github/workflows/build-lint.yml \
  .github/workflows/unit-test.yml

git diff --check

git diff -- \
  .github/workflows/build-lint.yml \
  .github/workflows/unit-test.yml
```

Confirm:

- both workflows use the exact same three ignore patterns;
- no job steps were removed from Build & Lint;
- Unit Tests uses `test:install-browsers:chromium`;
- Unit Tests no longer references the full install command.

- [ ] **Step 5: Run browser-mode unit tests with Chromium only**

```bash
bun run --cwd apps/web test:install-browsers:chromium
bun run test:unit
```

Expected: browser-mode tests pass without a WebKit installation.

- [ ] **Step 6: Commit**

```bash
git add \
  .github/workflows/build-lint.yml \
  .github/workflows/unit-test.yml

git commit -m "ci: skip code workflows for documentation changes"
```

---

### Task 3: Collapse E2E into Automatic and Manual Lanes

**Files:**

- Modify: `.github/workflows/e2e-test.yml`

**Produces:**

- automatic job: `chromium-smoke` / `Chromium smoke`;
- manual job: `manual-pre-release` / `Manual pre-release suites`.

- [ ] **Step 1: Add docs-only filters and concurrency**

Use:

```yaml
name: E2E Tests

on:
  push:
    branches: [main, develop]
    paths-ignore:
      - 'docs/**'
      - '**/*.md'
      - '**/*.mdx'
  pull_request:
    branches: [main, develop]
    paths-ignore:
      - 'docs/**'
      - '**/*.md'
      - '**/*.mdx'
  workflow_dispatch:

concurrency:
  group: e2e-${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

permissions:
  contents: read
```

Do not add `fetch-depth`, path-classification steps, or a scope summary.

- [ ] **Step 2: Fold bundle safety into Chromium smoke**

Replace the standalone `production-bundle-safety` and current `chromium-smoke` jobs with:

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

      - name: Setup Bun
        uses: oven-sh/setup-bun@735343b667d3e6f658f44d0eca948eb6282f2b76 # v2.0.2
        with:
          bun-version: '1.3.14'

      - name: Install dependencies
        run: bun install

      - name: Verify production bundle excludes E2E harness
        run: bun run --cwd apps/web test:e2e:assert-production-bundle

      - name: Install Chromium
        run: bun run --cwd apps/web test:install-browsers:chromium

      - name: Run smoke E2E tests
        run: bun run --cwd apps/web test:e2e:smoke -- --retries=0

      - name: Upload test artifacts
        if: failure()
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: chromium-smoke-results
          path: |
            apps/web/test-results
            apps/web/playwright-report
          retention-days: 7
```

The bundle assertion must stay before the browser install.

- [ ] **Step 3: Remove the standalone WebKit PR job**

Delete `webkit-critical` completely. Its command moves to the manual lane in Step 4.

Remove every `needs: production-bundle-safety` reference.

- [ ] **Step 4: Repurpose the broad-suite block as one manual lane**

Replace/rename the existing `extended-a11y` block with:

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

      - name: Upload test artifacts
        if: failure()
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: manual-pre-release-results
          path: |
            apps/web/test-results
            apps/web/playwright-report
          retention-days: 7
```

Do not use a matrix, `continue-on-error`, retries, or result aggregation.

- [ ] **Step 5: Inspect the final E2E workflow**

```bash
bunx prettier --check .github/workflows/e2e-test.yml
git diff --check
git diff -- .github/workflows/e2e-test.yml
```

Confirm:

- exactly two jobs exist;
- automatic Chromium is excluded from `workflow_dispatch`;
- manual broad coverage runs only on `workflow_dispatch`;
- one `bun install` and one browser-install command exist per job;
- the automatic job installs Chromium only;
- the manual job installs Chromium+WebKit;
- no `strategy`, `matrix`, `needs`, classifier, dry-run assertion, or automatic main broad-suite condition remains.

- [ ] **Step 6: Run the automatic lane locally**

```bash
bun run --cwd apps/web test:e2e:assert-production-bundle
bun run --cwd apps/web test:install-browsers:chromium
bun run --cwd apps/web test:e2e:smoke -- --retries=0
```

Expected: all commands pass against the HPA-555 Worker-backed Playwright server.

- [ ] **Step 7: Confirm broad commands still select tests**

```bash
bun run --cwd apps/web test:e2e:webkit -- --list
bun run --cwd apps/web test:e2e:extended -- --list
bun run --cwd apps/web test:e2e:a11y -- --list
bun run --cwd apps/web test:e2e:stability -- --list
```

Expected: each command lists at least one test and exits zero.

- [ ] **Step 8: Commit**

```bash
git add .github/workflows/e2e-test.yml
git commit -m "ci: reduce E2E to automatic and manual lanes"
```

---

### Task 4: Update Active CI Documentation

**Files:**

- Modify: `apps/web/e2e/README.md`
- Modify: `CLAUDE.md`
- Modify: `docs/OPERATOR_RUNBOOK.md`
- Do not edit: `AGENTS.md` (symlink to `CLAUDE.md`)

- [ ] **Step 1: Update the E2E README command table**

Document these exact roles:

| Command | Role |
| --- | --- |
| `test:install-browsers:chromium` | Chromium-only install for Unit Tests and automatic E2E. |
| `test:e2e:assert-production-bundle` | First validation in automatic E2E. |
| `test:e2e:smoke` | Automatic Chromium desktop/mobile E2E lane. |
| `test:install-browsers` | Chromium+WebKit install for local/manual broad coverage. |
| `test:e2e:webkit` | Manual pre-release WebKit critical coverage. |
| `test:e2e:extended` | Manual pre-release five-project coverage. |
| `test:e2e:a11y` | Manual pre-release accessibility coverage. |
| `test:e2e:stability` | Manual pre-release ten-repeat Chromium stability sweep. |

Remove the dry-run command and parser section.

- [ ] **Step 2: Document the two E2E lanes**

Use this concise model:

```text
Automatic code-change E2E:
  production-bundle assertion -> Chromium install -> desktop/mobile smoke

Manual workflow dispatch:
  Chromium+WebKit install -> WebKit -> extended -> accessibility -> stability
```

State that documentation-only changes do not start Build & Lint, Unit Tests, or E2E.

- [ ] **Step 3: Correct `CLAUDE.md` cadence**

Update the E2E command descriptions:

- `test:e2e:smoke` — automatic Chromium desktop/mobile E2E;
- `test:e2e:webkit` — local/manual pre-release;
- `test:e2e:extended` — local/manual pre-release;
- `test:e2e:a11y` — local/manual pre-release;
- `test:e2e:stability` — local/manual pre-release;
- `test:e2e:assert-production-bundle` — automatic pre-browser assertion.

Add one sentence that Unit Tests installs Chromium only and docs-only changes skip all three
automatic code workflows.

Do not edit `AGENTS.md`; the symlink exposes the updated content automatically.

- [ ] **Step 4: Add the release procedure to the runbook**

Add a focused section:

```markdown
## Manual Pre-Release Browser Validation

Before a planned production release or before merging a release candidate to
`main`, dispatch **E2E Tests** on the candidate branch or commit. Require
**Manual pre-release suites** to pass.

The lane runs WebKit critical, extended five-project coverage, accessibility,
and Chromium stability sequentially. Ordinary pushes do not run this broad
lane automatically.
```

Include the accepted tradeoff: broad browser regressions can live until the pre-release run. Do not
add a cron schedule.

- [ ] **Step 5: Search active docs for stale cadence**

```bash
rg -n \
  "PR gate|main only|test:install-browsers:dry-run|assert-browser-install|extended-a11y|webkit-critical" \
  .github apps CLAUDE.md docs/OPERATOR_RUNBOOK.md \
  --glob '!docs/superpowers/**'
```

Expected:

- no dry-run/parser references remain;
- no active docs claim WebKit is a PR gate;
- no active docs claim extended/a11y run automatically on `main`;
- workflow job IDs may appear only where they remain valid.

- [ ] **Step 6: Format-check documentation**

```bash
bunx prettier --check \
  apps/web/e2e/README.md \
  CLAUDE.md \
  docs/OPERATOR_RUNBOOK.md

git diff --check
```

- [ ] **Step 7: Commit**

```bash
git add \
  apps/web/e2e/README.md \
  CLAUDE.md \
  docs/OPERATOR_RUNBOOK.md

git commit -m "docs: document automatic and pre-release CI lanes"
```

---

### Task 5: Verify Workflow Behavior

**Files:** No committed files unless verification finds a defect.

- [ ] **Step 1: Verify final file scope and static contracts**

```bash
git diff --check
git status --short

bunx prettier --check \
  .github/workflows/build-lint.yml \
  .github/workflows/unit-test.yml \
  .github/workflows/e2e-test.yml \
  apps/web/package.json \
  apps/web/e2e/README.md \
  CLAUDE.md \
  docs/OPERATOR_RUNBOOK.md

for workflow in \
  .github/workflows/build-lint.yml \
  .github/workflows/unit-test.yml \
  .github/workflows/e2e-test.yml
do
  rg -U "paths-ignore:\n\s+- 'docs/\*\*'\n\s+- '\*\*/\*\.md'\n\s+- '\*\*/\*\.mdx'" "$workflow"
done

rg -n "test:install-browsers:chromium" \
  .github/workflows/unit-test.yml \
  .github/workflows/e2e-test.yml \
  apps/web/package.json

! rg -n "test:install-browsers:dry-run|assert-browser-install" \
  .github apps CLAUDE.md docs/OPERATOR_RUNBOOK.md \
  --glob '!docs/superpowers/**'
```

Expected: all commands exit zero.

- [ ] **Step 2: Run the complete local validation set**

```bash
bun run test:unit
bun run --cwd apps/web test:e2e:assert-production-bundle
bun run --cwd apps/web test:e2e:smoke -- --retries=0

bun run --cwd apps/web test:e2e:webkit -- --list
bun run --cwd apps/web test:e2e:extended -- --list
bun run --cwd apps/web test:e2e:a11y -- --list
bun run --cwd apps/web test:e2e:stability -- --list
```

Expected: all commands exit zero.

- [ ] **Step 3: Push the implementation branch and inspect automatic CI**

```bash
git push -u origin agent/hpa-558-fast-browser-gate
```

Open the implementation pull request with a small non-documentation workflow or package change.

Confirm:

- Build & Lint starts;
- Unit Tests starts and its install step is Chromium-only;
- E2E starts exactly one automatic `Chromium smoke` job;
- E2E runs bundle safety before browser installation;
- WebKit and broad suites do not run automatically.

- [ ] **Step 4: Dispatch the manual lane**

From GitHub Actions, select:

```text
E2E Tests -> Run workflow -> agent/hpa-558-fast-browser-gate
```

Confirm:

- only `Manual pre-release suites` runs;
- dependencies install once;
- Chromium+WebKit install once;
- WebKit, extended, accessibility, and stability run in order;
- failure artifacts use `manual-pre-release-results`.

- [ ] **Step 5: Confirm E2E concurrency**

Push two quick successive non-documentation commits to the same implementation PR.

Expected: the newer E2E run cancels the older in-progress E2E run. Unit Tests and Build & Lint are
outside HPA-558's concurrency change.

- [ ] **Step 6: Merge and run a documentation-only probe**

After the implementation merges to `main`, open a probe PR changing only:

```text
docs/hpa-558-docs-only-probe.md
```

Confirm GitHub creates none of these workflow runs:

- Build & Lint
- Unit Tests
- E2E Tests

Close the probe PR without merging and delete its branch.

- [ ] **Step 7: Run a mixed-path probe**

Open or reuse a PR changing both:

```text
docs/hpa-558-mixed-probe.md
apps/web/package.json
```

Confirm all three automatic workflows start. Remove the temporary documentation file before the
implementation PR is finalized, or close the probe PR without merging.

- [ ] **Step 8: Final acceptance review**

Map the implementation evidence to every design acceptance row:

- one automatic Chromium E2E lane;
- production-bundle assertion before browser install;
- Chromium-only Unit Tests and automatic E2E installs;
- manual WebKit/extended/a11y/stability lane;
- docs-only trigger skips across all three workflows;
- mixed paths still run;
- E2E concurrency cancels superseded runs;
- dry-run parser and tests deleted;
- active docs and release runbook updated.

Do not mark HPA-558 complete if any row lacks direct evidence.
