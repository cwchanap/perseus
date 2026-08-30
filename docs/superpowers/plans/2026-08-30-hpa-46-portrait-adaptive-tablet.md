# HPA-46 Portrait and Adaptive Tablet UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the completed NativeScript iPad gameplay fully usable in portrait and preserve the same active puzzle run while rotating between portrait and landscape.

**Architecture:** Keep one mounted `Gameplay.svelte` tree. A tiny feature-local `gameplayLayout.ts` derives concrete GridLayout rows/columns from actual rendered size; the existing Canvas and tray move within that grid while `PuzzleSession` and viewport persistence remain unchanged. Portrait adds only a compact toolbar arrangement and an ephemeral two-height bottom tray drawer.

**Tech Stack:** NativeScript 9, Svelte Native 4, TypeScript 5.9, `@nativescript/canvas`, `@perseus/game-core`, Vitest 4, iOS/iPad.

**Spec:** `docs/superpowers/specs/2026-08-30-hpa-46-portrait-adaptive-tablet-design.md`

## Global Constraints

- One Linear ticket → one PR. Continue implementation on this planning PR/branch.
- `PuzzleSession` remains the only gameplay controller; no mobile store/controller.
- No game-core action or persisted schema change is planned.
- No portrait-specific board/view model/canonical coordinate system.
- Reuse the existing `PuzzleCanvas`, `PuzzleTray`, `GameplayToolbar`, sheets, filesystem session adapter, and downloaded puzzle model.
- Landscape HPA-3 behavior must remain unchanged.
- Portrait tray is a concrete bottom drawer: `220` DIPs collapsed, `360` DIPs expanded; expansion is not persisted.
- Landscape tray remains `320` DIPs wide.
- No phone optimization, Android release work, Google auth/sync, draggable tray divider, named trays, generic responsive framework, or new native E2E framework.
- If rotation cancels an in-flight drag/pinch, that gesture may end; gameplay/session state must not be lost.

---

## File map

| File | Responsibility in HPA-46 |
| --- | --- |
| `apps/mobile/app/gameplay/gameplayLayout.ts` | New tiny pure size → concrete tablet layout projection. |
| `apps/mobile/app/gameplay/gameplayLayout.test.ts` | Pins landscape/portrait/drawer constants and invalid-size behavior. |
| `apps/mobile/app/gameplay/boardViewport.test.ts` | Characterizes the existing persisted viewport contract across aspect changes. |
| `apps/mobile/app/gameplay/Gameplay.svelte` | Keeps one session/component tree and binds the adaptive GridLayout. |
| `apps/mobile/app/gameplay/PuzzleTray.svelte` | Adds only the portrait drawer expand/collapse affordance. |
| `apps/mobile/app/gameplay/GameplayToolbar.svelte` | Adds one compact portrait arrangement; action callbacks stay unchanged. |
| `apps/mobile/app/app.css` | Adds only concrete compact-toolbar/drawer styling if required. |
| `apps/mobile/App_Resources/iOS/Info.plist` | Enables portrait on iPad. |

No files under `packages/game-core`, API, workflows, web, downloads, or persistence should change unless implementation reveals a concrete bug contradicting this plan.

---

### Task 1: Pin the adaptive layout and cross-aspect viewport contracts

**Files:**
- Create: `apps/mobile/app/gameplay/gameplayLayout.ts`
- Create: `apps/mobile/app/gameplay/gameplayLayout.test.ts`
- Modify: `apps/mobile/app/gameplay/boardViewport.test.ts`

**Interfaces:**
- Produces: `createGameplayLayout(widthDip, heightDip, portraitTrayExpanded): GameplayLayout | null`
- Produces constants: `LANDSCAPE_TRAY_WIDTH`, `PORTRAIT_TRAY_COLLAPSED_HEIGHT`, `PORTRAIT_TRAY_EXPANDED_HEIGHT`
- Consumes: existing `createBoardTransform()` only for the characterization test; no production board geometry change.

- [ ] **Step 1: Write the failing adaptive-layout tests**

Create `gameplayLayout.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  LANDSCAPE_TRAY_WIDTH,
  PORTRAIT_TRAY_COLLAPSED_HEIGHT,
  PORTRAIT_TRAY_EXPANDED_HEIGHT,
  createGameplayLayout
} from './gameplayLayout';

describe('createGameplayLayout', () => {
  it('keeps the HPA-3 right tray in landscape', () => {
    expect(createGameplayLayout(1194, 834, false)).toEqual({
      mode: 'landscape',
      rows: '*',
      columns: `*,${LANDSCAPE_TRAY_WIDTH}`,
      trayRow: 0,
      trayColumn: 1,
      compactToolbar: false,
      drawerMode: false
    });
  });

  it('uses a collapsed bottom drawer in portrait by default', () => {
    expect(createGameplayLayout(834, 1194, false)).toEqual({
      mode: 'portrait',
      rows: `*,${PORTRAIT_TRAY_COLLAPSED_HEIGHT}`,
      columns: '*',
      trayRow: 1,
      trayColumn: 0,
      compactToolbar: true,
      drawerMode: true
    });
  });

  it('expands only the portrait tray height', () => {
    expect(createGameplayLayout(834, 1194, true)?.rows).toBe(
      `*,${PORTRAIT_TRAY_EXPANDED_HEIGHT}`
    );
    expect(createGameplayLayout(1194, 834, true)?.rows).toBe('*');
  });

  it('ignores non-renderable sizes', () => {
    expect(createGameplayLayout(0, 1194, false)).toBeNull();
    expect(createGameplayLayout(834, Number.NaN, false)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails because the module does not exist**

Run:

```bash
bun run --cwd apps/mobile test:unit -- gameplayLayout.test.ts
```

Expected: FAIL resolving `./gameplayLayout`.

- [ ] **Step 3: Implement the smallest feature-local layout projection**

Create `gameplayLayout.ts`:

```ts
export const LANDSCAPE_TRAY_WIDTH = 320;
export const PORTRAIT_TRAY_COLLAPSED_HEIGHT = 220;
export const PORTRAIT_TRAY_EXPANDED_HEIGHT = 360;

export type GameplayLayoutMode = 'landscape' | 'portrait';

export interface GameplayLayout {
  mode: GameplayLayoutMode;
  rows: string;
  columns: string;
  trayRow: number;
  trayColumn: number;
  compactToolbar: boolean;
  drawerMode: boolean;
}

export function createGameplayLayout(
  widthDip: number,
  heightDip: number,
  portraitTrayExpanded: boolean
): GameplayLayout | null {
  if (
    !Number.isFinite(widthDip) ||
    !Number.isFinite(heightDip) ||
    widthDip <= 0 ||
    heightDip <= 0
  ) {
    return null;
  }

  if (heightDip > widthDip) {
    const trayHeight = portraitTrayExpanded
      ? PORTRAIT_TRAY_EXPANDED_HEIGHT
      : PORTRAIT_TRAY_COLLAPSED_HEIGHT;
    return {
      mode: 'portrait',
      rows: `*,${trayHeight}`,
      columns: '*',
      trayRow: 1,
      trayColumn: 0,
      compactToolbar: true,
      drawerMode: true
    };
  }

  return {
    mode: 'landscape',
    rows: '*',
    columns: `*,${LANDSCAPE_TRAY_WIDTH}`,
    trayRow: 0,
    trayColumn: 1,
    compactToolbar: false,
    drawerMode: false
  };
}
```

Do not add breakpoints, device classes, platform checks, or a responsive-layout registry.

- [ ] **Step 4: Add the viewport aspect-change characterization**

Extend `boardViewport.test.ts` with one test using the same persisted viewport on two surfaces:

```ts
it('reprojects one persisted viewport across landscape and portrait without changing canonical cells', () => {
  const viewport = { zoom: 2, panX: 0.5, panY: 0.1 };
  const puzzle = { gridCols: 4, gridRows: 3, viewport };

  const landscape = createBoardTransform({
    ...puzzle,
    canvasWidth: 1000,
    canvasHeight: 700
  });
  const portrait = createBoardTransform({
    ...puzzle,
    canvasWidth: 700,
    canvasHeight: 1000
  });

  expect(landscape.viewport).toEqual(viewport);
  expect(portrait.viewport).toEqual(viewport);
  expect(
    landscape.cellAt(
      landscape.boardX + 2.5 * landscape.cellSize,
      landscape.boardY + 1.5 * landscape.cellSize
    )
  ).toEqual({ x: 2, y: 1 });
  expect(
    portrait.cellAt(
      portrait.boardX + 2.5 * portrait.cellSize,
      portrait.boardY + 1.5 * portrait.cellSize
    )
  ).toEqual({ x: 2, y: 1 });
});
```

This is deliberately a characterization test. If it already passes, keep `boardViewport.ts` unchanged.

- [ ] **Step 5: Run the mobile unit suite**

Run:

```bash
bun run --cwd apps/mobile test:unit
```

Expected: PASS.

- [ ] **Step 6: Commit the contract**

```bash
git add apps/mobile/app/gameplay/gameplayLayout.ts \
  apps/mobile/app/gameplay/gameplayLayout.test.ts \
  apps/mobile/app/gameplay/boardViewport.test.ts
git commit -m "test(mobile): pin adaptive tablet layout"
```

---

### Task 2: Reflow the same gameplay tree and add the portrait tray drawer

**Files:**
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte` (current composition around the toolbar/content grid)
- Modify: `apps/mobile/app/gameplay/PuzzleTray.svelte`
- Modify: `apps/mobile/App_Resources/iOS/Info.plist`
- Modify: `apps/mobile/app/app.css` only if the drawer toggle needs a concrete class

**Interfaces:**
- Consumes: `createGameplayLayout()` from Task 1.
- Produces: one mounted Canvas/tray tree that moves between right-panel landscape and bottom-drawer portrait.
- `PuzzleTray` adds presentation props `drawerMode`, `drawerExpanded`, `onToggleDrawer`; gameplay callbacks are otherwise unchanged.

- [ ] **Step 1: Enable iPad portrait in the product metadata**

In `UISupportedInterfaceOrientations~ipad`, change only the array from two landscape values to:

```xml
<array>
  <string>UIInterfaceOrientationPortrait</string>
  <string>UIInterfaceOrientationLandscapeLeft</string>
  <string>UIInterfaceOrientationLandscapeRight</string>
</array>
```

Do not add `UIInterfaceOrientationPortraitUpsideDown` and do not change the phone orientation array.

- [ ] **Step 2: Seed and update the adaptive layout from actual rendered size**

In `Gameplay.svelte`:

```ts
import { Application, Screen } from '@nativescript/core';
import { createGameplayLayout } from './gameplayLayout';

let portraitTrayExpanded = false;
let layoutWidthDip = Screen.mainScreen.widthDIPs;
let layoutHeightDip = Screen.mainScreen.heightDIPs;

$: gameplayLayout =
  createGameplayLayout(layoutWidthDip, layoutHeightDip, portraitTrayExpanded) ??
  createGameplayLayout(1024, 768, false)!;

function onGameplayLayoutChanged(args: any): void {
  const size = args.object?.getActualSize?.();
  if (!size || size.width <= 0 || size.height <= 0) return;
  layoutWidthDip = size.width;
  layoutHeightDip = size.height;
}

function togglePortraitTray(): void {
  portraitTrayExpanded = !portraitTrayExpanded;
}
```

Use the rendered content size as the ongoing source of truth. Do not subscribe to a second orientation service.

- [ ] **Step 3: Replace the fixed `columns="*,320"` content grid with one adaptive grid**

Keep exactly one `PuzzleCanvas` and one `PuzzleTray` in the markup:

```svelte
<gridLayout
  row={1}
  rows={gameplayLayout.rows}
  columns={gameplayLayout.columns}
  on:layoutChanged={onGameplayLayoutChanged}
>
  <gridLayout row={0} col={0}>
    <PuzzleCanvas
      bind:this={puzzleCanvas}
      {sessionState}
      piecePaths={launch.install.piecePaths}
      referencePath={launch.install.referencePath}
      referenceMode={sessionState.activeReferenceMode}
      {hintTarget}
      {placementFeedback}
      onAttemptPlacement={attemptPlacement}
      onViewportCommit={commitViewport}
    />
  </gridLayout>

  <gridLayout row={gameplayLayout.trayRow} col={gameplayLayout.trayColumn}>
    <PuzzleTray
      {sessionState}
      pieces={spec.pieces}
      piecePaths={launch.install.piecePaths}
      {hintPieceId}
      drawerMode={gameplayLayout.drawerMode}
      drawerExpanded={portraitTrayExpanded}
      onToggleDrawer={togglePortraitTray}
      onSelectPiece={selectPiece}
      onPieceDragStart={startPieceDrag}
      onPieceDragMove={movePieceDrag}
      onPieceDragEnd={endPieceDrag}
      onPieceDragCancel={cancelPieceDrag}
      onSetFilter={setTrayFilter}
      onShuffle={shuffleTray}
      onRotateSelected={rotateSelected}
    />
  </gridLayout>
</gridLayout>
```

Do **not** use `{#if portrait}` to duplicate/remount the gameplay subtree.

- [ ] **Step 4: Add the portrait-only drawer affordance to `PuzzleTray`**

Add:

```ts
export let drawerMode = false;
export let drawerExpanded = false;
export let onToggleDrawer: () => void = () => {};

$: headerColumns = drawerMode ? 'auto,*,auto,auto,auto' : 'auto,*,auto,auto';
$: shuffleColumn = drawerMode ? 3 : 2;
$: rotateColumn = drawerMode ? 4 : 3;
```

Then keep the existing header/actions, inserting only this conditional button:

```svelte
<gridLayout row={0} class="tray-header" columns={headerColumns}>
  <label col={0} text={`REMAINING ${remainingCount}`} class="tray-count" verticalAlignment="middle" />
  {#if drawerMode}
    <button
      col={2}
      text={drawerExpanded ? 'LESS PIECES' : 'MORE PIECES'}
      class="tray-action"
      on:tap={onToggleDrawer}
    />
  {/if}
  <button col={shuffleColumn} text="SHUFFLE" class="tray-action" on:tap={onShuffle} />
  <button
    col={rotateColumn}
    text="ROTATE"
    class={canRotate ? 'tray-action' : 'tray-action-disabled'}
    isEnabled={canRotate}
    on:tap={onRotateSelected}
  />
</gridLayout>
```

Do not change filters, piece tile size, long-press drag ownership, ScrollView behavior, tray order, or session persistence.

- [ ] **Step 5: Pass the compact-layout flag to the toolbar without changing toolbar behavior yet**

Add to the existing toolbar call:

```svelte
<GameplayToolbar
  compact={gameplayLayout.compactToolbar}
  ...
/>
```

Task 3 implements the compact markup. Landscape should still receive `false`.

- [ ] **Step 6: Run unit tests before the native gate**

Run:

```bash
bun run --cwd apps/mobile test:unit
```

Expected: PASS.

- [ ] **Step 7: Prove the single-tree reflow on iPad before polishing the toolbar**

Run from `apps/mobile`:

```bash
bunx ns run ios --no-hmr --justlaunch
```

On the target iPad simulator/device:

1. launch portrait;
2. open a downloaded puzzle;
3. confirm Canvas above and tray below;
4. toggle `MORE PIECES` / `LESS PIECES` and confirm only Canvas/tray allocation changes;
5. place/select a piece;
6. rotate to landscape and confirm the same run/placement/selection remains present and the right tray appears;
7. rotate back to portrait.

Stop here if row/column changes remount `PuzzleCanvas`/`PuzzleTray` or reset gameplay state. The fallback is an imperative update of the same GridLayout's row/column definitions, not duplicated portrait markup.

- [ ] **Step 8: Commit the adaptive composition**

```bash
git add apps/mobile/App_Resources/iOS/Info.plist \
  apps/mobile/app/gameplay/Gameplay.svelte \
  apps/mobile/app/gameplay/PuzzleTray.svelte \
  apps/mobile/app/app.css
git commit -m "feat(mobile): add portrait gameplay layout"
```

If `app.css` was not changed, omit it from `git add`.

---

### Task 3: Add the compact portrait toolbar and finish orientation acceptance

**Files:**
- Modify: `apps/mobile/app/gameplay/GameplayToolbar.svelte`
- Modify: `apps/mobile/app/app.css`
- Modify: only HPA-46 files from Tasks 1-2 if native acceptance finds a concrete defect

**Interfaces:**
- Consumes: `compact: boolean` from `Gameplay.svelte`.
- Produces: the same callbacks/actions as HPA-3 in two concrete tablet arrangements.
- No toolbar action model/registry is introduced.

- [ ] **Step 1: Add the presentation-only `compact` prop**

At the top of `GameplayToolbar.svelte`:

```ts
export let compact = false;
```

Do not alter any callback signatures or menu state.

- [ ] **Step 2: Keep the current landscape bar unchanged behind `{:else}`**

Wrap the existing top bar in:

```svelte
{#if compact}
  <!-- portrait markup from Step 3 -->
{:else}
  <!-- existing HPA-3 toolbar-bar exactly as today -->
{/if}
```

This makes the landscape regression easy to review.

- [ ] **Step 3: Add the explicit two-row portrait toolbar**

Use one compact primary row and one quick-action row:

```svelte
<gridLayout class="toolbar-bar" columns="auto,*,auto,auto">
  <button col={0} text="LIBRARY" class="toolbar-button" on:tap={onLibrary} />
  <stackLayout col={1} class="toolbar-title">
    <label text={puzzleName} class="toolbar-name" textWrap="true" />
    <label text={difficultyLabel} class="toolbar-difficulty" />
  </stackLayout>
  <label col={2} text={formatElapsed(elapsedSeconds)} class="toolbar-timer" />
  <button
    col={3}
    text="MORE"
    class={openMenu === 'more' ? 'toolbar-button-active' : 'toolbar-button'}
    on:tap={() => toggleMenu('more')}
  />
</gridLayout>

<gridLayout class="toolbar-quick" columns="*,*,*,*">
  <button col={0} text="UNDO" class={canUndo ? 'toolbar-button' : 'toolbar-button-disabled'} isEnabled={canUndo} on:tap={onUndo} />
  <button col={1} text="REDO" class={canRedo ? 'toolbar-button' : 'toolbar-button-disabled'} isEnabled={canRedo} on:tap={onRedo} />
  <button col={2} text="HINT" class="toolbar-button" on:tap={onHint} />
  {#if referenceAvailable}
    <button
      col={3}
      text="REFERENCE"
      class={referenceMode ? 'toolbar-button-active' : 'toolbar-button'}
      on:tap={() => toggleMenu('reference')}
    />
  {/if}
</gridLayout>
```

If no reference asset exists, leaving the fourth equal column empty is acceptable; do not add layout machinery for that case.

- [ ] **Step 4: Make the existing menus fit portrait without creating a new menu system**

Keep the current landscape menu markup unchanged.

For `compact && openMenu === 'more'`, use two columns/three rows with the same callbacks:

```svelte
<gridLayout class="toolbar-menu" rows="auto,auto,auto" columns="*,*">
  <button row={0} col={0} text="FIT BOARD" class="toolbar-button" on:tap={() => runFromMenu(onFitBoard)} />
  <button
    row={0}
    col={1}
    text={rotationEnabled ? 'ROTATION OFF' : 'ROTATION ON'}
    class={rotationToggleDisabled ? 'toolbar-button-disabled' : 'toolbar-button'}
    isEnabled={!rotationToggleDisabled}
    on:tap={() => runFromMenu(() => onSetRotationMode(!rotationEnabled))}
  />
  <button row={1} col={0} text="PAUSE" class="toolbar-button" on:tap={() => runFromMenu(onPause)} />
  <button
    row={1}
    col={1}
    text={confirmRestart ? 'CONFIRM RESTART?' : 'RESTART'}
    class={confirmRestart ? 'toolbar-button-active' : 'toolbar-button'}
    on:tap={requestRestart}
  />
  <button row={2} col={0} colSpan={2} text="DISCARD" class="toolbar-button" on:tap={() => runFromMenu(onDiscard)} />
</gridLayout>
```

The compact Reference menu can keep three equal columns because it has only Hold to Peek / Toggle / Ghost.

- [ ] **Step 5: Add only the compact-row spacing CSS**

In `app.css`:

```css
.toolbar-quick {
  padding: 0 8 4 8;
}
```

Reuse all existing button/title/timer classes. Do not fork the palette or typography for portrait.

- [ ] **Step 6: Run automated regression checks**

Run:

```bash
bun run --cwd apps/mobile test:unit
bun run check
```

Expected: PASS for the affected workspace. Do not run or modify game-core tests unless game-core unexpectedly changed.

- [ ] **Step 7: Run the final iPad orientation smoke**

Run:

```bash
cd apps/mobile
bunx ns run ios --no-hmr --justlaunch
```

Exercise this exact journey:

1. start in portrait and open/resume a downloaded Easy/Normal puzzle;
2. verify Library/title/timer/More top row and Undo/Redo/Hint/Reference quick row;
3. open More and exercise Fit Board; verify all five existing secondary actions are reachable;
4. collapse/expand the bottom tray;
5. select and place a piece in portrait;
6. set a non-All tray filter and zoom/pan the board;
7. rotate to landscape and confirm the same run, placed piece, filter, selection where applicable, timer/lifecycle, and understandable viewport remain;
8. verify the existing HPA-3 landscape right tray and toolbar still behave normally;
9. rotate back to portrait;
10. long-press drag one tray piece onto the board using the portrait layout;
11. background the app for several seconds, foreground it, and confirm HPA-3 timing/persistence behavior remains unchanged.

If convenient, inspect the simulator session file before/after orientation with the existing app container to confirm the `runId` and placements are unchanged. Do not create new automation infrastructure solely for this evidence.

- [ ] **Step 8: Re-run the mobile suite after any smoke fixes**

```bash
bun run --cwd apps/mobile test:unit
bun run check
```

Expected: PASS.

- [ ] **Step 9: Commit the toolbar/final polish**

```bash
git add apps/mobile/app/gameplay/GameplayToolbar.svelte \
  apps/mobile/app/app.css \
  apps/mobile/app/gameplay/Gameplay.svelte \
  apps/mobile/app/gameplay/PuzzleTray.svelte \
  apps/mobile/app/gameplay/gameplayLayout.ts \
  apps/mobile/app/gameplay/gameplayLayout.test.ts \
  apps/mobile/app/gameplay/boardViewport.test.ts \
  apps/mobile/App_Resources/iOS/Info.plist
git commit -m "feat(mobile): finish adaptive iPad gameplay"
```

Only staged files with actual changes should be committed.

---

## Final review checklist

Before marking HPA-46 ready for review:

- [ ] Diff contains only the HPA-46 adaptive tablet slice plus its docs.
- [ ] `PuzzleSession` construction still happens once in `Gameplay.svelte`; orientation does not reload/recreate it.
- [ ] Exactly one `PuzzleCanvas` and one `PuzzleTray` exist in the gameplay markup.
- [ ] Landscape still uses the HPA-3 `320` DIP right tray.
- [ ] Portrait uses one bottom tray with `220`/`360` DIP states.
- [ ] Drawer expansion is not persisted.
- [ ] `PuzzleCanvas` still owns surface relayout and `boardViewport.ts` still owns all board geometry.
- [ ] No orientation-specific viewport/schema field exists.
- [ ] Toolbar callbacks are unchanged; only presentation differs.
- [ ] iPad plist supports portrait + two landscape orientations, not upside-down portrait.
- [ ] Mobile unit tests and workspace checks pass.
- [ ] Native evidence covers portrait play, live orientation change, return to portrait, portrait drag placement, and background/foreground.
- [ ] PR body records any manual native evidence and any deviation from the planned `220`/`360` tray heights.
