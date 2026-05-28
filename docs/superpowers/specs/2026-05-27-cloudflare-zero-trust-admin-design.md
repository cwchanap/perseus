# Cloudflare Zero Trust Admin Protection Design

## Summary

Perseus will protect the production admin portal with Cloudflare Zero Trust Access while
keeping the existing Perseus admin passkey/session layer intact. Cloudflare Access becomes
the outer gate for admin UI and admin API paths. The current app-level admin authentication
remains the inner gate.

The public puzzle experience and player authentication routes remain public.

## Goals

- Require Cloudflare Zero Trust before any production admin UI or admin API request reaches
  the Perseus Worker.
- Limit admin access to the configured admin identity and devices whose serial numbers pass
  a WARP device posture check.
- Keep admin identity and device serial numbers out of committed source code.
- Keep Zero Trust configuration in the existing Pulumi infrastructure deployment path.
- Preserve the existing admin passkey/session flow as a second authentication layer.
- Make future device additions possible without source changes.

## Non-Goals

- Replace the existing Perseus admin passkey/session authentication.
- Protect public routes such as `/`, `/puzzle/*`, `/api/puzzles/*`, or `/api/auth/*`.
- Add Worker-side Cloudflare Access JWT validation in this first pass.
- Move player authentication behind Cloudflare Access.
- Manage Cloudflare WARP enrollment policy for the whole account.

## Existing Context

Production Perseus is deployed as a Cloudflare Worker named `perseus`. The Worker serves
both Hono API routes and static SvelteKit assets. Admin functionality currently lives under:

- `/admin`
- `/admin/*`
- `/api/admin`
- `/api/admin/*`

The app already requires an admin passkey, sets an admin session cookie, and checks that
session before rendering protected admin pages. Infrastructure is managed in
`packages/infrastructure` with Pulumi, and GitHub Actions runs Pulumi preview and deploy
for the production stack.

## Architecture

Cloudflare Access will be configured as a self-hosted application for the Perseus production
hostname. The application destinations will cover only the admin surface:

- `https://perseus.cwchanap.dev/admin`
- `https://perseus.cwchanap.dev/admin/*`
- `https://perseus.cwchanap.dev/api/admin`
- `https://perseus.cwchanap.dev/api/admin/*`

The Access policy will allow only the configured admin email and will require a
serial-number device posture rule. That posture rule will be backed by a Cloudflare Zero
Trust list containing the configured device serial numbers.

Request flow:

1. A browser requests an admin URL.
2. Cloudflare Access evaluates identity and device posture before proxying the request.
3. If Access denies the request, Perseus does not receive it.
4. If Access allows the request, Perseus receives it and applies the existing admin
   passkey/session checks.
5. Public routes bypass this Access application and continue to work as they do today.

This gives two independent gates for admin work: Cloudflare identity/device posture first,
then Perseus admin authentication.

## Secrets And Personal Identifiers

Source code will contain only Pulumi config key names. It will not hardcode the admin email
or any device serial numbers.

Required config values:

- `adminAccessEmail`: the Cloudflare Zero Trust identity email allowed to reach admin paths.
- `adminDeviceSerials`: a secret JSON array string of allowed device serial numbers.

Optional config value:

- `adminAccessSessionDuration`: Access session duration, defaulting to `12h`.

Local Pulumi config should store `adminAccessEmail` and `adminDeviceSerials` as secrets.
GitHub Actions should map the same values from GitHub secrets into the Pulumi preview and
deploy `config-map`.

The personal values remain out of git and are encrypted in Pulumi state. Cloudflare Zero
Trust will necessarily receive the values because it must evaluate the Access policy and
device posture rule.

`adminDeviceSerials` is a JSON array so additional devices can be added by updating the
secret value and redeploying infrastructure. Adding a device should not require a source
change.

## Infrastructure Components

Pulumi will manage the Zero Trust resources in `packages/infrastructure`:

- A Cloudflare Zero Trust list for allowed admin device serial numbers.
- A Cloudflare Zero Trust device posture rule of type `serial_number`, backed by the serial
  list. The rule should not hardcode a single platform unless Cloudflare requires it for the
  chosen posture check.
- A Cloudflare Zero Trust Access policy that includes `adminAccessEmail` and requires the
  serial-number posture rule.
- A Cloudflare Zero Trust Access application with path-scoped public destinations for the
  admin UI and admin API paths.

The Access application should be path-scoped, not hostname-wide. A hostname-wide Access
application would unnecessarily protect public player routes.

## Deployment

Deployment stays on the existing Pulumi path:

1. Enroll the intended device in Cloudflare WARP.
2. Configure `adminAccessEmail` and `adminDeviceSerials` in Pulumi secret config.
3. Add matching GitHub Actions secrets for CI/CD deploys.
4. Update the infrastructure workflow so both preview and deploy pass the new config values.
5. Run Pulumi preview and confirm only the expected Zero Trust resources are created.
6. Deploy through the existing production infrastructure workflow or local Pulumi flow.

The first deploy should not require Worker code changes and should not change public route
behavior.

## Verification

Manual verification after deploy:

- From the allowed WARP-enrolled device and matching identity, `/admin` reaches the existing
  Perseus passkey page.
- From the same device without Access authentication, Cloudflare Access prompts first.
- From another device or failed posture state, Cloudflare Access denies the request before
  Perseus loads.
- Public routes such as `/`, `/puzzle/*`, `/api/puzzles/*`, and `/api/auth/*` remain
  accessible without Cloudflare Access.
- The existing Perseus passkey still rejects invalid admin login attempts after Access
  allows the request.

Automated checks should focus on the infrastructure contract:

- The Access application destinations include exactly the admin UI and admin API paths.
- The Access policy includes the configured admin email and requires the serial-number
  posture rule.
- Secret parsing rejects empty or malformed `adminDeviceSerials` values.
- GitHub Actions passes the new secret-backed config to both preview and deploy jobs.

## Failure Handling

- Missing `adminAccessEmail` or `adminDeviceSerials` must fail Pulumi preview/deploy instead
  of creating a broad or weak Access policy.
- Malformed `adminDeviceSerials` JSON, non-array values, empty arrays, or blank serial
  entries must fail during infrastructure validation.
- Failed device posture should deny at Cloudflare Access before the request reaches Perseus.
- A valid Access session with an invalid or expired Perseus admin session should continue to
  use the existing Perseus admin auth behavior.
- Path-scoping mistakes should be caught by checking both public and admin routes after
  deploy.

## References

- Cloudflare Access application paths:
  https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/
- Cloudflare WARP device posture checks:
  https://developers.cloudflare.com/cloudflare-one/identity/devices/
- Cloudflare serial-number device check:
  https://developers.cloudflare.com/cloudflare-one/identity/devices/warp-client-checks/corp-device/
