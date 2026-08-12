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
- Produces: the revised `PuzzleCompletionDialog` props used by Task 2:

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

- [ ] **Step 1: Rewrite the component fixture around result classes and add failing presentation-matrix tests**

Replace `timedProps()` with one standard-timed base fixture and add explicit factual fields:

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

Replace the current S-rank assertions with a standard-timed summary test:

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
```

Add nonstandard result coverage:

```ts
it('shows rotation timed result without a personal-best comparison', async () => {
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

it('shows assisted result and assistance counters without a personal-best comparison', async () => {
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
    elapsedSeconds: null,
    bestTime: 68
  });

  await expect.element(page.getByTestId('completion-result-label')).toHaveTextContent('RELAXED');
  expect(page.getByText('FINAL TIME').query()).toBeNull();
  expect(page.getByText('PERSONAL BEST').query()).toBeNull();
  await expect.element(page.getByTestId('completion-piece-count')).toHaveTextContent('12');
});
```

Retain/update the existing new-best, unsaved, focus/Escape, retry, Play Again, and Back to Arcade tests. New-best tests should use `resultClass: 'standard_timed'`; do not infer `NEW RECORD` from time equality.

- [ ] **Step 2: Run the focused component test and verify the new contract fails**

Run from `apps/web`:

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts
```

Expected: FAIL because the component still requires `timed`, renders `S RANK`, and does not render result/context fields.

- [ ] **Step 3: Replace the `timed` presentation contract with `ResultClass` and factual derived values**

In `PuzzleCompletionDialog.svelte`, import the existing shared result type and replace the prop interface/destructuring:

```ts
import type { ResultClass } from '@perseus/types';

const RESULT_LABELS: Record<ResultClass, string> = {
  standard_timed: 'STANDARD TIMED',
  rotation_timed: 'ROTATION TIMED',
  assisted_timed: 'ASSISTED TIMED',
  relaxed: 'RELAXED'
};

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

let {
  puzzleName,
  resultClass,
  elapsedSeconds,
  pieceCount,
  hintsUsed,
  incorrectAttempts,
  rotationEnabled,
  rotationUsed,
  bestTime,
  isNewBest,
  localStatsFailed,
  serverSubmissionRetryable,
  onRetryServerSubmission,
  onPlayAgain,
  onBackToArcade,
  onDismiss
}: Props = $props();

const resultLabel = $derived(RESULT_LABELS[resultClass]);
const timedResult = $derived(resultClass !== 'relaxed');
const standardTimedResult = $derived(resultClass === 'standard_timed');
const displayedBestTime = $derived(bestTime ?? (isNewBest ? elapsedSeconds : null));
const rotationSummary = $derived(
  `${rotationEnabled ? 'ON' : 'OFF'} · ${rotationUsed ? 'USED' : 'NOT USED'}`
);
```

- [ ] **Step 4: Replace S-rank markup with the result label and compact run summary**

Delete `.modal-rank` markup/CSS and its reduced-motion reference. Render the result label as metadata:

```svelte
<div class="modal-tag">// MISSION COMPLETE</div>
<div class="modal-result" data-testid="completion-result-label">{resultLabel}</div>
<h2 id="modal-title" class="modal-title">{puzzleName.toUpperCase()}</h2>
```

Gate competitive timing strictly by result class:

```svelte
{#if timedResult && elapsedSeconds !== null}
  <div class="modal-stat">
    <span class="mstat-label">FINAL TIME</span>
    <span class="mstat-value">{formatTime(elapsedSeconds)}</span>
  </div>
{/if}

{#if standardTimedResult && displayedBestTime !== null}
  <div class: new-best={isNewBest} class="modal-stat">
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
```

Use a compact factual grid/list below timing:

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

Style `.modal-result`, `.completion-summary`, `.summary-item`, and `.summary-value` with the existing display/mono variables. Keep the visual hierarchy below the puzzle name/final time; do not recreate the giant `.modal-rank` treatment.

- [ ] **Step 5: Run the component test and formatting check**

```bash
bunx vitest --run --browser src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts
bunx prettier --check src/lib/components/PuzzleCompletionDialog.svelte src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts
```

Expected: both commands PASS.

- [ ] **Step 6: Commit the presentational slice**

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
- Consumes: the Task 1 dialog interface; `sessionState.sealedCompletion`, `sessionState.resultClass`, `sessionState.pieceCount`, `sessionState.counters`, `sessionState.rotationEnabled`, and `sessionState.facts.rotationUsed`.
- Produces: no new reusable interface. The route continues to own completion-effect orchestration and passes scalar presentation facts into the dialog.

- [ ] **Step 1: Add a failing assisted-completion route test that proves real session facts reach the dialog**

Use the existing `renderPuzzlePage`, `selectPiece`, `placeSelectedPieceAt`, and `placePiece` helpers. A hint makes the result assisted; a wrong-slot attempt increments the existing counter:

```ts
it('shows assisted completion facts from PuzzleSession state', async () => {
  await renderPuzzlePage();

  await selectPiece(1);
  await page.getByLabelText('Hint').click();

  await selectPiece(0);
  await placeSelectedPieceAt(1, 0); // wrong slot: counted rejection
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

Strengthen the existing standard-new-best test with:

```ts
await expect.element(page.getByTestId('completion-result-label')).toHaveTextContent('STANDARD TIMED');
await expect.element(page.getByText('NEW RECORD')).toBeVisible();
```

Strengthen the existing Relaxed completion test with:

```ts
await expect.element(page.getByTestId('completion-result-label')).toHaveTextContent('RELAXED');
expect(page.getByText('FINAL TIME').query()).toBeNull();
expect(page.getByText('PERSONAL BEST').query()).toBeNull();
await expect.element(page.getByTestId('completion-piece-count')).toHaveTextContent('2');
```

Do not replace the existing retry or once-per-run regression tests; they remain the behavior fence for completion effects.

- [ ] **Step 2: Run the focused route test and verify the dialog-wiring contract fails**

Run from `apps/web`:

```bash
bunx vitest --run --browser 'src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: FAIL because `+page.svelte` still passes `timed` and does not provide the Task 1 result/context props.

- [ ] **Step 3: Wire the existing sealed result/time and completed state facts directly into the dialog**

Replace the current `timed={showTimedPresentation}` dialog call with:

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

Do not introduce route-local copies such as `completionCounters`, `completionResultClass`, or a `CompletionSummary` object. Do not modify `handleSessionEvent`, `handleLocalStatsEffect`, `handleServerSubmissionEffect`, `restartWithCurrentChoices`, or the completion seal.

- [ ] **Step 4: Run both focused test files**

```bash
bunx vitest --run --browser \
  src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: PASS.

- [ ] **Step 5: Run static checks and the web unit suite**

From the repository root:

```bash
bun run check --filter=@perseus/web
bun run test:unit --filter=@perseus/web
bun run lint --filter=@perseus/web
bun run build --filter=@perseus/web
```

Expected: all commands PASS. The unit command retains coverage reporting but has no 95% threshold gate after HPA-563.

- [ ] **Step 6: Verify the scope and stale-copy fence**

```bash
rg -n "S RANK|modal-rank" apps/web/src

git diff --check main...HEAD
git diff --name-only main...HEAD
```

Expected:

- `rg` returns no live web-source/test matches for `S RANK` or `modal-rank`;
- whitespace check passes;
- implementation changes are limited to the four planned web files plus the two planning documents already on the branch.

- [ ] **Step 7: Commit the route integration**

```bash
git add 'apps/web/src/routes/puzzle/[id]/+page.svelte' \
  'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "feat(web): wire completion result facts"
```

---

## Final verification

After both tasks are committed, rerun the cheap behavior and static gates on the final tree:

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

No new E2E test is required for HPA-224: the existing route browser test exercises real `PuzzleSession` transitions and already fences Play Again, Escape, retry, and once-per-run completion effects. Broader Playwright matrices remain pre-release coverage under HPA-215's delivery principles.