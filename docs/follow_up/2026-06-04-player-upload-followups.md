# Player Upload Follow-ups

Date: 2026-06-04
Status: Pending
Source: PR #27 review (`feat/player-upload`)

## Summary

Three items from the PR #27 review were intentionally deferred from the merge
to keep the diff scoped to the player-upload feature. Each is small enough to
land as its own PR but tied together by a common theme: production hardening
that does not change the v1 user contract.

The auth gate (`requirePlayerAuth`) and cleanup-on-failure chains shipped
correctly in #27. These follow-ups add the ownership, deduplication, and abuse
protection layers that the reviewers flagged as missing.

---

## 1. Persist `ownerId` on player-created puzzles

**Reviewer:** type-design, code-reviewer (Important #3b)
**Severity when deferred:** P2 (no production puzzles yet — feature ships
zero records that would need backfill)

### Problem

`requirePlayerAuth` validates the player session and sets
`c.set('playerSession', session)`, but no handler reads it and
`PuzzleMetadata` carries no `ownerId`. Consequences:

- No way to answer "which puzzles did this player upload?"
- No way to prevent player A from deleting player B's puzzle
  (once DELETE is exposed to players)
- No quota or abuse tracking per player
- The router type does not thread `Variables.playerSession`, so even if a
  handler tried to read identity it would lose type safety

### Scope

- Add `ownerId?: string` to `PuzzleMetadataBase` in `packages/types/src/index.ts`
  (optional now, encouraged later; admin puzzles remain unowned)
- Thread `Variables.playerSession` through router types (done in PR #27
  follow-up commit — verify still in place)
- Set `ownerId: session.user.id` in both worker and bun POST handlers
- Decide KV/DO query strategy for "my puzzles": either index by player or
  scan-and-filter (current `listPuzzlesPage` is scan-and-filter — fine at
  expected scale)
- Surface in API: `GET /api/puzzles?mine=1` returns only caller's puzzles
- Surface in web: optional "My puzzles" tab on gallery
- Decide on delete authorization: player can delete own `processing`/`ready`
  puzzle; admin can delete any
- Migration: existing puzzles (all admin-created) get `ownerId: undefined`;
  no backfill needed

### Open question

Is per-player ownership required for v1 of player upload, or is the auth gate
sufficient? If v1 ships without ownership, this becomes a v1.1 feature.

---

## 2. Extract shared upload-validation module

**Reviewer:** type-design, code-reviewer, test-analyzer (Important #4)
**Severity when deferred:** P2 (maintenance burden; today the copies agree)

### Problem

`detectImageType`, `parseImageDimensions`, and `aspectRatiosMatch` are
byte-for-byte identical across four files:

- `apps/api/src/routes/admin.ts`
- `apps/api/src/routes/admin.worker.ts`
- `apps/api/src/routes/puzzles.ts`
- `apps/api/src/routes/puzzles.worker.ts`

Additionally:

- `createPlayerPuzzle` and `createPuzzle` in `apps/web/src/lib/services/api.ts`
  differ only in URL path
- Piece-count validation diverges in expression between runtimes (Bun:
  `isValidPieceCount(count, ratio)`; Worker: inlined range check +
  `isValidPieceCountForAspectRatio(count, ratio)`). They agree today but
  nothing forces agreement.
- The originals in `admin.ts` carry byte-layout comments
  (`PNG: width/height are 4-byte big-endian at offset 16-23`, etc.) that the
  copies in `puzzles.ts` / `puzzles.worker.ts` stripped.

### Scope

Proposed module layout (kept runtime-agnostic so both Bun and Worker can
import):

```
apps/api/src/services/image-utils.ts
  - detectImageType(file: File | Blob): Promise<string | null>
  - parseImageDimensions(file: File | Blob, mimeType: string)
      -> Promise<{ width: number; height: number } | null>
  - aspectRatiosMatch(imageWidth, imageHeight, targetRatio): boolean
  - ASPECT_RATIO_TOLERANCE
```

Form-data parsing helpers (route-level, since they touch Hono context):

```
apps/api/src/services/upload-validation.ts
  - validatePuzzleUploadForm(formData)
      -> { ok: true, payload: {...} } | { ok: false, response: Response }
```

Web client dedup:

```
apps/web/src/lib/services/api.ts
  - buildPuzzleFormData(name, pieceCount, image, category?, aspectRatio?)
  - createPuzzle/createPlayerPuzzle call it
```

### Tests

The shared module gets its own test file; route-level tests stay focused on
handler behavior (rollback chains, auth, status codes). The narrow
`/* v8 ignore */` blocks added in #27 follow-up move to the route handlers
only — the helpers now have direct coverage.

### Non-goal

Do not change the public API contract or validation behavior. The PR should
be a pure refactor with no observable difference to clients.

---

## 3. Rate-limit player upload endpoint

**Reviewer:** code-reviewer (Suggestion)
**Severity when deferred:** P1 (abuse vector, but matches current admin parity)

### Problem

`POST /api/puzzles` has no rate limiting. Admin upload also lacks upload
rate limiting (only `/api/admin/login` is limited), but the player audience
is broader than the admin audience, and each successful upload triggers an
expensive Cloudflare Workflow (image processing, KV writes, piece
generation).

A misbehaving or compromised session can:

- Burn Worker CPU/R2 storage on junk uploads
- Fill the gallery with garbage
- Inflate Workflow invocation costs

### Scope

- Reuse the existing `rate-limit` middleware pattern
  (`apps/api/src/middleware/rate-limit.ts` and `.worker.ts`)
- Apply to `POST /api/puzzles` (both runtimes)
- Suggested initial limits:
  - 5 uploads per 10 minutes per session
  - 20 uploads per hour per session
  - 50 uploads per day per session
- Return 429 with `Retry-After` header
- Make limits configurable via env (so we can tune without redeploying)

### Open questions

- Should the limit key on `session.user.id`, IP, or both?
  - User-id alone is correct for authenticated abuse; IP catches pre-auth
    spam but penalizes shared-NAT users.
  - Recommendation: primary key on user-id, secondary IP-based limit at a
    higher threshold.
- Do we want a quota (lifetime upload count) in addition to a rate (window)?
  - Quota implies the ownership work in item #1.
- Should the workflow trigger itself be the gated resource, or should we gate
  at HTTP entry? HTTP entry is cheaper and the right place.

### Non-goal

Do not add rate limiting to GET endpoints — those are cacheable and already
served from KV.

---

## Implementation order

These three are independent. Recommended order if shipping sequentially:

1. **Shared upload-validation module (#2)** — pure refactor, no behavior
   change, smallest risk. Lands the byte-layout comments back in one place
   and lets us delete the narrow `v8 ignore` blocks added in #27.
2. **Persist ownerId (#1)** — small feature on top of the refactor. Adds
   one optional field, threads it through two runtimes, exposes one query
   param.
3. **Rate limiting (#3)** — operational hardening. Depends on a product
   decision about the specific numbers; can land independently of the
   others.
