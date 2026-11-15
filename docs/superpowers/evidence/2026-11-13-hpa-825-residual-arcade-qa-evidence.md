# HPA-825 — Supplemental evidence extract (redacted)

Factual supporting evidence for the disposition table in
[`2026-11-13-hpa-825-residual-arcade-qa.md`](../plans/2026-11-13-hpa-825-residual-arcade-qa.md). This file is a
transcription of recorded run outcomes, capture observations and manifest excerpts; the table in the plan
is the **sole disposition record**. The original command logs, manifests and frame PNGs were local
worktree scratch, are **not** retained in the repository and are not hosted. The upload question was
explicitly deferred and never attempted, so no evidence exists for it.

## Shared environment

- Runs executed 2026-11-14 (drag lane) and 2026-11-14/15 (paint captures) on branch HEAD `c47315bb`
  (merge-base with `origin/main`: `0fe71b87`; `origin/main` at test time: `4b582ae9`).
- Post-fix HPA-1026 verification runs executed 2026-11-15 on branch HEAD `0360cfb6` (`c2ecc595` avatar
  accessible-name fix plus `0360cfb6` test coverage); the `c47315bb`-era runs above are pre-fix history.
- macOS 26.6.2 arm64; Playwright 1.64.1; bundled Chromium 156.0.8078.4; local E2E harness
  (Playwright-managed API on :3999, production-mode web preview on :4173).
- Production paint captures: read-only `GET` navigations against `https://perseus.cwchanap.dev/` with
  `cf-cache-status: HIT` on every capture; production revision candidate is the successful deploy run
  [43544192168](https://github.com/cwchanap/perseus/actions/runs/43544192168) for `ca379441` (exact
  served SHA unverified — recorded limitation).
- Screencast/screenshot frame cadence ~10–80 ms; transients shorter than the cadence are unobservable.

## Native pointer placement — automated run outcomes (2026-11-14, 18:48–19:00 UTC)

| Command                                                                                                | Exit | Outcome (Playwright summary)               |
| ------------------------------------------------------------------------------------------------------ | ---- | ------------------------------------------ |
| `bun run --cwd apps/web test:e2e`                                                                      | 1    | 111 passed / 7 skipped / 2 failed (27.2 s) |
| `bun run --cwd apps/web test:e2e:smoke`                                                                | 0    | 167 passed / 9 skipped / 0 failed (22.0 s) |
| `bun run --cwd apps/web test:e2e:extended -- gameplay-interactions.spec.ts --project=chromium-desktop` | 0    | 10 passed / 0 failed (14.4 s)              |

Key recorded lines (strict `placeWithMouse`, no synthetic DnD fallback on `chromium-desktop`):

- `✓ [chromium-desktop] › e2e/gameplay-interactions.spec.ts:30 › correct placement places the piece at
its target cell @smoke` — native `dragstart` → `drop` accepted by the engine.
- `✓ [chromium-desktop] › gameplay-interactions.spec.ts:38 › mouse @extended › rejected placement keeps
the piece in the tray (517ms)` — wrong-cell drop produced an explicit engine rejection, piece retained
  in tray; the same test passed on the four non-desktop projects via the documented mobile/WebKit
  fallback (2.0–2.4 s each).

Notes:

- Appending `--project=chromium-desktop` to `test:e2e:extended` did **not** narrow the run: the script itself
  names five projects (`chromium-desktop`, `chromium-mobile`, `chromium-tablet`, `webkit-mobile`,
  `webkit-tablet`) and Playwright accumulates repeated `--project` flags, so the command ran all five
  (10 passed = 2 `@extended` tests × 5 projects). The evidence above is from the `chromium-desktop`
  project within that five-project run; targeting desktop only requires invoking Playwright directly with
  a single `--project=chromium-desktop` (verified via `--list`: 2 tests).
- The two default-lane failures are the pre-existing axe `label-content-name-mismatch` (serious)
  `.profile-avatar` finding described in the plan's out-of-scope paragraph (`gallery.spec.ts` bookmark
  round-trip, `gameplay-accessibility.spec.ts` authenticated gallery). Both reproduced deterministically
  across three runs and targeted `-g` re-runs (exit 1 each time); the branch diff touches no app code.

## Cold first paint — capture observations (2026-11-14 headed, 2026-11-15 headless recheck)

Captured sequence per scenario (relWallMs after navigation start → average frame RGB):

| Scenario                  | Captured sequence                                                                                                              | fp/fcp (ms) |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| cold-cachedisabled        | 1 ms white `(255,255,255)` → 172 ms dark shell `(10,6,33)` → 338 ms shell+spinner `(17,15,41)` → 1955 ms gallery `(95,84,104)` | 160/340     |
| cold-freshcontext         | 1 ms white → 140 ms dark shell → 257 ms shell+spinner → 807 ms gallery fully rendered                                          | 144/252     |
| warm-revisit              | 0 ms previous page (gallery) → 66 ms dark → 116 ms content                                                                     | 64/120      |
| hard-reload-cachedisabled | 0 ms previous page → 75 ms dark → 641 ms content                                                                               | 64/120      |

The prior headed session (2026-11-14 19:02 UTC) shows the identical sample pattern in fresh contexts
(white sample ≈0–1 ms, next captured frame dark at ≈159–172 ms ≈ fp) and the previous page in
warm/reload paths; zero console/page errors in every scenario. Abridged manifest excerpt
(`manifest-recheck-cold-freshcontext.json`; `frames` entries trimmed to the timing fields, `paintTiming`
values verbatim; the network section separately records the document response `200` with
`cfCacheStatus: "HIT"`):

```json
{
	"frames": [
		{ "seq": 0, "file": "recheck-cold-freshcontext_00.png", "relWallMs": 1 },
		{ "seq": 1, "file": "recheck-cold-freshcontext_01.png", "relWallMs": 140 },
		{ "seq": 2, "file": "recheck-cold-freshcontext_02.png", "relWallMs": 257 }
	],
	"paintTiming": {
		"fcp": 252,
		"fp": 144,
		"responseEnd": 52.600000001490116,
		"domContentLoaded": 138.10000000149012
	}
}
```

Fresh-build and production HTML inspection (2026-11-15):

- Fresh `bun run build` at 00:31 UTC: `build/200.html` head carries the render-blocking
  `<link href="/_app/immutable/assets/0.AP-ShP5m.css" rel="stylesheet">` and no `color-scheme` meta; that
  stylesheet sets `html`/`body` `background-color` from `--bg-0:#0a0620`.
- Production HTML at 00:42 UTC: HTTP/2 `200`, `cf-cache-status: HIT`, no `color-scheme` meta, same
  stylesheet reference `0.AP-ShP5m.css` (hash matches the branch build output).

`<meta name="color-scheme">` A/B on a local slow-CSS build (render-blocking CSS delayed 1500 ms, 4 arms,
00:37–00:41 UTC): the three `p3-*` screencast manifests (`p3-nometa`, `p3-meta`, `p3-cssscheme`) each
hold exactly one frame, captured at fp (afterCommit ≈1549–1561 ms ≈ fp 1544–1564 ms) with average RGB
`(10,6,33)`, while the fourth arm's `probe-nometa.json` (a `Page.captureScreenshot` poller) holds 90 shot
records — 11 successful captures before document commit (the pre-navigation surface, `afterCommitMs`
null), 12 capture-error records (≈188–201 ms), and successful frames only again from ≈1741 ms
(fp = 1560 ms). No arm captured a frame between document commit and first paint. The root element's
computed CSS `color-scheme`
read `normal` with the meta present (during the window and after full load) and `dark` in the
`<style>:root{color-scheme:dark}</style>` control arm, confirming the probe reads that property. Because a
`<meta name="color-scheme">` sets the document's supported/used scheme without necessarily changing the
root's computed CSS property, these captures do not resolve engine support for the meta; they show **no
difference between arms and no improvement demonstrated**, so the candidate change was reverted (no repo
change).

Capture blind spot (applies to all runs): no run captured a frame between document commit and first
paint — `Page.captureScreenshot` blocks until a frame exists and `Page.startScreencast` pushes only on
compositor-frame production — so the duration/continuity of the interval between the initial white sample
(~0–1 ms, before the document response at `responseEnd` ≈53–96 ms) and the dark first-paint frame is
**inconclusive**.

## Playwright clock install/pauseAt race — one-off failure, investigation and reruns (2026-11-15)

Recorded outcomes for the follow-up investigation of a one-off default-lane failure of the
`GameplayPage.loadFixture` clock pair (`clock.install({ time: START_AT })` then
`clock.pauseAt(START_AT)`, identical timestamp) throwing `clock.pauseAt: Cannot fast-forward to the
past` in `gameplay-infrastructure.spec.ts:98` ("authenticated completion: celebration, local stats,
one sealed request"). Follow-up tickets:
[HPA-1027](https://linear.app/cwchanap/issue/HPA-1027/perseus-stabilize-e2e-clock-installpause-race)
(stabilize the pair) and
[HPA-1028](https://linear.app/cwchanap/issue/HPA-1028/perseus-prevent-e2e-from-reusing-an-unrelated-local-server)
(prevent unrelated-server reuse). No application code changed at any point in this follow-up.

- 2026-11-15, branch HEAD `e5dbda77`: full desktop `test:e2e` run concurrent with the root unit
  suite → 110 passed / 7 skipped / 3 failed. Two failures are the pre-existing avatar a11y
  violations ([HPA-1026](https://linear.app/cwchanap/issue/HPA-1026/perseus-fix-profile-avatar-accessible-name-mismatch-in-desktop-e2e));
  the third is the clock failure above. The concurrently running root `bun run test:unit` reported
  7/7 workspace turbo tasks passed (task-level result as reported; not evidence that the mobile
  workspace's tests themselves ran).
- Identity-verified isolated reruns (2026-11-15; dedicated API/web ports, each service confirmed as
  Perseus before testing): the exact failing test passed 10/10 serial and 10/10 under CPU-spinner
  load, and a harness-analog spec using the exact `loadFixture` clock sequence reproduced the
  identical error 3/3 with an explicit 150 ms stall inserted between `install` and `pauseAt`
  (3/3 passed without a stall). The original run's stall was not measured, so contention remains a
  plausible — not proven — cause of the original failure.
- An intervening rerun failed 10/10 on missing puzzle-board solely because Playwright reused an
  unrelated foreign preview (Gliese) already listening on web port 4173; all ten failures are
  invalid for Perseus and are not reproductions (HPA-1028).
- 2026-11-15, branch HEAD `f06c8a34`, web port free and a fresh Perseus preview:
  `bun run --cwd apps/web test:e2e -- --workers=1` → 111 passed / 7 skipped / 2 failed; both
  failures are the avatar a11y pair (HPA-1026), and the strict native-drag tests plus the
  previously failing clock test passed.

## Profile avatar accessible name — HPA-1026 fix and fresh verification (2026-11-15)

The pre-fix history is recorded above: the axe `label-content-name-mismatch` (serious) pair on
`.profile-avatar` in `ArcadeShell.svelte` reproduced in the 2026-11-14 default run (2 failed) and both
2026-11-15 pre-fix reruns (`e5dbda77`: 3 failed with the unrelated clock one-off; `f06c8a34` serial:
2 failed, avatar pair only). Those records are retained as historical; the fix landed on this branch
afterwards.

- `c2ecc595` (HPA-1026): both sidebar and compact `.profile-avatar` links in `ArcadeShell.svelte` now
  use the accessible name `Profile for ${playerDisplayName || 'Player'} — ${initials}` — the visible
  initials are embedded outside parentheses because axe strips parentheticals before matching
  `label-content-name-mismatch`. `0360cfb6` adds web unit coverage for the empty-display-name
  fallback and rename reactivity. Verification below is the automated axe scan inside the desktop
  Chromium E2E suite; no real-device or screen-reader testing is claimed.
- Earlier isolated custom-port desktop run at `0360cfb6` (dedicated ports): 112 passed / 1 failed;
  the single failure is **unrelated to the avatar change** — it stemmed from the port-3999 hardcoding
  in the custom-port setup (same unrelated-server class as
  [HPA-1028](https://linear.app/cwchanap/issue/HPA-1028/perseus-prevent-e2e-from-reusing-an-unrelated-local-server)),
  so it is environment noise, not a regression, and is distinguished from the passing default run
  below.
- The fresh default run at `0360cfb6` used the **existing API server on :3999, identified as this
  checkout**, plus a fresh production-mode web preview on :4173.

| Command                                                                                                                           | Exit | Outcome                                   |
| --------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------- |
| `bun run --cwd apps/web test:e2e -- --workers=1`                                                                                  | 0    | 113 passed / 7 skipped / 0 failed         |
| `bun run --cwd apps/web test:e2e:smoke -- --workers=1`                                                                            | 0    | 167 passed / 9 skipped / 0 failed         |
| `(cd apps/web && bunx playwright test --grep @extended --project=chromium-desktop e2e/gameplay-interactions.spec.ts --workers=1)` | 0    | 2 passed / 0 failed                       |
| `bun run test:unit` (repo root)                                                                                                   | 0    | 7 tasks passed (6 cached; web fresh 1271) |
| `bun run check` (repo root)                                                                                                       | 0    | 5 tasks passed (4 cached)                 |
| `bun run lint` (repo root)                                                                                                        | 0    | 3 tasks passed (2 cached)                 |

Notes:

- The smoke lane covers the Chromium desktop and emulated mobile projects; the extended command ran
  only the `chromium-desktop` project.
- Both previously failing tests are green in the default run: the `gallery.spec.ts` bookmark
  round-trip and the `gameplay-accessibility.spec.ts` authenticated gallery scan no longer report the
  `.profile-avatar` violation. The strict native-drag lanes still pass, so the drag evidence above is
  unaffected.
