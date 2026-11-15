# HPA-1030 — Implementation plan and acceptance

Ticket: https://linear.app/cwchanap/issue/HPA-1030
Spec: [2026-11-15-hpa-1030-completion-sync-feedback-design.md](../specs/2026-11-15-hpa-1030-completion-sync-feedback-design.md)

**Delivery: one PR for this ticket.** This is the same PR for implementation, validation and subsequent review corrections; do not open another PR for HPA-1030.

## Changes made on this branch
- [x] Derive `serverSubmissionRequiresSignIn` from the existing failed `unauthorized` sealed effect.
- [x] Derive `serverSubmissionPending` and `localStatsSaved` from the existing effect status.
- [x] Replace the anonymous retry-failure presentation with truthful sign-in/device-save feedback; preserve retryable non-auth errors.
- [x] Add focused dialog and 401 route regression cases.
- [ ] Run and record checks on this branch, fix only valid failures; do not claim unexecuted checks pass.
- [ ] Perform end-to-end/visual verification against the supported target browsers; promote from draft only when acceptance is supported.

## Suggested verification commands
```bash
bun run --cwd apps/web check
bun run --cwd apps/web lint
bun run --cwd apps/web test:unit
bun run --cwd apps/web test:e2e
bun run --cwd apps/web test:e2e:webkit
```

Run without reusing an unrelated E2E preview on port 4173; see [HPA-1028](https://linear.app/cwchanap/issue/HPA-1028).

## End-to-end acceptance
- [ ] **macOS** desktop browser: complete a puzzle while signed out with a 401 completion response; see device-local saved result and sign-in message, no failure/retry button, and a persisted clear after reload. Authenticated 5xx failure still offers retry and eventually clears its failure banner after success.
- [ ] **Windows** desktop Chrome/Edge: signed-out completion and authenticated retry status render correctly, with placement, completion and navigation still usable.
- [ ] **iOS** Safari: complete the small puzzle by tap, see the correct local-only status, dismiss/navigate back, and confirm the clear remains available on this device with no dialog overflow.
- [ ] **Visual check:** compare saved/sign-in, pending and retry states with the current Galaxy Arcade completion dialog and a ticket mockup if one is later attached; preserve the existing result framing and focus.
- [ ] Focused dialog and route tests pass for `unauthorized`, local-save success/pending/failure, server-pending status and retryable 5xx; local completion recording and auth-transition retry contracts remain intact.
- [ ] No new artwork/SFX, schema changes, or backend/new-auth flow. Linux/Android automated coverage remains CI-owned; no separate platform acceptance for them.

## Status as of initial PR
Changes are committed but have **not been executed locally** in this ChatGPT session: there is no local repository checkout or network access to GitHub for running Bun/Playwright. All runtime and visual acceptance is pending CI or a connected development environment. Do not mark this task Done solely because the draft PR exists.
