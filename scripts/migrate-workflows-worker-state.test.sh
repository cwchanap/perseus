#!/usr/bin/env bash
# Tests for migrate-workflows-worker-state.sh — validates URN resolution and
# deletion ordering without touching real Pulumi state.
#
# Run:  bash scripts/migrate-workflows-worker-state.test.sh
#   or  bun run test:shell   (after adding to the test:shell script)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/migrate-workflows-worker-state.sh"

PASS=0
FAIL=0

ok() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1" >&2; FAIL=$((FAIL + 1)); }

# Source the script to access extract_urn and resolve_urns.
# shellcheck disable=SC1090
source "$SCRIPT"

# ---------------------------------------------------------------------------
# Mock `pulumi stack export` JSON — simulates the stale state subtree.
# URNs follow the real format: urn:pulumi:<org>::<project>::<type>::<name>
# ---------------------------------------------------------------------------
MOCK_ORG="cwchanap"
MOCK_PROJECT="perseus-infrastructure"

mock_urn() {
	local type="$1"
	local name="$2"
	echo "urn:pulumi:${MOCK_ORG}::${MOCK_PROJECT}::${type}::${name}"
}

WORKER_URN_MOCK=$(mock_urn "cloudflare:index/worker:Worker" "workflows-worker")
VERSION_URN_MOCK=$(mock_urn "cloudflare:index/workerversion:WorkerVersion" "workflows-worker-version")
WORKFLOW_URN_MOCK=$(mock_urn "cloudflare:index/workflow:Workflow" "perseus-workflow")
VERSION_DO_URN_MOCK=$(mock_urn "cloudflare:index/workerversion:WorkerVersion" "workflows-worker-version-do")
DEPLOYMENT_URN_MOCK=$(mock_urn "cloudflare:index/workersdeployment:WorkersDeployment" "workflows-worker-deployment")

# External API-chain dependents of workflows-worker-version-do.
API_VERSION_URN_MOCK=$(mock_urn "cloudflare:index/workerversion:WorkerVersion" "api-worker-version")
API_DEPLOYMENT_URN_MOCK=$(mock_urn "cloudflare:index/workersdeployment:WorkersDeployment" "api-worker-deployment")
API_CRON_URN_MOCK=$(mock_urn "cloudflare:index/workerscrontrigger:WorkersCronTrigger" "api-worker-cron-trigger")

# An unrelated resource to ensure exact-name matching (not prefix matching).
API_WORKER_URN=$(mock_urn "cloudflare:index/worker:Worker" "api-worker")

MOCK_JSON=$(cat <<ENDJSON
{
  "version": 3,
  "deployment": {
    "resources": [
      {"urn": "${API_WORKER_URN}", "type": "cloudflare:index/worker:Worker", "inputs": {"name": "api"}},
      {"urn": "${WORKER_URN_MOCK}", "type": "cloudflare:index/worker:Worker", "inputs": {"name": "perseus-workflows"}},
      {"urn": "${VERSION_URN_MOCK}", "type": "cloudflare:index/workerversion:WorkerVersion"},
      {"urn": "${WORKFLOW_URN_MOCK}", "type": "cloudflare:index/workflow:Workflow"},
      {"urn": "${VERSION_DO_URN_MOCK}", "type": "cloudflare:index/workerversion:WorkerVersion"},
      {"urn": "${DEPLOYMENT_URN_MOCK}", "type": "cloudflare:index/workersdeployment:WorkersDeployment"},
      {"urn": "${API_VERSION_URN_MOCK}", "type": "cloudflare:index/workerversion:WorkerVersion"},
      {"urn": "${API_DEPLOYMENT_URN_MOCK}", "type": "cloudflare:index/workersdeployment:WorkersDeployment"},
      {"urn": "${API_CRON_URN_MOCK}", "type": "cloudflare:index/workerscrontrigger:WorkersCronTrigger"}
    ]
  }
}
ENDJSON
)

# ---------------------------------------------------------------------------
# Test 1: extract_urn resolves exact logical names
# ---------------------------------------------------------------------------
echo "Test 1: extract_urn resolves exact logical names"

result=$(extract_urn "workflows-worker" "$MOCK_JSON")
if [[ "$result" == "$WORKER_URN_MOCK" ]]; then
	ok "workflows-worker → $result"
else
	fail "expected $WORKER_URN_MOCK, got '$result'"
fi

result=$(extract_urn "perseus-workflow" "$MOCK_JSON")
if [[ "$result" == "$WORKFLOW_URN_MOCK" ]]; then
	ok "perseus-workflow → $result"
else
	fail "expected $WORKFLOW_URN_MOCK, got '$result'"
fi

result=$(extract_urn "workflows-worker-deployment" "$MOCK_JSON")
if [[ "$result" == "$DEPLOYMENT_URN_MOCK" ]]; then
	ok "workflows-worker-deployment → $result"
else
	fail "expected $DEPLOYMENT_URN_MOCK, got '$result'"
fi

# ---------------------------------------------------------------------------
# Test 2: extract_urn does NOT match prefix-similar names
# 'workflows-worker' must not match 'workflows-worker-version'
# ---------------------------------------------------------------------------
echo ""
echo "Test 2: extract_urn rejects prefix-similar names"

result=$(extract_urn "workflows-worker-version" "$MOCK_JSON")
if [[ "$result" == "$VERSION_URN_MOCK" ]]; then
	ok "workflows-worker-version → $result (not confused with -do)"
else
	fail "expected $VERSION_URN_MOCK, got '$result'"
fi

result=$(extract_urn "workflows-worker-version-do" "$MOCK_JSON")
if [[ "$result" == "$VERSION_DO_URN_MOCK" ]]; then
	ok "workflows-worker-version-do → $result"
else
	fail "expected $VERSION_DO_URN_MOCK, got '$result'"
fi

# Ensure 'workflows-worker' doesn't accidentally match longer names
result=$(extract_urn "workflows-worker" "$MOCK_JSON")
if [[ "$result" != *"-version"* && "$result" != *"-deployment"* ]]; then
	ok "workflows-worker does not match version/deployment variants"
else
	fail "workflows-worker matched a longer name: '$result'"
fi

# ---------------------------------------------------------------------------
# Test 3: extract_urn returns empty for missing resources
# ---------------------------------------------------------------------------
echo ""
echo "Test 3: extract_urn returns empty for missing resources"

result=$(extract_urn "nonexistent-resource" "$MOCK_JSON")
if [[ -z "$result" ]]; then
	ok "missing resource returns empty string"
else
	fail "expected empty, got '$result'"
fi

# ---------------------------------------------------------------------------
# Test 4: resolve_urns sets all global variables
# ---------------------------------------------------------------------------
echo ""
echo "Test 4: resolve_urns populates all URN variables"

resolve_urns "$MOCK_JSON"

if [[ "$WORKER_URN" == "$WORKER_URN_MOCK" ]]; then
	ok "WORKER_URN correct"
else
	fail "WORKER_URN: expected $WORKER_URN_MOCK, got '$WORKER_URN'"
fi

if [[ "$VERSION_URN" == "$VERSION_URN_MOCK" ]]; then
	ok "VERSION_URN correct"
else
	fail "VERSION_URN: expected $VERSION_URN_MOCK, got '$VERSION_URN'"
fi

if [[ "$WORKFLOW_URN" == "$WORKFLOW_URN_MOCK" ]]; then
	ok "WORKFLOW_URN correct"
else
	fail "WORKFLOW_URN: expected $WORKFLOW_URN_MOCK, got '$WORKFLOW_URN'"
fi

if [[ "$VERSION_DO_URN" == "$VERSION_DO_URN_MOCK" ]]; then
	ok "VERSION_DO_URN correct"
else
	fail "VERSION_DO_URN: expected $VERSION_DO_URN_MOCK, got '$VERSION_DO_URN'"
fi

if [[ "$DEPLOYMENT_URN" == "$DEPLOYMENT_URN_MOCK" ]]; then
	ok "DEPLOYMENT_URN correct"
else
	fail "DEPLOYMENT_URN: expected $DEPLOYMENT_URN_MOCK, got '$DEPLOYMENT_URN'"
fi

if [[ "$API_VERSION_URN" == "$API_VERSION_URN_MOCK" ]]; then
	ok "API_VERSION_URN correct"
else
	fail "API_VERSION_URN: expected $API_VERSION_URN_MOCK, got '$API_VERSION_URN'"
fi

if [[ "$API_DEPLOYMENT_URN" == "$API_DEPLOYMENT_URN_MOCK" ]]; then
	ok "API_DEPLOYMENT_URN correct"
else
	fail "API_DEPLOYMENT_URN: expected $API_DEPLOYMENT_URN_MOCK, got '$API_DEPLOYMENT_URN'"
fi

if [[ "$API_CRON_URN" == "$API_CRON_URN_MOCK" ]]; then
	ok "API_CRON_URN correct"
else
	fail "API_CRON_URN: expected $API_CRON_URN_MOCK, got '$API_CRON_URN'"
fi

# ---------------------------------------------------------------------------
# Test 5: print_plan outputs reverse dependency order
# ---------------------------------------------------------------------------
echo ""
echo "Test 5: print_plan shows reverse dependency order"

resolve_urns "$MOCK_JSON"
build_deletion_order
plan_output=$(print_plan)
# The API cron-trigger (outermost dependent) must appear before everything else.
api_cron_line=$(echo "$plan_output" | grep -n "api-worker-cron-trigger" | head -1 | cut -d: -f1)
# The deployment (leaf) must appear before the worker (root).
dep_line=$(echo "$plan_output" | grep -n "workflows-worker-deployment" | head -1 | cut -d: -f1)
worker_line=$(echo "$plan_output" | grep -n "workflows-worker$" | head -1 | cut -d: -f1)

if [[ -n "$dep_line" && -n "$worker_line" && "$dep_line" -lt "$worker_line" ]]; then
	ok "deployment (line $dep_line) before worker (line $worker_line)"
else
	fail "expected deployment before worker; got dep=$dep_line worker=$worker_line"
fi

# version-do must appear before workflow (version-do depends on workflow)
vdo_line=$(echo "$plan_output" | grep -n "workflows-worker-version-do" | head -1 | cut -d: -f1)
wf_line=$(echo "$plan_output" | grep -n "perseus-workflow" | head -1 | cut -d: -f1)
if [[ -n "$vdo_line" && -n "$wf_line" && "$vdo_line" -lt "$wf_line" ]]; then
	ok "version-do (line $vdo_line) before workflow (line $wf_line)"
else
	fail "expected version-do before workflow; got vdo=$vdo_line wf=$wf_line"
fi

# workflow must appear before version (workflow depends on version)
ver_line=$(echo "$plan_output" | grep -n "workflows-worker-version$" | head -1 | cut -d: -f1)
if [[ -n "$wf_line" && -n "$ver_line" && "$wf_line" -lt "$ver_line" ]]; then
	ok "workflow (line $wf_line) before version (line $ver_line)"
else
	fail "expected workflow before version; got wf=$wf_line ver=$ver_line"
fi

# API chain must appear before workflows-worker-version-do (the version-do has
# the API version as an external dependent via createApiWorker's dependsOn).
api_ver_line=$(echo "$plan_output" | grep -n "api-worker-version$" | head -1 | cut -d: -f1)
api_dep_line=$(echo "$plan_output" | grep -n "api-worker-deployment" | head -1 | cut -d: -f1)
if [[ -n "$api_cron_line" && -n "$api_dep_line" && -n "$api_ver_line" \
	&& "$api_cron_line" -lt "$api_dep_line" && "$api_dep_line" -lt "$api_ver_line" ]]; then
	ok "API chain order: cron ($api_cron_line) < deployment ($api_dep_line) < version ($api_ver_line)"
else
	fail "expected api cron < deployment < version; got cron=$api_cron_line dep=$api_dep_line ver=$api_ver_line"
fi
if [[ -n "$api_ver_line" && -n "$vdo_line" && "$api_ver_line" -lt "$vdo_line" ]]; then
	ok "api-worker-version ($api_ver_line) before workflows-worker-version-do ($vdo_line)"
else
	fail "expected api-worker-version before version-do; got api_ver=$api_ver_line vdo=$vdo_line"
fi

# Full order: api-cron < api-dep < api-ver < wf-dep < vdo < wf < ver < worker
if [[ "$api_cron_line" -lt "$api_dep_line" && "$api_dep_line" -lt "$api_ver_line" \
	&& "$api_ver_line" -lt "$dep_line" && "$dep_line" -lt "$vdo_line" \
	&& "$vdo_line" -lt "$wf_line" && "$wf_line" -lt "$ver_line" && "$ver_line" -lt "$worker_line" ]]; then
	ok "full reverse-dependency order correct: api-cron < api-dep < api-ver < dep < vdo < wf < ver < worker"
else
	fail "order incorrect: api-cron=$api_cron_line api-dep=$api_dep_line api-ver=$api_ver_line dep=$dep_line vdo=$vdo_line wf=$wf_line ver=$ver_line worker=$worker_line"
fi

# ---------------------------------------------------------------------------
# Test 6: print_plan handles missing resources gracefully
# ---------------------------------------------------------------------------
echo ""
echo "Test 6: print_plan handles missing resources"

# Resolve against JSON that's missing version-do and deployment
PARTIAL_JSON=$(cat <<ENDJSON
{
  "version": 3,
  "deployment": {
    "resources": [
      {"urn": "${WORKER_URN_MOCK}", "type": "cloudflare:index/worker:Worker"},
      {"urn": "${VERSION_URN_MOCK}", "type": "cloudflare:index/workerversion:WorkerVersion"},
      {"urn": "${WORKFLOW_URN_MOCK}", "type": "cloudflare:index/workflow:Workflow"}
    ]
  }
}
ENDJSON
)
resolve_urns "$PARTIAL_JSON"
build_deletion_order
partial_plan=$(print_plan)
if echo "$partial_plan" | grep -q "SKIP.*workflows-worker-deployment"; then
	ok "missing deployment shown as SKIP"
else
	fail "expected SKIP for missing deployment"
fi
if echo "$partial_plan" | grep -q "SKIP.*workflows-worker-version-do"; then
	ok "missing version-do shown as SKIP"
else
	fail "expected SKIP for missing version-do"
fi
if echo "$partial_plan" | grep -q "SKIP.*api-worker-version"; then
	ok "missing api-worker-version shown as SKIP"
else
	fail "expected SKIP for missing api-worker-version"
fi

# ---------------------------------------------------------------------------
# Test 7: worker_physical_name distinguishes stale vs adopted Worker
# ---------------------------------------------------------------------------
echo ""
echo "Test 7: worker_physical_name reads inputs.name"

# Stale state: workflows-worker has inputs.name = 'perseus-workflows'
name=$(worker_physical_name "$WORKER_URN_MOCK" "$MOCK_JSON")
if [[ "$name" == "perseus-workflows" ]]; then
	ok "stale worker name → '$name'"
else
	fail "expected 'perseus-workflows', got '$name'"
fi

# Unrelated worker: api-worker has inputs.name = 'api'
name=$(worker_physical_name "$API_WORKER_URN" "$MOCK_JSON")
if [[ "$name" == "api" ]]; then
	ok "api worker name → '$name'"
else
	fail "expected 'api', got '$name'"
fi

# Missing URN returns empty
name=$(worker_physical_name "urn:pulumi:fake::fake::fake::fake" "$MOCK_JSON")
if [[ -z "$name" ]]; then
	ok "missing URN → empty name"
else
	fail "expected empty, got '$name'"
fi

# ---------------------------------------------------------------------------
# Test 8: post-adoption regression — physical name 'workflows' must NOT match
# the stale guard. A rerun after successful migration resolves the same logical
# name 'workflows-worker' but with inputs.name='workflows'. The migration must
# abort rather than delete valid managed state.
# ---------------------------------------------------------------------------
echo ""
echo "Test 8: post-adoption state is not treated as stale"

POST_ADOPTION_JSON=$(cat <<ENDJSON
{
  "version": 3,
  "deployment": {
    "resources": [
      {"urn": "${WORKER_URN_MOCK}", "type": "cloudflare:index/worker:Worker", "inputs": {"name": "workflows"}},
      {"urn": "${VERSION_URN_MOCK}", "type": "cloudflare:index/workerversion:WorkerVersion"},
      {"urn": "${WORKFLOW_URN_MOCK}", "type": "cloudflare:index/workflow:Workflow"}
    ]
  }
}
ENDJSON
)
resolve_urns "$POST_ADOPTION_JSON"
post_name=$(worker_physical_name "$WORKER_URN" "$POST_ADOPTION_JSON")
if [[ "$post_name" == "workflows" ]]; then
	ok "post-adoption worker name → '$post_name' (not 'perseus-workflows')"
else
	fail "expected 'workflows' for post-adoption state, got '$post_name'"
fi
# The guard condition: migration must proceed only when name == 'perseus-workflows'
if [[ "$post_name" != "perseus-workflows" ]]; then
	ok "guard would abort post-adoption rerun (name '$post_name' != 'perseus-workflows')"
else
	fail "guard would WRONGLY proceed on post-adoption state"
fi

# ---------------------------------------------------------------------------
# Test 9: required_artifact_paths lists the build artifacts the migration
# needs before pulumi preview/up. These must match packages/infrastructure
# Pulumi.yaml `main` and config.ts `paths` — a drift would let the script
# delete state and then fail at preview.
# ---------------------------------------------------------------------------
echo ""
echo "Test 9: required_artifact_paths matches Pulumi entry + config paths"

expected_paths=(
	'packages/infrastructure/dist/index.js'
	'apps/api/dist/worker.js'
	'apps/workflows/dist/index.js'
	'apps/web/build'
)
actual_paths=()
while IFS= read -r p; do
	actual_paths+=("$p")
done < <(required_artifact_paths)

if [[ "${#actual_paths[@]}" -eq "${#expected_paths[@]}" ]]; then
	ok "path count matches (${#actual_paths[@]})"
else
	fail "expected ${#expected_paths[@]} paths, got ${#actual_paths[@]}"
fi
all_match=true
for i in "${!expected_paths[@]}"; do
	if [[ "${actual_paths[$i]:-}" != "${expected_paths[$i]}" ]]; then
		fail "path[$i]: expected '${expected_paths[$i]}', got '${actual_paths[$i]:-}'"
		all_match=false
	fi
done
if [[ "$all_match" == true ]]; then
	ok "all artifact paths match Pulumi.yaml main + config.ts paths"
fi

# ---------------------------------------------------------------------------
# Test 10: --stack is appended to Pulumi subcommands, not the root command.
# Pulumi defines -s/--stack on subcommands (stack, state, preview, up), not on
# the root `pulumi` command, so `pulumi -s <stack> <subcommand>` fails before
# the first export. This stubs `pulumi`, runs the script with --dry-run --stack,
# and asserts the recorded argv never leads with --stack and that `stack
# export` carries --stack after the subcommand.
# ---------------------------------------------------------------------------
echo ""
echo "Test 10: --stack placed on subcommands, not root pulumi"

STUB_DIR=$(mktemp -d)
ARGV_LOG=$(mktemp)
cat > "$STUB_DIR/pulumi" <<EOF
#!/usr/bin/env bash
# Record the full argv on one line (space-joined) so the test can grep the
# complete command shape, then answer stack export with empty-state JSON so
# the script reaches its WORKER_URN safety check and exits cleanly.
printf '%s\n' "\$*" >> "$ARGV_LOG"
if [[ \$1 == "stack" && \$2 == "export" ]]; then
	printf '{"version":3,"deployment":{"resources":[]}}\n'
fi
exit 0
EOF
chmod +x "$STUB_DIR/pulumi"

# Run the script (not sourced) with the stub on PATH. Dry-run skips the
# build step and the state backup, but still calls `pulumi stack export`.
# Empty resources → WORKER_URN empty → clean exit 1 at the safety check.
PATH="$STUB_DIR:$PATH" bash "$SCRIPT" --dry-run --stack "cwchanap/perseus-infrastructure/production" >/dev/null 2>&1 || true

# No recorded invocation may lead with --stack (that would mean it was
# passed to the root `pulumi` command).
root_stack_count=$(grep -c '^--stack' "$ARGV_LOG" || true)
if [[ "$root_stack_count" -eq 0 ]]; then
	ok "no invocation passed --stack to the root pulumi command"
else
	fail "$root_stack_count invocation(s) passed --stack to root pulumi"
fi

# The `stack export` invocation must carry --stack <stack> after the
# subcommand, not before it.
export_line=$(grep '^stack export' "$ARGV_LOG" | head -1)
if [[ "$export_line" == "stack export --stack cwchanap/perseus-infrastructure/production" ]]; then
	ok "stack export appends --stack after subcommand: '$export_line'"
else
	fail "stack export argv wrong; expected 'stack export --stack ...', got '$export_line'"
fi

# Sanity: without --stack, the recorded argv must not contain --stack at all.
: > "$ARGV_LOG"
PATH="$STUB_DIR:$PATH" bash "$SCRIPT" --dry-run >/dev/null 2>&1 || true
no_stack_count=$(grep -c -- '--stack' "$ARGV_LOG" || true)
if [[ "$no_stack_count" -eq 0 ]]; then
	ok "no --stack flag emitted when --stack arg is absent"
else
	fail "$no_stack_count --stack flag(s) emitted without --stack arg"
fi

rm -rf "$STUB_DIR" "$ARGV_LOG"

# ---------------------------------------------------------------------------
# Test 11: execute mode requires an explicit production --stack. Without it,
# pulumi mutates whichever stack is currently selected in the checkout — a
# cheap way to delete state from the wrong stack. The stale-name guard does
# not prove the selected stack is production. Execute mode must fail fast
# unless --stack is supplied and ends in /perseus-infrastructure/production;
# dry-run (read-only) stays looser.
# ---------------------------------------------------------------------------
echo ""
echo "Test 11: execute mode requires explicit production --stack"

STUB_DIR11=$(mktemp -d)
ARGV_LOG11=$(mktemp)
cat > "$STUB_DIR11/pulumi" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$ARGV_LOG11"
if [[ \$1 == "stack" && \$2 == "export" ]]; then
	printf '{"version":3,"deployment":{"resources":[]}}\n'
fi
exit 0
EOF
chmod +x "$STUB_DIR11/pulumi"

# Execute mode without --stack must fail fast with the stack-required error,
# before any pulumi invocation.
: > "$ARGV_LOG11"
out=$(PATH="$STUB_DIR11:$PATH" bash "$SCRIPT" 2>&1 || true)
if echo "$out" | grep -q "ERROR: --stack is required for execute/resume mode"; then
	ok "execute mode without --stack fails fast"
else
	fail "execute mode without --stack did not fail with the expected error"
fi
pulumi_calls_before_gate=$(wc -l < "$ARGV_LOG11" | tr -d ' ')
if [[ "$pulumi_calls_before_gate" -eq 0 ]]; then
	ok "no pulumi call made before the stack gate"
else
	fail "pulumi called $pulumi_calls_before_gate time(s) before the stack gate"
fi

# Execute mode with a non-production --stack must fail fast.
out=$(PATH="$STUB_DIR11:$PATH" bash "$SCRIPT" --stack "cwchanap/perseus-infrastructure/staging" 2>&1 || true)
if echo "$out" | grep -q "must end in '/perseus-infrastructure/production'"; then
	ok "execute mode with non-production --stack fails fast"
else
	fail "execute mode with non-production --stack did not fail with the expected error"
fi

# Dry-run without --stack must NOT hit the execute-mode stack gate (it is
# read-only and allowed to run without an explicit stack).
out=$(PATH="$STUB_DIR11:$PATH" bash "$SCRIPT" --dry-run 2>&1 || true)
if ! echo "$out" | grep -q "ERROR: --stack is required for execute mode"; then
	ok "dry-run without --stack does not hit the execute-mode stack gate"
else
	fail "dry-run without --stack wrongly hit the execute-mode stack gate"
fi

rm -rf "$STUB_DIR11" "$ARGV_LOG11"

# ---------------------------------------------------------------------------
# Test 12: auto-restore the backup when the post-deletion preview fails.
# Step 2 strips the stale URNs from the stack checkpoint; if the read-only
# preview then fails (bad import ID, transient provider/auth failure), the
# script must restore the backup via `pulumi stack import` before exiting so
# a rerun can proceed — otherwise the WORKER_URN safety check fails on the
# stripped state. Stubs `pulumi` (export→mock state, state delete→ok,
# preview→fail, stack import→ok) and `bun` (no-op build) and runs in execute
# mode with a valid production --stack.
# ---------------------------------------------------------------------------
echo ""
echo "Test 12: auto-restore backup on post-deletion preview failure"

STUB_DIR12=$(mktemp -d)
ARGV_LOG12=$(mktemp)
MOCK_STATE_FILE=$(mktemp)
printf '%s' "$MOCK_JSON" > "$MOCK_STATE_FILE"
cat > "$STUB_DIR12/pulumi" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$ARGV_LOG12"
if [[ \$1 == "stack" && \$2 == "export" ]]; then
	cat "$MOCK_STATE_FILE"
	exit 0
fi
if [[ \$1 == "stack" && \$2 == "import" ]]; then
	cat > /dev/null
	exit 0
fi
if [[ \$1 == "state" && \$2 == "delete" ]]; then
	exit 0
fi
if [[ \$1 == "preview" ]]; then
	echo "simulated preview failure" >&2
	exit 1
fi
exit 0
EOF
chmod +x "$STUB_DIR12/pulumi"

# Stub bun so build_artifacts is a no-op (the real build is slow and not
# what this test exercises).
cat > "$STUB_DIR12/bun" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$STUB_DIR12/bun"

# The script writes a state-backup-*.json to REPO_ROOT in execute mode.
# Snapshot existing backups so the test can clean up only the one it creates.
REPO_ROOT12="$(cd "$SCRIPT_DIR/.." && pwd)"
before_backups=$(find "$REPO_ROOT12" -maxdepth 1 -name 'state-backup-*.json' 2>/dev/null | sort || true)

# Execute mode with a valid production stack. The stubbed pulumi fails
# preview; the script must restore the backup (call `stack import`) and
# exit non-zero. Capture the exit code without letting set -e abort the
# test harness on the expected non-zero exit.
exit_code=0
PATH="$STUB_DIR12:$PATH" bash "$SCRIPT" --stack "cwchanap/perseus-infrastructure/production" >/dev/null 2>&1 || exit_code=$?

if [[ "$exit_code" -ne 0 ]]; then
	ok "script exited non-zero on preview failure (exit $exit_code)"
else
	fail "script exited 0 despite preview failure"
fi

# state delete must have run (deletion happened before the failed preview).
delete_count=$(grep -c '^state delete' "$ARGV_LOG12" || true)
if [[ "$delete_count" -gt 0 ]]; then
	ok "state delete ran before preview ($delete_count call(s))"
else
	fail "state delete was not invoked before preview"
fi

# stack import must have run (auto-restore triggered by preview failure).
import_count=$(grep -c '^stack import' "$ARGV_LOG12" || true)
if [[ "$import_count" -gt 0 ]]; then
	ok "stack import (auto-restore) invoked on preview failure"
else
	fail "stack import was not invoked — backup not auto-restored"
fi

# The stack import must carry --stack (restore targets the right stack).
import_line=$(grep '^stack import' "$ARGV_LOG12" | head -1)
if [[ "$import_line" == "stack import --stack cwchanap/perseus-infrastructure/production" ]]; then
	ok "stack import targets the explicit stack: '$import_line'"
else
	fail "stack import argv wrong; expected '--stack ...', got '$import_line'"
fi

rm -rf "$STUB_DIR12" "$ARGV_LOG12" "$MOCK_STATE_FILE"

# Clean up the state-backup file this execute-mode run created in REPO_ROOT
# (leave any pre-existing backups untouched).
after_backups=$(find "$REPO_ROOT12" -maxdepth 1 -name 'state-backup-*.json' 2>/dev/null | sort || true)
new_backups=$(comm -13 <(printf '%s\n' "$before_backups") <(printf '%s\n' "$after_backups"))
if [[ -n "$new_backups" ]]; then
	while IFS= read -r f; do
		[[ -n "$f" ]] && rm -f "$f"
	done <<< "$new_backups"
fi

# ---------------------------------------------------------------------------
# Helper: build a stub `pulumi` + `bun` for --resume tests. The stub records
# argv, answers `stack export` with a mock state file, and lets the caller
# choose the `preview` exit code. `state delete` and `stack import` succeed
# (so the test can assert they were NOT called — resume must not invoke
# either). Args: <stub_dir> <argv_log> <mock_state_file> <preview_exit>
# ---------------------------------------------------------------------------
make_resume_stub() {
	local dir="$1" log="$2" state="$3" preview_exit="$4"
	cat > "$dir/pulumi" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$log"
if [[ \$1 == "stack" && \$2 == "export" ]]; then
	cat "$state"
	exit 0
fi
if [[ \$1 == "stack" && \$2 == "import" ]]; then
	cat > /dev/null
	exit 0
fi
if [[ \$1 == "state" && \$2 == "delete" ]]; then
	exit 0
fi
if [[ \$1 == "preview" ]]; then
	exit $preview_exit
fi
if [[ \$1 == "up" ]]; then
	exit 0
fi
exit 0
EOF
	chmod +x "$dir/pulumi"
	cat > "$dir/bun" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
	chmod +x "$dir/bun"
}

# Snapshot existing state-backup files in REPO_ROOT so a test can clean up only
# the ones it creates. Args: <repo_root>; prints the snapshot on stdout.
snapshot_backups() {
	find "$1" -maxdepth 1 -name 'state-backup-*.json' 2>/dev/null | sort || true
}

# Remove state-backup files in REPO_ROOT that did not exist in the given
# snapshot. Args: <repo_root> <before_snapshot>
cleanup_new_backups() {
	local repo_root="$1" before="$2"
	local after new
	after=$(find "$repo_root" -maxdepth 1 -name 'state-backup-*.json' 2>/dev/null | sort || true)
	new=$(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after"))
	if [[ -n "$new" ]]; then
		while IFS= read -r f; do
			[[ -n "$f" ]] && rm -f "$f"
		done <<< "$new"
	fi
}

# ---------------------------------------------------------------------------
# Test 13: --resume converges an already-adopted Worker without re-running
# Step 2 deletion. After a failed Step 4 (`pulumi up`) that imported the live
# 'workflows' Worker, the logical name 'workflows-worker' exists with physical
# name 'workflows'. Resume must detect that, run guarded preview → up, and
# NOT call `state delete` (Step 2 already ran) or `stack import` (resume never
# restores the backup).
# ---------------------------------------------------------------------------
echo ""
echo "Test 13: --resume converges adopted Worker (no state delete, no restore)"

STUB_DIR13=$(mktemp -d)
ARGV_LOG13=$(mktemp)
STATE13=$(mktemp)
printf '%s' "$POST_ADOPTION_JSON" > "$STATE13"
make_resume_stub "$STUB_DIR13" "$ARGV_LOG13" "$STATE13" 0

REPO_ROOT13="$(cd "$SCRIPT_DIR/.." && pwd)"
before13=$(snapshot_backups "$REPO_ROOT13")

exit_code=0
PATH="$STUB_DIR13:$PATH" bash "$SCRIPT" --resume --stack "cwchanap/perseus-infrastructure/production" >/dev/null 2>&1 || exit_code=$?

if [[ "$exit_code" -eq 0 ]]; then
	ok "resume exited 0"
else
	fail "resume exited $exit_code (expected 0)"
fi
delete_count=$(grep -c '^state delete' "$ARGV_LOG13" || true)
if [[ "$delete_count" -eq 0 ]]; then
	ok "resume did not run state delete (Step 2 skipped)"
else
	fail "resume ran state delete $delete_count time(s) — must not re-delete"
fi
preview_count=$(grep -c '^preview' "$ARGV_LOG13" || true)
if [[ "$preview_count" -ge 1 ]]; then
	ok "resume ran guarded preview ($preview_count call(s))"
else
	fail "resume did not run preview"
fi
up_count=$(grep -c '^up' "$ARGV_LOG13" || true)
if [[ "$up_count" -ge 1 ]]; then
	ok "resume ran up ($up_count call(s))"
else
	fail "resume did not run up"
fi
import_count=$(grep -c '^stack import' "$ARGV_LOG13" || true)
if [[ "$import_count" -eq 0 ]]; then
	ok "resume did not run stack import (no backup restore)"
else
	fail "resume ran stack import $import_count time(s) — must not restore"
fi

rm -rf "$STUB_DIR13" "$ARGV_LOG13" "$STATE13"
cleanup_new_backups "$REPO_ROOT13" "$before13"

# ---------------------------------------------------------------------------
# Test 14: --resume refuses when the stale 'perseus-workflows' Worker is still
# in state (Step 2 did not complete). Resume is the wrong tool there — the
# normal flow resumes Step 2 via SKIP. Must exit non-zero before any
# preview/up/state-delete.
# ---------------------------------------------------------------------------
echo ""
echo "Test 14: --resume refuses when stale Worker still in state"

STUB_DIR14=$(mktemp -d)
ARGV_LOG14=$(mktemp)
STATE14=$(mktemp)
printf '%s' "$MOCK_JSON" > "$STATE14"
make_resume_stub "$STUB_DIR14" "$ARGV_LOG14" "$STATE14" 0

REPO_ROOT14="$(cd "$SCRIPT_DIR/.." && pwd)"
before14=$(snapshot_backups "$REPO_ROOT14")

exit_code=0
out14=$(PATH="$STUB_DIR14:$PATH" bash "$SCRIPT" --resume --stack "cwchanap/perseus-infrastructure/production" 2>&1) || exit_code=$?

if [[ "$exit_code" -ne 0 ]]; then
	ok "resume refused stale state (exit $exit_code)"
else
	fail "resume exited 0 despite stale 'perseus-workflows' Worker"
fi
if echo "$out14" | grep -q "stale 'perseus-workflows' Worker is still in state"; then
	ok "refusal message present"
else
	fail "refusal message missing"
fi
if [[ $(grep -c '^preview' "$ARGV_LOG14" || true) -eq 0 ]]; then
	ok "no preview after refusal"
else
	fail "preview ran after refusal"
fi
if [[ $(grep -c '^up' "$ARGV_LOG14" || true) -eq 0 ]]; then
	ok "no up after refusal"
else
	fail "up ran after refusal"
fi
if [[ $(grep -c '^state delete' "$ARGV_LOG14" || true) -eq 0 ]]; then
	ok "no state delete after refusal"
else
	fail "state delete ran after refusal"
fi

rm -rf "$STUB_DIR14" "$ARGV_LOG14" "$STATE14"
cleanup_new_backups "$REPO_ROOT14" "$before14"

# ---------------------------------------------------------------------------
# Test 15: --resume converges a pending-import state (stale Worker deleted,
# live 'workflows' not yet imported). WORKER_URN is absent. Resume must still
# run preview → up (the `import` options in the program adopt the live Worker).
# ---------------------------------------------------------------------------
echo ""
echo "Test 15: --resume converges pending-import state (Worker absent)"

STUB_DIR15=$(mktemp -d)
ARGV_LOG15=$(mktemp)
STATE15=$(mktemp)
printf '%s' '{"version":3,"deployment":{"resources":[]}}' > "$STATE15"
make_resume_stub "$STUB_DIR15" "$ARGV_LOG15" "$STATE15" 0

REPO_ROOT15="$(cd "$SCRIPT_DIR/.." && pwd)"
before15=$(snapshot_backups "$REPO_ROOT15")

exit_code=0
out15=$(PATH="$STUB_DIR15:$PATH" bash "$SCRIPT" --resume --stack "cwchanap/perseus-infrastructure/production" 2>&1) || exit_code=$?

if [[ "$exit_code" -eq 0 ]]; then
	ok "resume exited 0 for pending-import state"
else
	fail "resume exited $exit_code for pending-import state (expected 0)"
fi
if echo "$out15" | grep -q "import pending"; then
	ok "detected pending-import state"
else
	fail "did not report pending-import state"
fi
if [[ $(grep -c '^state delete' "$ARGV_LOG15" || true) -eq 0 ]]; then
	ok "no state delete for pending-import resume"
else
	fail "state delete ran during pending-import resume"
fi
if [[ $(grep -c '^up' "$ARGV_LOG15" || true) -ge 1 ]]; then
	ok "up ran to converge pending-import state"
else
	fail "up did not run for pending-import state"
fi

rm -rf "$STUB_DIR15" "$ARGV_LOG15" "$STATE15"
cleanup_new_backups "$REPO_ROOT15" "$before15"

# ---------------------------------------------------------------------------
# Test 16: --resume --dry-run stops after the read-only preview (no up, no
# state mutation). Validates the partial-adoption detection + preview without
# converging.
# ---------------------------------------------------------------------------
echo ""
echo "Test 16: --resume --dry-run stops after preview (no up)"

STUB_DIR16=$(mktemp -d)
ARGV_LOG16=$(mktemp)
STATE16=$(mktemp)
printf '%s' "$POST_ADOPTION_JSON" > "$STATE16"
make_resume_stub "$STUB_DIR16" "$ARGV_LOG16" "$STATE16" 0

exit_code=0
out16=$(PATH="$STUB_DIR16:$PATH" bash "$SCRIPT" --resume --dry-run --stack "cwchanap/perseus-infrastructure/production" 2>&1) || exit_code=$?

if [[ "$exit_code" -eq 0 ]]; then
	ok "resume dry-run exited 0"
else
	fail "resume dry-run exited $exit_code (expected 0)"
fi
if echo "$out16" | grep -q "Resume dry run complete"; then
	ok "dry-run completion message present"
else
	fail "dry-run completion message missing"
fi
if [[ $(grep -c '^up' "$ARGV_LOG16" || true) -eq 0 ]]; then
	ok "no up in resume dry-run"
else
	fail "up ran in resume dry-run"
fi
if [[ $(grep -c '^state delete' "$ARGV_LOG16" || true) -eq 0 ]]; then
	ok "no state delete in resume dry-run"
else
	fail "state delete ran in resume dry-run"
fi

rm -rf "$STUB_DIR16" "$ARGV_LOG16" "$STATE16"

# ---------------------------------------------------------------------------
# Test 17: --resume requires an explicit production --stack in execute mode
# (same gate as the normal migration). Without --stack, resume would mutate
# whichever stack is currently selected. Must fail fast before any pulumi call.
# ---------------------------------------------------------------------------
echo ""
echo "Test 17: --resume requires explicit production --stack"

STUB_DIR17=$(mktemp -d)
ARGV_LOG17=$(mktemp)
make_resume_stub "$STUB_DIR17" "$ARGV_LOG17" /dev/null 0

exit_code=0
out17=$(PATH="$STUB_DIR17:$PATH" bash "$SCRIPT" --resume 2>&1) || exit_code=$?

if [[ "$exit_code" -ne 0 ]]; then
	ok "resume without --stack failed fast (exit $exit_code)"
else
	fail "resume without --stack exited 0"
fi
if echo "$out17" | grep -q "ERROR: --stack is required for execute/resume mode"; then
	ok "stack-required error present"
else
	fail "stack-required error missing"
fi
pulumi_calls=$(wc -l < "$ARGV_LOG17" | tr -d ' ')
if [[ "$pulumi_calls" -eq 0 ]]; then
	ok "no pulumi call before the stack gate"
else
	fail "pulumi called $pulumi_calls time(s) before the stack gate"
fi

rm -rf "$STUB_DIR17" "$ARGV_LOG17"

# ---------------------------------------------------------------------------
# Test 18: --resume does NOT restore the pre-migration backup when the guarded
# preview fails. Remote mutations may have already happened (that is why we
# are resuming), so restoring the old checkpoint would desync state from live
# Cloudflare resources. Must exit non-zero with no `stack import` and no `up`.
# ---------------------------------------------------------------------------
echo ""
echo "Test 18: --resume does not restore backup on preview failure"

STUB_DIR18=$(mktemp -d)
ARGV_LOG18=$(mktemp)
STATE18=$(mktemp)
printf '%s' "$POST_ADOPTION_JSON" > "$STATE18"
make_resume_stub "$STUB_DIR18" "$ARGV_LOG18" "$STATE18" 1

REPO_ROOT18="$(cd "$SCRIPT_DIR/.." && pwd)"
before18=$(snapshot_backups "$REPO_ROOT18")

exit_code=0
PATH="$STUB_DIR18:$PATH" bash "$SCRIPT" --resume --stack "cwchanap/perseus-infrastructure/production" >/dev/null 2>&1 || exit_code=$?

if [[ "$exit_code" -ne 0 ]]; then
	ok "resume exited non-zero on preview failure (exit $exit_code)"
else
	fail "resume exited 0 despite preview failure"
fi
import_count=$(grep -c '^stack import' "$ARGV_LOG18" || true)
if [[ "$import_count" -eq 0 ]]; then
	ok "no stack import (backup not restored)"
else
	fail "stack import ran $import_count time(s) — must not restore during resume"
fi
up_count=$(grep -c '^up' "$ARGV_LOG18" || true)
if [[ "$up_count" -eq 0 ]]; then
	ok "no up after preview failure"
else
	fail "up ran $up_count time(s) after preview failure"
fi
delete_count=$(grep -c '^state delete' "$ARGV_LOG18" || true)
if [[ "$delete_count" -eq 0 ]]; then
	ok "no state delete during resume"
else
	fail "state delete ran $delete_count time(s) during resume"
fi

rm -rf "$STUB_DIR18" "$ARGV_LOG18" "$STATE18"
cleanup_new_backups "$REPO_ROOT18" "$before18"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "================================"
echo "Results: $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
	exit 1
fi
exit 0
