# Galaxy Arcade UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Perseus web gallery, gameplay, completion, and admin surfaces to match the approved Galaxy Arcade mockup across phone, landscape tablet, and desktop without changing gameplay, persistence, API, or backend behavior.

**Architecture:** Keep the current SvelteKit route ownership and `@perseus/game-core` session boundaries. Add only three repeated presentation primitives (`ArcadeShell`, `DifficultyGems`, `ProgressRing`), then reshape the existing gallery/gameplay/completion/admin components with responsive CSS and local UI-only presentation state. Functional behavior continues to flow through the current services/stores; the final task adds deterministic visual-regression baselines after manual comparison with the canonical mockup variants.

**Tech Stack:** SvelteKit 2, Svelte 5, TypeScript 5.9, Tailwind CSS v4 plus component CSS, Vitest browser mode, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-07-galaxy-arcade-ui-redesign-design.md`

## Global Constraints

- One ticket / one implementation PR. Tasks below are reviewable commits inside that PR, not separate PRs.
- Web-only implementation: do not modify `apps/mobile`, API/workflows, infrastructure, D1, `@perseus/game-core`, `@perseus/types`, or `@perseus/shared` unless implementation proves the spec impossible without doing so; if that happens, stop and review the spec before expanding scope.
- Preserve all current gameplay/session/persistence semantics and existing server contracts.
- Preserve existing keyboard, touch, focus-trap, `inert`, `aria-*`, and 44px coarse-pointer behavior.
- Do not add a component library, icon package, global state framework, or second design-token system.
- Canonical visual variants are mockup 2a–2f, 3a–3c, and 4a. Turn 1 and 4b are reference-only.
- Rendered 3a is authoritative over contradictory prose: desktop gallery is three columns, not four.
- Phone canonical viewport is 393×852; routine mobile E2E remains 390×844.
- Landscape-tablet canonical composition is 1080×810; existing 768×1024 portrait tablet tests must continue passing.
- Desktop canonical viewport is 1440×900.
- Mock fixture cell sizes (48/72/84px) are visual targets for the 6×8 sample only; production sizing remains dynamic.
- Truthful behavior wins over mock sample copy: do not label Back to Arcade as `NEXT` without real next-puzzle semantics.

---

## File Structure

### New files

- `apps/web/src/lib/components/ArcadeShell.svelte`
  - Non-gameplay player navigation shell.
  - Desktop 232px sidebar; compact phone/tablet header/navigation.
  - Pure presentation: receives auth/progression display values and callbacks from `+layout.svelte`.
- `apps/web/src/lib/components/DifficultyGems.svelte`
  - Accessible 1/2/3-gem difficulty presentation plus piece count.
  - No navigation or progression ownership.
- `apps/web/src/lib/components/ProgressRing.svelte`
  - Accessible conic progress ring used by resume/gameplay HUD.
  - No state ownership.
- `apps/web/src/lib/components/__tests__/ArcadeShell.svelte.test.ts`
- `apps/web/src/lib/components/__tests__/DifficultyGems.svelte.test.ts`
- `apps/web/src/lib/components/__tests__/ProgressRing.svelte.test.ts`
- `apps/web/e2e/ui-redesign-visual.spec.ts`
- Playwright-generated screenshot baselines adjacent to the visual spec after manual mockup comparison.

### Main modified files

- `apps/web/src/routes/layout.css`
- `apps/web/src/routes/+layout.svelte`
- `apps/web/src/routes/layout.svelte.test.ts`
- `apps/web/src/routes/+page.svelte`
- `apps/web/src/routes/page.svelte.test.ts`
- `apps/web/src/lib/components/PuzzleCard.svelte`
- `apps/web/src/lib/components/PuzzleDifficultyPicker.svelte`
- `apps/web/src/lib/components/CategoryBadge.svelte`
- `apps/web/src/lib/components/CategoryFilter.svelte`
- related component tests
- `apps/web/src/routes/puzzle/[id]/+page.svelte`
- `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`
- `apps/web/src/lib/components/PuzzleToolbar.svelte`
- `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- `apps/web/src/lib/components/PuzzleBoardPanel.svelte` only if chrome spacing requires a presentation hook; do not move board logic.
- `apps/web/src/lib/services/puzzleLayout.ts`
- `apps/web/src/lib/services/puzzleLayout.test.ts`
- related toolbar/inventory/board tests
- `apps/web/src/lib/components/PuzzleCompletionDialog.svelte`
- `apps/web/src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts`
- `apps/web/src/routes/admin/+page.svelte`
- `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte`
- `apps/web/src/routes/admin/PlayerAccessPanel.svelte`
- admin route/panel tests
- `apps/web/e2e/gallery.spec.ts`
- `apps/web/e2e/gameplay-mobile-tap.spec.ts`
- `apps/web/e2e/gameplay-interactions.spec.ts`
- `apps/web/e2e/gameplay-session-controls.spec.ts`
- `apps/web/e2e/gameplay-accessibility.spec.ts`
- admin E2E coverage if current selectors need semantic updates.

---

### Task 1: Retune the visual tokens and introduce the player Arcade shell

**Files:**
- Create: `apps/web/src/lib/components/ArcadeShell.svelte`
- Create: `apps/web/src/lib/components/__tests__/ArcadeShell.svelte.test.ts`
- Modify: `apps/web/src/routes/layout.css`
- Modify: `apps/web/src/routes/+layout.svelte`
- Modify: `apps/web/src/routes/layout.svelte.test.ts`

**Interfaces:**
- `ArcadeShell` consumes:
  - `children: Snippet`
  - `currentPath: string`
  - `authStatus: 'loading' | 'authenticated' | 'anonymous'`
  - `playerDisplayName: string`
  - `score: number | null`
  - `rank: number | null`
  - `onLogout: () => void`
- `ArcadeShell` produces only rendered navigation/content; it owns no auth or progression fetch.
- `+layout.svelte` remains the auth-refresh owner and performs a best-effort `getPlayerProgression()` when auth becomes authenticated.

- [ ] **Step 1: Write shell tests for route ownership and desktop navigation**

Add `ArcadeShell.svelte.test.ts` with assertions equivalent to:

```ts
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ArcadeShell from '../ArcadeShell.svelte';

it('renders all five player destinations and progression in the desktop shell', () => {
	const { container } = render(ArcadeShell, {
		currentPath: '/',
		authStatus: 'authenticated',
		playerDisplayName: 'Alex C.',
		score: 900,
		rank: 38,
		onLogout: vi.fn(),
		children: () => 'content'
	});

	expect(screen.getByRole('link', { name: 'Arcade' })).toBeTruthy();
	expect(screen.getByRole('link', { name: 'Ranks' })).toBeTruthy();
	expect(screen.getByRole('link', { name: 'Upload' })).toBeTruthy();
	expect(screen.getByRole('link', { name: 'Quick' })).toBeTruthy();
	expect(screen.getByRole('link', { name: 'Profile' })).toBeTruthy();
	expect(container.textContent).toContain('900');
	expect(container.textContent).toContain('#38');
});
```

Also update `layout.svelte.test.ts` to assert:

- `/puzzle/:id` does not render `ArcadeShell`.
- `/admin` does not render `ArcadeShell`.
- `/`, `/leaderboard`, `/upload`, `/quick`, `/profile`, `/login` render through `ArcadeShell`.
- progression fetch failure does not block child rendering.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
bun run --cwd apps/web test:unit -- \
	src/lib/components/__tests__/ArcadeShell.svelte.test.ts \
	src/routes/layout.svelte.test.ts
```

Expected: FAIL because `ArcadeShell.svelte` does not exist and the root layout still renders the floating navigation.

- [ ] **Step 3: Retune global tokens and remove the CRT overlay**

In `layout.css`:

- move `--bg-*` toward `#0a0620`, `#150d33`, `#1c1440`, `#1f1548`
- move borders toward `#2c1c60` / `#38246f`
- keep cyan/magenta/gold token names but retune values toward the mock
- keep Orbitron/Rajdhani/Share Tech Mono imports
- remove `body::after` scanlines
- replace square arcade-button treatment with the rounded candy/glass treatment
- retain `prefers-reduced-motion` and coarse-pointer rules

Do not introduce a parallel `.galaxy-*` theme tree; existing tokens become the new default.

- [ ] **Step 4: Implement `ArcadeShell.svelte`**

Use semantic navigation and current route highlighting. The desktop sidebar should be hidden below the shell's desktop breakpoint; phone/tablet render a compact top shell without reserving 232px.

Representative props:

```svelte
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		children: Snippet;
		currentPath: string;
		authStatus: 'loading' | 'authenticated' | 'anonymous';
		playerDisplayName: string;
		score: number | null;
		rank: number | null;
		onLogout: () => void;
	}

	let { children, currentPath, authStatus, playerDisplayName, score, rank, onLogout }: Props =
		$props();
</script>
```

Keep destination URLs based on `$app/paths.resolve` and retain sign-in/sign-out behavior.

- [ ] **Step 5: Replace root floating navigation with shell composition**

In `+layout.svelte`:

- keep `playerAuth.refresh()` on mount
- derive `isPuzzleRoute` and `isAdminRoute`
- puzzle/admin render children directly
- all other routes render `ArcadeShell`
- best-effort load progression only after authenticated auth state is known
- clear progression display on logout/anonymous transition

Do not move progression into a global store.

- [ ] **Step 6: Run tests, check, and commit**

Run:

```bash
bun run --cwd apps/web test:unit -- \
	src/lib/components/__tests__/ArcadeShell.svelte.test.ts \
	src/routes/layout.svelte.test.ts
bun run --cwd apps/web check
```

Expected: PASS.

Commit:

```bash
git add apps/web/src/routes/layout.css \
	apps/web/src/routes/+layout.svelte \
	apps/web/src/routes/layout.svelte.test.ts \
	apps/web/src/lib/components/ArcadeShell.svelte \
	apps/web/src/lib/components/__tests__/ArcadeShell.svelte.test.ts
git commit -m "feat(web): add galaxy arcade shell"
```

---

### Task 2: Add gem difficulty and progress-ring primitives

**Files:**
- Create: `apps/web/src/lib/components/DifficultyGems.svelte`
- Create: `apps/web/src/lib/components/ProgressRing.svelte`
- Create: `apps/web/src/lib/components/__tests__/DifficultyGems.svelte.test.ts`
- Create: `apps/web/src/lib/components/__tests__/ProgressRing.svelte.test.ts`
- Modify: `apps/web/src/lib/components/PuzzleDifficultyPicker.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleDifficultyPicker.svelte.test.ts`

**Interfaces:**

```ts
type PuzzleDifficulty = 'easy' | 'normal' | 'hard';

interface DifficultyGemsProps {
	difficulty: PuzzleDifficulty;
	pieceCount: number;
}

interface ProgressRingProps {
	percent: number;
	size?: number;
	accent?: 'cyan' | 'magenta' | 'gold';
	showValue?: boolean;
	label: string;
}
```

`DifficultyGems` maps easy → 1 cyan gem, normal → 2 magenta gems, hard → 3 gold gems and includes screen-reader difficulty text.

- [ ] **Step 1: Write primitive tests**

`DifficultyGems` tests must assert gem count, `data-difficulty`, visible piece count, and accessible text:

```ts
it.each([
	['easy', 1, 12],
	['normal', 2, 48],
	['hard', 3, 108]
] as const)('renders %s as the expected gem count', (difficulty, gems, pieceCount) => {
	const { container } = render(DifficultyGems, { difficulty, pieceCount });
	expect(container.querySelectorAll('[data-testid="difficulty-gem"]')).toHaveLength(gems);
	expect(container.textContent).toContain(String(pieceCount));
	expect(screen.getByText(new RegExp(difficulty, 'i'))).toBeTruthy();
});
```

`ProgressRing` tests must clamp values below 0 / above 100 and expose `role="progressbar"`, `aria-valuemin="0"`, `aria-valuemax="100"`, and the supplied label.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
bun run --cwd apps/web test:unit -- \
	src/lib/components/__tests__/DifficultyGems.svelte.test.ts \
	src/lib/components/__tests__/ProgressRing.svelte.test.ts
```

Expected: FAIL because the components do not exist.

- [ ] **Step 3: Implement the two presentational components**

Use inline SVG for the gem silhouette. Do not add an icon package.

`ProgressRing` should use one conic-gradient element with a dark inner circle rather than SVG arc math. Clamp once in the component:

```ts
const value = $derived(Math.min(100, Math.max(0, percent)));
```

- [ ] **Step 4: Refactor `PuzzleDifficultyPicker` to use gem presentation without changing link semantics**

Keep:

- `PUZZLE_DIFFICULTIES` ordering
- ready/non-ready behavior
- `resolve('/puzzle/:id')`
- local best-time lookup
- progress/continue semantics
- existing `data-testid="difficulty-action"`

Replace visible Easy/Normal/Hard text rows with `DifficultyGems`; keep an `.sr-only` difficulty name for accessibility.

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
bun run --cwd apps/web test:unit -- \
	src/lib/components/__tests__/DifficultyGems.svelte.test.ts \
	src/lib/components/__tests__/ProgressRing.svelte.test.ts \
	src/lib/components/__tests__/PuzzleDifficultyPicker.svelte.test.ts
```

Expected: PASS.

Commit:

```bash
git add apps/web/src/lib/components/DifficultyGems.svelte \
	apps/web/src/lib/components/ProgressRing.svelte \
	apps/web/src/lib/components/PuzzleDifficultyPicker.svelte \
	apps/web/src/lib/components/__tests__/DifficultyGems.svelte.test.ts \
	apps/web/src/lib/components/__tests__/ProgressRing.svelte.test.ts \
	apps/web/src/lib/components/__tests__/PuzzleDifficultyPicker.svelte.test.ts
git commit -m "feat(web): add arcade difficulty and progress visuals"
```

---

### Task 3: Redesign the gallery for 2a, 2d, and 3a

**Files:**
- Modify: `apps/web/src/routes/+page.svelte`
- Modify: `apps/web/src/routes/page.svelte.test.ts`
- Modify: `apps/web/src/lib/components/PuzzleCard.svelte`
- Modify: `apps/web/src/lib/components/CategoryBadge.svelte`
- Modify: `apps/web/src/lib/components/CategoryFilter.svelte`
- Modify: `apps/web/src/lib/components/SearchBar.svelte` only for new shell-compatible styling
- Modify: related component tests
- Modify: `apps/web/e2e/gallery.spec.ts`

**Interfaces:**
- Gallery data/service interfaces remain unchanged.
- `PuzzleCard` continues consuming `family`, `progressByVariantId`, `playableLinks`.
- `CategoryBadge` continues consuming the existing category type; if a `showLabel?: boolean` prop is useful, default it so current non-gallery callers stay readable.

- [ ] **Step 1: Add failing component/route assertions for the poster layout**

Update tests to require:

- `PuzzleCard` has an art-first poster root (`data-testid="puzzle-card"` retained).
- category remains accessible when rendered as icon-first chrome.
- three difficulty actions still exist for a ready family.
- processing/failed overlays remain explicit.
- gallery resume section includes a `progressbar` ring and the existing resume action.
- no functional test relies on the removed `Easy`, `Normal`, `Hard` visible labels; use `data-difficulty`/accessible names instead.

Add an E2E assertion that selecting each category still changes results through the new icon/chip controls.

- [ ] **Step 2: Run gallery/component tests and verify failure**

Run:

```bash
bun run --cwd apps/web test:unit -- \
	src/lib/components/__tests__/PuzzleCard.svelte.test.ts \
	src/lib/components/__tests__/CategoryBadge.svelte.test.ts \
	src/lib/components/__tests__/CategoryFilter.svelte.test.ts \
	src/routes/page.svelte.test.ts
```

Expected: FAIL on the new poster/resume/gem structure.

- [ ] **Step 3: Restyle `PuzzleCard` as the shared poster component**

Keep one card implementation for all form factors.

Required composition:

- square thumbnail
- image gradient at bottom for text readability
- icon category chip
- puzzle title over/against art
- compact mastery/best-time/progress badge if current data provides it
- difficulty gem row as the lower action region
- processing overlay with spinner/label
- failed overlay with failure label

Do not introduce separate `MobilePuzzleCard` / `DesktopPuzzleCard` components.

- [ ] **Step 4: Convert category controls to compact icon/chip presentation**

Preserve the existing fieldset/radio semantics and category values. Visual icons may be inline SVG per category, but the radio accessible name remains the category word.

- [ ] **Step 5: Recompose the gallery route around the canonical breakpoints**

Keep the route's existing effects/functions unchanged wherever possible. Change only rendered structure/CSS:

- phone: single-column/scrolling art-first feed matching 2a
- landscape tablet: three-column poster wall matching 2d
- desktop shell content: three-column wall matching 3a
- resume banner uses `ProgressRing`
- desktop banner ring targets ~74px and action ~70px high
- desktop content must account for the 232px shell sidebar naturally through `ArcadeShell`, not per-route margins

The existing cursor sentinel remains after the poster grid.

- [ ] **Step 6: Run unit tests and gallery E2E**

Run:

```bash
bun run --cwd apps/web test:unit -- \
	src/lib/components/__tests__/PuzzleCard.svelte.test.ts \
	src/lib/components/__tests__/CategoryBadge.svelte.test.ts \
	src/lib/components/__tests__/CategoryFilter.svelte.test.ts \
	src/routes/page.svelte.test.ts
bun run --cwd apps/web test:e2e -- gallery.spec.ts
```

Expected: PASS for search, categories, load-more, quick puzzle, saved progress, resume, and discard flows.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/routes/+page.svelte \
	apps/web/src/routes/page.svelte.test.ts \
	apps/web/src/lib/components/PuzzleCard.svelte \
	apps/web/src/lib/components/PuzzleDifficultyPicker.svelte \
	apps/web/src/lib/components/CategoryBadge.svelte \
	apps/web/src/lib/components/CategoryFilter.svelte \
	apps/web/src/lib/components/SearchBar.svelte \
	apps/web/src/lib/components/__tests__ \
	apps/web/e2e/gallery.spec.ts
git commit -m "feat(web): redesign arcade gallery"
```

---

### Task 4: Recompose gameplay for phone sheet, tablet rail/tray, and desktop rail/tray

**Files:**
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`
- Modify: `apps/web/src/lib/components/PuzzleToolbar.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts`
- Modify: `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`
- Modify: `apps/web/src/lib/services/puzzleLayout.ts`
- Modify: `apps/web/src/lib/services/puzzleLayout.test.ts`
- Modify: `apps/web/e2e/gameplay-mobile-tap.spec.ts`
- Modify: `apps/web/e2e/gameplay-interactions.spec.ts`
- Modify: `apps/web/e2e/gameplay-session-controls.spec.ts`
- Modify: `apps/web/e2e/gameplay-accessibility.spec.ts`

**Interfaces:**
- `PuzzleToolbar` keeps its existing callback/boolean props unchanged.
- `PuzzleInventoryPanel` keeps its canonical-session props unchanged.
- Add only local presentation state inside `PuzzleInventoryPanel`:

```ts
type MobileSheetState = 'peek' | 'half' | 'full';
const MOBILE_SHEET_HEIGHT: Record<MobileSheetState, number> = {
	peek: 140,
	half: 300,
	full: 528
};
```

- `puzzleLayout.ts` remains the sole board metric owner; do not return rail/tray UI state from it.

- [ ] **Step 1: Write failing inventory-sheet tests**

Add tests that render the inventory under phone layout and assert:

```ts
expect(screen.getByTestId('puzzle-inventory-panel').dataset.sheetState).toBe('half');
await user.click(screen.getByRole('button', { name: 'Expand piece tray' }));
expect(screen.getByTestId('puzzle-inventory-panel').dataset.sheetState).toBe('full');
await user.click(screen.getByRole('button', { name: 'Collapse piece tray' }));
expect(screen.getByTestId('puzzle-inventory-panel').dataset.sheetState).toBe('peek');
```

Also assert sheet changes do not call `onFilterChange`, `onSelect`, or any persistence callback.

Keep the existing hint-reveal test and require a hinted piece to expand/reveal the tray sufficiently to scroll it into view.

- [ ] **Step 2: Add failing toolbar accessibility/layout tests**

Keep the current roving-focus test suite and add assertions that:

- there is no `More puzzle actions` button in the redesigned rail
- every rendered icon control has an accessible name
- arrow-key roving focus still follows visible enabled actions
- pressed reference/rotation states remain exposed
- disabled actions remain skipped

- [ ] **Step 3: Add failing board-metric tests for new chrome reserves**

Extend `puzzleLayout.test.ts` with representative fixtures:

```ts
it('keeps a 6x8 portrait fixture near the 72px landscape-tablet target without hardcoding cells', () => {
	const metrics = getResponsivePuzzleBoardMetrics(puzzle, { width: 1080, height: 810 }, 300, 992);
	expect(metrics.cellSize).toBeGreaterThanOrEqual(60);
	expect(metrics.cellSize).toBeLessThanOrEqual(78);
});

it('keeps the same fixture near the 84px desktop target with a 352px tray', () => {
	const metrics = getResponsivePuzzleBoardMetrics(puzzle, { width: 1440, height: 900 }, 352, 1344);
	expect(metrics.cellSize).toBeGreaterThanOrEqual(72);
	expect(metrics.cellSize).toBeLessThanOrEqual(90);
});
```

Use ranges because arbitrary aspect/grid math is the product behavior; exact fixture pixel constants are not.

- [ ] **Step 4: Run focused tests and verify failure**

Run:

```bash
bun run --cwd apps/web test:unit -- \
	src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts \
	src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts \
	src/lib/services/puzzleLayout.test.ts \
	src/routes/puzzle/[id]/page.svelte.test.ts
```

Expected: FAIL on sheet states, no-MORE rail, and new geometry.

- [ ] **Step 5: Convert `PuzzleToolbar` from horizontal/MORE menu to responsive control rail**

Preserve the current prop interface and keyboard action model. Remove `moreOpen` and the MORE toggle.

Markup should expose all available actions as icon buttons with existing `data-toolbar-action` values. CSS decides grouping/visibility emphasis:

- phone: right rail, 52px primary targets, Hint gold, glass secondary controls
- landscape tablet: left ~88px rail with ~52px controls
- desktop: left ~96px rail with ~56px controls and redo clearly visible

Low-frequency actions may be lower in the rail or visually quieter, but do not remove their functionality. A vertically scrollable rail is acceptable on short phone heights if required.

- [ ] **Step 6: Convert `PuzzleInventoryPanel` to responsive sheet/docked-tray presentation**

Replace binary `drawerOpen` with `MobileSheetState` for bottom-sheet modes while keeping desktop/tablet docked behavior always open.

Implementation rules:

- default mobile sheet state: `half`
- cycle handle: `peek -> half -> full -> peek`
- hinted piece raises sheet to at least `half`, then retains current filter-reset/scroll behavior
- `data-sheet-state` exposes state for tests
- local sheet state is never dispatched to session store or serializer
- phone target heights use CSS custom properties so safe-area padding does not alter the state machine
- landscape tablet/desktop ignore mobile sheet height and render as right tray
- portrait tablet may use sheet/stacked behavior based on available width/orientation

Keep the existing filter, shuffle, rotate-selected, cancel-selection, roving-focus, rejected/hint styling, and completion message logic.

- [ ] **Step 7: Recompose the puzzle route around rail / board / tray regions**

Do not move route orchestration into new stores. Keep current state/effects/functions and change the rendering shell:

```text
phone:
  full-screen board
  floating HUD top
  floating control rail right
  bottom inventory sheet

landscape tablet:
  control rail | board | docked tray

1440 desktop:
  96px control rail | board | 352px default tray
```

Continue passing CSS variables for board width/height/cell/piece slot. Keep the existing tray resize pointer code for docked layouts.

- [ ] **Step 8: Tune `puzzleLayout.ts` reserves/targets**

Change only constants/helper calculations necessary for the new chrome. Keep:

- dynamic image aspect
- dynamic grid dimensions
- minimum-cell guard
- measured layout-width cap
- existing exported interfaces

Do not add separate `getPhoneGalaxyLayout()` / `getDesktopGalaxyLayout()` functions when CSS can own the chrome.

- [ ] **Step 9: Run gameplay unit tests and E2E behavior suites**

Run:

```bash
bun run --cwd apps/web test:unit -- \
	src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts \
	src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts \
	src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts \
	src/lib/services/puzzleLayout.test.ts \
	src/routes/puzzle/[id]/page.svelte.test.ts
bun run --cwd apps/web test:e2e -- gameplay-mobile-tap.spec.ts
bun run --cwd apps/web test:e2e -- gameplay-interactions.spec.ts
bun run --cwd apps/web test:e2e -- gameplay-session-controls.spec.ts
bun run --cwd apps/web test:e2e:a11y
```

Expected: PASS. Existing portrait-tablet tests in the a11y/extended suites must remain green.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/routes/puzzle/[id]/+page.svelte \
	apps/web/src/routes/puzzle/[id]/page.svelte.test.ts \
	apps/web/src/lib/components/PuzzleToolbar.svelte \
	apps/web/src/lib/components/PuzzleInventoryPanel.svelte \
	apps/web/src/lib/components/__tests__/PuzzleToolbar.svelte.test.ts \
	apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts \
	apps/web/src/lib/services/puzzleLayout.ts \
	apps/web/src/lib/services/puzzleLayout.test.ts \
	apps/web/e2e/gameplay-mobile-tap.spec.ts \
	apps/web/e2e/gameplay-interactions.spec.ts \
	apps/web/e2e/gameplay-session-controls.spec.ts \
	apps/web/e2e/gameplay-accessibility.spec.ts
git commit -m "feat(web): redesign responsive gameplay workspace"
```

---

### Task 5: Redesign completion around finished artwork

**Files:**
- Modify: `apps/web/src/lib/components/PuzzleCompletionDialog.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`
- Modify: `apps/web/e2e/gameplay-interactions.spec.ts` or the existing completion-focused E2E spec that owns the assertions

**Interfaces:**
- Extend `PuzzleCompletionDialog` with one presentation input:

```ts
referenceImageUrl: string | null;
```

- Route obtains the value from the already-loaded `puzzleSource.resolveReferenceImage()`; no extra fetch.
- Existing completion callbacks and award props remain unchanged.

- [ ] **Step 1: Write failing completion tests**

Add assertions for:

- finished artwork renders when `referenceImageUrl` is non-null
- graceful art placeholder when null
- all existing result/final-time/best-time/award/retry testids still render
- play again and back-to-arcade callbacks remain distinct
- modal still has `role="dialog"`, `aria-modal="true"`, and focus trap
- relaxed result still omits timed-only presentation

- [ ] **Step 2: Run completion tests and verify failure**

Run:

```bash
bun run --cwd apps/web test:unit -- \
	src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts \
	src/routes/puzzle/[id]/page.svelte.test.ts
```

Expected: FAIL because the dialog has no artwork prop/composition.

- [ ] **Step 3: Add the reference image prop from the existing source**

In the puzzle route, derive once from the loaded source and pass it to the dialog. Do not call `fetchPuzzle` or `getReferenceImageUrl` again.

- [ ] **Step 4: Recompose the dialog responsively**

Keep one `PuzzleCompletionDialog` markup tree with responsive regions:

- phone: art centered, stars/reward, one large time/result number, four compact stat tiles
- 1080×810 landscape: ~396px art left, results right
- 1440×900: ~504px art left, desktop-scale result pane right

Keep achievements/mastery/server retry available below/within the result pane without turning the canonical fixture into a scrolling phone modal. If award content exceeds the fixture, allow the result pane to scroll rather than clipping data.

Do not add fake star scoring. Stars are a presentation of existing mastery/result state only. If the current award state does not map to three earned levels, render the visual star treatment without creating new persisted semantics.

- [ ] **Step 5: Keep truthful CTA behavior**

Use the mock's candy/glass hierarchy but retain existing actions:

- primary: `PLAY AGAIN` or the most appropriate existing action chosen consistently with current UX
- secondary: `BACK TO ARCADE`
- server retry remains explicit when needed

Do not implement next-puzzle selection.

- [ ] **Step 6: Run focused unit/E2E tests and commit**

Run:

```bash
bun run --cwd apps/web test:unit -- \
	src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts \
	src/routes/puzzle/[id]/page.svelte.test.ts
bun run --cwd apps/web test:e2e -- gameplay-interactions.spec.ts
```

Expected: PASS.

Commit:

```bash
git add apps/web/src/lib/components/PuzzleCompletionDialog.svelte \
	apps/web/src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts \
	apps/web/src/routes/puzzle/[id]/+page.svelte \
	apps/web/src/routes/puzzle/[id]/page.svelte.test.ts \
	apps/web/e2e/gameplay-interactions.spec.ts
git commit -m "feat(web): redesign mission completion results"
```

---

### Task 6: Recompose admin around canonical 4a

**Files:**
- Modify: `apps/web/src/routes/admin/+page.svelte`
- Modify: `apps/web/src/routes/admin/admin-page.svelte.test.ts`
- Modify: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte`
- Modify: `apps/web/src/routes/admin/AdminPuzzlesPanel.svelte.test.ts`
- Modify: `apps/web/src/routes/admin/PlayerAccessPanel.svelte`
- Modify: `apps/web/src/routes/admin/PlayerAccessPanel.svelte.test.ts`
- Reuse: `apps/web/src/lib/components/DifficultyGems.svelte`

**Interfaces:**
- Keep `AdminTab = 'puzzles' | 'players'` route-local.
- Keep existing panel data/service interfaces unchanged.
- Admin sidebar buttons call the route-local `activeTab` setter; no router/store is added.

- [ ] **Step 1: Write failing admin shell/table tests**

Update route tests to require:

- `Missions` and `Player access` controls are in the admin sidebar
- Upload and View arcade are in the same sidebar
- tab roles/`aria-selected`/keyboard Home/End/Arrow behavior remain correct
- only one panel is rendered at a time

Update puzzle-panel tests to require:

- 60px-class thumbnail presentation for ready rows
- status exposes both dot decoration and visible status word
- three gem piece-count groups are rendered
- preview and delete have accessible icon-action labels
- delete remains the destructive action
- search/filter/pagination/polling/delete behavior assertions remain unchanged

- [ ] **Step 2: Run admin tests and verify failure**

Run:

```bash
bun run --cwd apps/web test:unit -- \
	src/routes/admin/admin-page.svelte.test.ts \
	src/routes/admin/AdminPuzzlesPanel.svelte.test.ts \
	src/routes/admin/PlayerAccessPanel.svelte.test.ts
```

Expected: FAIL on new sidebar/table structure.

- [ ] **Step 3: Move admin navigation into a 232px sidebar**

Keep route-local tab handlers. The page becomes:

```text
admin shell
  sidebar
    brand / ADMIN
    Missions [count]
    Player access [count]
    Upload
    View arcade
  selected panel content
```

Use live counts already available to the page/panels; if exposing a count would require duplicating a fetch, omit the decorative count until the panel can report it through a simple callback. Do not add a new admin endpoint solely for sidebar counts.

- [ ] **Step 4: Restyle `AdminPuzzlesPanel` as the 4a database table**

Keep its current load/poll/filter/page/delete functions. Change row composition to the mock:

- 60px thumbnail/status placeholder
- mission name + category
- passive status pill
- easy/normal/hard `DifficultyGems`
- preview icon action
- delete icon action

Use the existing `formatFamilyPieceCounts` data or variant summaries; do not derive a second difficulty model.

- [ ] **Step 5: Restyle `PlayerAccessPanel` to the same tool language**

Preserve add/remove behavior and form semantics. Use readable 13–15px Rajdhani body text and the same surfaces/action hierarchy as 4a.

- [ ] **Step 6: Run admin tests and commit**

Run:

```bash
bun run --cwd apps/web test:unit -- \
	src/routes/admin/admin-page.svelte.test.ts \
	src/routes/admin/AdminPuzzlesPanel.svelte.test.ts \
	src/routes/admin/PlayerAccessPanel.svelte.test.ts
```

Expected: PASS.

Commit:

```bash
git add apps/web/src/routes/admin/+page.svelte \
	apps/web/src/routes/admin/admin-page.svelte.test.ts \
	apps/web/src/routes/admin/AdminPuzzlesPanel.svelte \
	apps/web/src/routes/admin/AdminPuzzlesPanel.svelte.test.ts \
	apps/web/src/routes/admin/PlayerAccessPanel.svelte \
	apps/web/src/routes/admin/PlayerAccessPanel.svelte.test.ts
git commit -m "feat(web): redesign admin control panel"
```

---

### Task 7: Fit unmocked routes into the shell and run full functional regression

**Files:**
- Modify only as needed for shell overlap/theme consistency:
  - `apps/web/src/routes/leaderboard/+page.svelte`
  - `apps/web/src/routes/profile/+page.svelte`
  - `apps/web/src/routes/quick/+page.svelte`
  - `apps/web/src/routes/upload/+page.svelte`
  - `apps/web/src/routes/login/+page.svelte`
  - `apps/web/src/routes/+error.svelte`
- Modify associated tests only where shell/theme structure legitimately changes selectors.

**Interfaces:**
- No route data/service contract changes.

- [ ] **Step 1: Run existing route tests before touching the files**

Run:

```bash
bun run --cwd apps/web test:unit -- \
	src/routes/leaderboard/page.svelte.test.ts \
	src/routes/profile/page.svelte.test.ts \
	src/routes/quick \
	src/routes/upload/page.svelte.test.ts \
	src/routes/login/page.svelte.test.ts \
	src/routes/error.svelte.test.ts
```

Expected: PASS unless earlier shell CSS exposes a real overlap/selector regression.

- [ ] **Step 2: Make only required spacing/readability fixes**

Do not redesign these routes. Fix only:

- content hidden beneath compact header
- width assumptions that conflict with desktop sidebar content area
- obsolete near-black token assumptions that become unreadable after token retune
- shared button classes that need semantic variants

Avoid route-specific decorative redesign work not represented in the mockup.

- [ ] **Step 3: Run the complete web unit/check gate**

Run:

```bash
bun run --cwd apps/web test:unit
bun run --cwd apps/web check
bun run --cwd apps/web lint
```

Expected: PASS.

- [ ] **Step 4: Run core web E2E behavior lanes**

Run:

```bash
bun run --cwd apps/web test:e2e:smoke
bun run --cwd apps/web test:e2e:a11y
bun run --cwd apps/web test:e2e:extended
```

Expected: PASS across desktop, mobile, portrait tablet, and WebKit lanes selected by each script.

- [ ] **Step 5: Commit only if this task required code changes**

```bash
git add apps/web/src/routes apps/web/src/lib/components
# Skip this commit entirely if no files changed.
git commit -m "fix(web): fit existing routes into arcade shell"
```

---

### Task 8: Add and approve visual-parity baselines

**Files:**
- Create: `apps/web/e2e/ui-redesign-visual.spec.ts`
- Create: Playwright screenshot baseline files generated by `toHaveScreenshot()`
- Modify: `apps/web/e2e/gameplay-fixtures/catalog.ts` only if a stable existing fixture cannot expose the needed gallery/completion state; prefer existing fixtures first.

**Interfaces:**
- Use the existing deterministic E2E harness and `e2e/support/test` for gameplay states.
- Do not add production-only fixture hooks.

- [ ] **Step 1: Write the visual test with canonical viewport/state cases**

Structure the spec around explicit named cases:

```ts
test.describe('Galaxy Arcade visual parity', () => {
	test('phone gallery — mock 2a @visual', async ({ page }) => {
		await page.setViewportSize({ width: 393, height: 852 });
		// load deterministic gallery fixture
		await expect(page).toHaveScreenshot('galaxy-phone-gallery.png', { fullPage: true });
	});

	test('landscape tablet gameplay — mock 2e @visual', async ({ gameplayPage, page }) => {
		await page.setViewportSize({ width: 1080, height: 810 });
		await gameplayPage.gotoFixture(/* existing deterministic fixture */);
		await expect(page).toHaveScreenshot('galaxy-tablet-gameplay.png');
	});
});
```

Include canonical cases:

- phone gallery 2a
- phone gameplay 2b
- phone completion 2c
- landscape tablet gallery 2d
- landscape tablet gameplay 2e
- landscape tablet completion 2f
- desktop gallery 3a
- desktop gameplay 3b
- desktop completion 3c
- desktop admin Missions 4a
- desktop admin Player Access 4a

Use stable fixture data and disable incidental animation during screenshot capture through existing reduced-motion/context capabilities, not production feature flags.

- [ ] **Step 2: Run visual tests without baselines and verify expected failure**

Run:

```bash
bun run --cwd apps/web test:e2e -- ui-redesign-visual.spec.ts
```

Expected: FAIL because screenshots have no approved baselines yet.

- [ ] **Step 3: Generate candidate baselines**

Run:

```bash
bun run --cwd apps/web test:e2e -- ui-redesign-visual.spec.ts --update-snapshots
```

Expected: candidate PNG baselines are created.

- [ ] **Step 4: Manually compare every candidate with the supplied mockup before accepting**

Compare composition, hierarchy, dimensions, spacing, palette, glow/candy treatment, icon/gem language, and major typography at the corresponding canonical variant.

Required explicit checks:

- 3a gallery is three columns.
- 2b phone board is full-bleed with right rail and bottom sheet.
- 2e tablet uses left rail + docked right tray at 1080×810.
- 3b desktop uses ~96px rail and ~352px default tray.
- 2c/2f/3c keep finished art dominant.
- 4a uses table rows, passive status pills, 60px thumbnails, gem counts, and red only for delete.

If a candidate differs materially, fix UI code first and regenerate that baseline. Do not bless a mismatched screenshot to make the test pass.

- [ ] **Step 5: Run the visual test against approved baselines**

Run:

```bash
bun run --cwd apps/web test:e2e -- ui-redesign-visual.spec.ts
```

Expected: PASS with no diff.

- [ ] **Step 6: Run final verification before marking the single PR ready**

Run:

```bash
bun run --cwd apps/web lint
bun run --cwd apps/web check
bun run --cwd apps/web test:unit
bun run --cwd apps/web test:e2e:smoke
bun run --cwd apps/web test:e2e:a11y
bun run --cwd apps/web test:e2e:extended
bun run --cwd apps/web test:e2e -- ui-redesign-visual.spec.ts
```

Expected: all commands PASS.

- [ ] **Step 7: Commit visual baselines and final spec-alignment adjustments**

```bash
git add apps/web/e2e/ui-redesign-visual.spec.ts apps/web/e2e/**/*.png
# Include UI files only if Step 4 required final parity adjustments.
git commit -m "test(web): lock galaxy arcade visual parity"
```

---

## Implementation Review Checklist

Before marking the PR ready for review, verify every item:

- [ ] No changes under `apps/mobile`, `apps/api`, `apps/workflows`, `packages/game-core`, `packages/types`, `packages/shared`, or `packages/infrastructure` unless the design was explicitly re-reviewed.
- [ ] No new persistence fields or session codec changes.
- [ ] No new application/global store for visual state.
- [ ] Phone tray state is local and non-persistent.
- [ ] Desktop player sidebar begins only where the canonical desktop layout has room; landscape tablet still matches 2d without a 232px player sidebar.
- [ ] Portrait 768×1024 tablet remains functional.
- [ ] Toolbar/inventory keyboard tests still exercise roving focus after icon conversion.
- [ ] Icon-only controls have stable accessible names.
- [ ] Admin status includes text, not color alone.
- [ ] Gallery desktop is three columns.
- [ ] Completion does not invent a next-puzzle algorithm.
- [ ] Existing behavior E2E suites pass before screenshot baselines are approved.
- [ ] Each visual baseline was compared to the supplied canonical mockup rather than accepted from test output alone.
