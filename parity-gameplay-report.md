# Gameplay parity repair B

## Scope

- Reworked the gameplay toolbar, HUD, board, tray, and mobile sheet presentation using the existing Svelte components and gameplay handlers.
- Preserved board geometry, drag and tap placement, toolbar actions, inventory filters, rotation, drawer state, roving focus, and accessible labels.
- Switched the visual fixture to `apps/web/e2e/fixtures/galaxy-reference-art.png`, the supplied deterministic 504x673 reference artwork. Gallery product behavior is unchanged; its visual baselines were refreshed because the shared visual thumbnail input changed.

## Verification

- `bun run check --filter=@perseus/web` — passed, 0 errors and 0 warnings.
- `bun run --cwd apps/web test:unit -- src/lib/services/puzzleLayout.test.ts` — passed, 13 tests.
- `bun run --cwd apps/web test:unit -- src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts` — passed, 28 tests.
- Phone accessibility lane on API `3999` / web preview `4273` — passed, 4 tests.
- Focused phone workspace and inventory-fit checks on API `3999` / web preview `4273` — passed, 2 tests.
- Required visual lane on API `3999` / web preview `4273`, updating the six affected named baselines — passed, 6 tests (`2a`, `2b`, `2d`, `2e`, `3a`, `3b`).
- Focused toolbar interaction checks on API `3999` / web preview `4273` — passed, 2 tests, including enabled Redo after Undo staying behind More on phone.
- Focused inventory component tests — passed, 28 tests after the tray-header sizing change.
- Round-2 inventory disclosure check on API `3999` / web preview `4273` — passed, 1 Chromium tablet test. Enter opens the native `More Filters` disclosure, its Corner action receives focus, and Enter closes it again.
- Round-2 coarse-pointer geometry assertions — passed for the phone and tablet layouts. Every visible interactive tray control is at least `44px × 44px`; the count chip remains excluded from the hit-target minimum while still participating in the tray bounds and overlap checks.
- Fresh gameplay-only visual lane on API `3999` / web preview `4273` — passed, 3 tests while regenerating `2b`, `2e`, and `3b`; the repeat without snapshot updates also passed, 3 tests.
- The `2e` geometry assertion now checks the count chip, every filter button, and the tray handle for in-tray bounds and pairwise non-overlap at the 1080px tablet viewport.
- Official absolute `local-playwright.config.ts` Chromium-desktop run — passed, 3 fresh gameplay updates and a 3-test repeat. The named baselines were written at `02:39:25`, `02:39:27`, and `02:39:29` PDT for phone, tablet, and desktop respectively.
- Svelte autofixer — zero issues for `PuzzleInventoryPanel.svelte`; its remaining suggestions are the component's existing effect/action advisories.

## Fresh visual evidence

Named baselines were regenerated in the final 3999/4273 run and are tracked under:

- `apps/web/e2e/ui-redesign-visual.spec.ts-snapshots/galaxy-phone-gallery-chromium-desktop-darwin.png`
- `apps/web/e2e/ui-redesign-visual.spec.ts-snapshots/galaxy-phone-gameplay-chromium-desktop-darwin.png`
- `apps/web/e2e/ui-redesign-visual.spec.ts-snapshots/galaxy-tablet-gallery-chromium-desktop-darwin.png`
- `apps/web/e2e/ui-redesign-visual.spec.ts-snapshots/galaxy-tablet-gameplay-chromium-desktop-darwin.png`
- `apps/web/e2e/ui-redesign-visual.spec.ts-snapshots/galaxy-desktop-gallery-chromium-desktop-darwin.png`
- `apps/web/e2e/ui-redesign-visual.spec.ts-snapshots/galaxy-desktop-gameplay-chromium-desktop-darwin.png`

## Review follow-ups

Round 2 addresses the reviewer hit-target finding without duplicating action DOM. Phone and desktop keep the direct filter actions; the 1024–1279px tablet header keeps `All` direct and places Corner, Edge, Center, and Shuffle behind the native `More Filters` disclosure. Closed tablet filter actions are hidden from focus, and the opened menu preserves their existing labels, pressed state, and handlers. The toolbar retains one Redo action in the secondary group: desktop and tablet extract it into the direct rail order, while phone keeps the same action hidden with More closed and visible in the open More menu after Undo. Gallery product behavior and gallery baselines were not changed in this follow-up.

The final browser review should still recheck the apparent desktop Undo rail-width difference noted during screenshot inspection; the round-2 CSS is scoped to inventory classes and does not alter `PuzzleToolbar`.
