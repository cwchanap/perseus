#!/usr/bin/env bash
set -euo pipefail

# Guard against tar path traversal before extraction. Reject any entry that is
# absolute or climbs out of the target directory (..) — a tampered/crafted
# tarball could otherwise overwrite files outside the extraction directory.
#
# This is defense-in-depth: the caller is expected to have already verified the
# tarball checksum. But a checksum pins content, not intent — a correctly
# checksummed tarball can still contain malicious paths if the source was
# compromised before packaging.
#
# Usage:
#   scripts/verify-tarball-paths.sh <tarball>
#
# Exit codes:
#   0 — all entries are safe (relative, no parent traversal)
#   1 — one or more entries are unsafe (printed to stderr)
#   2 — usage error or tarball unreadable

usage() {
	cat <<'EOF'
Usage:
  scripts/verify-tarball-paths.sh <tarball>

Checks every entry in the tarball for path-traversal safety:
  - Rejects absolute paths (leading /)
  - Rejects any path component equal to .. (parent traversal)

Exits 0 if all entries are safe, 1 if any are unsafe.
EOF
}

tarball="${1:-}"
if [[ -z "$tarball" ]]; then
	usage >&2
	exit 2
fi
if [[ ! -f "$tarball" ]]; then
	echo "Tarball not found: $tarball" >&2
	exit 2
fi

# List entries and flag unsafe ones. Two checks per line:
#   1. $0 ~ /^\//  — path starts with / (absolute)
#   2. any field == ".."  — parent directory traversal
BAD=$(tar -tzf "$tarball" | awk -F/ '
	$0 ~ /^\//        { print; next }
	{ for (i=1;i<=NF;i++) if ($i == "..") { print; break } }
' || true)

if [[ -n "$BAD" ]]; then
	echo "::error::Tarball contains unsafe path(s) (absolute or parent traversal):" >&2
	# Quote $BAD so malicious entries with glob chars (e.g. "*") don't expand
	# against the cwd in the error output. Read line-by-line to preserve paths.
	while IFS= read -r line; do
		printf '  %s\n' "$line" >&2
	done <<< "$BAD"
	exit 1
fi

exit 0
