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
#   ./scripts/migrate-workflows-worker-state.sh --dry-run   # preview only
#   ./scripts/migrate-workflows-worker-state.sh             # execute migration
#   ./scripts/migrate-workflows-worker-state.sh --stack <org>/perseus-infrastructure/production
#
# Prerequisites
# -------------
#   - pulumi CLI authenticated for the production stack
#   - jq installed
#   - Run from repo root
#   - `import` options present in packages/infrastructure/src/workers.ts

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
# DEPLOYMENT_URN.
# Args: <stack-export-json>
resolve_urns() {
	local stack_json="$1"
	WORKER_URN=$(extract_urn 'workflows-worker' "$stack_json")
	VERSION_URN=$(extract_urn 'workflows-worker-version' "$stack_json")
	WORKFLOW_URN=$(extract_urn 'perseus-workflow' "$stack_json")
	VERSION_DO_URN=$(extract_urn 'workflows-worker-version-do' "$stack_json")
	DEPLOYMENT_URN=$(extract_urn 'workflows-worker-deployment' "$stack_json")
}

# Print the deletion plan in reverse dependency order.
# Reads: WORKER_URN, VERSION_URN, WORKFLOW_URN, VERSION_DO_URN, DEPLOYMENT_URN
print_plan() {
	# Dependency chain:
	#   worker → version → workflow → version-do → deployment
	# Reverse (dependents first):
	local order=(
		"workflows-worker-deployment:${DEPLOYMENT_URN}"
		"workflows-worker-version-do:${VERSION_DO_URN}"
		"perseus-workflow:${WORKFLOW_URN}"
		"workflows-worker-version:${VERSION_URN}"
		"workflows-worker:${WORKER_URN}"
	)
	for entry in "${order[@]}"; do
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

# Delete stale state entries in reverse dependency order.
# Args: <pulumi-cmd-prefix> <dry-run>
delete_stale_state() {
	local pulumi_cmd="$1"
	local dry_run="$2"
	local order=(
		"workflows-worker-deployment:${DEPLOYMENT_URN}"
		"workflows-worker-version-do:${VERSION_DO_URN}"
		"perseus-workflow:${WORKFLOW_URN}"
		"workflows-worker-version:${VERSION_URN}"
		"workflows-worker:${WORKER_URN}"
	)
	for entry in "${order[@]}"; do
		local label="${entry%%:*}"
		local urn="${entry#*:}"
		if [[ -z "$urn" ]]; then
			echo "  SKIP   $label (not in state)"
			continue
		fi
		echo "  DELETE $label"
		if [[ "$dry_run" == "true" ]]; then
			echo "         [dry-run] $pulumi_cmd state delete '$urn' -y"
		else
			# shellcheck disable=SC2086
			$pulumi_cmd state delete "$urn" -y
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

	# Check dependencies
	command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required" >&2; exit 1; }
	command -v pulumi >/dev/null 2>&1 || { echo "ERROR: pulumi is required" >&2; exit 1; }

	# Build pulumi command prefix
	PULUMI_CMD="pulumi"
	if [[ -n "$STACK_ARG" ]]; then
		PULUMI_CMD="pulumi -s $STACK_ARG"
	fi

	# Step 0: Backup state
	BACKUP_FILE="state-backup-$(date +%Y%m%d-%H%M%S).json"
	echo "=== Step 0: Backup state ==="
	echo "  Writing $BACKUP_FILE"
	if [[ "$DRY_RUN" == "true" ]]; then
		echo "  [dry-run] skipped"
	else
		# shellcheck disable=SC2086
		$PULUMI_CMD stack export > "$BACKUP_FILE"
		echo "  Backup saved."
	fi

	# Step 1: Discover URNs
	echo ""
	echo "=== Step 1: Discover stale URNs ==="
	if [[ "$DRY_RUN" == "true" ]]; then
		echo "  [dry-run] cannot resolve URNs without stack access"
		echo "  In a real run, this reads 'pulumi stack export' and resolves:"
		echo "    workflows-worker, workflows-worker-version, perseus-workflow,"
		echo "    workflows-worker-version-do, workflows-worker-deployment"
		exit 0
	fi

	STACK_JSON=$($PULUMI_CMD stack export)
	resolve_urns "$STACK_JSON"

	echo ""
	print_plan

	# Safety check: at least the Worker must be in state
	if [[ -z "$WORKER_URN" ]]; then
		echo ""
		echo "ERROR: 'workflows-worker' not found in stack state." >&2
		echo "       It may have already been migrated. Inspect with:" >&2
		echo "         $PULUMI_CMD stack --show-urns" >&2
		exit 1
	fi

	# Step 2: Delete stale state entries
	echo ""
	echo "=== Step 2: Delete stale state (reverse dependency order) ==="
	delete_stale_state "$PULUMI_CMD" "$DRY_RUN"

	# Step 3: Preview
	echo ""
	echo "=== Step 3: pulumi preview ==="
	echo "  The Worker and Workflow should show as 'import' (adopted)."
	echo "  WorkerVersion and WorkersDeployment will be freshly created"
	echo "  (new version upload + deployment — safe, additive operations)."
	# shellcheck disable=SC2086
	$PULUMI_CMD preview --diff

	# Step 4: Apply
	if [[ "$DRY_RUN" == "true" ]]; then
		echo ""
		echo "=== Dry run complete ==="
		echo "Re-run without --dry-run to execute the migration."
		exit 0
	fi

	echo ""
	echo "=== Step 4: pulumi up ==="
	# shellcheck disable=SC2086
	$PULUMI_CMD up -y

	# Step 5: Verify
	echo ""
	echo "=== Step 5: Verify ==="
	echo "  1. Check 'pulumi preview' shows no create/replace for workflows-worker"
	echo "     or perseus-workflow."
	# shellcheck disable=SC2086
	$PULUMI_CMD preview

	echo ""
	echo "=== Migration complete ==="
	echo "Next steps:"
	echo "  1. Verify the preview above shows no create/replace for the Worker/Workflow."
	echo "  2. Remove the 'import' options from packages/infrastructure/src/workers.ts"
	echo "     (both the Worker and the Workflow resources)."
	echo "  3. Run 'pulumi up' again — preview must be clean (no create/replace)."
	echo "  4. Commit the removal and deploy normally."
fi
