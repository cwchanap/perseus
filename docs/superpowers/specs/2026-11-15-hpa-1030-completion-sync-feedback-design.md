# HPA-1030 — Truthful completion sync feedback

Linear: https://linear.app/cwchanap/issue/HPA-1030

## Problem
Three signed-out completed puzzle runs were saved locally but displayed **MISSION SYNC FAILED** with a **RETRY SYNC** action that immediately failed again. The UI conflated server account sync with the independently successful device-local completion.

## Existing ownership
- `PuzzleSession` seals each completion and tracks local-stat and server-submission effects independently.
- `apps/web/src/routes/puzzle/[id]/+page.svelte` submits the server effect, maps HTTP 401 to the shared `unauthorized` code, and already retries unauthorized effects on an authentication transition.
- `PuzzleCompletionDialog.svelte` currently renders the generic server error solely from `serverSubmissionRetryable`.

## Product behavior
1. A failed server effect with code `unauthorized` shows a neutral **SIGN IN TO SYNC** explanation, never a **MISSION SYNC FAILED** alert or a retry that cannot work while signed out.
2. The local-save wording must reflect the independent local-stats effect: **Saved on this device** only when it succeeded; **Saving on this device** while pending; **Local save failed** if it failed.
3. A pending server effect shows **SYNCING RESULT…** instead of leaving a retry control active. A retryable non-auth failure continues to show the existing **RETRY SYNC** action, which drives the existing `retry_completion_effects` action.
4. Signing in continues to use the existing auth-transition retry. No new credentials or sign-in navigation are introduced inside the completion dialog.
5. Completion, local badges, timing, awards, scores, and persistence remain unchanged.

## Implementation
Derive three small view inputs from the already-present `sealedCompletion` status on the puzzle route: unauthorized failure, server submission pending, and local stats saved. Pass these alongside the existing retryable/local-failure inputs to the dialog. Keep state and UI handling in their current owners. Reuse the current modal layout and styles with a small neutral text treatment.

## Non-goals
No backend changes, new completion/auth stores, persistence migration, offline queue, retroactive data reprocessing, new screens, or generated artwork/SFX. No changes to mobile-native gameplay; web is the reported affected surface.

## Verification
Focused dialog tests cover authorized retry behavior, unauthorized local-save truthfulness, pending and failure display. The existing puzzle-route test covers completion effect handling, plus an explicit 401 regression. Full project checks and browser E2E remain required before merging; none are implied by merely adding tests.

Visual comparison uses the currently shipped Galaxy Arcade result dialog. No Linear mockup is attached as of 2026-11-15; check one if added later.
