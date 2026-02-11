#!/usr/bin/env bash
# Pre-deploy validation script
# Ensures production wrangler configs do not contain placeholder values.
# Usage: ./scripts/validate-wrangler-config.sh

set -euo pipefail

PLACEHOLDER="REPLACE_WITH_PRODUCTION_KV_NAMESPACE_ID"
EXIT_CODE=0

for config in apps/*/wrangler.production.toml; do
  if [ ! -f "$config" ]; then
    continue
  fi

  if grep -q "$PLACEHOLDER" "$config"; then
    echo "ERROR: $config contains placeholder '$PLACEHOLDER'. Replace with the actual KV namespace ID before deploying." >&2
    EXIT_CODE=1
  fi

  # Check for empty id values in kv_namespaces (allow leading whitespace)
  if grep -qE '^\s*id\s*=\s*""' "$config"; then
    echo "ERROR: $config contains an empty KV namespace id." >&2
    EXIT_CODE=1
  fi
done

if [ "$EXIT_CODE" -eq 0 ]; then
  echo "All wrangler production configs validated successfully."
fi

exit $EXIT_CODE
