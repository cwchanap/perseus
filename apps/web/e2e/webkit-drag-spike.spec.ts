// WebKit mouse-drag stability spike.
//
// Runs a single mouse-drag placement test 20 times on webkit-mobile to
// determine whether Playwright's dragTo() is reliable for HTML5 drag-and-drop
// on WebKit.
//
// IMPORTANT: this test calls dragTo() directly — NOT placeWithMouse (which
// falls back to dispatching DnD events when dragTo fails). The spike's purpose
// is to measure raw dragTo() reliability so we can decide whether native mouse
// drag tests belong in @webkit-critical or @extended.
//
// Run with:
//
//   bun run --cwd apps/web test:e2e -- e2e/webkit-drag-spike.spec.ts \
//     --project=webkit-mobile --repeat-each=20 --retries=0 --workers=1
//
// Outcome decision:
//
// - 0/20 failures  → native mouse drag is reliable → tag mouse drag tests
//                    as @webkit-critical.
// - any failure    → mouse drag is unreliable on WebKit → move mouse drag
//                    tests to @extended; keep keyboard/touch as
//                    @webkit-critical. File a follow-up issue.
//
// RESULT: 0/20 pass — dragTo() does not produce a drop event for HTML5 DnD
// on WebKit (webkit-mobile). Every attempt left the piece in the tray.
//
// Action taken:
//   - Mouse drag tests tagged @extended in gameplay-interactions.spec.ts.
//   - Keyboard, touch, and dialog tests tagged @webkit-critical.
//   - placeWithMouse falls back to dispatching DnD events (dragover + drop)
//     when dragTo() does not register a drop, so it remains usable across
//     all browsers.
//   - Follow-up: investigate WebKit-compatible mouse drag (e.g. CDP input
//     dispatch, or a dedicated WebKit drag simulation path).
import { test, expect } from './support/test';

test('webkit mouse drag places a piece (stability spike)', async ({ gameplayPage, page }) => {
	await gameplayPage.gotoFixture();
	// Call dragTo() directly — no DnD-dispatch fallback — to measure raw
	// dragTo() reliability on WebKit.
	const source = gameplayPage.pieceSource(0);
	const target = gameplayPage.dropZone(0, 0);
	await source.dragTo(target);
	// Verify placement with no fallback.
	await expect(page.getByTestId('piece-slot-0')).toHaveCount(0);
});
