---
name: perseus-operations
description: Use when operating Perseus production or admin workflows, including deployments, D1 migrations or recovery, puzzle uploads or seeding, Cloudflare Access credentials, cleanup, reconciliation, or related production troubleshooting in the Perseus repository.
---

# Perseus Operations

Use this skill from the Perseus repository root. Treat
[references/operator-runbook.md](references/operator-runbook.md) as the detailed operational
reference; read only the sections relevant to the requested operation.

## Route the operation

- Deployments and D1 migration ordering: §§1–3.
- D1 state recovery or resource re-adoption: §4.
- GitHub seed workflow: §5.
- Orphan cleanup and force deletion: §§6–7.
- Cloudflare Access scope and authentication: §8.
- Idempotency behavior: §9.
- Completion usage reconciliation: §10.
- Local or production puzzle uploads, bulk catalogs, and token rotation: §11.

## Operating rules

1. Identify the target environment and exact operation before running commands.
2. Read the matching runbook section, then inspect its linked workflow, config, or source when
   the operation mutates production or the documented facts could have drifted.
3. Start with read-only status or dry-run commands where the workflow provides them.
4. Never print, paste, or commit Access client secrets, JWTs, or Pulumi secrets.
5. Resolve exact targets before destructive work. Obtain user confirmation immediately before a
   production deletion, replacement, or other destructive mutation unless that exact action was
   already explicitly authorized.
6. After acting, verify the observable production state and report both the operation and its
   verification result.

## Production upload invariant

For local CLI uploads to production, use the Cloudflare Access service token path in §11. WARP or
a browser session alone does not authenticate the CLI, and copied browser cookies are not the
automation path. Pulumi is used only to retrieve the already-provisioned Access client ID and
secret; it does not perform the puzzle upload.
