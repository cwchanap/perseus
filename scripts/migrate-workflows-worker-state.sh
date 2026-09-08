#!/usr/bin/env bash
# One-time Pulumi state migration: adopt the live 'workflows' Cloudflare Worker.
#
# Background
# ----------
# The Pulumi resource 'workflows-worker' was previously configured to manage a
# Cloudflare Worker named 'perseus-workflows'. The live production Worker is
# actually named 'workflows' (created out-of-band on 2026-06-28 via wrangler).
# packages/infrastructure/src/workers.ts now sets name='workflows' and includes
# `import` options on the Worker and Workflow resources so `pulumi up` adopts
# the existing remote resources instead of creating new ones.
#
# Before that `pulumi up` can run, the stale state subtree (pointing at the old
# 'perseus-workflows' Worker) must be removed. `pulumi state delete` takes a
# full URN — not a logical name — and refuses to delete resources that have
# dependents. This script resolves URNs from `pulumi stack export`, deletes the
# stale subtree in reverse dependency order, then runs `pulumi up` to adopt.
#
# Usage
# -----
#   ./scripts/migrate-workflows-worker-state.sh --dry-run   # validate URN plan only
#   ./scripts/migrate-workflows-worker-state.sh --stack <org>/perseus-infrastructure/production
#           # execute migration (--stack is REQUIRED in execute mode and must
#           # end in /perseus-infrastructure/production; dry-run needs neither)
#
# The script self-locates the repo root and cd's into packages/infrastructure
# (the Pulumi project dir) for all pulumi commands, so it can be run from
# anywhere.
#
# Prerequisites
# -------------
#   - pulumi CLI authenticated for the production stack
#   - jq installed
#   - `import` options present in packages/infrastructure/src/workers.ts
#   - Build artifacts (execute migration only — dry-run needs none). The
#     script runs these from the repo root before any state mutation:
#       bun run build --filter=@perseus/web
#       bun run build --filter=@perseus/api
#       bun run build --filter=@perseus/workflows
#       bun run build --filter=@perseus/infrastructure
#     This guarantees the Pulumi program (packages/infrastructure/dist/index.js)
#     reflects the current source — including this PR's `import` options —
#     before any production state is removed. All four outputs are gitignored,
#     so an existence check alone is unsafe (stale dist can survive a branch
#     switch and still pass the gate).

set -euo pipefail

# ---------------------------------------------------------------------------
# Functions (sourced by the test — keep pure where possible)
# ---------------------------------------------------------------------------

# Extract a URN for a given logical name from a `pulumi stack export` JSON blob.
# Args: <logical-name> <stack-export-json>
# Prints the URN (empty string if not found).
extract_urn() {
	local logical_name="$1"
	local stack_json="$2"
	# URN format: urn:pulumi:<org>::<project>::<type>::<logical-name>
	# The $ anchor ensures 'workflows-worker' doesn't match 'workflows-worker-version'.
	printf '%s' "$stack_json" | jq -r --arg name "$logical_name" \
		'.deployment.resources[] | select(.urn | endswith("::" + $name)) | .urn' \
		| head -1
}

# Resolve all stale URNs from a stack export JSON blob.
# Sets global variables: WORKER_URN, VERSION_URN, WORKFLOW_URN, VERSION_DO_URN,
# DEPLOYMENT_URN, and the external API-chain dependents API_VERSION_URN,
# API_DEPLOYMENT_URN, API_CRON_URN.
# Args: <stack-export-json>
resolve_urns() {
	local stack_json="$1"
	WORKER_URN=$(extract_urn 'workflows-worker' "$stack_json")
	VERSION_URN=$(extract_urn 'workflows-worker-version' "$stack_json")
	WORKFLOW_URN=$(extract_urn 'perseus-workflow' "$stack_json")
	VERSION_DO_URN=$(extract_urn 'workflows-worker-version-do' "$stack_json")
	DEPLOYMENT_URN=$(extract_urn 'workflows-worker-deployment' "$stack_json")
	# External dependents of workflows-worker-version-do: createApiWorker
	# declares dependsOn: [api-worker, workflowsWorker.version], and
	# workflowsWorker.version is versionWithDo when the DO binding is present.
	# These must be deleted before version-do or Pulumi refuses the removal.
	API_VERSION_URN=$(extract_urn 'api-worker-version' "$stack_json")
	API_DEPLOYMENT_URN=$(extract_urn 'api-worker-deployment' "$stack_json")
	API_CRON_URN=$(extract_urn 'api-worker-cron-trigger' "$stack_json")
}

# Extract the Cloudflare physical name (inputs.name) for a given URN from a
# `pulumi stack export` JSON blob. Used to distinguish the stale
# 'perseus-workflows' Worker from the adopted 'workflows' Worker, since both
# share the logical Pulumi name 'workflows-worker'.
# Args: <urn> <stack-export-json>
# Prints the name (empty string if not found).
worker_physical_name() {
	local urn="$1"
	local stack_json="$2"
	printf '%s' "$stack_json" | jq -r --arg urn "$urn" \
		'.deployment.resources[] | select(.urn == $urn) | .inputs.name // empty' \
		| head -1
}

# Build the deletion order as the global DELETION_ORDER array of "label:urn"
# entries. Must be called after resolve_urns. Reverse dependency order —
# dependents deleted before the resources they depend on.
#
# The API worker chain (cron-trigger → deployment → version) depends on
# workflows-worker-version-do via createApiWorker's dependsOn. All three API
# resources are additive (re-created every deploy via version upload), so
# dropping them from state and letting `pulumi up` recreate them is safe —
# only the Worker and Workflow are adopted via `import`.
build_deletion_order() {
	DELETION_ORDER=(
		"api-worker-cron-trigger:${API_CRON_URN}"
		"api-worker-deployment:${API_DEPLOYMENT_URN}"
		"api-worker-version:${API_VERSION_URN}"
		"workflows-worker-deployment:${DEPLOYMENT_URN}"
		"workflows-worker-version-do:${VERSION_DO_URN}"
		"perseus-workflow:${WORKFLOW_URN}"
		"workflows-worker-version:${VERSION_URN}"
		"workflows-worker:${WORKER_URN}"
	)
}

# Print the deletion plan in reverse dependency order.
# Reads: DELETION_ORDER (set by build_deletion_order)
print_plan() {
	for entry in "${DELETION_ORDER[@]}"; do
		local label="${entry%%:*}"
		local urn="${entry#*:}"
		if [[ -z "$urn" ]]; then
			echo "  SKIP   $label (not in state — already removed?)"
		else
			echo "  DELETE $label"
			echo "         $urn"
		fi
	done
}

# Print the repo-root-relative artifact paths that must exist before the
# migration can run `pulumi preview`/`pulumi up`. The Pulumi program entry is
# packages/infrastructure/dist/index.js (Pulumi.yaml `main: dist/index.js`,
# resolved relative to the infrastructure dir); the worker/web paths mirror
# packages/infrastructure/src/config.ts `paths`.
required_artifact_paths() {
	printf '%s\n' \
		'packages/infrastructure/dist/index.js' \
		'apps/api/dist/worker.js' \
		'apps/workflows/dist/index.js' \
		'apps/web/build'
}

# Build all four artifacts from the repo root before any state mutation.
# Existence checks are insufficient — every output in required_artifact_paths
# is gitignored, so stale dist from a prior branch/checkout can pass an
# existence gate while lacking this PR's `import` options in
# packages/infrastructure/dist/index.js. Running the builds guarantees the
# Pulumi program and worker dists reflect the current source before any
# production state is removed. Args: <repo-root>
build_artifacts() {
	local repo_root="$1"
	local filters=(
		'@perseus/web'
		'@perseus/api'
		'@perseus/workflows'
		'@perseus/infrastructure'
	)
	echo "=== Building artifacts (from $repo_root) ==="
	for filter in "${filters[@]}"; do
		echo "  bun run build --filter=$filter"
		(cd "$repo_root" && bun run build "--filter=$filter")
	done
}

# Delete stale state entries in reverse dependency order.
# Args: <dry-run>
# Reads: DELETION_ORDER (set by build_deletion_order), PULUMI_CMD and
# STACK_FLAGS (set by main). --stack is appended to the `state delete`
# subcommand, not the root `pulumi` command (Pulumi defines -s/--stack on
# subcommands only).
delete_stale_state() {
	local dry_run="$1"
	local stack_disp=""
	if ((${#STACK_FLAGS[@]} > 0)); then
		stack_disp="${STACK_FLAGS[*]} "
	fi
	for entry in "${DELETION_ORDER[@]}"; do
		local label="${entry%%:*}"
		local urn="${entry#*:}"
		if [[ -z "$urn" ]]; then
			echo "  SKIP   $label (not in state)"
			continue
		fi
		echo "  DELETE $label"
		if [[ "$dry_run" == "true" ]]; then
			echo "         [dry-run] pulumi state delete ${stack_disp}'$urn' -y"
		else
			"${PULUMI_CMD[@]}" state delete "${STACK_FLAGS[@]}" "$urn" -y
		fi
	done
}

# ---------------------------------------------------------------------------
# Main (only runs when executed, not sourced)
# ---------------------------------------------------------------------------
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
	DRY_RUN=false
	STACK_ARG=""

	while [[ $# -gt 0 ]]; do
		case "$1" in
			--dry-run) DRY_RUN=true; shift ;;
			--stack) STACK_ARG="$2"; shift 2 ;;
			-h|--help)
				grep '^#' "$0" | sed 's/^# \?//'
				exit 0
				;;
			*) echo "Unknown argument: $1" >&2; exit 1 ;;
		esac
	done

	# Execute mode mutates production state, so require an explicit production
	# stack. Without --stack, pulumi operates on whichever stack is currently
	# selected in this checkout — a cheap way to delete state from the wrong
	# stack. The stale-name guard only proves the selected stack has a
	# 'perseus-workflows' Worker, not that it's production (another stack from
	# the old config can too). Require --stack ending in
	# /perseus-infrastructure/production for execute mode; dry-run stays
	# looser (read-only).
	if [[ "$DRY_RUN" != "true" ]]; then
		if [[ -z "$STACK_ARG" ]]; then
			echo "ERROR: --stack is required for execute mode (one-time production migration)." >&2
			echo "       Pass --stack <org>/perseus-infrastructure/production." >&2
			echo "       Use --dry-run for a read-only validation without --stack." >&2
			exit 1
		fi
		if [[ "$STACK_ARG" != */perseus-infrastructure/production ]]; then
			echo "ERROR: --stack must end in '/perseus-infrastructure/production' for execute mode." >&2
			echo "       Got: $STACK_ARG" >&2
			exit 1
		fi
	fi

	# Check dependencies
	command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required" >&2; exit 1; }
	command -v pulumi >/dev/null 2>&1 || { echo "ERROR: pulumi is required" >&2; exit 1; }

	# Locate the repo root from this script's path (scripts/ lives at the repo
	# root) and cd into the Pulumi project dir so `pulumi stack export`,
	# `preview`, and `up` resolve the project. Pulumi.yaml `main: dist/index.js`
	# is relative to packages/infrastructure — running pulumi from elsewhere
	# either fails or operates on the wrong project.
	SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
	REPO_ROOT="$(cd "$SCRIPT_PATH/.." && pwd)"
	if [[ ! -f "$REPO_ROOT/package.json" || ! -f "$REPO_ROOT/packages/infrastructure/Pulumi.yaml" ]]; then
		echo "ERROR: could not locate repo root from $SCRIPT_PATH" >&2
		echo "       expected $REPO_ROOT to contain package.json and packages/infrastructure/Pulumi.yaml" >&2
		exit 1
	fi
	INFRA_DIR="$REPO_ROOT/packages/infrastructure"
	cd "$INFRA_DIR"

	# Build artifacts before any state is deleted — otherwise an operator
	# could remove production state and then fail at preview because the
	# Pulumi program or worker dists are missing or stale. Dry-run needs
	# none: it only exports state and prints the deletion plan (no preview/up).
	if [[ "$DRY_RUN" != "true" ]]; then
		build_artifacts "$REPO_ROOT" || exit 1
	fi

	# Pulumi command. -s/--stack is defined on Pulumi subcommands (stack,
	# state, preview, up), not on the root `pulumi` command, so --stack is
	# appended to each subcommand invocation via STACK_FLAGS rather than
	# prefixed to the executable. PULUMI_CMD and STACK_FLAGS are arrays so
	# the invocations stay word-split-safe (no SC2086).
	PULUMI_CMD=(pulumi)
	STACK_FLAGS=()
	STACK_FLAG_DISPLAY=""
	if [[ -n "$STACK_ARG" ]]; then
		STACK_FLAGS=(--stack "$STACK_ARG")
		STACK_FLAG_DISPLAY="--stack $STACK_ARG"
	fi

	# Step 0: Backup state
	BACKUP_FILE="$REPO_ROOT/state-backup-$(date +%Y%m%d-%H%M%S).json"
	echo "=== Step 0: Backup state ==="
	echo "  Writing $BACKUP_FILE"
	if [[ "$DRY_RUN" == "true" ]]; then
		echo "  [dry-run] skipped"
	else
		"${PULUMI_CMD[@]}" stack export "${STACK_FLAGS[@]}" > "$BACKUP_FILE"
		echo "  Backup saved."
	fi

	# Step 1: Discover URNs
	echo ""
	echo "=== Step 1: Discover stale URNs ==="
	STACK_JSON=$("${PULUMI_CMD[@]}" stack export "${STACK_FLAGS[@]}")
	resolve_urns "$STACK_JSON"
	build_deletion_order

	echo ""
	print_plan

	# Safety check: at least the Worker must be in state
	if [[ -z "$WORKER_URN" ]]; then
		echo ""
		echo "ERROR: 'workflows-worker' not found in stack state." >&2
		echo "       It may have already been migrated. Inspect with:" >&2
		echo "         pulumi stack --show-urns${STACK_FLAG_DISPLAY:+ $STACK_FLAG_DISPLAY}" >&2
		exit 1
	fi

	# Safety check: the resolved Worker must be the stale 'perseus-workflows'.
	# After adoption the logical name 'workflows-worker' still exists but its
	# physical name is 'workflows' — deleting that would destroy valid state.
	WORKER_NAME=$(worker_physical_name "$WORKER_URN" "$STACK_JSON")
	if [[ "$WORKER_NAME" != 'perseus-workflows' ]]; then
		echo ""
		echo "ERROR: workflows-worker physical name is '$WORKER_NAME', not 'perseus-workflows'." >&2
		echo "       The migration may have already run. Aborting to avoid deleting valid state." >&2
		echo "       Inspect with: pulumi stack --show-urns${STACK_FLAG_DISPLAY:+ $STACK_FLAG_DISPLAY}" >&2
		exit 1
	fi

	# Step 2: Delete stale state entries
	echo ""
	echo "=== Step 2: Delete stale state (reverse dependency order) ==="
	delete_stale_state "$DRY_RUN"

	# Dry-run stops here. A `pulumi preview` in dry-run would run against the
	# pre-migration state: the stale URNs still exist (delete_stale_state only
	# printed), but the program declares `import` IDs for the live resources,
	# so Pulumi rejects the import ("resource '<URN>' already exists") instead
	# of showing the post-deletion plan. The import preview is only meaningful
	# after the real state removals — do not present this preview as a
	# read-only validation of the migration.
	if [[ "$DRY_RUN" == "true" ]]; then
		echo ""
		echo "=== Dry run complete ==="
		echo "Validated: state export, stale-URN resolution, deletion order."
		echo "NOT validated: pulumi preview of the import (requires real state removal)."
		echo "Re-run without --dry-run to execute the migration and preview the adoption."
		exit 0
	fi

	# Step 3: Preview (post-deletion — the stale URNs are gone, so the
	# program's `import` IDs adopt the live resources). Preview is read-only:
	# remote resources are untouched even if it fails. But Step 2 already
	# stripped the stale URNs from the stack checkpoint, so a failed preview
	# (bad import ID, transient provider/auth failure) would leave the script
	# in an unrecoverable state — a rerun fails the WORKER_URN safety check
	# because that URN is now absent. Catch a non-zero preview and restore the
	# backup before exiting so the documented flow remains recoverable.
	echo ""
	echo "=== Step 3: pulumi preview ==="
	echo "  The Worker and Workflow should show as 'import' (adopted)."
	echo "  WorkerVersion and WorkersDeployment will be freshly created"
	echo "  (new version upload + deployment — safe, additive operations)."
	if ! "${PULUMI_CMD[@]}" preview "${STACK_FLAGS[@]}" --diff; then
		echo "" >&2
		echo "ERROR: pulumi preview failed after state deletion." >&2
		echo "       Remote resources are untouched. Restoring stack backup before exit." >&2
		if ! "${PULUMI_CMD[@]}" stack import "${STACK_FLAGS[@]}" < "$BACKUP_FILE"; then
			echo "ERROR: automatic restore failed. Manually restore with:" >&2
			echo "  pulumi stack import${STACK_FLAG_DISPLAY:+ $STACK_FLAG_DISPLAY} < \"$BACKUP_FILE\"" >&2
			exit 1
		fi
		echo "  Restored from $BACKUP_FILE" >&2
		echo "  Fix the preview error and re-run the migration." >&2
		exit 1
	fi

	# Step 4: Apply
	echo ""
	echo "=== Step 4: pulumi up ==="
	"${PULUMI_CMD[@]}" up "${STACK_FLAGS[@]}" -y

	# Step 5: Verify
	echo ""
	echo "=== Step 5: Verify ==="
	echo "  1. Check 'pulumi preview' shows no create/replace for workflows-worker"
	echo "     or perseus-workflow."
	"${PULUMI_CMD[@]}" preview "${STACK_FLAGS[@]}"

	echo ""
	echo "=== Migration complete ==="
	echo "Next steps:"
	echo "  1. Verify the preview above shows no create/replace for the Worker/Workflow."
	echo "  2. Remove the 'import' options from packages/infrastructure/src/workers.ts"
	echo "     (both the Worker and the Workflow resources)."
	echo "  3. Run 'pulumi up' again — preview must be clean (no create/replace)."
	echo "  4. Commit the removal and deploy normally."
fi
