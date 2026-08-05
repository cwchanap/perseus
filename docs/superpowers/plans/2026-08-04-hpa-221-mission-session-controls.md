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
- Preserve the existing Play Again read-only guard and old-session clear before creating the replacement run.
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

Append to `session.test.ts`:

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

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/session.test.ts
```

Expected: TypeScript/test failure because `configure_setup` and `setup_configured` do not exist.

- [ ] **Step 3: Extend action, outcome, and invariant documentation**

Append this action member in `types.ts`:

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

Add inside `createPuzzleSession()` before the active rotation handler:

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
		[
			'incorrect attempt',
			{
				counters: { incorrectAttempts: 1, hintsUsed: 0, referenceActivations: 0 }
			}
		],
		[
			'hint use',
			{
				counters: { incorrectAttempts: 0, hintsUsed: 1, referenceActivations: 0 },
				facts: { rotationUsed: true, hintUsed: true, ghostReferenceUsed: false },
				resultClass: 'assisted_timed'
			}
		],
		['completed lifecycle', { lifecycle: 'completed' }]
	] as const)('rejects a false-activity snapshot with %s', (_name, patch) => {
		expect(load({ ...configuredRotation('active'), ...patch }).status).toBe('invalid');
	});
});
```

- [ ] **Step 2: Run the new test and verify the valid rows fail**

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/persistence.validation-activity.test.ts
```

Expected: setup/active/paused rows fail because `rotationUsed: true` currently implies `hasUserActivity: true`.

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

Replace the rejection with:

```ts
if (
	(hasCountedAction || derivedFacts.rotationUsed) &&
	!hasUserActivity &&
	!isPreActivityConfiguredRotation
) {
	return null;
}
```

Do not weaken result-class, rotation-map, counter, timing-quality, or completion-seal checks.

- [ ] **Step 4: Run focused persistence tests**

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

- Produces `GAMEPLAY_PREFERENCES_KEY`, `GameplayPreferences`, `DEFAULT_GAMEPLAY_PREFERENCES`, `loadGameplayPreferences()`, and `saveGameplayPreferences()`.

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
		return isGameplayPreferences(parsed) ? { ...parsed } : { ...DEFAULT_GAMEPLAY_PREFERENCES };
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

Create `SessionDialogs.svelte.test.ts` with tests for mandatory Escape blocking, optional Escape dismissal, inline restart confirmation, one Exit discard action, initial focus, and Tab wrap. Use these exact base props:

```ts
const setupProps = {
	puzzleName: 'Test Mission',
	pieceCount: 4,
	gridCols: 2,
	gridRows: 2,
	draft: {
		mode: 'timed' as const,
		rotationEnabled: false,
		startImmediately: false
	},
	inputHelp: 'Select a piece, then choose its slot.',
	onDraftChange: vi.fn(),
	onStart: vi.fn(),
	onCancel: vi.fn(),
	onExit: vi.fn()
};
```

Representative assertions:

```ts
render(MissionSetupDialog, { props: { ...setupProps, mandatory: true } });
const mandatory = await page.getByRole('dialog', { name: 'Mission Setup' }).element();
mandatory.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
expect(setupProps.onCancel).not.toHaveBeenCalled();
await page.getByRole('button', { name: 'Return to Arcade' }).click();
expect(setupProps.onExit).toHaveBeenCalledOnce();
```

```ts
const view = render(SessionPauseDialog, {
	props: {
		presentation: 'paused',
		mode: 'timed',
		confirmingRestart: false,
		onResume: vi.fn(),
		onRequestRestart: vi.fn(),
		onConfirmRestart: vi.fn(),
		onCancelRestart: vi.fn(),
		onExit: vi.fn()
	}
});
await view.rerender({
	presentation: 'paused',
	mode: 'timed',
	confirmingRestart: true,
	onResume: vi.fn(),
	onRequestRestart: vi.fn(),
	onConfirmRestart: vi.fn(),
	onCancelRestart: vi.fn(),
	onExit: vi.fn()
});
await expect.element(page.getByText('Restart this mission?')).toBeVisible();
expect(await page.getByRole('dialog').all()).toHaveLength(1);
```

- [ ] **Step 2: Run the dialog test and verify module failures**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/SessionDialogs.svelte.test.ts
```

Expected: module-not-found failures.

- [ ] **Step 3: Implement `modalFocus`**

Create `modalFocus.ts`:

```ts
const FOCUSABLE =
	'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function modalFocus(node: HTMLElement, focusKey: unknown = true) {
	const previousFocus =
		document.activeElement instanceof HTMLElement ? document.activeElement : null;
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

- [ ] **Step 4: Implement three presentational components**

Use these prop surfaces:

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

Each component must render one `role="dialog"`/`aria-modal="true"` surface, use `100dvh`, safe-area padding, and an internal scroll container. Use `use:modalFocus={mandatory}` in Mission Setup, `use:modalFocus={confirmingRestart}` in Pause/Resume, and `use:modalFocus` in Exit so focus resets when the Pause body changes. Components contain no session, navigation, persistence, or timer logic.

- [ ] **Step 5: Run dialog tests and verify pass**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/SessionDialogs.svelte.test.ts
```

- [ ] **Step 6: Commit UI primitives**

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
- Produces route-local state only: `sessionDialog`, `setupMandatory`, `setupDraft`, `devicePreferences`, `pausePresentation`, `restartConfirmation`, and `exitOrigin`.

- [ ] **Step 1: Add configurable route-test state**

Add hoisted state with a writable union, not a `'timed'` literal-only inference:

```ts
const preferenceState = vi.hoisted(() => ({
	value: {
		mode: 'timed',
		rotationEnabled: false,
		startImmediately: false
	} as {
		mode: 'timed' | 'relaxed';
		rotationEnabled: boolean;
		startImmediately: boolean;
	},
	save: vi.fn()
}));

const resumableState = vi.hoisted(() => ({ value: false }));
const restoredLifecycleState = vi.hoisted(() => ({
	value: 'active' as 'setup' | 'active' | 'paused' | 'completed'
}));
const timingQualityState = vi.hoisted(() => ({
	value: 'known' as 'known' | 'legacy_unknown'
}));
```

Mock the preference module with `loadGameplayPreferences` returning a clone and `saveGameplayPreferences` using `preferenceState.save`. Update the persistence mock to use `restoredLifecycleState.value`, `timingQualityState.value`, `resumableState.value`, and the real `serializeSession` from `importOriginal`.

- [ ] **Step 2: Write failing entry/setup tests**

Add cases for:

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
```

```ts
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
```

```ts
it('does not auto-skip a restored setup session', async () => {
	preferenceState.value = {
		mode: 'relaxed',
		rotationEnabled: true,
		startImmediately: true
	};
	restoredLifecycleState.value = 'setup';
	setSavedProgress({ placedPieces: [] });
	await renderPuzzlePage();
	await expect.element(page.getByRole('dialog', { name: 'Mission Setup' })).toBeVisible();
	await expect.element(page.getByLabelText('Timed')).toBeChecked();
	await expect.element(page.getByLabelText('Start immediately next time')).toBeChecked();
});
```

- [ ] **Step 3: Add route-local state and setup helpers**

```ts
type SessionDialog = 'setup' | 'pause' | 'exit' | null;

let sessionDialog = $state<SessionDialog>(null);
let setupMandatory = $state(false);
let setupDraft = $state<GameplayPreferences>({ ...DEFAULT_GAMEPLAY_PREFERENCES });
let devicePreferences = $state<GameplayPreferences>({ ...DEFAULT_GAMEPLAY_PREFERENCES });
let pausePresentation = $state<'resume' | 'paused'>('paused');
let restartConfirmation = $state(false);
let exitOrigin = $state<'active' | 'paused'>('active');

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

After subscription and visibility initialization:

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

- [ ] **Step 5: Implement setup confirmation and Open Setup**

Use:

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

Derive:

```ts
const canOpenSetup = $derived(
	sessionState?.lifecycle === 'active' && sessionState.hasUserActivity === false
);
```

- [ ] **Step 6: Extend `PuzzleToolbar` minimally**

Add `onPause`, `onOpenSetup`, and `canOpenSetup`. Render direct Pause and optional Setup buttons. Add `aria-describedby` to the existing disabled rotation button and this fixed hidden text:

```svelte
{#if rotationToggleDisabled}
	<span id="rotation-lock-reason" class="sr-only">
		Rotation is locked after the first placement
	</span>
{/if}
```

- [ ] **Step 7: Render setup outside the inert page**

Derive `hasSessionModal = sessionDialog !== null || showCelebration`, use it for the page `inert`/`aria-hidden`, and render `MissionSetupDialog` outside the inert page when `sessionDialog === 'setup'`.

- [ ] **Step 8: Run route tests and commit**

```bash
cd apps/web
bunx vitest --run --browser src/routes/puzzle/[id]/page.svelte.test.ts
```

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

- Consumes: existing `pause`, `resume`, `restart`, `configure_setup`, `serializeSession`, and `isResumable`.
- Produces private route functions only.

- [ ] **Step 1: Write failing route tests**

Add tests for restored active → Resume with a paused checkpoint, restart confirmation only after activity, Save/Discard exit, and Exit Cancel restoring the correct origin.

Representative assertions:

```ts
setSavedProgress({ placedPieces: [{ pieceId: 0, x: 0, y: 0 }] });
resumableState.value = true;
await renderPuzzlePage();
await expect.element(page.getByRole('dialog', { name: 'Resume Mission' })).toBeVisible();
expect(sessionStorageSpies.saveSession).toHaveBeenCalled();
```

```ts
await page.getByRole('button', { name: 'Pause mission' }).click();
await page.getByRole('button', { name: 'Restart' }).click();
await expect.element(page.getByText('Restart this mission?')).toBeVisible();
await page.getByRole('button', { name: 'Confirm restart' }).click();
await expect.element(page.getByRole('dialog', { name: 'Mission Setup' })).toBeVisible();
```

- [ ] **Step 2: Add one private transient cleanup function**

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

Keep it route-private.

- [ ] **Step 3: Implement Pause and Resume**

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

- [ ] **Step 4: Implement restart composition**

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

Preserve the existing Play Again preamble before calling this helper:

```ts
function handlePlayAgain(): void {
	if (!puzzle || !sessionStore) return;
	persistenceReadOnly = false;
	sessionStorageAdapter.clearSession(puzzle.id);
	restartWithCurrentChoices();
}
```

Do not dispatch `start`; Play Again must open setup.

- [ ] **Step 5: Implement Return to Arcade**

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

Route every Arcade action through `requestReturnToArcade()`.

- [ ] **Step 6: Render Pause and Exit, run tests, commit**

Render `SessionPauseDialog` and `ExitSessionDialog` outside the inert page. Cancel restart sets `restartConfirmation = false` without changing lifecycle.

```bash
cd apps/web
bunx vitest --run --browser src/routes/puzzle/[id]/page.svelte.test.ts
```

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

- Consumes: `sessionState.mode`, `sessionState.timingQuality`, and sealed result class.
- Produces presentation-only derived values; no domain or API changes.

- [ ] **Step 1: Write failing presentation tests**

Add a Relaxed route test that starts the setup flow, asserts `RELAXED`, completes the puzzle, and asserts no `FINAL TIME` or `PERSONAL BEST`. Add a legacy-unknown restored test that asserts `TIME UNAVAILABLE` and no timer wrapper.

- [ ] **Step 2: Add direct presentation derivations**

```ts
const showKnownTimedPresentation = $derived(
	sessionState?.mode === 'timed' && sessionState.timingQuality === 'known'
);
const showRelaxedPresentation = $derived(sessionState?.mode === 'relaxed');
const showUnknownTimePresentation = $derived(
	sessionState?.mode === 'timed' && sessionState.timingQuality === 'legacy_unknown'
);
```

Use a wrapper instead of passing an unsupported prop into `GameTimer`:

```svelte
{#if showKnownTimedPresentation}
	<div data-testid="game-timer">
		<GameTimer {timerState} {bestTime} />
	</div>
{:else if showRelaxedPresentation}
	<div data-testid="relaxed-mode-indicator">RELAXED</div>
{:else if showUnknownTimePresentation}
	<div data-testid="time-unavailable-indicator">TIME UNAVAILABLE</div>
{/if}
```

In completion, render the existing rank/time/best block only for known Timed. Render neutral `MISSION COMPLETE` and no time/best fields for Relaxed or legacy unknown. Leave completion effect dispatch unchanged.

- [ ] **Step 3: Run tests and commit**

```bash
cd apps/web
bunx vitest --run --browser src/routes/puzzle/[id]/page.svelte.test.ts
```

```bash
git add apps/web/src/routes/puzzle/[id]/+page.svelte \
  apps/web/src/routes/puzzle/[id]/page.svelte.test.ts
git commit -m "feat(web): add relaxed session presentation"
```

---

### Task 8: Add deterministic session-control E2E coverage and verify

**Files:**

- Modify: `apps/web/e2e/support/gameplay-page.ts`
- Create: `apps/web/e2e/gameplay-session-controls.spec.ts`

**Interfaces:**

- Extends `GotoFixtureOptions` with `seedPreferences?: GameplayPreferences`.
- Adds `missionSetupDialog()`, `startMission()`, `pauseMission()`, `resumeMission()`, and `readPersistedSession()`.
- Uses existing `ApiScenarioController.recordedRequests` for Relaxed completion assertions.

- [ ] **Step 1: Extend the existing atomic init script**

Import the preferences key/type and add `seedPreferences?: GameplayPreferences`. Add `preferencesJson` and `preferencesKey` to the single existing `addInitScript` argument, then seed:

```ts
if (args.preferencesJson) {
	localStorage.setItem(args.preferencesKey, args.preferencesJson);
}
```

Do not add a second init script.

- [ ] **Step 2: Add concise page-object helpers**

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
	if (options.mode) {
		await dialog.getByLabel(options.mode === 'timed' ? 'Timed' : 'Relaxed').check();
	}
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
```

Add Pause/Resume helpers and `readPersistedSession()` using the existing `progressKey()`.

- [ ] **Step 3: Create the four E2E tests**

Create `gameplay-session-controls.spec.ts` with:

1. Timed setup, first placement, 3 seconds active, 5 seconds paused, 2 seconds resumed, final timer `00:05`.
2. Relaxed completion, no timed labels, recorded request `resultClass === 'relaxed'`.
3. Seeded active Relaxed+rotation session, Resume, Restart, new run ID, empty placements, retained setup choices.
4. `webkit-mobile` setup/Pause action reachability, dynamic-height viewport, and Shift+Tab wrap.

Use `buildMinimalSeed('e2e-square-4')` for the restored test and the existing `ApiScenarioController.recordedRequests` for request inspection.

- [ ] **Step 4: Run focused E2E**

```bash
cd apps/web
bunx playwright test e2e/gameplay-session-controls.spec.ts --project=chromium-desktop
bunx playwright test e2e/gameplay-session-controls.spec.ts --project=webkit-mobile
```

- [ ] **Step 5: Commit E2E coverage**

```bash
git add apps/web/e2e/support/gameplay-page.ts \
  apps/web/e2e/gameplay-session-controls.spec.ts
git commit -m "test(web): cover mission session controls"
```

- [ ] **Step 6: Run complete web verification**

```bash
cd apps/web
bun run check
bun run lint
bun run test:unit
bun run build
bun run test:e2e
bun run test:e2e:webkit
```

Expected: check/lint/build exit 0; all Vitest browser tests pass; Chromium desktop and WebKit critical E2E pass.

- [ ] **Step 7: Inspect final KISS scope**

```bash
git diff --stat main...HEAD
git diff --name-only main...HEAD
```

Confirm no new controller/store, lifecycle, schema version, API route, backend migration, analytics event, modal framework, generic toolbar action model, or `doRestart` behavior change. Confirm route-local dialog state is not serialized.

- [ ] **Step 8: Commit verification-only formatting fixes when files changed**

```bash
git add apps/web
git commit -m "style(web): finalize mission session controls"
```
