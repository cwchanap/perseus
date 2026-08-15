# HPA-222 Persistent Reference Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve Hold-to-Peek, add one persistent Reference toggle, and make `PuzzleSession.activeReferenceMode` the canonical presentation state without adding a store, persistence field, assistance framework, or image-failure subsystem.

**Architecture:** `PuzzleSession` clears reference mode whenever gameplay leaves `active`. The route derives overlay/pressed state from the session snapshot and keeps only DOM Hold bookkeeping. Persistent `REF` remains a compact primary action; `PEEK` moves into the existing `MORE` container below 1024 px so the mobile primary action count does not grow. Missing URLs disable reference controls; transient image failures keep using `ReferenceOverlay`'s existing retryable unavailable message.

**Tech Stack:** Svelte 5, TypeScript, Vitest Browser Mode, existing Playwright Chromium smoke, Bun.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-15-hpa-222-reference-toggle-design.md`.
- Preserve the explicit HPA-222 Hold-to-Peek requirement.
- Keep `ReferenceMode = 'hold' | 'toggle' | 'ghost'`; no new mode.
- No persisted reference mode, schema/version change, analytics, preference, dependency, controller, command registry, assistance menu, preload service, or asset-health state.
- Keep Peek-down and inactive -> Toggle checkpointing so `referenceActivations` / `hasUserActivity` are persisted.
- Task 2 is atomic: toolbar props/names, direct callers, route, tests, and the existing mobile smoke change together so no committed intermediate state knowingly fails `bun run check`.

---

## Task 1: Put lifecycle cleanup in `PuzzleSession`

**Files:**
- Modify: `apps/web/src/lib/services/gameplay/session/session.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/session.test.ts`

**Produces:** every lifecycle entered through `transitionToInternal()` with `to !== 'active'` has `activeReferenceMode === null`. Restart remains covered by `freshState()`.

- [ ] **Step 1: Reuse existing reference-mode tests**

Do not add another scoring/counter test. The current `PuzzleSession reference modes` block already covers Hold informational scoring, Toggle counting, Hold -> Toggle no-double-count, and Ghost assisted scoring.

- [ ] **Step 2: Add failing lifecycle tests**

```ts
it('clears active reference mode when pausing', () => {
	const session = createPuzzleSession(makeOptions());
	session.dispatch({ type: 'start' });
	session.dispatch({ type: 'set_reference_mode', mode: 'toggle' });
	session.dispatch({ type: 'pause' });
	expect(session.getState().activeReferenceMode).toBeNull();
});

it('clears active reference mode when the board completes', () => {
	const session = createPuzzleSession(makeOptions({ metadata: makeMetadata(2) }));
	session.dispatch({ type: 'start' });
	session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });
	session.dispatch({ type: 'set_reference_mode', mode: 'toggle' });
	session.dispatch({ type: 'attempt_placement', pieceId: 1, x: 1, y: 0 });
	expect(session.getState().lifecycle).toBe('completed');
	expect(session.getState().activeReferenceMode).toBeNull();
});

it('clears active reference mode when redo restores completed lifecycle', () => {
	const session = createPuzzleSession(makeOptions({ metadata: makeMetadata(2) }));
	session.dispatch({ type: 'start' });
	session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });
	session.dispatch({ type: 'attempt_placement', pieceId: 1, x: 1, y: 0 });
	session.dispatch({ type: 'undo' });
	session.dispatch({ type: 'set_reference_mode', mode: 'toggle' });
	session.dispatch({ type: 'redo' });
	expect(session.getState().lifecycle).toBe('completed');
	expect(session.getState().activeReferenceMode).toBeNull();
});
```

- [ ] **Step 3: Run the focused test and verify red**

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/session.test.ts
```

Expected: the new cleanup assertions fail.

- [ ] **Step 4: Implement the one-line invariant**

```ts
function transitionToInternal(to: SessionLifecycle) {
	const from = state.lifecycle;
	if (to !== 'active') state.activeReferenceMode = null;
	state.lifecycle = to;
	emit({ type: 'lifecycle', from, to });
}
```

Do not put this only in `handleBoardCompletion()`; redo bypasses that helper. `doRestart()` already replaces state with `freshState()`.

- [ ] **Step 5: Verify green and check types**

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/session.test.ts
bun run check
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/services/gameplay/session/session.ts apps/web/src/lib/services/gameplay/session/session.test.ts
git commit -m "fix(web): clear reference mode outside active gameplay"
```

---

## Task 2: Ship Peek + persistent Reference atomically

**Files:**
- Modify: `apps/web/src/lib/components/PuzzleToolbar.svelte`
- Modify: `apps/web/src/lib/components/PuzzleBoardPanel.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`
- Modify: `apps/web/e2e/gameplay-mobile-tap.spec.ts`

**New toolbar props:**
```ts
onReferenceToggle: () => void;
referenceToggled: boolean;
referenceAvailable: boolean;
```

**New board-panel props:**
```ts
referenceToggled: boolean;
onReferenceToggle: () => void;
```

- [ ] **Step 1: Change the existing mobile smoke first**

Replace the old single `Reference` locator with:

```ts
const toggleReference = page.getByRole('button', { name: 'Toggle reference' });
const peekReference = page.getByRole('button', { name: 'Hold to peek reference' });
```

Desktop: both visible and `MORE` hidden. Compact: Toggle visible, Peek hidden before `MORE`, Peek visible after `MORE` opens. Loop the existing >=44 px check across Undo, Redo, Hint, Toggle Reference, and MORE.

Keep existing toolbar-width, overflow, secondary-panel, inventory fold-fit, and inventory density assertions. Do not add a single-row/fixed-height assertion because the E2E harness stubs Google Fonts and does not reproduce production Orbitron metrics.

Run before production edits and expect red:

```bash
cd apps/web
bunx playwright test e2e/gameplay-mobile-tap.spec.ts --project=chromium-desktop --project=chromium-mobile --grep "puzzle toolbar is direct on desktop and compact on phone"
```

- [ ] **Step 2: Update toolbar contract/tests**

Add test defaults for `onReferenceToggle`, `referenceToggled`, and `referenceAvailable`. Rename Hold queries to `Hold to peek reference`. Add callback, `aria-pressed`, Peek-disabled-while-toggled, missing-URL disabled, no-reference absence, and shared `aria-describedby="assistance-scoring-help"` tests.

Persistent REF stays primary. Move the existing Hold button into `#puzzle-toolbar-secondary`, rename it `PEEK`, and disable it when `!referenceAvailable || referenceToggled`.

Add one sr-only description:

```svelte
<span id="assistance-scoring-help" class="sr-only">
	Hint affects timed results. Peek and Reference do not.
</span>
```

- [ ] **Step 3: Update board panel without image-failure state**

Add `referenceToggled` / `onReferenceToggle` and derive:

```ts
const referenceAvailable = $derived(
	puzzle.hasReference === true && referenceImageUrl !== null
);
```

Pass these to the toolbar. Keep `ReferenceOverlay` unchanged: no `onUnavailable`, `referenceLoadFailed`, or keyed effect. Add panel coverage that a declared reference with null URL disables REF and Peek.

- [ ] **Step 4: Make the route consume session state directly**

Delete `showReferenceOverlay` and derive:

```ts
const activeReferenceMode = $derived(sessionState?.activeReferenceMode ?? null);
const referenceActive = $derived(activeReferenceMode !== null);
const referenceToggled = $derived(activeReferenceMode === 'toggle');
```

Keep one Hold-only helper:

```ts
function clearReferenceHold(): void {
	const shouldClearMode = sessionState?.activeReferenceMode === 'hold';
	referencePointerId = null;
	referenceHoldSource = null;
	if (shouldClearMode) sessionStore?.dispatch({ type: 'set_reference_mode', mode: null });
}
```

Hold-down still checkpoints. Release validates pointer source/id and delegates to the helper. Global matching pointer-up delegates to release. Window blur calls `clearReferenceHold()` so Toggle survives.

Add Toggle with the explicit Hold -> Toggle path:

```ts
function handleReferenceToggle(): void {
	if (!sessionStore || sessionState?.lifecycle !== 'active') return;
	const wasInactive = sessionState.activeReferenceMode === null;
	const nextMode = sessionState.activeReferenceMode === 'toggle' ? null : 'toggle';
	referencePointerId = null;
	referenceHoldSource = null;
	sessionStore.dispatch({ type: 'set_reference_mode', mode: nextMode });
	if (wasInactive && nextMode === 'toggle') checkpointSession();
}
```

Remove reference-mode work from `clearTransientGameplayState()`. Reset only Hold bookkeeping during route reuse. Extend Mission Setup help with `Hint affects timed results; Peek and Reference do not.`

- [ ] **Step 5: Update route tests**

Rename old Hold queries. Add persistent Toggle, Toggle-survives-blur, Hold -> Toggle stale-release, pause cleanup, and navigation reset coverage. Do not add image-error integration because overlay behavior is unchanged.

- [ ] **Step 6: Run affected tests and check before commit**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts \
  src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
bun run check
```

Fix any old `Reference` query or missing required prop in this task; do not commit a knowingly broken intermediate state.

- [ ] **Step 7: Run rendered mobile verification immediately**

```bash
cd apps/web
bunx playwright test e2e/gameplay-mobile-tap.spec.ts --project=chromium-desktop --project=chromium-mobile --grep "puzzle toolbar is direct on desktop and compact on phone"
bunx playwright test e2e/gameplay-mobile-tap.spec.ts --project=chromium-mobile
```

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/components/PuzzleToolbar.svelte \
  apps/web/src/lib/components/PuzzleBoardPanel.svelte \
  'apps/web/src/routes/puzzle/[id]/+page.svelte' \
  apps/web/src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts \
  apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts \
  'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts' \
  apps/web/e2e/gameplay-mobile-tap.spec.ts
git commit -m "feat(web): add persistent puzzle reference toggle"
```

---

## Task 3: Full verification

- [ ] **Step 1: Run affected tests**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/services/gameplay/session/session.test.ts \
  src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts \
  src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
```

- [ ] **Step 2: Run full suite/checks**

```bash
cd apps/web
bun run test:unit
bunx playwright test e2e/gameplay-mobile-tap.spec.ts --project=chromium-mobile
bun run check
bun run lint
```

- [ ] **Step 3: Scope review**

Production changes stay in `session.ts`, `PuzzleToolbar.svelte`, `PuzzleBoardPanel.svelte`, and the puzzle route. Tests stay in their existing files plus `gameplay-mobile-tap.spec.ts`.

Confirm unchanged: `ReferenceOverlay.svelte`, persisted schema/version, API/shared types, preferences, analytics, dependencies, Playwright projects/fixtures/font stubbing, HPA-223 work.

- [ ] **Step 4: Behavior review**

```text
Hold -> checkpoint -> release/blur ends Hold
null -> Toggle -> checkpoint -> persists until toggled/off or lifecycle leaves active
Hold -> Toggle -> no double-count; stale Hold release cannot close Toggle
pause/completion/redo/dispose -> engine clears reference
restart -> freshState starts null
compact primary -> Undo / Redo / Hint / REF / MORE
compact Peek -> behind MORE; desktop Peek -> inline
missing URL -> disabled controls
image load error -> existing unavailable message; later activation can retry
```

- [ ] **Step 5: Commit only if verification required a fix**

Use a specific regression-fix message; otherwise do not create an empty commit.

## Review-resolution notes

The latest review was right that the prior plan overpaid for image failure, split lifecycle ownership between route and engine, and left a known broken intermediate toolbar contract. The revised plan removes the image subsystem, puts all non-active cleanup in the engine, keeps toolbar/callers atomic, moves rendered mobile verification into the feature task, and documents Hold -> Toggle explicitly. Peek remains because deleting it would violate current HPA-222 acceptance; on compact layouts it moves behind `MORE` instead of becoming a sixth permanent primary action. A single-row/fixed-height smoke assertion is intentionally not added because production already differs from the font-stubbed harness; the structural primary-action-count rule plus existing fold/overflow assertions are the truthful guard.
