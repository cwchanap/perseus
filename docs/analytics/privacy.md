# Analytics Privacy and Consent Gate

This document records the engineering privacy constraints for the HPA-532 analytics contract. It
is not legal advice and does not replace a legal/privacy review, public privacy policy, consent
analysis, or jurisdiction-specific requirements.

## Default state: collection disabled

HPA-532 does not enable analytics. It exports factories only.

Until the production privacy policy and consent/notice decision are approved and implemented,
HPA-534 must construct the client with `createNoopAnalyticsTransport()`. Creating the HTTP transport
is an explicit opt-in at the application composition boundary. There is no hidden default network
client and no second `enabled` flag.

## Data-minimization principles

The V1 contract uses strict event variants and bounded enums/buckets. It intentionally avoids a
free-form `properties` map so later emitters cannot attach arbitrary data.

Permitted correlation is limited to:

- `eventId`, used to deduplicate one analytics occurrence;
- `runId`, used to join events belonging to one puzzle run;
- bounded event context and event-specific counters/timings defined in the catalog.

Authentication is only the class `unknown`, `anonymous`, or `authenticated`. The contract never
contains the authenticated player's identity.

## Prohibited client fields

Events must not include or derive any of the following:

- player/user/account ID;
- anonymous browser/device/install ID;
- email address, display name, profile name, or avatar;
- puzzle ID, puzzle name, filename, upload name, category search text, or raw query text;
- image URL, object-storage URL, signed URL, referring URL, or current page URL;
- access token, session token, cookie, authorization header, passkey, or secret;
- user-agent string, browser fingerprint, screen dimensions beyond the bounded viewport class, or
  raw input-device details beyond the bounded primary-input class;
- IP address, precise location, GPS coordinates, or fine-grained network information;
- arbitrary exception messages, response bodies, stack traces, logs, or other uncontrolled free
  text.

Adding any such field requires a new reviewed contract and cannot be done through a V1 extension
property.

## Run-ID scope

An accepted run ID may be:

- a fresh canonical lowercase UUID v4; or
- `legacy-<sha256-of-canonical-legacy-payload>` represented as `legacy-` plus 64 lowercase
  hexadecimal characters for a migrated session.

Both forms are scoped to one puzzle run. A new/restarted play gets a new run ID; resuming that same
run keeps it. The run ID is not intended or permitted to become a user identifier, browser
identifier, or cross-run identity.

Deterministic once-per-run event IDs embed the accepted run ID. Occurrence event IDs are fresh
lowercase UUID v4 values and are not stable across events.

## Transmitted data

When the HTTP transport is explicitly selected, a batch contains only validated V1 envelopes:

- event name and schema version;
- event ID;
- run ID where applicable;
- client `occurredAt` timestamp;
- bounded context snapshot;
- exact event-specific timing/counter data.

The HTTP adapter uses `credentials: 'omit'` and `cache: 'no-store'`. It does not intentionally send
cookies or authentication credentials, and it does not read server response bodies into error
telemetry.

HPA-533 must not silently enrich accepted events with IP address, user-agent, precise location,
account identity, or other hidden identifiers. Trusted server fields are limited to documented
operational metadata such as environment, release, and `receivedAt`.

## Local browser ledger

The once-per-run ledger exists only to suppress duplicate client emission. It stores:

- run ID;
- event schema version;
- one of the six once-per-run event names;
- local recorded timestamp.

It does not store event context, counters, player identity, puzzle metadata, URLs, or transport
responses.

The ledger retains at most 1,000 run records, at most six marks per run, and a 90-day window relative
to the next successful mark. It is stored in `localStorage`, is cleared by the existing E2E
`localStorage.clear()` lifecycle, and may be removed by the user through normal site-data controls.
A future-schema ledger is preserved rather than overwritten by older code.

The ledger is not a delivery receipt. Mark-before-enqueue may suppress a later duplicate even when
the first copy was lost.

## Retention and separation ownership

HPA-532 defines only the local ledger retention above. HPA-533 must document and configure the
server/sink retention policy, access controls, production-versus-non-production separation, and any
operational deletion process before collection is approved.

HPA-535 reporting must deduplicate by `eventId`. It must use trusted server `receivedAt` for
calendar windows rather than client-controlled `occurredAt`.

## Supporting evidence, not identity inference

`puzzle_exited_incomplete` may occur multiple times for one resumed run. It is supporting evidence,
not a definitive abandonment record. Reporting must reduce to distinct runs where appropriate and
must not use repeated exits to infer a person, household, or device.

`contentOrigin`, viewport, input, auth class, progress, assistance, and other dimensions are coarse
product-analysis categories. They must not be combined or expanded into fingerprinting features.

## Error handling and logging

The browser facade exposes only bounded error codes:

- `invalid_input`;
- `invalid_event_id`;
- `ledger_storage_unavailable`;
- `ledger_incompatible_schema`;
- `transport_failed`;
- `queue_overflow`.

Production error handling must not append raw event payloads, user data, URLs, response bodies, or
exception text to these codes. Analytics failure must never block or change product behavior.

## Approval checklist before HTTP enablement

Before HPA-534 selects the HTTP transport in production, confirm:

- the public privacy policy accurately describes the collection and purposes;
- the notice/consent requirement and user controls are approved for target jurisdictions;
- the no-op default is replaced only in approved environments;
- HPA-533 revalidates strict batches and adds no hidden identifiers;
- server retention, environment separation, access control, and incident ownership are documented;
- dashboards use only documented meanings and deduplicate by `eventId`;
- event payload inspection confirms no prohibited or free-form fields are present.
