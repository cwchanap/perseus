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
#   ./scripts/migrate-workflows-worker-state.sh --resume --stack <org>/perseus-infrastructure/production
#           # converge a PARTIALLY-COMPLETED migration (Step 4 `pulumi up`
#           # failed after Step 2 deleted the stale state). Detects the
#           # partial-adoption state and runs a guarded preview → up to
#           # finish the remaining import/create steps. Does NOT re-run
#           # Step 2 deletion and does NOT restore the pre-migration backup
#           # (remote mutations may have already happened). --resume also
#           # requires --stack (production) in execute mode; combine with
#           # --dry-run for a read-only resume preview.
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
	RESUME=false
	STACK_ARG=""

	while [[ $# -gt 0 ]]; do
		case "$1" in
			--dry-run) DRY_RUN=true; shift ;;
			--resume) RESUME=true; shift ;;
			--stack) STACK_ARG="$2"; shift 2 ;;
			-h|--help)
				grep '^#' "$0" | sed 's/^# \?//'
				exit 0
				;;
			*) echo "Unknown argument: $1" >&2; exit 1 ;;
		esac
	done

	# Execute AND resume modes mutate production state, so require an explicit
	# production stack. Without --stack, pulumi operates on whichever stack is
	# currently selected in this checkout — a cheap way to delete state from
	# the wrong stack. The stale-name guard only proves the selected stack has a
	# 'perseus-workflows' Worker, not that it's production (another stack from
	# the old config can too). Require --stack ending in
	# /perseus-infrastructure/production for execute and resume modes; dry-run
	# stays looser (read-only).
	if [[ "$DRY_RUN" != "true" ]]; then
		if [[ -z "$STACK_ARG" ]]; then
			echo "ERROR: --stack is required for execute/resume mode (one-time production migration)." >&2
			echo "       Pass --stack <org>/perseus-infrastructure/production." >&2
			echo "       Use --dry-run for a read-only validation without --stack." >&2
			exit 1
		fi
		if [[ "$STACK_ARG" != */perseus-infrastructure/production ]]; then
			echo "ERROR: --stack must end in '/perseus-infrastructure/production' for execute/resume mode." >&2
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

	# --- Resume mode: converge a partially-completed migration ----------------
	# Use after a failed Step 4 (`pulumi up`) once Step 2 (stale-state deletion)
	# has already finished. Pulumi does NOT roll back a failed update — it
	# checkpoints progress as resource steps complete, so a failed `pulumi up`
	# can leave the live 'workflows' Worker already imported (logical name
	# 'workflows-worker' now in state with physical name 'workflows') or only
	# some WorkerVersion/Deployment steps created. A normal rerun aborts at the
	# Step 1 safety guards (WORKER_URN absent, or physical name 'workflows').
	#
	# Resume detects that partial-adoption state and runs a guarded
	# preview → up to converge the remaining steps. It does NOT re-run Step 2
	# (state already deleted) and does NOT restore the pre-migration backup
	# (remote mutations may have already happened — restoring would desync
	# state from the live Cloudflare resources).
	if [[ "$RESUME" == "true" ]]; then
		echo ""
		echo "=== Resume: detect partial-adoption state ==="
		RESUME_JSON=$("${PULUMI_CMD[@]}" stack export "${STACK_FLAGS[@]}")
		RESUME_WORKER_URN=$(extract_urn 'workflows-worker' "$RESUME_JSON")
		RESUME_WORKER_NAME=""
		if [[ -n "$RESUME_WORKER_URN" ]]; then
			RESUME_WORKER_NAME=$(worker_physical_name "$RESUME_WORKER_URN" "$RESUME_JSON")
		fi

		# Refuse if the stale 'perseus-workflows' Worker is still the managed
		# Worker — that means Step 2 did not complete, so resume is the wrong
		# tool. The normal flow resumes Step 2 via SKIP for already-removed URNs.
		if [[ -n "$RESUME_WORKER_URN" && "$RESUME_WORKER_NAME" == "perseus-workflows" ]]; then
			echo "" >&2
			echo "ERROR: the stale 'perseus-workflows' Worker is still in state." >&2
			echo "       Migration Step 2 (stale-state deletion) has not completed." >&2
			echo "       --resume is for a failed Step 4 (pulumi up) AFTER Step 2 finished." >&2
			echo "       Re-run WITHOUT --resume to continue the migration (Step 2" >&2
			echo "       resumes via SKIP for already-removed URNs, then preview + up)." >&2
			exit 1
		fi

		if [[ -n "$RESUME_WORKER_URN" && "$RESUME_WORKER_NAME" == "workflows" ]]; then
			echo "  Detected: 'workflows' Worker already adopted (physical name 'workflows')."
			echo "  Resume will converge any remaining WorkerVersion/Deployment steps."
		elif [[ -z "$RESUME_WORKER_URN" ]]; then
			echo "  Detected: stale 'workflows-worker' removed from state; import pending."
			echo "  Resume will import the live 'workflows' Worker + 'perseus' Workflow"
			echo "  and create WorkerVersion/Deployment."
		else
			# Fail closed. --resume has only two known-safe partial states:
			# the logical Worker is absent (import pending), or it exists with
			# physical name 'workflows' (already adopted). Any other physical
			# name means the production stack is in a state this migration did
			# not create or model. Continuing would run a preview and then
			# unattended `pulumi up -y`, so a surprising checkpoint could be
			# mutated rather than quarantined. Abort before preview/up in all
			# modes (dry-run included) — the diagnostic below is still printed.
			echo "" >&2
			echo "ERROR: workflows-worker physical name is '$RESUME_WORKER_NAME'." >&2
			echo "       Expected 'perseus-workflows' (stale, pre-Step-2), 'workflows'" >&2
			echo "       (already adopted), or absent (import pending). Any other name" >&2
			echo "       means the production stack is in a state this migration did not" >&2
			echo "       create or model. Aborting to avoid mutating an unexpected" >&2
			echo "       checkpoint via unattended preview/up." >&2
			echo "       Inspect with: pulumi stack --show-urns${STACK_FLAG_DISPLAY:+ $STACK_FLAG_DISPLAY}" >&2
			echo "       If this is a known-safe state, resolve it manually before resuming." >&2
			exit 1
		fi

		# Guarded preview (read-only). Shows what remains to converge. Does
		# NOT restore the backup on failure — remote mutations may have already
		# happened, so restoring the pre-migration checkpoint would desync
		# state from live Cloudflare resources.
		echo ""
		echo "=== Resume: pulumi preview --diff ==="
		echo "  Read-only. Shows remaining import + create steps."
		if ! "${PULUMI_CMD[@]}" preview "${STACK_FLAGS[@]}" --diff; then
			echo "" >&2
			echo "ERROR: pulumi preview failed during resume." >&2
			echo "       State was NOT modified by preview. Do NOT restore the" >&2
			echo "       pre-migration backup — remote mutations may have already" >&2
			echo "       happened (that is why you are resuming)." >&2
			echo "       Inspect the preview error, fix the program/config, and re-run:" >&2
			echo "         $0 --resume${STACK_FLAG_DISPLAY:+ $STACK_FLAG_DISPLAY}" >&2
			exit 1
		fi

		if [[ "$DRY_RUN" == "true" ]]; then
			echo ""
			echo "=== Resume dry run complete ==="
			echo "Validated: partial-adoption detection + read-only preview."
			echo "NOT validated: pulumi up (re-run without --dry-run to converge)."
			exit 0
		fi

		# Converge. If this fails again partway, Pulumi checkpoints progress and
		# the operator re-runs --resume (detection is idempotent).
		echo ""
		echo "=== Resume: pulumi up ==="
		"${PULUMI_CMD[@]}" up "${STACK_FLAGS[@]}" -y

		echo ""
		echo "=== Resume: verify ==="
		echo "  Preview should show no create/replace for workflows-worker or perseus-workflow."
		"${PULUMI_CMD[@]}" preview "${STACK_FLAGS[@]}"
		echo ""
		echo "=== Resume complete ==="
		echo "Next steps:"
		echo "  1. Verify the preview above shows no create/replace for the Worker/Workflow."
		echo "  2. Remove the 'import' options from packages/infrastructure/src/workers.ts"
		echo "     (both the Worker and the Workflow resources)."
		echo "  3. Run 'pulumi up' again — preview must be clean (no create/replace)."
		echo "  4. Commit the removal and deploy normally."
		exit 0
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
		echo "" >&2
		echo "ERROR: 'workflows-worker' not found in stack state." >&2
		echo "       It may have already been migrated, OR Step 2 ran and Step 4" >&2
		echo "       (pulumi up) failed before importing the live 'workflows' Worker." >&2
		echo "       Inspect with: pulumi stack --show-urns${STACK_FLAG_DISPLAY:+ $STACK_FLAG_DISPLAY}" >&2
		echo "       If Step 4 failed partway, converge the partial update with:" >&2
		echo "         $0 --resume${STACK_FLAG_DISPLAY:+ $STACK_FLAG_DISPLAY}" >&2
		exit 1
	fi

	# Safety check: the resolved Worker must be the stale 'perseus-workflows'.
	# After adoption the logical name 'workflows-worker' still exists but its
	# physical name is 'workflows' — deleting that would destroy valid state.
	WORKER_NAME=$(worker_physical_name "$WORKER_URN" "$STACK_JSON")
	if [[ "$WORKER_NAME" != 'perseus-workflows' ]]; then
		echo "" >&2
		echo "ERROR: workflows-worker physical name is '$WORKER_NAME', not 'perseus-workflows'." >&2
		echo "       The migration may have already run, OR Step 4 (pulumi up) failed" >&2
		echo "       after importing the live 'workflows' Worker. Aborting to avoid" >&2
		echo "       deleting valid state." >&2
		echo "       Inspect with: pulumi stack --show-urns${STACK_FLAG_DISPLAY:+ $STACK_FLAG_DISPLAY}" >&2
		echo "       If Step 4 failed partway, converge the partial update with:" >&2
		echo "         $0 --resume${STACK_FLAG_DISPLAY:+ $STACK_FLAG_DISPLAY}" >&2
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
