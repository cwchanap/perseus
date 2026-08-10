# HPA-218 Final Review Fix

## Diagnosis

`listQuick()` accepts current-schema records after checking only `schemaVersion`, string `id`,
and numeric `createdAt`. A malformed record with missing `pieces` can therefore reach gallery
discovery. `quickValidationContext()` previously called `puzzle.pieces.map(...)` unconditionally,
so one malformed Quick candidate threw before valid server or Quick candidates could be inspected.

## Files changed

- `apps/web/src/lib/services/gameplay/galleryProgress.ts`
  - Validate only the Quick metadata needed for a safe `SessionValidationContext` (dimensions,
    count, and canonical piece descriptors).
  - Return `null` for malformed metadata and skip that candidate during discovery.
- `apps/web/src/lib/services/gameplay/galleryProgress.test.ts`
  - Add a regression with a current-schema Quick record missing `pieces`, plus valid server and
    Quick sessions that must still produce progress.

## TDD evidence

RED:

```text
rtk bun run test:unit --filter=@perseus/web -- gameplay/galleryProgress.test.ts
```

Result: 1 failed, 5 passed. The new regression failed with
`TypeError: Cannot read properties of undefined (reading 'map')` at
`quickValidationContext` (`galleryProgress.ts:64`).

GREEN:

```text
rtk bun run test:unit --filter=@perseus/web -- gameplay/galleryProgress.test.ts
```

Result: 1 file passed, 6 tests passed.

```text
rtk bun run check --filter=@perseus/web
```

Result: `svelte-check found 0 errors and 0 warnings`.

```text
rtk bun run test:unit --filter=@perseus/web
```

Result: 63 test files passed, 1,179 tests passed.

```text
rtk bunx prettier --check apps/web/src/lib/services/gameplay/galleryProgress.ts apps/web/src/lib/services/gameplay/galleryProgress.test.ts
rtk git diff --check
```

Result: all files matched Prettier code style; no diff errors.

## Commit

`2dbe06e` — `fix(web): skip malformed quick gallery candidates`

## Self-review

- Discovery remains read-only; malformed Quick metadata is skipped without storage cleanup.
- Valid server and Quick candidates continue through the same `peekSession` and resumability path.
- No compatibility parser, storage migration, shared schema, API, route, or font changes were made.
- The validation is local to gallery context construction and excludes unrelated Quick fields such
  as image data and edge metadata.

## Concerns

None identified for this scoped fix.
