# HPA-226 Deterministic Gameplay E2E Design — Review Resolution Addendum

- **Issue:** HPA-226
- **Parent:** HPA-215
- **Date:** 2026-07-31
- **Status:** Normative clarification
- **Base design:**
  [`2026-07-31-hpa-226-deterministic-gameplay-e2e-infrastructure-design.md`](2026-07-31-hpa-226-deterministic-gameplay-e2e-infrastructure-design.md)

This addendum resolves the technical questions raised during review. It is normative and
supersedes the base design where the two differ. All other decisions in the base design remain
unchanged.

## Review Verdict

The review identified two high-value implementation questions and five consistency issues.
Their disposition is:

| Review item | Disposition |
| --- | --- |
| Playwright clock and `performance.now()` | Concern resolved; clarify mandatory `clock.install()` usage and add a contract test |
| WebKit HTML5 drag reliability | Valid; add a spike and explicit gate fallback |
| Runtime dependency signatures | Valid clarification; the proposed API is a route adapter, not an engine-signature mirror |
| Storage medium wording | Valid; canonical session persistence is `localStorage`; other clears are defensive |
| Browser installation cost | Partially valid; dependencies are already installed, but WebKit adds cost and `--only-shell` must be retained |
| Five-fixture wording | Valid; tighten wording |
| E2E alias with missing global | Valid; missing configuration is a hard error |

## 1. Clock Determinism

### Verified behavior

The repository resolves Playwright 1.57.0. In that version, `page.clock.install()` overrides the
browser time surfaces used by the current gameplay clock, including:

- `Date`;
- `setTimeout` and `setInterval`;
- animation and idle callbacks;
- `performance`, including `performance.now()`;
- `Event.timeStamp`.

The route's current `Clock.monotonicNow()` implementation may therefore remain based on
`performance.now()`. HPA-226 does **not** add `Clock` to the E2E runtime dependency seam.

### Required harness behavior

Gameplay tests that assert elapsed active time must call:

```ts
await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
```

before `page.goto()` or any other page operation that can invoke a clock-related browser API.
They advance time with `page.clock.runFor(...)`, `fastForward(...)`, or `pauseAt(...)` as
appropriate.

`page.clock.setFixedTime()` is not sufficient for gameplay timer tests. It fixes `Date` while
allowing normal timer progression, so it may be used only for tests that need stable wall-clock
presentation without deterministic elapsed-time advancement.

### Contract test

Slice 1 adds a small harness contract test that:

1. installs the clock before navigation;
2. reads `performance.now()` from the page;
3. advances the clock by exactly 2,000 ms with `runFor(2000)`;
4. asserts that `performance.now()` advanced by exactly 2,000 ms;
5. proves that the gameplay timer advances by the corresponding whole seconds after a counted
   gameplay action.

If a future Playwright upgrade breaks this contract, the harness test fails before feature E2E
scenarios silently become nondeterministic.

## 2. WebKit HTML5 Drag Gate

HTML5 drag-and-drop reliability in headless WebKit is treated as an implementation risk, not an
assumed capability.

### Slice 1 spike

Before native mouse drag is added to the PR-blocking WebKit set, implementation must run a
CI-like spike against the existing rendered piece and drop-zone path:

1. try Playwright's native `dragTo()` path;
2. if required, try the narrowly scoped standards-shaped drag-event fallback already allowed by
   the base design;
3. run the representative placement test at least 20 consecutive times with `--retries=0` and
   one worker in headless WebKit on the CI operating system;
4. capture traces and geometry for every failure.

### Explicit escape valve

The WebKit project remains PR-blocking for the acceptance criteria that actually require WebKit:
responsive layout, focus compatibility, and critical touch or keyboard placement.

Native HTML5 **mouse drag** becomes part of `@webkit-critical` only when the spike completes with
zero failures. If either the native path or the allowed UI-event fallback remains unreliable:

- WebKit mouse-drag coverage is tagged `@extended` and is not a required PR check;
- the WebKit PR gate uses keyboard or supported touch placement to exercise the shared domain
  placement path;
- the limitation and trace evidence are documented in `apps/web/e2e/README.md`;
- a follow-up issue is linked rather than silently skipping the scenario.

The entire WebKit project is never demoted merely because native HTML5 mouse drag is unreliable.

## 3. Runtime Adapter Signatures

`GameplayRuntimeDependencies` is deliberately a route-level adapter API. It is not intended to
mirror `CreatePuzzleSessionOptions` one-for-one.

The route adapts it as follows:

```ts
const pieceIds = loadedPuzzle.pieces.map((piece) => piece.id);
const runtime = createGameplayRuntimeDependencies();

const store = createPuzzleSessionStore({
	metadata,
	runIdFactory: runtime.runIdFactory,
	clock,
	initialTrayOrder: runtime.createInitialTrayOrder(pieceIds),
	createTrayOrder: () => runtime.createRestartTrayOrder(pieceIds),
	createRotations: (requestedPieceIds) =>
		runtime.createRotations(loadedPuzzle.id, requestedPieceIds)
});
```

The signature differences are intentional:

- `initialTrayOrder` is a value in the engine contract but is generated once by the route
  adapter after puzzle load;
- `createTrayOrder` is a zero-argument engine callback because the route closes over the
  canonical piece IDs;
- the route-level rotation adapter receives `puzzleId` so production can preserve the current
  puzzle-derived seed, then closes over it for the engine callback.

The implementation plan and code comments must call this an **adapter boundary**, not a direct
pass-through interface.

## 4. Storage Reset Semantics

The versioned `PuzzleSession` storage adapter persists session records in `localStorage`, not
`sessionStorage`.

The harness reset policy is clarified as:

- cookies: always cleared for test isolation;
- `localStorage`: always cleared unless the current test explicitly preserves or seeds it;
- `sessionStorage`: cleared defensively because auth or future feature code may use it, but it is
  not the canonical PuzzleSession medium;
- IndexedDB and Cache Storage: defensive future-proof cleanup only when those stores exist; the
  current gameplay implementation does not depend on them.

Documentation and helper names must not imply that PuzzleSession currently uses IndexedDB,
Cache Storage, or `sessionStorage`.

## 5. Browser Installation and CI Cost

The current CI command already uses `--with-deps`, so HPA-226 does not newly introduce Linux
package installation. The cost increase comes from adding the WebKit browser and its additional
required dependency set.

Retain the current Chromium headless-shell optimization:

```json
{
	"test:install-browsers": "playwright install --with-deps --only-shell chromium webkit"
}
```

`--only-shell` affects the Chromium installation and avoids downloading the full Chromium build
for headless CI. WebKit is still installed normally.

The CI and local-command documentation must explicitly call out:

- the additional WebKit browser download and cache footprint;
- the additional WebKit Linux dependencies;
- the reason `--only-shell` remains present;
- that developers running headed Chromium locally may need a separate full-browser install.

## 6. Fixture Count Wording

Use this wording consistently in the spec, PR, and future implementation plan:

> Five deterministic fixtures spanning the three supported aspect ratios, including dedicated
> 4-piece completion, 100-piece layout, and 225-piece large-layout cases.

The three aspect ratios and three notable piece-count cases are coverage dimensions, not six
separate fixtures.

## 7. Missing E2E Global Is a Hard Error

The production no-op module continues to return `null` because the E2E reader is absent from a
normal build.

When the Vite E2E alias is active, the reader has no production-random fallback. The following
conditions throw a deterministic configuration error before `PuzzleSession` construction:

- `window.__PERSEUS_E2E_GAMEPLAY_V1__` is absent;
- the value is not frozen as required by the harness contract;
- the version is unsupported;
- the fixture ID does not match the loaded fixture;
- a run-ID or restart-order sequence is empty or exhausted;
- tray orders, rotations, or IDs fail validation.

This distinguishes two states cleanly:

- **normal build:** physical no-op module, production dependencies are used;
- **E2E build:** aliased reader, complete valid E2E configuration is mandatory.

Forgetting the Playwright init script therefore fails loudly instead of silently using
production randomness.

## Revised Implementation Sequence

1. **Harness contracts and WebKit spike** — verify `performance.now()` clock control, implement
   the hard-error E2E reader contract, and decide native WebKit drag gating using the repeated
   spike.
2. **Playwright baseline** — projects, reporters, artifacts, scripts, browser installation, and
   split CI jobs using the spike result.
3. **Fixture catalog** — typed builder, five fixtures, SVG assets, and fixture router.
4. **Runtime determinism** — route adapter factory, alias-based E2E reader, validation, and
   production-bundle assertion.
5. **State and API controls** — localStorage reset/seeding, defensive secondary-store cleanup,
   auth personas, deferred responses, and failure scenarios.
6. **Gameplay driver** — mouse, keyboard, current tap/touch support, dialog base, and observable
   waits.
7. **Smoke coverage** — skipped-test resolution, small completion, persistence, failure,
   aspect-ratio, and large-fixture scenarios.
8. **Accessibility and documentation** — axe helper, focus/live-region support, E2E guide,
   browser-install cost, and threat analysis.
9. **Stability verification** — repeated, serial, parallel, Chromium, and WebKit runs without
   hidden flakes or arbitrary sleeps.

## Revised Acceptance Clarifications

- Deterministic timer coverage requires the Playwright clock contract test and
  `clock.install()` before navigation.
- WebKit remains a critical PR browser, but native HTML5 mouse drag is critical only after the
  reliability spike passes.
- Runtime dependency signatures are accepted only with the documented route-adapter mapping.
- PuzzleSession reset and seed helpers treat `localStorage` as canonical.
- Browser installation preserves Chromium `--only-shell` and explicitly accounts for WebKit
  cost.
- An E2E build without the init-script global fails before gameplay starts.

## References

- Playwright clock: https://playwright.dev/docs/clock
- Playwright browser installation: https://playwright.dev/docs/browsers
- Playwright command line: https://playwright.dev/docs/test-cli
