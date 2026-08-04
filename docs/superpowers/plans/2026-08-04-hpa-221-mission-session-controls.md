# HPA-221 Mission Session Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add mission setup, deliberate resume, explicit pause, restart/exit controls, and Relaxed presentation while keeping `PuzzleSession` as the only canonical run-state owner.

**Architecture:** Add one setup-only `configure_setup` action and one bounded schema-v1 persistence exception for configured rotation before activity. Keep preferences, dialogs, and orchestration route-owned; compose the existing `restart`, `pause`, `resume`, and completion paths rather than adding lifecycle or controller abstractions.

**Tech Stack:** Svelte 5, SvelteKit, TypeScript 5.9, Vitest Browser Mode, Playwright, Bun, existing `PuzzleSession` domain/persistence services.

## Global Constraints

- `PuzzleSession` remains the sole canonical owner of lifecycle, mode, timing, run ID, placements, rotation, result class, and persisted run state.
- Add exactly one domain action: setup-only `configure_setup`.
- Do not modify `doRestart`; route code captures mode/rotation and composes `restart` → `configure_setup`.
- Do not add `reopen_setup`, an active-session setup mutator, a lifecycle transition, a coordinator store, or persisted UI state.
- Keep the persisted session at schema version `1`; the validator change is backward-compatible and requires no migration.
- Device preferences use only `perseus-gameplay-preferences-v1` with `{ mode, rotationEnabled, startImmediately }`.
- Start Immediately applies only to fresh route entry; explicit Restart and Play Again always show setup.
- Existing `hasUserActivity` semantics remain the only resumability and restart-confirmation threshold.
- The existing active rotation toggle remains available until the first successful placement and exposes the fixed reason `Rotation is locked after the first placement` afterward.
- Relaxed uses the existing `relaxed` result class and sealed-completion transport; no backend or API changes.
- Use three focused dialog components and one focus action; do not build a modal manager, dialog stack, or generic disabled-reason system.
- Dialogs must support `390 × 844`, safe-area insets, dynamic viewport height, orientation/browser-chrome changes, and predictable focus restoration.
- Use four representative E2E flows; keep exhaustive state/focus permutations in unit and component tests.

---

## File Structure

### Create

- `apps/web/src/lib/services/gameplay/session/preferences.ts` — synchronous, injectable local-storage codec for mode, rotation, and Start Immediately.
- `apps/web/src/lib/services/gameplay/session/preferences.test.ts` — defaults, round-trip, corrupt input, and unavailable-storage tests.
- `apps/web/src/lib/services/gameplay/session/persistence.validation-activity.test.ts` — table-driven pre-activity rotation validation cases.
- `apps/web/src/lib/actions/modalFocus.ts` — focus entry, Tab containment, and restoration for conditionally rendered dialogs.
- `apps/web/src/lib/components/MissionSetupDialog.svelte` — setup form and mandatory/optional Escape behavior.
- `apps/web/src/lib/components/SessionPauseDialog.svelte` — Resume/Pause surface plus inline restart confirmation.
- `apps/web/src/lib/components/ExitSessionDialog.svelte` — Save, Discard, and Cancel actions.
- `apps/web/src/lib/components/__tests__/SessionDialogs.svelte.test.ts` — focused dialog behavior and accessibility tests.
- `apps/web/e2e/gameplay-session-controls.spec.ts` — the four integrated HPA-221 flows.

### Modify

- `apps/web/src/lib/services/gameplay/session/types.ts` — action/outcome types and the pre-activity `SessionFacts` invariant comment.
- `apps/web/src/lib/services/gameplay/session/session.ts` — setup-only `configure_setup` transition.
- `apps/web/src/lib/services/gameplay/session/session.test.ts` — configuration and post-start rejection tests.
- `apps/web/src/lib/services/gameplay/session/persistence.ts` — one named pre-activity configured-rotation predicate.
- `apps/web/src/lib/components/PuzzleToolbar.svelte` — Pause/Open Setup callbacks and fixed rotation-lock explanation.
- `apps/web/src/routes/puzzle/[id]/+page.svelte` — entry orchestration, dialogs, pause/restart/exit flows, and Relaxed/legacy presentation.
- `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts` — route integration coverage and configurable persistence/preference mocks.
- `apps/web/e2e/support/gameplay-page.ts` — preference seeding and session-control helpers.

---

### Task 1: Add setup-only `configure_setup`

**Files:**
- Modify: `apps/web/src/lib/services/gameplay/session/types.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/session.ts`
- Test: `apps/web/src/lib/services/gameplay/session/session.test.ts`

**Interfaces:**
- Consumes: existing `SessionMode`, `createRotations`, `recomputeResultClass()`, `makeHistoryBaseline()`.
- Produces: action `{ type: 'configure_setup'; mode: SessionMode; rotationEnabled: boolean }` and outcome `{ type: 'setup_configured'; mode: SessionMode; rotationEnabled: boolean }`.

- [ ] **Step 1: Write failing setup-configuration tests**

Append these cases to `session.test.ts`:

```ts
it('configures mode and rotation in setup without activity or a new run id', () => {
	const session = createPuzzleSession({
		...makeOptions(),
		createRotations: () => ({ 0: 90, 1: 180, 2: 270, 3: 0 })
	});
	const originalRunId = session.getState().runId;

	expect(
		session.dispatch({ type: 'configure_setup', mode: 'relaxed', rotationEnabled: true })
	).toEqual({ type: 'setup_configured', mode: 'relaxed', rotationEnabled: true });

	const relaxed = session.getState();
	expect(relaxed.runId).toBe(originalRunId);
	expect(relaxed.lifecycle).toBe('setup');
	expect(relaxed.mode).toBe('relaxed');
	expect(relaxed.elapsedActiveSeconds).toBeNull();
	expect(relaxed.timerStarted).toBe(false);
	expect(relaxed.rotationEnabled).toBe(true);
	expect(relaxed.pieceRotations).toEqual({ 0: 90, 1: 180, 2: 270, 3: 0 });
	expect(relaxed.facts.rotationUsed).toBe(true);
	expect(relaxed.resultClass).toBe('relaxed');
	expect(relaxed.hasUserActivity).toBe(false);
	expect(relaxed.canUndo).toBe(false);
	expect(relaxed.canRedo).toBe(false);

	session.dispatch({ type: 'configure_setup', mode: 'timed', rotationEnabled: false });
	const timed = session.getState();
	expect(timed.runId).toBe(originalRunId);
	expect(timed.mode).toBe('timed');
	expect(timed.elapsedActiveSeconds).toBe(0);
	expect(timed.rotationEnabled).toBe(false);
	expect(timed.pieceRotations).toEqual({});
	expect(timed.facts.rotationUsed).toBe(false);
	expect(timed.resultClass).toBe('standard_timed');
	expect(timed.hasUserActivity).toBe(false);
});

it('rejects configure_setup after start', () => {
	const session = createPuzzleSession(makeOptions());
	session.dispatch({ type: 'start' });

	expect(
		session.dispatch({ type: 'configure_setup', mode: 'relaxed', rotationEnabled: true })
	).toEqual({ type: 'lifecycle_noop', reason: 'lifecycle_disallows' });
	expect(session.getState().mode).toBe('timed');
	expect(session.getState().rotationEnabled).toBe(false);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/session.test.ts
```

Expected: TypeScript/test failure because `configure_setup` and `setup_configured` do not exist.

- [ ] **Step 3: Extend the action, outcome, and invariant documentation**

In `types.ts`, append this action member:

```ts
| { type: 'configure_setup'; mode: SessionMode; rotationEnabled: boolean }
```

Append this outcome member:

```ts
| { type: 'setup_configured'; mode: SessionMode; rotationEnabled: boolean }
```

Replace the unconditional `SessionFacts` monotonicity comment with:

```ts
/**
 * Eligibility facts may be revised while a run is still in setup and has no
 * user activity. Once activity begins, they are monotonic and may only move
 * toward less-competitive result classes. They remain outside undo/redo.
 */
```

- [ ] **Step 4: Implement the minimal setup transition**

Add this helper inside `createPuzzleSession()` before the active rotation handler:

```ts
function doConfigureSetup(
	mode: PuzzleSessionState['mode'],
	rotationEnabled: boolean
): PuzzleSessionOutcome {
	if (state.lifecycle !== 'setup') {
		return { type: 'lifecycle_noop', reason: 'lifecycle_disallows' };
	}

	const ids = metadata.pieces.map((piece) => piece.id);
	const pieceRotations = rotationEnabled
		? validateAndCloneRotations(createRotations(ids), pieceById)
		: {};

	state.mode = mode;
	state.elapsedActiveSeconds = mode === 'timed' ? 0 : null;
	state.timerStarted = false;
	state.rotationEnabled = rotationEnabled;
	state.pieceRotations = pieceRotations;
	state.facts = { ...state.facts, rotationUsed: rotationEnabled };
	state.resultClass = recomputeResultClass();
	state.hasUserActivity = false;
	state.selectedPieceId = null;
	state.activeReferenceMode = null;
	state.canUndo = false;
	state.canRedo = false;
	placementHistory = makeHistoryBaseline(state);
	notify();

	return { type: 'setup_configured', mode, rotationEnabled };
}
```

Add the dispatch branch:

```ts
case 'configure_setup':
	return doConfigureSetup(action.mode, action.rotationEnabled);
```

Do not change `doRestart()` or `doSetRotationMode()`.

- [ ] **Step 5: Run the focused test and verify pass**

Run:

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/session.test.ts
```

Expected: all `session.test.ts` tests pass.

- [ ] **Step 6: Commit the domain change**

```bash
git add apps/web/src/lib/services/gameplay/session/types.ts \
  apps/web/src/lib/services/gameplay/session/session.ts \
  apps/web/src/lib/services/gameplay/session/session.test.ts
git commit -m "feat(web): add puzzle setup configuration action"
```

---

### Task 2: Permit only valid pre-activity rotation snapshots

**Files:**
- Create: `apps/web/src/lib/services/gameplay/session/persistence.validation-activity.test.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.ts`

**Interfaces:**
- Consumes: `validSnapshot()`, `load()`, schema-v1 cross-field validation.
- Produces: one local boolean named `isPreActivityConfiguredRotation` used only by the existing activity consistency check.

- [ ] **Step 1: Write table-driven acceptance and near-miss tests**

Create `persistence.validation-activity.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { PersistedPuzzleSessionV1 } from './types';
import { load, validSnapshot } from './persistence.test-fixtures';

function configuredRotation(
	lifecycle: PersistedPuzzleSessionV1['lifecycle']
): PersistedPuzzleSessionV1 {
	return {
		...validSnapshot(),
		lifecycle,
		elapsedActiveSeconds: 0,
		timerStarted: false,
		placedPieces: [],
		rotationEnabled: true,
		pieceRotations: { 0: 90, 1: 180, 2: 270, 3: 0 },
		counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
		facts: { rotationUsed: true, hintUsed: false, ghostReferenceUsed: false },
		hasUserActivity: false,
		resultClass: 'rotation_timed',
		sealedCompletion: null
	};
}

describe('pre-activity configured rotation validation', () => {
	it.each(['setup', 'active', 'paused'] as const)(
		'loads a configured rotation snapshot in %s lifecycle',
		(lifecycle) => {
			expect(load(configuredRotation(lifecycle))).toMatchObject({ status: 'loaded' });
		}
	);

	it.each([
		['started timer', { timerStarted: true }],
		['placed piece', { placedPieces: [{ pieceId: 0, x: 0, y: 0 }] }],
		['incorrect attempt', {
			counters: { incorrectAttempts: 1, hintsUsed: 0, referenceActivations: 0 }
		}],
		['hint use', {
			counters: { incorrectAttempts: 0, hintsUsed: 1, referenceActivations: 0 },
			facts: { rotationUsed: true, hintUsed: true, ghostReferenceUsed: false },
			resultClass: 'assisted_timed'
		}],
		['completed lifecycle', { lifecycle: 'completed' }]
	] as const)('rejects a false-activity snapshot with %s', (_name, patch) => {
		expect(load({ ...configuredRotation('active'), ...patch }).status).toBe('invalid');
	});
});
```

- [ ] **Step 2: Run the new test and verify the valid rows fail**

Run:

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/persistence.validation-activity.test.ts
```

Expected: the setup/active/paused rows fail because `rotationUsed: true` currently implies `hasUserActivity: true`.

- [ ] **Step 3: Add the bounded predicate in the existing validator**

Immediately before the current activity rejection in `validateV1()`, add:

```ts
const isPreActivityConfiguredRotation =
	derivedFacts.rotationUsed &&
	hasRotations &&
	!hasUserActivity &&
	placedPieces.length === 0 &&
	counters.incorrectAttempts === 0 &&
	counters.hintsUsed === 0 &&
	counters.referenceActivations === 0 &&
	timerStarted === false &&
	lifecycle !== 'completed' &&
	record.sealedCompletion === null;
```

Replace the existing rejection with:

```ts
if (
	(hasCountedAction || derivedFacts.rotationUsed) &&
	!hasUserActivity &&
	!isPreActivityConfiguredRotation
) {
	return null;
}
```

Do not weaken any result-class, rotation-map, counter, timing-quality, or completion-seal checks.

- [ ] **Step 4: Run focused persistence tests**

Run:

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/services/gameplay/session/persistence.validation-activity.test.ts \
  src/lib/services/gameplay/session/persistence.validation-storage.test.ts \
  src/lib/services/gameplay/session/persistence.validation-completion.test.ts
```

Expected: all focused persistence tests pass.

- [ ] **Step 5: Commit the validator change**

```bash
git add apps/web/src/lib/services/gameplay/session/persistence.ts \
  apps/web/src/lib/services/gameplay/session/persistence.validation-activity.test.ts
git commit -m "fix(web): allow configured rotation before activity"
```

---

### Task 3: Add the tiny device-preferences codec

**Files:**
- Create: `apps/web/src/lib/services/gameplay/session/preferences.ts`
- Create: `apps/web/src/lib/services/gameplay/session/preferences.test.ts`

**Interfaces:**
- Produces:
  - `GAMEPLAY_PREFERENCES_KEY`
  - `GameplayPreferences`
  - `DEFAULT_GAMEPLAY_PREFERENCES`
  - `loadGameplayPreferences(storage?: Storage): GameplayPreferences`
  - `saveGameplayPreferences(preferences: GameplayPreferences, storage?: Storage): void`

- [ ] **Step 1: Write failing codec tests**

Create `preferences.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { memoryStorage } from './persistence.test-fixtures';
import {
	DEFAULT_GAMEPLAY_PREFERENCES,
	GAMEPLAY_PREFERENCES_KEY,
	loadGameplayPreferences,
	saveGameplayPreferences
} from './preferences';

describe('gameplay preferences', () => {
	it('returns defaults when missing', () => {
		expect(loadGameplayPreferences(memoryStorage({}))).toEqual(DEFAULT_GAMEPLAY_PREFERENCES);
	});

	it('round-trips mode, rotation, and Start Immediately', () => {
		const store: Record<string, string> = {};
		const storage = memoryStorage(store);
		const preferences = {
			mode: 'relaxed' as const,
			rotationEnabled: true,
			startImmediately: true
		};

		saveGameplayPreferences(preferences, storage);

		expect(JSON.parse(store[GAMEPLAY_PREFERENCES_KEY])).toEqual(preferences);
		expect(loadGameplayPreferences(storage)).toEqual(preferences);
	});

	it('falls back for corrupt values', () => {
		const storage = memoryStorage({
			[GAMEPLAY_PREFERENCES_KEY]: JSON.stringify({
				mode: 'fast',
				rotationEnabled: 'yes',
				startImmediately: 1
			})
		});

		expect(loadGameplayPreferences(storage)).toEqual(DEFAULT_GAMEPLAY_PREFERENCES);
	});

	it('does not throw when storage is unavailable', () => {
		const storage = memoryStorage({});
		storage.getItem = () => {
			throw new Error('read denied');
		};
		storage.setItem = () => {
			throw new Error('write denied');
		};

		expect(loadGameplayPreferences(storage)).toEqual(DEFAULT_GAMEPLAY_PREFERENCES);
		expect(() => saveGameplayPreferences(DEFAULT_GAMEPLAY_PREFERENCES, storage)).not.toThrow();
	});
});
```

- [ ] **Step 2: Run the test and verify failure**

Run:

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/preferences.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement the minimal codec**

Create `preferences.ts`:

```ts
import type { SessionMode } from './types';

export const GAMEPLAY_PREFERENCES_KEY = 'perseus-gameplay-preferences-v1';

export interface GameplayPreferences {
	mode: SessionMode;
	rotationEnabled: boolean;
	startImmediately: boolean;
}

export const DEFAULT_GAMEPLAY_PREFERENCES: GameplayPreferences = {
	mode: 'timed',
	rotationEnabled: false,
	startImmediately: false
};

function browserStorage(): Storage | undefined {
	try {
		return typeof localStorage === 'undefined' ? undefined : localStorage;
	} catch {
		return undefined;
	}
}

function isGameplayPreferences(value: unknown): value is GameplayPreferences {
	if (!value || typeof value !== 'object') return false;
	const record = value as Record<string, unknown>;
	return (
		(record.mode === 'timed' || record.mode === 'relaxed') &&
		typeof record.rotationEnabled === 'boolean' &&
		typeof record.startImmediately === 'boolean'
	);
}

export function loadGameplayPreferences(
	storage: Storage | undefined = browserStorage()
): GameplayPreferences {
	if (!storage) return { ...DEFAULT_GAMEPLAY_PREFERENCES };
	try {
		const raw = storage.getItem(GAMEPLAY_PREFERENCES_KEY);
		if (raw === null) return { ...DEFAULT_GAMEPLAY_PREFERENCES };
		const parsed: unknown = JSON.parse(raw);
		return isGameplayPreferences(parsed)
			? { ...parsed }
			: { ...DEFAULT_GAMEPLAY_PREFERENCES };
	} catch {
		return { ...DEFAULT_GAMEPLAY_PREFERENCES };
	}
}

export function saveGameplayPreferences(
	preferences: GameplayPreferences,
	storage: Storage | undefined = browserStorage()
): void {
	if (!storage) return;
	try {
		storage.setItem(GAMEPLAY_PREFERENCES_KEY, JSON.stringify(preferences));
	} catch {
		// Device preferences are best effort and never block play.
	}
}
```

- [ ] **Step 4: Run the codec test and verify pass**

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/preferences.test.ts
```

Expected: all four tests pass.

- [ ] **Step 5: Commit the codec**

```bash
git add apps/web/src/lib/services/gameplay/session/preferences.ts \
  apps/web/src/lib/services/gameplay/session/preferences.test.ts
git commit -m "feat(web): add gameplay setup preferences"
```

---

### Task 4: Extract focus handling and add three dialog components

**Files:**
- Create: `apps/web/src/lib/actions/modalFocus.ts`
- Create: `apps/web/src/lib/components/MissionSetupDialog.svelte`
- Create: `apps/web/src/lib/components/SessionPauseDialog.svelte`
- Create: `apps/web/src/lib/components/ExitSessionDialog.svelte`
- Create: `apps/web/src/lib/components/__tests__/SessionDialogs.svelte.test.ts`

**Interfaces:**
- Produces `modalFocus(node: HTMLElement, focusKey?: unknown)`.
- `MissionSetupDialog` consumes a `GameplayPreferences` draft and emits whole-draft changes.
- `SessionPauseDialog` owns no state; `confirmingRestart` selects normal versus confirmation content.
- `ExitSessionDialog` owns no state and exposes Save, Discard, and Cancel callbacks.

- [ ] **Step 1: Write dialog behavior tests**

Create `SessionDialogs.svelte.test.ts` with these representative cases:

```ts
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import MissionSetupDialog from '../MissionSetupDialog.svelte';
import SessionPauseDialog from '../SessionPauseDialog.svelte';
import ExitSessionDialog from '../ExitSessionDialog.svelte';

const draft = {
	mode: 'timed' as const,
	rotationEnabled: false,
	startImmediately: false
};

describe('session dialogs', () => {
	it('keeps mandatory setup open on Escape and exposes Return to Arcade', async () => {
		const onCancel = vi.fn();
		const onExit = vi.fn();
		render(MissionSetupDialog, {
			props: {
				puzzleName: 'Test Mission',
				pieceCount: 4,
				gridCols: 2,
				gridRows: 2,
				draft,
				mandatory: true,
				inputHelp: 'Select a piece, then choose its slot.',
				onDraftChange: vi.fn(),
				onStart: vi.fn(),
				onCancel,
				onExit
			}
		});

		const dialog = page.getByRole('dialog', { name: 'Mission Setup' });
		await expect.element(dialog).toBeVisible();
		await dialog.element().then((element) =>
			element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
		);
		expect(onCancel).not.toHaveBeenCalled();
		await page.getByRole('button', { name: 'Return to Arcade' }).click();
		expect(onExit).toHaveBeenCalledOnce();
	});

	it('dismisses optional setup on Escape', async () => {
		const onCancel = vi.fn();
		render(MissionSetupDialog, {
			props: {
				puzzleName: 'Test Mission',
				pieceCount: 4,
				gridCols: 2,
				gridRows: 2,
				draft,
				mandatory: false,
				inputHelp: 'Select a piece, then choose its slot.',
				onDraftChange: vi.fn(),
				onStart: vi.fn(),
				onCancel,
				onExit: vi.fn()
			}
		});

		const dialog = await page.getByRole('dialog', { name: 'Mission Setup' }).element();
		dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(onCancel).toHaveBeenCalledOnce();
	});

	it('switches Pause content to restart confirmation without another dialog', async () => {
		const onRequestRestart = vi.fn();
		const view = render(SessionPauseDialog, {
			props: {
				presentation: 'paused',
				mode: 'timed',
				confirmingRestart: false,
				onResume: vi.fn(),
				onRequestRestart,
				onConfirmRestart: vi.fn(),
				onCancelRestart: vi.fn(),
				onExit: vi.fn()
			}
		});

		await page.getByRole('button', { name: 'Restart' }).click();
		expect(onRequestRestart).toHaveBeenCalledOnce();
		await view.rerender({
			presentation: 'paused',
			mode: 'timed',
			confirmingRestart: true,
			onResume: vi.fn(),
			onRequestRestart,
			onConfirmRestart: vi.fn(),
			onCancelRestart: vi.fn(),
			onExit: vi.fn()
		});
		await expect.element(page.getByText('Restart this mission?')).toBeVisible();
		expect(await page.getByRole('dialog').all()).toHaveLength(1);
	});

	it('exposes one discard confirmation in Exit', async () => {
		const onDiscard = vi.fn();
		render(ExitSessionDialog, {
			props: { onSave: vi.fn(), onDiscard, onCancel: vi.fn() }
		});
		await page.getByRole('button', { name: 'Discard & Exit' }).click();
		expect(onDiscard).toHaveBeenCalledOnce();
	});
});
```

- [ ] **Step 2: Run the dialog test and verify module failures**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/SessionDialogs.svelte.test.ts
```

Expected: module-not-found failures for the new action/components.

- [ ] **Step 3: Implement `modalFocus`**

Create `modalFocus.ts`:

```ts
const FOCUSABLE =
	'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function modalFocus(node: HTMLElement, focusKey: unknown = true) {
	const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	let activeKey = focusKey;
	let focusTimer: ReturnType<typeof setTimeout> | null = null;

	const focusable = () =>
		Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
			(element) => element.offsetParent !== null
		);

	const focusFirst = () => {
		if (focusTimer !== null) clearTimeout(focusTimer);
		focusTimer = setTimeout(() => focusable()[0]?.focus(), 0);
	};

	const trap = (event: KeyboardEvent) => {
		if (event.key !== 'Tab') return;
		const elements = focusable();
		if (elements.length === 0) return;
		const first = elements[0];
		const last = elements[elements.length - 1];
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	};

	document.addEventListener('keydown', trap);
	focusFirst();

	return {
		update(nextKey: unknown) {
			if (nextKey === activeKey) return;
			activeKey = nextKey;
			focusFirst();
		},
		destroy() {
			if (focusTimer !== null) clearTimeout(focusTimer);
			document.removeEventListener('keydown', trap);
			setTimeout(() => previousFocus?.focus(), 0);
		}
	};
}
```

- [ ] **Step 4: Implement the three presentational components**

Use native inputs/buttons and the existing gameplay modal classes. Required prop surfaces:

```ts
// MissionSetupDialog.svelte
interface Props {
	puzzleName: string;
	pieceCount: number;
	gridCols: number;
	gridRows: number;
	draft: GameplayPreferences;
	mandatory: boolean;
	inputHelp: string;
	onDraftChange: (draft: GameplayPreferences) => void;
	onStart: () => void;
	onCancel: () => void;
	onExit: () => void;
}
```

```ts
// SessionPauseDialog.svelte
interface Props {
	presentation: 'resume' | 'paused';
	mode: SessionMode;
	confirmingRestart: boolean;
	onResume: () => void;
	onRequestRestart: () => void;
	onConfirmRestart: () => void;
	onCancelRestart: () => void;
	onExit: () => void;
}
```

```ts
// ExitSessionDialog.svelte
interface Props {
	onSave: () => void;
	onDiscard: () => void;
	onCancel: () => void;
}
```

Each component must:

- render exactly one `role="dialog"`/`aria-modal="true"` surface;
- use `use:modalFocus` on the dialog box;
- use `100dvh`, `env(safe-area-inset-*)`, and an internal scroll container;
- call `onCancel` on Escape only where the surface is dismissible;
- contain no session store, navigation, persistence, or timer logic.

- [ ] **Step 5: Run dialog tests and verify pass**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/SessionDialogs.svelte.test.ts
```

Expected: all dialog tests pass.

- [ ] **Step 6: Commit the UI primitives**

```bash
git add apps/web/src/lib/actions/modalFocus.ts \
  apps/web/src/lib/components/MissionSetupDialog.svelte \
  apps/web/src/lib/components/SessionPauseDialog.svelte \
  apps/web/src/lib/components/ExitSessionDialog.svelte \
  apps/web/src/lib/components/__tests__/SessionDialogs.svelte.test.ts
git commit -m "feat(web): add mission session dialogs"
```

---

### Task 5: Wire fresh/restored setup entry and toolbar controls

**Files:**
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/lib/components/PuzzleToolbar.svelte`
- Test: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**
- Consumes: `configure_setup`, preference codec, `MissionSetupDialog`.
- Produces route-local state:
  - `sessionDialog: 'setup' | 'pause' | 'exit' | null`
  - `setupMandatory: boolean`
  - `setupDraft: GameplayPreferences`
  - `devicePreferences: GameplayPreferences`
  - `pausePresentation: 'resume' | 'paused'`
  - `restartConfirmation: boolean`
  - `exitOrigin: 'active' | 'paused'`

- [ ] **Step 1: Add configurable preference and resumability mocks to route tests**

In `page.svelte.test.ts`, add hoisted state:

```ts
const preferenceState = vi.hoisted(() => ({
	value: {
		mode: 'timed' as const,
		rotationEnabled: false,
		startImmediately: false
	},
	save: vi.fn()
}));

const resumableState = vi.hoisted(() => ({ value: false }));
```

Mock the preference module:

```ts
vi.mock('$lib/services/gameplay/session/preferences', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('$lib/services/gameplay/session/preferences')>();
	return {
		...actual,
		loadGameplayPreferences: vi.fn(() => ({ ...preferenceState.value })),
		saveGameplayPreferences: preferenceState.save
	};
});
```

Change the persistence mock to keep the real `serializeSession` and use:

```ts
isResumable: () => resumableState.value
```

Reset both hoisted states in `beforeEach()`.

- [ ] **Step 2: Write failing route tests for entry/setup behavior**

Add these cases:

```ts
it('shows configured setup for a fresh session', async () => {
	preferenceState.value = {
		mode: 'relaxed',
		rotationEnabled: true,
		startImmediately: false
	};
	await renderPuzzlePage();

	await expect.element(page.getByRole('dialog', { name: 'Mission Setup' })).toBeVisible();
	await expect.element(page.getByLabelText('Relaxed')).toBeChecked();
	await expect.element(page.getByLabelText('Enable rotation')).toBeChecked();
});

it('starts a fresh session immediately from preferences', async () => {
	preferenceState.value = {
		mode: 'timed',
		rotationEnabled: false,
		startImmediately: true
	};
	await renderPuzzlePage();

	await expect.element(page.getByRole('dialog', { name: 'Mission Setup' })).not.toBeInTheDocument();
	await expect.element(page.getByRole('button', { name: 'Open mission setup' })).toBeVisible();
});

it('does not auto-skip a restored setup session', async () => {
	preferenceState.value = {
		mode: 'relaxed',
		rotationEnabled: true,
		startImmediately: true
	};
	progressState.value = {
		puzzleId: 'test-puzzle',
		placedPieces: [],
		rotationEnabled: false,
		pieceRotations: {},
		lastUpdated: '2024-01-01T00:00:00.000Z'
	};
	// Extend the existing mock snapshot selector so this case returns lifecycle setup.
	await renderPuzzlePage();

	await expect.element(page.getByRole('dialog', { name: 'Mission Setup' })).toBeVisible();
	await expect.element(page.getByLabelText('Timed')).toBeChecked();
	await expect.element(page.getByLabelText('Start immediately next time')).toBeChecked();
});
```

Add a hoisted `restoredLifecycleState` with default `'active'`, use it in the storage mock, and set it to `'setup'` in the restored setup test.

- [ ] **Step 3: Add the local route state and helpers**

At route scope add:

```ts
type SessionDialog = 'setup' | 'pause' | 'exit' | null;

let sessionDialog = $state<SessionDialog>(null);
let setupMandatory = $state(false);
let setupDraft = $state<GameplayPreferences>({ ...DEFAULT_GAMEPLAY_PREFERENCES });
let devicePreferences = $state<GameplayPreferences>({ ...DEFAULT_GAMEPLAY_PREFERENCES });
let pausePresentation = $state<'resume' | 'paused'>('paused');
let restartConfirmation = $state(false);
let exitOrigin = $state<'active' | 'paused'>('active');
```

Add:

```ts
function draftFromSession(): GameplayPreferences {
	return {
		mode: sessionState?.mode ?? devicePreferences.mode,
		rotationEnabled: sessionState?.rotationEnabled ?? devicePreferences.rotationEnabled,
		startImmediately: devicePreferences.startImmediately
	};
}

function showMissionSetup(mandatory: boolean): void {
	setupDraft = draftFromSession();
	setupMandatory = mandatory;
	sessionDialog = 'setup';
}
```

- [ ] **Step 4: Replace route auto-start with explicit entry handling**

After store subscription and visibility initialization:

```ts
devicePreferences = loadGameplayPreferences();

if (!restored) {
	store.dispatch({
		type: 'configure_setup',
		mode: devicePreferences.mode,
		rotationEnabled: devicePreferences.rotationEnabled
	});
	if (devicePreferences.startImmediately) {
		store.dispatch({ type: 'start' });
	} else {
		showMissionSetup(true);
	}
} else if (restored.lifecycle === 'setup') {
	showMissionSetup(true);
} else if (restored.lifecycle === 'active') {
	store.dispatch({ type: 'pause' });
	checkpointSession();
	pausePresentation = 'resume';
	sessionDialog = 'pause';
} else if (restored.lifecycle === 'paused') {
	pausePresentation = 'resume';
	sessionDialog = 'pause';
}
```

Remove the old unconditional fresh/setup auto-start block.

Add setup confirmation:

```ts
function confirmMissionSetup(): void {
	if (!sessionStore || !sessionState) return;
	saveGameplayPreferences(setupDraft);
	devicePreferences = { ...setupDraft };

	if (sessionState.lifecycle === 'setup') {
		sessionStore.dispatch({
			type: 'configure_setup',
			mode: setupDraft.mode,
			rotationEnabled: setupDraft.rotationEnabled
		});
		sessionStore.dispatch({ type: 'start' });
		checkpointSession();
		sessionDialog = null;
		return;
	}

	const settingsChanged =
		setupDraft.mode !== sessionState.mode ||
		setupDraft.rotationEnabled !== sessionState.rotationEnabled;
	if (!settingsChanged) {
		sessionDialog = null;
		return;
	}

	const next = { ...setupDraft };
	sessionStore.dispatch({ type: 'restart' });
	sessionStore.dispatch({
		type: 'configure_setup',
		mode: next.mode,
		rotationEnabled: next.rotationEnabled
	});
	sessionStore.dispatch({ type: 'start' });
	checkpointSession();
	pendingViewportReset = true;
	sessionDialog = null;
}
```

Add Open Setup only when:

```ts
const canOpenSetup = $derived(
	sessionState?.lifecycle === 'active' && sessionState.hasUserActivity === false
);
```

- [ ] **Step 5: Extend `PuzzleToolbar` minimally**

Add props:

```ts
onPause: () => void;
onOpenSetup: () => void;
canOpenSetup: boolean;
```

Render direct buttons for Pause and optional Setup. For the existing rotation button use:

```svelte
aria-describedby={rotationToggleDisabled ? 'rotation-lock-reason' : undefined}
```

and render:

```svelte
{#if rotationToggleDisabled}
	<span id="rotation-lock-reason" class="sr-only">
		Rotation is locked after the first placement
	</span>
{/if}
```

Do not add a generic toolbar action model or disabled-reason component.

- [ ] **Step 6: Render `MissionSetupDialog` and inert the page**

Derive:

```ts
const hasSessionModal = $derived(sessionDialog !== null || showCelebration);
```

Use it for the page `inert`/`aria-hidden` attributes. Render `MissionSetupDialog` outside the inert page when `sessionDialog === 'setup'`, passing puzzle metadata, `setupDraft`, `setupMandatory`, `confirmMissionSetup`, optional cancel, and Return to Arcade.

- [ ] **Step 7: Run focused route tests**

```bash
cd apps/web
bunx vitest --run --browser src/routes/puzzle/[id]/page.svelte.test.ts
```

Expected: new entry/setup cases and existing route integration tests pass.

- [ ] **Step 8: Commit entry/setup integration**

```bash
git add apps/web/src/routes/puzzle/[id]/+page.svelte \
  apps/web/src/routes/puzzle/[id]/page.svelte.test.ts \
  apps/web/src/lib/components/PuzzleToolbar.svelte
git commit -m "feat(web): add mission setup entry flow"
```

---

### Task 6: Wire pause, restart, replay, and exit composition

**Files:**
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Test: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**
- Consumes: existing `pause`, `resume`, `restart`, `configure_setup`, `serializeSession`, `isResumable`.
- Produces private route functions only; no new shared service.

- [ ] **Step 1: Write failing route tests for control flows**

Add cases that assert:

```ts
it('shows Resume for a restored active session and checkpoints paused lifecycle', async () => {
	setSavedProgress({ placedPieces: [{ pieceId: 0, x: 0, y: 0 }] });
	resumableState.value = true;
	await renderPuzzlePage();

	await expect.element(page.getByRole('dialog', { name: 'Resume Mission' })).toBeVisible();
	expect(sessionStorageSpies.saveSession).toHaveBeenCalled();
});

it('confirms restart only after existing activity', async () => {
	await renderPuzzlePage();
	await page.getByRole('button', { name: 'Start Mission' }).click();
	await placePiece(0, 0, 0);
	await page.getByRole('button', { name: 'Pause mission' }).click();
	await page.getByRole('button', { name: 'Restart' }).click();

	await expect.element(page.getByText('Restart this mission?')).toBeVisible();
	await page.getByRole('button', { name: 'Confirm restart' }).click();
	await expect.element(page.getByRole('dialog', { name: 'Mission Setup' })).toBeVisible();
});

it('discards only the active session on exit', async () => {
	resumableState.value = true;
	await renderPuzzlePage();
	await page.getByRole('button', { name: 'Start Mission' }).click();
	await placePiece(0, 0, 0);
	await page.getByRole('button', { name: 'Return to arcade' }).click();
	await page.getByRole('button', { name: 'Discard & Exit' }).click();

	expect(sessionStorageSpies.clearSession).toHaveBeenCalledWith('test-puzzle');
	expect(goto).toHaveBeenCalledWith('/');
});
```

Update role names to match the final component copy exactly.

- [ ] **Step 2: Run the focused route test and verify failure**

```bash
cd apps/web
bunx vitest --run --browser src/routes/puzzle/[id]/page.svelte.test.ts
```

Expected: failures because Pause/Restart/Exit handlers are not wired.

- [ ] **Step 3: Add one private transient cleanup function**

Move the existing blur/reference cleanup into:

```ts
function clearTransientGameplayState(): void {
	if (referenceHoldSource !== null) {
		sessionStore?.dispatch({ type: 'set_reference_mode', mode: null });
	}
	showReferenceOverlay = false;
	referencePointerId = null;
	referenceHoldSource = null;
	sessionStore?.dispatch({ type: 'cancel_selection' });
	clearHintTarget();
	if (rejectedPieceTimeout !== null) clearTimeout(rejectedPieceTimeout);
	rejectedPieceTimeout = null;
	rejectedPiece = null;
	isPanning = false;
	activePanPointerId = null;
}
```

Keep the helper route-private.

- [ ] **Step 4: Implement Pause and Resume handlers**

```ts
function openPauseDialog(presentation: 'resume' | 'paused' = 'paused'): void {
	if (sessionState?.lifecycle === 'active') {
		clearTransientGameplayState();
		sessionStore?.dispatch({ type: 'pause' });
		checkpointSession();
	}
	pausePresentation = presentation;
	restartConfirmation = false;
	sessionDialog = 'pause';
}

function resumeSession(): void {
	sessionStore?.dispatch({ type: 'resume' });
	restartConfirmation = false;
	sessionDialog = null;
}
```

Use `openPauseDialog` for the toolbar Pause action. Restored active loading may dispatch `pause` directly before calling `openPauseDialog('resume')` to avoid duplicate dispatch.

- [ ] **Step 5: Implement restart/replay through route composition**

```ts
function restartWithCurrentChoices(): void {
	if (!sessionStore || !sessionState) return;
	const mode = sessionState.mode;
	const rotationEnabled = sessionState.rotationEnabled;

	clearTransientGameplayState();
	showCelebration = false;
	isNewBest = false;
	localStatsFailed = false;
	sessionStore.dispatch({ type: 'restart' });
	sessionStore.dispatch({ type: 'configure_setup', mode, rotationEnabled });
	checkpointSession();
	devicePreferences = loadGameplayPreferences();
	showMissionSetup(true);
	restartConfirmation = false;
	pendingViewportReset = true;
}

function requestRestart(): void {
	if (sessionState?.hasUserActivity) {
		restartConfirmation = true;
		return;
	}
	restartWithCurrentChoices();
}
```

Change Play Again to call `restartWithCurrentChoices()` and do not dispatch `start`; setup must always open after replay.

- [ ] **Step 6: Implement Return to Arcade and exit-origin restoration**

```ts
function currentRunIsResumable(): boolean {
	if (!sessionState) return false;
	const snapshot = serializeSession(sessionState);
	return snapshot ? sessionStorageAdapter.isResumable(snapshot) : false;
}

function requestReturnToArcade(): void {
	if (!currentRunIsResumable()) {
		persistSessionFinal();
		void goto(resolve('/'));
		return;
	}

	exitOrigin = sessionState?.lifecycle === 'paused' ? 'paused' : 'active';
	if (exitOrigin === 'active') {
		clearTransientGameplayState();
		sessionStore?.dispatch({ type: 'pause' });
		checkpointSession();
	}
	sessionDialog = 'exit';
}

function saveAndExit(): void {
	persistSessionFinal();
	void goto(resolve('/'));
}

function discardAndExit(): void {
	if (puzzle) sessionStorageAdapter.clearSession(puzzle.id);
	void goto(resolve('/'));
}

function cancelExit(): void {
	if (exitOrigin === 'active') {
		sessionStore?.dispatch({ type: 'resume' });
		sessionDialog = null;
	} else {
		pausePresentation = 'paused';
		sessionDialog = 'pause';
	}
}
```

Route the header Arcade action, mandatory setup Exit, Pause Exit, and completion Back to Arcade through `requestReturnToArcade()`.

- [ ] **Step 7: Render Pause and Exit dialogs**

Render `SessionPauseDialog` for `sessionDialog === 'pause'` and `ExitSessionDialog` for `sessionDialog === 'exit'`. The Pause component receives `restartConfirmation`; Cancel restart sets it back to false without changing lifecycle.

- [ ] **Step 8: Run route tests and verify pass**

```bash
cd apps/web
bunx vitest --run --browser src/routes/puzzle/[id]/page.svelte.test.ts
```

Expected: new pause/restart/exit tests and existing route tests pass.

- [ ] **Step 9: Commit session-control integration**

```bash
git add apps/web/src/routes/puzzle/[id]/+page.svelte \
  apps/web/src/routes/puzzle/[id]/page.svelte.test.ts
git commit -m "feat(web): add pause restart and exit controls"
```

---

### Task 7: Add Relaxed and legacy-unknown presentation rules

**Files:**
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Test: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**
- Consumes: existing `sessionState.mode`, `sessionState.timingQuality`, and sealed result class.
- Produces presentation-only derived values; no domain or API changes.

- [ ] **Step 1: Write failing presentation tests**

Add route cases:

```ts
it('shows Relaxed without timed HUD or completion claims', async () => {
	preferenceState.value = {
		mode: 'relaxed',
		rotationEnabled: false,
		startImmediately: false
	};
	await renderPuzzlePage();
	await page.getByRole('button', { name: 'Start Mission' }).click();

	await expect.element(page.getByTestId('relaxed-mode-indicator')).toHaveTextContent('RELAXED');
	await expect.element(page.getByTestId('game-timer')).not.toBeInTheDocument();

	await placePiece(0, 0, 0);
	await placePiece(1, 1, 0);
	const dialog = page.getByRole('dialog', { name: /Test Mission/i });
	await expect.element(dialog.getByText('MISSION COMPLETE')).toBeVisible();
	await expect.element(dialog.getByText('FINAL TIME')).not.toBeInTheDocument();
	await expect.element(dialog.getByText('PERSONAL BEST')).not.toBeInTheDocument();
});

it('does not show timed-best claims for legacy-unknown resumed runs', async () => {
	setSavedProgress({ placedPieces: [{ pieceId: 0, x: 0, y: 0 }] });
	// Extend the storage mock with timingQualityOverride = 'legacy_unknown'.
	await renderPuzzlePage();

	await expect.element(page.getByTestId('time-unavailable-indicator')).toHaveTextContent(
		'TIME UNAVAILABLE'
	);
	await expect.element(page.getByTestId('game-timer')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run route tests and verify failure**

```bash
cd apps/web
bunx vitest --run --browser src/routes/puzzle/[id]/page.svelte.test.ts
```

Expected: failures because timed UI is unconditional.

- [ ] **Step 3: Add direct presentation derivations**

```ts
const showKnownTimedPresentation = $derived(
	sessionState?.mode === 'timed' && sessionState.timingQuality === 'known'
);
const showRelaxedPresentation = $derived(sessionState?.mode === 'relaxed');
const showUnknownTimePresentation = $derived(
	sessionState?.mode === 'timed' && sessionState.timingQuality === 'legacy_unknown'
);
```

In the HUD:

- render `<GameTimer data-testid="game-timer">` only for known Timed;
- render `RELAXED` for Relaxed;
- render `TIME UNAVAILABLE` for legacy unknown.

In completion:

- render the existing timed rank/time/best block only for known Timed;
- render neutral `MISSION COMPLETE` and no time/best fields for Relaxed or legacy unknown;
- leave completion effect dispatch and request projection unchanged.

Pass mode into `SessionPauseDialog` so Resume/Pause labels identify Relaxed directly.

- [ ] **Step 4: Run route tests and verify pass**

```bash
cd apps/web
bunx vitest --run --browser src/routes/puzzle/[id]/page.svelte.test.ts
```

Expected: all route integration tests pass.

- [ ] **Step 5: Commit presentation changes**

```bash
git add apps/web/src/routes/puzzle/[id]/+page.svelte \
  apps/web/src/routes/puzzle/[id]/page.svelte.test.ts
git commit -m "feat(web): add relaxed session presentation"
```

---

### Task 8: Add deterministic session-control E2E coverage and verify the feature

**Files:**
- Modify: `apps/web/e2e/support/gameplay-page.ts`
- Create: `apps/web/e2e/gameplay-session-controls.spec.ts`

**Interfaces:**
- Extends `GotoFixtureOptions` with `seedPreferences?: GameplayPreferences`.
- Adds helpers for setup, pause/resume, and reading the current persisted session.
- Uses existing `ApiScenarioController.recordedRequests` for Relaxed completion assertions.

- [ ] **Step 1: Extend atomic fixture initialization with preferences**

Import:

```ts
import {
	GAMEPLAY_PREFERENCES_KEY,
	type GameplayPreferences
} from '../../src/lib/services/gameplay/session/preferences';
```

Add to `GotoFixtureOptions`:

```ts
seedPreferences?: GameplayPreferences;
```

Add `preferencesJson` and `preferencesKey` to the single existing `addInitScript` argument. Inside the script, after storage clear and before freezing gameplay config:

```ts
if (args.preferencesJson) {
	localStorage.setItem(args.preferencesKey, args.preferencesJson);
}
```

Do not add a second init script.

- [ ] **Step 2: Add concise page-object helpers**

Add:

```ts
missionSetupDialog(): Locator {
	return this.page.getByRole('dialog', { name: 'Mission Setup' });
}

async startMission(options: {
	mode?: 'timed' | 'relaxed';
	rotationEnabled?: boolean;
	startImmediately?: boolean;
} = {}): Promise<void> {
	const dialog = this.missionSetupDialog();
	await expect(dialog).toBeVisible();
	if (options.mode) await dialog.getByLabel(options.mode === 'timed' ? 'Timed' : 'Relaxed').check();
	if (options.rotationEnabled !== undefined) {
		await dialog.getByLabel('Enable rotation').setChecked(options.rotationEnabled);
	}
	if (options.startImmediately !== undefined) {
		await dialog
			.getByLabel('Start immediately next time')
			.setChecked(options.startImmediately);
	}
	await dialog.getByRole('button', { name: 'Start Mission' }).click();
	await expect(dialog).not.toBeVisible();
}

async pauseMission(): Promise<Locator> {
	await this.page.getByRole('button', { name: 'Pause mission' }).click();
	const dialog = this.page.getByRole('dialog', { name: 'Mission Paused' });
	await expect(dialog).toBeVisible();
	return dialog;
}

async resumeMission(dialog: Locator): Promise<void> {
	await dialog.getByRole('button', { name: 'Resume' }).click();
	await expect(dialog).not.toBeVisible();
}
```

Add `readPersistedSession()` by reading `progressKey(this.fixture!.fixtureId)` and parsing it as `PersistedPuzzleSessionV1 | null`.

- [ ] **Step 3: Write the four E2E tests**

Create `gameplay-session-controls.spec.ts`:

```ts
import { test, expect } from './support/test';
import { buildMinimalSeed } from './gameplay-fixtures/persisted-state';

test.describe('Mission session controls', () => {
	test('Timed setup, pause, and resume exclude decision time @smoke', async ({
		gameplayPage,
		page
	}) => {
		await gameplayPage.gotoFixture({
			clock: { startAt: new Date('2026-08-04T12:00:00Z') }
		});
		await gameplayPage.startMission({ mode: 'timed' });
		await gameplayPage.selectAndPlaceWithKeyboard(0, 0, 0);
		await page.clock.runFor(3_000);
		const pause = await gameplayPage.pauseMission();
		await page.clock.runFor(5_000);
		await gameplayPage.resumeMission(pause);
		await page.clock.runFor(2_000);
		await expect(page.getByTestId('game-timer')).toContainText('00:05');
	});

	test('Relaxed completion uses relaxed result class and no timed claims @smoke', async ({
		gameplayPage,
		page
	}) => {
		await gameplayPage.gotoFixture({ completion: { kind: 'success' } });
		await gameplayPage.startMission({ mode: 'relaxed' });
		await gameplayPage.solveFixture();

		await expect(page.getByText('FINAL TIME')).not.toBeVisible();
		const request = gameplayPage.apiController.recordedRequests.at(-1)?.bodyJson as {
			resultClass?: string;
		};
		expect(request.resultClass).toBe('relaxed');
	});

	test('restored active run resumes then restarts with retained choices @smoke', async ({
		gameplayPage,
		page
	}) => {
		const seed = {
			...buildMinimalSeed('e2e-square-4'),
			mode: 'relaxed' as const,
			rotationEnabled: true,
			pieceRotations: { 0: 90, 1: 180, 2: 270, 3: 0 },
			facts: { rotationUsed: true, hintUsed: false, ghostReferenceUsed: false },
			resultClass: 'relaxed' as const
		};
		await gameplayPage.gotoFixture({ seedSession: seed });

		const resume = page.getByRole('dialog', { name: 'Resume Mission' });
		await expect(resume).toBeVisible();
		await resume.getByRole('button', { name: 'Restart' }).click();
		await expect(gameplayPage.missionSetupDialog()).toBeVisible();
		await expect(gameplayPage.missionSetupDialog().getByLabel('Relaxed')).toBeChecked();
		await expect(gameplayPage.missionSetupDialog().getByLabel('Enable rotation')).toBeChecked();
		const restarted = await gameplayPage.readPersistedSession();
		expect(restarted?.runId).not.toBe(seed.runId);
		expect(restarted?.placedPieces).toEqual([]);
	});

	test('mobile dialogs keep actions reachable and focus contained @webkit-critical', async ({
		gameplayPage,
		page
	}) => {
		test.skip(test.info().project.name !== 'webkit-mobile');
		await gameplayPage.gotoFixture();
		const setup = gameplayPage.missionSetupDialog();
		await expect(setup.getByRole('button', { name: 'Start Mission' })).toBeInViewport();
		await gameplayPage.startMission();
		const pause = await gameplayPage.pauseMission();
		const first = pause.getByRole('button', { name: 'Resume' });
		const last = pause.getByRole('button', { name: 'Return to Arcade' });
		await first.focus();
		await page.keyboard.press('Shift+Tab');
		await expect(last).toBeFocused();
	});
});
```

Use the exact fixture ID type accepted by `buildMinimalSeed`; if `GameplayFixtureId` is required for the literal, retain the literal `e2e-square-4` as shown.

- [ ] **Step 4: Run the new E2E file in Chromium desktop**

```bash
cd apps/web
bunx playwright test e2e/gameplay-session-controls.spec.ts --project=chromium-desktop
```

Expected: the three non-WebKit cases pass; the WebKit-only case skips.

- [ ] **Step 5: Run the mobile/WebKit critical case**

```bash
cd apps/web
bunx playwright test e2e/gameplay-session-controls.spec.ts --project=webkit-mobile
```

Expected: all applicable cases pass, including focus containment.

- [ ] **Step 6: Commit E2E coverage**

```bash
git add apps/web/e2e/support/gameplay-page.ts \
  apps/web/e2e/gameplay-session-controls.spec.ts
git commit -m "test(web): cover mission session controls"
```

- [ ] **Step 7: Run complete web verification**

Run in this order:

```bash
cd apps/web
bun run check
bun run lint
bun run test:unit
bun run build
bun run test:e2e
bun run test:e2e:webkit
```

Expected:

- `svelte-check` reports 0 errors and 0 warnings introduced by HPA-221;
- Prettier/ESLint pass;
- all Vitest browser tests pass;
- production build exits 0;
- Chromium desktop E2E passes;
- WebKit critical E2E passes.

- [ ] **Step 8: Inspect the final diff against KISS guardrails**

Run:

```bash
git diff --stat main...HEAD
git diff --name-only main...HEAD
```

Confirm:

- no new controller/store, lifecycle, schema version, API route, backend migration, analytics event, modal framework, or generic toolbar action model;
- `doRestart()` remains behaviorally unchanged;
- all new shared files have one responsibility;
- route-local dialog state is not serialized.

- [ ] **Step 9: Commit any verification-only formatting fixes**

Only when verification changed files:

```bash
git add apps/web
git commit -m "style(web): finalize mission session controls"
```
