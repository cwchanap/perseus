# Fast Required Browser Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Perseus's three-job required browser path with one fast `Chromium smoke` check,
move broad suites to one manual pre-release job, and remove CI-only browser-install assertion
maintenance.

**Architecture:** Keep `.github/workflows/e2e-test.yml` as the single browser workflow. Its
existing `Chromium smoke` job remains the required check and uses a conservative inline Git diff
classifier to skip Bun and Playwright only for proven documentation-only changes. A mutually
exclusive `workflow_dispatch` job installs Chromium and WebKit once and runs WebKit, extended,
accessibility, and stability sequentially.

**Tech Stack:** GitHub Actions, Bash, Bun 1.3.14, Playwright 1.57, TypeScript, Markdown.

## Global Constraints

- Implement only after HPA-555 is merged to `main` and Playwright uses the Worker-backed API.
- Confirm HPA-555 made one contributor guide canonical and `AGENTS.md` a short pointer.
- Preserve required job ID `chromium-smoke` and display name `Chromium smoke`.
- Do not use trigger-level `paths` or `paths-ignore` for the required workflow.
- Treat only `docs/**`, `**/*.md`, and `**/*.mdx` as documentation-only.
- Treat unknown events, missing SHAs, empty diffs, invalid ranges, and `git diff` failures as
  browser-relevant without failing the classifier step.
- Write an unconditional GitHub step summary explaining whether browser setup ran.
- Use Bun `1.3.14` and the repository's pinned GitHub Action SHAs.
- Keep zero Playwright retries in required and broad CI commands.
- Keep WebKit, extended, accessibility, and stability scenarios and package commands.
- Keep the manual lane sequential and fail-fast.
- Do not add a matrix, shard scheduler, cache service, path-filter action, dynamic risk score,
  test-impact analysis, result aggregator, or suite-selection inputs.
- Do not edit completed HPA-226 design or implementation-plan history.
- Do not copy cadence guidance back into `AGENTS.md` after HPA-555 makes it a pointer.
- Do not preserve the custom browser-install parser for compatibility.
- Before a planned production release, dispatch and require the manual pre-release lane.
- Immediately after the workflow implementation merges, update branch protection before treating
  HPA-558 as complete or opening/merging follow-up PRs.

## Dependency Order

```text
HPA-555 merged
  -> Task 1 simplify browser installation scripts
  -> Task 2 collapse browser CI into required/manual lanes
  -> Task 3 update every active cadence surface
  -> Task 4 verify runtime behavior
  -> merge implementation
  -> Task 5 immediately repair branch protection and run probe PRs
```

## File Map

| Path | Responsibility after HPA-558 |
| --- | --- |
| `apps/web/package.json` | Local E2E commands plus Chromium-only and full browser installs. |
| `.github/workflows/e2e-test.yml` | One required fast lane and one manual broad lane. |
| `apps/web/e2e/README.md` | Detailed contributor E2E reference. |
| `CLAUDE.md` | Concise canonical agent-facing cadence after HPA-555. |
| `docs/OPERATOR_RUNBOOK.md` | Manual pre-release dispatch habit. |
| `AGENTS.md` | Remains HPA-555's short pointer; no duplicated cadence table. |
| `apps/web/scripts/assert-browser-install.ts` | Deleted. |
| `apps/web/scripts/assert-browser-install.test.ts` | Deleted. |

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

- [ ] **Step 1: Confirm the HPA-555 prerequisite from repository state**

```bash
git switch main
git pull --ff-only

! rg -n "build:bun|start:bun" apps/web/playwright.config.ts apps/api/package.json
rg -n "wrangler dev" apps/web/playwright.config.ts apps/api/package.json
rg -n "CLAUDE\.md" AGENTS.md
! rg -n "dual runtime|PR gate|main only" AGENTS.md
```

Expected:

- Playwright no longer boots the Bun HTTP API.
- Worker/Wrangler commands are present.
- `AGENTS.md` is a short pointer and no longer duplicates active architecture or E2E cadence.

Stop if any assertion fails. Rebase only after HPA-555 is complete.

- [ ] **Step 2: Create the implementation branch from updated `main`**

```bash
git switch -c agent/hpa-558-fast-browser-gate
```

- [ ] **Step 3: Record active dry-run references before deletion**

```bash
rg -n "test:install-browsers:dry-run|assert-browser-install" \
  .github apps/web CLAUDE.md docs/OPERATOR_RUNBOOK.md \
  --glob '!docs/superpowers/**'
```

Expected: current workflow/package/README/parser references only.

- [ ] **Step 4: Replace the package scripts**

In `apps/web/package.json`, keep every `test:e2e:*` command unchanged. Replace the browser install
entries with:

```json
"test:install-browsers:chromium": "playwright install --with-deps --only-shell chromium",
"test:install-browsers": "playwright install --with-deps --only-shell chromium webkit"
```

Remove `test:install-browsers:dry-run`.

- [ ] **Step 5: Delete the custom parser and its tests**

```bash
rm apps/web/scripts/assert-browser-install.ts
rm apps/web/scripts/assert-browser-install.test.ts
```

Do not move or preserve a compatibility export.

- [ ] **Step 6: Validate both direct install commands without downloading**

```bash
bun run --cwd apps/web test:install-browsers:chromium -- --dry-run
bun run --cwd apps/web test:install-browsers -- --dry-run
```

Expected:

- Chromium command lists Chromium headless shell and supporting assets, not WebKit.
- Full command additionally lists WebKit.
- No repository parser consumes the output.

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

### Task 2: Collapse Browser CI into Required and Manual Lanes

**Files:**

- Modify: `.github/workflows/e2e-test.yml`

**Produces:**

- Required job: `chromium-smoke` / `Chromium smoke`
- Manual job: `manual-pre-release` / `Manual pre-release suites`

- [ ] **Step 1: Keep current events and add isolated concurrency**

Use:

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

Do not add trigger-level path filters.

- [ ] **Step 2: Replace automatic jobs with the surviving required job**

Start `jobs` with:

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

Delete standalone `production-bundle-safety`, `webkit-critical`, and automatic
`extended-a11y` jobs. Remove every `needs: production-bundle-safety` reference.

- [ ] **Step 3: Add a conservative classifier that catches diff failures**

Immediately after checkout, add exactly:

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
              if [[ -z "$PR_BASE_SHA" || -z "$PR_HEAD_SHA" ]]; then
                echo "run_browser=true" >> "$GITHUB_OUTPUT"
                echo "Missing pull-request comparison SHA; running the browser gate."
                exit 0
              fi
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

          if ! changed_files="$(git diff --name-only "$range" 2>/dev/null)"; then
            echo "run_browser=true" >> "$GITHUB_OUTPUT"
            echo "Diff range unavailable; running the browser gate."
            exit 0
          fi

          if [[ -z "$changed_files" ]]; then
            echo "run_browser=true" >> "$GITHUB_OUTPUT"
            echo "No changed paths resolved; running the browser gate."
          elif grep -Ev '(^docs/|\.mdx?$)' <<< "$changed_files" >/dev/null; then
            echo "run_browser=true" >> "$GITHUB_OUTPUT"
            echo "Browser-relevant changes detected."
          else
            echo "run_browser=false" >> "$GITHUB_OUTPUT"
            echo "Documentation-only change; skipping Bun and Playwright setup."
          fi
```

Do not extract this into a repository script or add a path-filter dependency.

- [ ] **Step 4: Add an unconditional scope summary**

Immediately after classification:

```yaml
      - name: Summarize scope
        env:
          RUN_BROWSER: ${{ steps.scope.outputs.run_browser }}
        run: |
          if [[ "$RUN_BROWSER" == "true" ]]; then
            echo "Browser gate will run." >> "$GITHUB_STEP_SUMMARY"
          else
            echo "Documentation-only change; Bun and Playwright setup skipped." \
              >> "$GITHUB_STEP_SUMMARY"
          fi
```

This step always runs for the required job and makes the no-op result visible in the GitHub UI.

- [ ] **Step 5: Gate every expensive required step**

Add this condition to Bun setup, dependency installation, bundle assertion, Chromium installation,
and smoke execution:

```yaml
if: steps.scope.outputs.run_browser == 'true'
```

Use this exact sequence:

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

      - name: Upload test artifacts
        if: failure() && steps.scope.outputs.run_browser == 'true'
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: chromium-smoke-results
          path: |
            apps/web/test-results
            apps/web/playwright-report
          retention-days: 7
```

- [ ] **Step 6: Add the mutually exclusive manual lane**

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

Do not add `continue-on-error`, a matrix, or result aggregation.

- [ ] **Step 7: Exercise classifier fixtures in a temporary Git repository**

Create an executable copy of the finalized classifier body without committing it:

```bash
cat > /tmp/hpa-558-classify.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

case "$EVENT_NAME" in
  pull_request)
    if [[ -z "$PR_BASE_SHA" || -z "$PR_HEAD_SHA" ]]; then
      echo "run_browser=true" >> "$GITHUB_OUTPUT"
      exit 0
    fi
    range="${PR_BASE_SHA}...${PR_HEAD_SHA}"
    ;;
  push)
    if [[ -z "$PUSH_BEFORE_SHA" || "$PUSH_BEFORE_SHA" =~ ^0+$ ]]; then
      echo "run_browser=true" >> "$GITHUB_OUTPUT"
      exit 0
    fi
    range="${PUSH_BEFORE_SHA}..${CURRENT_SHA}"
    ;;
  *)
    echo "run_browser=true" >> "$GITHUB_OUTPUT"
    exit 0
    ;;
esac

if ! changed_files="$(git diff --name-only "$range" 2>/dev/null)"; then
  echo "run_browser=true" >> "$GITHUB_OUTPUT"
  exit 0
fi

if [[ -z "$changed_files" ]]; then
  echo "run_browser=true" >> "$GITHUB_OUTPUT"
elif grep -Ev '(^docs/|\.mdx?$)' <<< "$changed_files" >/dev/null; then
  echo "run_browser=true" >> "$GITHUB_OUTPUT"
else
  echo "run_browser=false" >> "$GITHUB_OUTPUT"
fi
EOF
chmod +x /tmp/hpa-558-classify.sh
```

Create fixture history:

```bash
fixture="$(mktemp -d)"
cd "$fixture"
git init -q
git config user.name hpa-558-test
git config user.email hpa-558@example.invalid

echo base > README.md
git add README.md
git commit -qm base
base_sha="$(git rev-parse HEAD)"

mkdir -p docs
echo docs > docs/guide.md
git add docs/guide.md
git commit -qm docs
docs_sha="$(git rev-parse HEAD)"

mkdir -p apps/web
echo '{}' > apps/web/package.json
git add apps/web/package.json
git commit -qm code
code_sha="$(git rev-parse HEAD)"
```

Run and assert all cases:

```bash
run_case() {
  local expected="$1"
  shift
  local output
  output="$(mktemp)"
  env GITHUB_OUTPUT="$output" \
    PR_BASE_SHA="" PR_HEAD_SHA="" PUSH_BEFORE_SHA="" CURRENT_SHA="" \
    "$@" /tmp/hpa-558-classify.sh
  grep -qx "run_browser=${expected}" "$output"
  rm "$output"
}

run_case false EVENT_NAME=pull_request PR_BASE_SHA="$base_sha" PR_HEAD_SHA="$docs_sha"
run_case true EVENT_NAME=pull_request PR_BASE_SHA="$docs_sha" PR_HEAD_SHA="$code_sha"
run_case true EVENT_NAME=pull_request PR_BASE_SHA="$docs_sha" PR_HEAD_SHA="$docs_sha"
run_case true EVENT_NAME=pull_request PR_BASE_SHA=deadbeef PR_HEAD_SHA="$docs_sha"
run_case true EVENT_NAME=push PUSH_BEFORE_SHA=0000000000000000000000000000000000000000 \
  CURRENT_SHA="$docs_sha"
run_case true EVENT_NAME=unexpected

cd -
rm -rf "$fixture" /tmp/hpa-558-classify.sh
```

Expected: every assertion exits zero. The bad range and empty range select browser validation
rather than failing the classifier.

- [ ] **Step 8: Format-check and inspect workflow structure**

```bash
bunx prettier --check .github/workflows/e2e-test.yml
git diff --check
git diff -- .github/workflows/e2e-test.yml

! rg -n "strategy:|matrix:|paths-ignore:|test:install-browsers:dry-run" \
  .github/workflows/e2e-test.yml

test "$(rg -c '^  [a-z0-9-]+:$' .github/workflows/e2e-test.yml)" -ge 2
```

Manually confirm:

- exactly the intended `chromium-smoke` and `manual-pre-release` jobs exist;
- each job has one `bun install` and one browser-install command;
- the classifier catches `git diff` failure;
- the summary step is unconditional;
- every action reference is pinned to a full SHA.

- [ ] **Step 9: Commit**

```bash
git add .github/workflows/e2e-test.yml
git commit -m "ci: reduce browser checks to one fast gate"
```

---

### Task 3: Update Every Active E2E Cadence Surface

**Files:**

- Modify: `apps/web/e2e/README.md`
- Modify: `CLAUDE.md`
- Modify: `docs/OPERATOR_RUNBOOK.md`
- Verify only: `AGENTS.md`

- [ ] **Step 1: Update the E2E README command table**

Document:

| Command | Role after HPA-558 |
| --- | --- |
| `test:e2e:assert-production-bundle` | First assertion in required code-change job. |
| `test:install-browsers:chromium` | Chromium-only install for required job. |
| `test:e2e:smoke` | Only required browser suite; desktop and mobile Chromium. |
| `test:install-browsers` | Chromium + WebKit install for local/manual broad validation. |
| `test:e2e:webkit` | Manual pre-release WebKit coverage. |
| `test:e2e:extended` | Manual pre-release five-project coverage. |
| `test:e2e:a11y` | Manual pre-release accessibility scans. |
| `test:e2e:stability` | Manual pre-release ten-repeat Chromium sweep. |

Remove the dry-run command and its parser section.

- [ ] **Step 2: Document the two workflow lanes and artifacts**

Use this model:

```text
Code pull request or push:
  Chromium smoke
  -> docs-only: successful no-op after scope summary
  -> code/unknown: production bundle assertion -> Chromium install -> smoke

Manual workflow dispatch before a planned release:
  WebKit critical -> extended -> accessibility -> stability
```

Document:

- `chromium-smoke-results` for required failures;
- `manual-pre-release-results` for manual failures;
- seven-day retention;
- the manual lane is sequential and fail-fast.

- [ ] **Step 3: Correct the canonical agent-facing cadence in `CLAUDE.md`**

Replace the stale labels:

- `test:e2e:smoke` — only required code-change browser gate;
- `test:e2e:webkit` — local/manual pre-release;
- `test:e2e:extended` — local/manual pre-release;
- `test:e2e:a11y` — local/manual pre-release;
- `test:e2e:stability` — local/manual pre-release;
- `test:e2e:assert-production-bundle` — runs before smoke in the same required job.

Add one sentence that documentation-only changes receive a successful no-op `Chromium smoke`
check after path classification.

Do not duplicate this section into `AGENTS.md`.

- [ ] **Step 4: Add the operator habit to the deploy section of the runbook**

In `docs/OPERATOR_RUNBOOK.md` under `## 1. Deploy Infrastructure`, add:

> **Planned release browser gate:** Before merging a release candidate to `main` or intentionally
> cutting a production release, dispatch `E2E Tests` → `Manual pre-release suites` on the
> candidate branch or commit and require it to pass. Ordinary development pushes do not run the
> WebKit, extended, accessibility, or stability lane automatically.

Do not wire this manual workflow into every deploy in this ticket.

- [ ] **Step 5: Search for every remaining active stale cadence statement**

```bash
rg -n "PR gate|main only|test:e2e:(webkit|extended|a11y|stability)|test:install-browsers:dry-run|assert-browser-install" \
  .github apps CLAUDE.md AGENTS.md docs/OPERATOR_RUNBOOK.md \
  --glob '!docs/superpowers/**'
```

Expected:

- command references remain where they are accurately described;
- no active file calls WebKit a PR gate or extended/a11y main-only;
- no active dry-run/parser reference remains;
- `AGENTS.md` contains no cadence table and remains a pointer.

- [ ] **Step 6: Format-check active docs**

```bash
bunx prettier --check apps/web/e2e/README.md CLAUDE.md docs/OPERATOR_RUNBOOK.md AGENTS.md
git diff --check
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/e2e/README.md CLAUDE.md docs/OPERATOR_RUNBOOK.md
git commit -m "docs: document required and pre-release E2E lanes"
```

---

### Task 4: Verify Local and Branch Workflow Behavior

**Files:** None unless verification exposes an error.

- [ ] **Step 1: Run static repository validation**

```bash
bunx prettier --check \
  .github/workflows/e2e-test.yml \
  apps/web/package.json \
  apps/web/e2e/README.md \
  CLAUDE.md \
  docs/OPERATOR_RUNBOOK.md

git diff --check

! rg -n "test:install-browsers:dry-run|assert-browser-install" \
  .github apps CLAUDE.md docs/OPERATOR_RUNBOOK.md \
  --glob '!docs/superpowers/**'
```

- [ ] **Step 2: Run the required lane locally**

```bash
bun install
bun run --cwd apps/web test:e2e:assert-production-bundle
bun run --cwd apps/web test:install-browsers:chromium
bun run --cwd apps/web test:e2e:smoke -- --retries=0
```

Expected: all commands pass against HPA-555's Worker-backed E2E server.

- [ ] **Step 3: Confirm broad commands still discover tests**

```bash
bun run --cwd apps/web test:e2e:webkit -- --list
bun run --cwd apps/web test:e2e:extended -- --list
bun run --cwd apps/web test:e2e:a11y -- --list
bun run --cwd apps/web test:e2e:stability -- --list
```

Expected: every command lists at least one test and resolves its intended projects/tags.

- [ ] **Step 4: Push the implementation branch and open a draft PR**

```bash
git push -u origin agent/hpa-558-fast-browser-gate
```

Open a draft PR targeting `main` with HPA-555 listed as the landed prerequisite.

- [ ] **Step 5: Verify automatic required workflow behavior**

On the code PR:

- confirm only `Chromium smoke` runs from this browser workflow;
- confirm bundle assertion precedes Chromium installation;
- confirm one dependency install and one Chromium install;
- push a no-op follow-up commit while the job runs and confirm the older run is canceled;
- inspect the job summary and confirm `Browser gate will run.` appears.

- [ ] **Step 6: Dispatch the manual lane on the branch**

From GitHub Actions, choose `E2E Tests`, select the implementation branch, and run the workflow.

Confirm:

- only `Manual pre-release suites` runs;
- dependencies install once;
- Chromium + WebKit install once;
- WebKit, extended, accessibility, and stability run sequentially;
- the pinned artifact action is used on failure;
- no automatic `main`-push broad job remains.

- [ ] **Step 7: Re-read the acceptance criteria before merge**

Verify each design acceptance row against the actual diff and workflow run. Do not merge if the
classifier, manual lane, active docs, or artifact pin differs from the plan.

---

### Task 5: Treat Branch Protection as an Immediate Post-Merge Hard Gate

**Files:** Repository settings plus temporary probe PRs.

This task begins immediately after the implementation PR merges. Do not mark HPA-558 complete and
do not open or merge normal follow-up PRs until Steps 1-4 are complete.

- [ ] **Step 1: Update required checks immediately after merge**

In GitHub repository settings, edit the active `main` ruleset or branch protection rule:

- require `Chromium smoke`;
- remove `Production bundle safety` if present;
- remove `WebKit critical` if present;
- ensure `Manual pre-release suites` is not required.

Save the rule before opening the documentation-only probe.

- [ ] **Step 2: Open a documentation-only probe PR**

Create a temporary branch changing only a Markdown file, for example adding and then later
removing a harmless sentence in `docs/`.

Confirm:

- `Chromium smoke` reaches success;
- job summary says Bun and Playwright were skipped;
- Setup Bun, dependency install, browser install, and smoke steps are skipped;
- the PR is mergeable with the required check satisfied.

Close the probe without merging or revert the harmless documentation change afterward.

- [ ] **Step 3: Confirm a code PR remains protected**

Use the next real code PR or a temporary non-doc change. Confirm `Chromium smoke` executes the
bundle assertion and desktop/mobile smoke, and that a failing check blocks merging.

- [ ] **Step 4: Record the manual pre-release habit**

Read the merged runbook entry and perform one successful manual dispatch on the release candidate
or current `main` before the next planned production release.

- [ ] **Step 5: Mark HPA-558 complete**

Only after branch protection, docs-only no-op, code-path enforcement, cancellation, and manual-lane
checks are proven should the Linear issue move to Done.

## Completion Evidence

The implementation handoff must include:

- implementation PR URL and merge commit;
- required code-path workflow run;
- canceled superseded run;
- manual pre-release workflow run;
- documentation-only probe run;
- final required-check names;
- local production-bundle and Chromium smoke command results;
- confirmation that active docs no longer teach the old cadence.
