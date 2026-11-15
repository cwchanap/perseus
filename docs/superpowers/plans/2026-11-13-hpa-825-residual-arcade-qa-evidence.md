# HPA-825 — Supplemental evidence extract (redacted)

Factual supporting evidence for the disposition table in
[`2026-11-13-hpa-825-residual-arcade-qa.md`](2026-11-13-hpa-825-residual-arcade-qa.md). This file is a
transcription of recorded run outcomes, capture observations and manifest excerpts; the table in the plan
is the **sole disposition record**. The original command logs, manifests and frame PNGs were local
worktree scratch, are **not** retained in the repository and are not hosted. The upload question was
explicitly deferred and never attempted, so no evidence exists for it.

## Shared environment

- Runs executed 2026-11-14 (drag lane) and 2026-11-14/15 (paint captures) on branch HEAD `c47315bb`
  (merge-base with `origin/main`: `0fe71b87`; `origin/main` at test time: `4b582ae9`).
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

- Appending `--project=chromium-desktop` to `test:e2e:extended` does **not** narrow the run (Playwright
  accumulates repeated `--project` flags); the evidence above is from the `chromium-desktop` project
  within the all-project run.
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
00:37–00:41 UTC): in every arm the manifest holds a single frame, captured at fp (≈1544–1564 ms), with
average RGB `(10,6,33)`; no frames before fp in any arm. The root element's computed CSS `color-scheme`
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
