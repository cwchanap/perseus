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
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "================================"
echo "Results: $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
	exit 1
fi
exit 0
