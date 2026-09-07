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

# An unrelated resource to ensure exact-name matching (not prefix matching).
API_WORKER_URN=$(mock_urn "cloudflare:index/worker:Worker" "api-worker")

MOCK_JSON=$(cat <<ENDJSON
{
  "version": 3,
  "deployment": {
    "resources": [
      {"urn": "${API_WORKER_URN}", "type": "cloudflare:index/worker:Worker"},
      {"urn": "${WORKER_URN_MOCK}", "type": "cloudflare:index/worker:Worker"},
      {"urn": "${VERSION_URN_MOCK}", "type": "cloudflare:index/workerversion:WorkerVersion"},
      {"urn": "${WORKFLOW_URN_MOCK}", "type": "cloudflare:index/workflow:Workflow"},
      {"urn": "${VERSION_DO_URN_MOCK}", "type": "cloudflare:index/workerversion:WorkerVersion"},
      {"urn": "${DEPLOYMENT_URN_MOCK}", "type": "cloudflare:index/workersdeployment:WorkersDeployment"}
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

# ---------------------------------------------------------------------------
# Test 5: print_plan outputs reverse dependency order
# ---------------------------------------------------------------------------
echo ""
echo "Test 5: print_plan shows reverse dependency order"

plan_output=$(print_plan)
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

# Full order: deployment < version-do < workflow < version < worker
if [[ "$dep_line" -lt "$vdo_line" && "$vdo_line" -lt "$wf_line" && "$wf_line" -lt "$ver_line" && "$ver_line" -lt "$worker_line" ]]; then
	ok "full reverse-dependency order correct: dep < vdo < wf < ver < worker"
else
	fail "order incorrect: dep=$dep_line vdo=$vdo_line wf=$wf_line ver=$ver_line worker=$worker_line"
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
