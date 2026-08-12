# HPA-224 Truthful Completion Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hard-coded `S RANK` with a truthful completion summary using existing `PuzzleSession` result, timing, counter, rotation, and standard-personal-best facts.

**Architecture:** Keep `PuzzleSession` as the only canonical run-state owner and keep completion effects/local statistics in the puzzle route. Evolve the existing `PuzzleCompletionDialog` into a result-class-driven presentational component; the route passes immutable sealed result/time plus completed session counters/facts directly, with no new view model, store, persistence field, or API contract.

**Tech Stack:** Svelte 5 runes, TypeScript, Vitest Browser Mode with Playwright, existing `PuzzleSession` domain and local-stats service.

## Global Constraints

- Remove `S RANK`; do not replace it with another rank, score, grade, or achievement formula.
- `standard_timed` is the only personal-best category.
- `rotation_timed` and `assisted_timed` show final time but never standard-best comparison.
- `relaxed` shows no competitive final time or personal-best comparison.
- Reuse `PuzzleSessionState` / `SealedCompletion`; do not change their schemas or add a completion view model/store/controller.
- Do not change API, D1, completion-request, local-stats, analytics, gallery, or profile contracts.
- Keep completion-effect once-per-run behavior, retry UI, modal focus/Escape, Play Again, and Back to Arcade unchanged.
- Use focused tests for changed behavior; do not add a new test harness or broad browser matrix.

---

### Task 1: Make `PuzzleCompletionDialog` render factual result context

**Files:**
- Modify: `apps/web/src/lib/components/PuzzleCompletionDialog.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts`

**Interfaces:**
- Consumes: `ResultClass` from `@perseus/types`, existing `formatTime`, existing `modalFocus`, and current completion callbacks.
- Produces:

```ts
interface Props {
  puzzleName: string;
  resultClass: ResultClass;
  elapsedSeconds: number | null;
  pieceCount: number;
  hintsUsed: number;
  incorrectAttempts: number;
  rotationEnabled: boolean;
  rotationUsed: boolean;
  bestTime: number | null;
  isNewBest: boolean;
  localStatsFailed: boolean;
  serverSubmissionRetryable: boolean;
  onRetryServerSubmission: () => void;
  onPlayAgain: () => void;
  onBackToArcade: () => void;
  onDismiss: () => void;
}
```

- [ ] **Step 1: Rewrite the component fixture and add failing result-matrix tests**

Replace `timedProps()` with:

```ts
function standardTimedProps() {
  return {
    puzzleName: 'Test Mission',
    resultClass: 'standard_timed' as const,
    elapsedSeconds: 75,
    pieceCount: 12,
    hintsUsed: 0,
    incorrectAttempts: 1,
    rotationEnabled: false,
    rotationUsed: false,
    bestTime: 68,
    isNewBest: false,
    localStatsFailed: false,
    serverSubmissionRetryable: true,
    onRetryServerSubmission: vi.fn(),
    onPlayAgain: vi.fn(),
    onBackToArcade: vi.fn(),
    onDismiss: vi.fn()
  };
}
```

Add/replace tests with these exact cases:

```ts
it('shows a truthful standard timed summary without a rank', async () => {
  render(PuzzleCompletionDialog, standardTimedProps());

  expect(page.getByText('S RANK').query()).toBeNull();
  await expect.element(page.getByTestId('completion-result-label')).toHaveTextContent('STANDARD TIMED');
  await expect.element(page.getByText('FINAL TIME')).toBeVisible();
  await expect.element(page.getByText('01:15')).toBeVisible();
  await expect.element(page.getByText('PERSONAL BEST')).toBeVisible();
  await expect.element(page.getByText('01:08')).toBeVisible();
  expect(page.getByText('NEW RECORD').query()).toBeNull();
  await expect.element(page.getByTestId('completion-piece-count')).toHaveTextContent('12');
  await expect.element(page.getByTestId('completion-hints-used')).toHaveTextContent('0');
  await expect.element(page.getByTestId('completion-incorrect-attempts')).toHaveTextContent('1');
  await expect.element(page.getByTestId('completion-rotation')).toHaveTextContent('OFF · NOT USED');
});

it('shows a standard timed new-best verdict', async () => {
  render(PuzzleCompletionDialog, {
    ...standardTimedProps(),
    bestTime: 75,
    isNewBest: true
  });

  await expect.element(page.getByText('NEW RECORD')).toBeVisible();
});

it('shows UNSAVED instead of NEW RECORD when a new-best write fails', async () => {
  render(PuzzleCompletionDialog, {
    ...standardTimedProps(),
    bestTime: 75,
    isNewBest: true,
    localStatsFailed: true
  });

  await expect.element(page.getByTestId('new-best-unsaved')).toBeVisible();
  expect(page.getByText('NEW RECORD').query()).toBeNull();
});

it('shows rotation timed without a personal-best comparison', async () => {
  render(PuzzleCompletionDialog, {
    ...standardTimedProps(),
    resultClass: 'rotation_timed',
    rotationEnabled: true,
    rotationUsed: true
  });

  await expect.element(page.getByTestId('completion-result-label')).toHaveTextContent('ROTATION TIMED');
  await expect.element(page.getByText('FINAL TIME')).toBeVisible();
  expect(page.getByText('PERSONAL BEST').query()).toBeNull();
  await expect.element(page.getByTestId('completion-rotation')).toHaveTextContent('ON · USED');
});

it('shows assisted timed counters without a personal-best comparison', async () => {
  render(PuzzleCompletionDialog, {
    ...standardTimedProps(),
    resultClass: 'assisted_timed',
    hintsUsed: 2,
    incorrectAttempts: 3
  });

  await expect.element(page.getByTestId('completion-result-label')).toHaveTextContent('ASSISTED TIMED');
  await expect.element(page.getByTestId('completion-hints-used')).toHaveTextContent('2');
  await expect.element(page.getByTestId('completion-incorrect-attempts')).toHaveTextContent('3');
  expect(page.getByText('PERSONAL BEST').query()).toBeNull();
});

it('shows Relaxed as a noncompetitive completion', async () => {
  render(PuzzleCompletionDialog, {
    ...standardTimedProps(),
    resultClass: 'relaxed',
    elapsedSeconds: null
  });

  await expect.element(page.getByTestId('completion-result-label')).toHaveTextContent('RELAXED');
  expect(page.getByText('FINAL TIME').query()).toBeNull();
  expect(page.getByText('PERSONAL BEST').query()).toBeNull();
  await expect.element(page.getByTestId('completion-piece-count')).toHaveTextContent('12');
});
```

Retain the existing focus, Escape, retry, Play Again, and Back to Arcade callback assertions in the component suite.

- [ ] **Step 2: Run the focused component test and verify it fails for the old contract**

From `apps/web`:

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts
```

Expected: FAIL because the component still requires `timed`, renders `S RANK`, and lacks result/context fields.

- [ ] **Step 3: Replace `timed` with the result-oriented props and derived display values**

Add the existing shared type and mappings:

```ts
import type { ResultClass } from '@perseus/types';

const RESULT_LABELS: Record<ResultClass, string> = {
  standard_timed: 'STANDARD TIMED',
  rotation_timed: 'ROTATION TIMED',
  assisted_timed: 'ASSISTED TIMED',
  relaxed: 'RELAXED'
};
```

Use the interface above, destructure every prop, then derive only display facts:

```ts
const resultLabel = $derived(RESULT_LABELS[resultClass]);
const timedResult = $derived(resultClass !== 'relaxed');
const standardTimedResult = $derived(resultClass === 'standard_timed');
const displayedBestTime = $derived(bestTime ?? (isNewBest ? elapsedSeconds : null));
const rotationSummary = $derived(
  `${rotationEnabled ? 'ON' : 'OFF'} · ${rotationUsed ? 'USED' : 'NOT USED'}`
);
```

Do not derive `resultClass` from hints or rotation in this component.

- [ ] **Step 4: Replace the rank markup with factual result, timing, best, and context markup**

Replace the giant rank with:

```svelte
<div class="modal-tag">// MISSION COMPLETE</div>
<div class="modal-result" data-testid="completion-result-label">{resultLabel}</div>
<h2 id="modal-title" class="modal-title">{puzzleName.toUpperCase()}</h2>
```

Render timing and personal best with result-class gates:

```svelte
<div class="modal-stats">
  {#if timedResult && elapsedSeconds !== null}
    <div class="modal-stat">
      <span class="mstat-label">FINAL TIME</span>
      <span class="mstat-value">{formatTime(elapsedSeconds)}</span>
    </div>
  {/if}

  {#if standardTimedResult && displayedBestTime !== null}
    <div class="modal-stat">
      <span class="mstat-label">PERSONAL BEST</span>
      <span class="mstat-value" class:gold={isNewBest}>{formatTime(displayedBestTime)}</span>
      {#if isNewBest}
        {#if localStatsFailed}
          <span class="new-record-badge unsaved" data-testid="new-best-unsaved">UNSAVED</span>
        {:else}
          <span class="new-record-badge">NEW RECORD</span>
        {/if}
      {/if}
    </div>
  {/if}
</div>
```

Add the factual run summary:

```svelte
<div class="completion-summary" data-testid="completion-run-summary">
  <div class="summary-item" data-testid="completion-piece-count">
    <span class="mstat-label">PIECES</span>
    <span class="summary-value">{pieceCount}</span>
  </div>
  <div class="summary-item" data-testid="completion-hints-used">
    <span class="mstat-label">HINTS USED</span>
    <span class="summary-value">{hintsUsed}</span>
  </div>
  <div class="summary-item" data-testid="completion-incorrect-attempts">
    <span class="mstat-label">INCORRECT ATTEMPTS</span>
    <span class="summary-value">{incorrectAttempts}</span>
  </div>
  <div class="summary-item" data-testid="completion-rotation">
    <span class="mstat-label">ROTATION</span>
    <span class="summary-value">{rotationSummary}</span>
  </div>
</div>
```

Delete `.modal-rank` CSS and remove it from the reduced-motion selector. Add only local styles for `.modal-result`, `.completion-summary`, `.summary-item`, and `.summary-value`, using existing font/color variables; keep the result label visually smaller than the former rank.

- [ ] **Step 5: Run component test and formatting check**

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts
bunx prettier --check src/lib/components/PuzzleCompletionDialog.svelte src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add apps/web/src/lib/components/PuzzleCompletionDialog.svelte \
  apps/web/src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts
git commit -m "feat(web): show truthful completion summary"
```

---

### Task 2: Wire completed `PuzzleSession` facts through the puzzle route

**Files:**
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**
- Consumes: Task 1 props plus `sessionState.sealedCompletion`, `sessionState.resultClass`, `sessionState.pieceCount`, `sessionState.counters`, `sessionState.rotationEnabled`, and `sessionState.facts.rotationUsed`.
- Produces: no new reusable interface or route-local summary state.

- [ ] **Step 1: Add a failing route integration test for real assisted-run facts**

Use the route test's existing helpers:

```ts
it('shows assisted completion facts from PuzzleSession state', async () => {
  await renderPuzzlePage();

  await selectPiece(1);
  await page.getByLabelText('Hint').click();

  await selectPiece(0);
  await placeSelectedPieceAt(1, 0); // wrong slot; increments incorrectAttempts
  await placePiece(0, 0, 0);
  await placePiece(1, 1, 0);

  await expect.element(page.getByTestId('celebration-modal')).toBeVisible();
  await expect.element(page.getByTestId('completion-result-label')).toHaveTextContent('ASSISTED TIMED');
  await expect.element(page.getByTestId('completion-hints-used')).toHaveTextContent('1');
  await expect.element(page.getByTestId('completion-incorrect-attempts')).toHaveTextContent('1');
  expect(page.getByText('PERSONAL BEST').query()).toBeNull();
  expect(recordLocalCompletion).toHaveBeenCalledTimes(1);
  expect(recordCompletion).toHaveBeenCalledTimes(1);
});
```

Strengthen the existing standard-new-best test:

```ts
await expect.element(page.getByTestId('completion-result-label')).toHaveTextContent('STANDARD TIMED');
await expect.element(page.getByText('NEW RECORD')).toBeVisible();
```

Strengthen the existing Relaxed completion test:

```ts
await expect.element(page.getByTestId('completion-result-label')).toHaveTextContent('RELAXED');
expect(page.getByText('FINAL TIME').query()).toBeNull();
expect(page.getByText('PERSONAL BEST').query()).toBeNull();
await expect.element(page.getByTestId('completion-piece-count')).toHaveTextContent('2');
```

Keep the existing retry and once-per-run effect tests unchanged.

- [ ] **Step 2: Run the route test and verify the new dialog contract fails**

From `apps/web`:

```bash
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: FAIL because the route still passes `timed` and does not pass completion facts.

- [ ] **Step 3: Pass sealed result/time and completed session facts directly to the dialog**

Replace the current dialog invocation with:

```svelte
<PuzzleCompletionDialog
  puzzleName={puzzle?.name ?? ''}
  resultClass={sessionState?.sealedCompletion?.resultClass ??
    sessionState?.resultClass ??
    'standard_timed'}
  elapsedSeconds={sessionState?.sealedCompletion?.elapsedActiveSeconds ??
    sessionState?.elapsedActiveSeconds ??
    null}
  pieceCount={sessionState?.pieceCount ?? puzzle?.pieceCount ?? 0}
  hintsUsed={sessionState?.counters.hintsUsed ?? 0}
  incorrectAttempts={sessionState?.counters.incorrectAttempts ?? 0}
  rotationEnabled={sessionState?.rotationEnabled ?? false}
  rotationUsed={sessionState?.facts.rotationUsed ?? false}
  {bestTime}
  {isNewBest}
  {localStatsFailed}
  {serverSubmissionRetryable}
  onRetryServerSubmission={handleRetryServerSubmission}
  onPlayAgain={handlePlayAgain}
  onBackToArcade={requestReturnToArcade}
  onDismiss={() => (showCelebration = false)}
/>
```

Do not add `completionSummary`, duplicate counters, or result-class derivation to the route. Do not modify `SealedCompletion`, `recordLocalCompletion`, `handleSessionEvent`, or server-submission logic.

- [ ] **Step 4: Run both focused browser test files**

```bash
bunx vitest --run --browser \
  src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: PASS.

- [ ] **Step 5: Run the web package gates**

From the repository root:

```bash
bun run check --filter=@perseus/web
bun run test:unit --filter=@perseus/web
bun run lint --filter=@perseus/web
bun run build --filter=@perseus/web
```

Expected: PASS. HPA-563 removed the former 95% coverage threshold, but the unit command still emits coverage reports.

- [ ] **Step 6: Run the stale-copy and scope fences**

```bash
rg -n "S RANK|modal-rank" apps/web/src
git diff --check main...HEAD
git diff --name-only main...HEAD
```

Expected:

- `rg` finds no live `S RANK` / `.modal-rank` source or test references;
- `git diff --check` passes;
- implementation files are limited to the four planned web files, plus the two HPA-224 planning documents already on the branch.

- [ ] **Step 7: Commit Task 2**

```bash
git add 'apps/web/src/routes/puzzle/[id]/+page.svelte' \
  'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "feat(web): wire completion result facts"
```

---

## Final Verification

After both implementation commits, rerun the cheap final-tree gate:

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
cd ../..
bun run check --filter=@perseus/web
bun run lint --filter=@perseus/web
bun run build --filter=@perseus/web
git diff --check main...HEAD
```

No new Playwright E2E spec is required for HPA-224. The route browser tests already exercise real `PuzzleSession` transitions and fence completion once-per-run behavior, Escape, Play Again, retry, new-best, and Relaxed behavior; broader browser matrices remain pre-release coverage under HPA-215.