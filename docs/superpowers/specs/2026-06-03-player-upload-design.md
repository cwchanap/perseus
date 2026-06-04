# Player Upload Design

Date: 2026-06-03
Status: Approved design

## Summary

Perseus will split server-backed puzzle upload from the admin portal. Logged-in players upload
server puzzles from `/upload`; anonymous users continue to use `/quick` for local-only puzzles.
The admin portal remains the operator surface for player allowlist management, mission database
review, and deletion. Admin upload remains available from a local laptop script that uses the
existing admin passkey flow.

## API

- Keep `POST /api/admin/puzzles` protected by the existing admin session for scripted operator
  uploads.
- Add `POST /api/puzzles` protected by `perseus_player_session`.
- Reuse the current multipart form contract: `name`, `pieceCount`, optional `aspectRatio`,
  optional `category`, and `image`.
- Preserve existing validation and generation behavior in both Bun and Worker runtimes.

## Web

- Add `/upload` as the player server-upload page.
- Gate `/upload` with the player auth store. Signed-out users see the existing Google sign-in
  entry point, with `returnTo=/upload`.
- Keep `/quick` anonymous and local-only.
- Remove the visible create form from `/admin`; keep allowlist, puzzle list, polling, and delete.

## Script

Add a Bun script that logs in to `/api/admin/login`, stores the returned admin cookie in memory,
and posts the same multipart payload to `/api/admin/puzzles`. The script is intended for local
laptop operator uploads and accepts the target server URL, passkey, image path, name, piece count,
aspect ratio, and optional category.

## Testing

- API tests cover anonymous rejection and authenticated player upload for Bun and Worker routes.
- Web tests cover `/upload` signed-out/signed-in behavior and the updated upload API client.
- Existing admin tests continue to cover admin upload and delete behavior.
