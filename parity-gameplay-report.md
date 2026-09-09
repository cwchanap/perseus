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
- Svelte autofixer — zero issues for all six edited Svelte files.

## Fresh visual evidence

Named baselines were regenerated in the final 3999/4273 run and are tracked under:

- `apps/web/e2e/ui-redesign-visual.spec.ts-snapshots/galaxy-phone-gallery-chromium-desktop-darwin.png`
- `apps/web/e2e/ui-redesign-visual.spec.ts-snapshots/galaxy-phone-gameplay-chromium-desktop-darwin.png`
- `apps/web/e2e/ui-redesign-visual.spec.ts-snapshots/galaxy-tablet-gallery-chromium-desktop-darwin.png`
- `apps/web/e2e/ui-redesign-visual.spec.ts-snapshots/galaxy-tablet-gameplay-chromium-desktop-darwin.png`
- `apps/web/e2e/ui-redesign-visual.spec.ts-snapshots/galaxy-desktop-gallery-chromium-desktop-darwin.png`
- `apps/web/e2e/ui-redesign-visual.spec.ts-snapshots/galaxy-desktop-gameplay-chromium-desktop-darwin.png`

## Review follow-ups

The fresh visual captures still show two responsive details for the independent gameplay review: the 300px tablet tray header can clip the first filter against the compact count chip, and the disabled Redo presentation needs the final More-menu placement when it becomes enabled after Undo. The current candidate keeps all handlers and focus semantics intact so those can be corrected in the scoped follow-up without changing the gameplay engine.
