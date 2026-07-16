#!/usr/bin/env bash
set -euo pipefail

# Guard against tar path traversal before extraction. Reject any entry that is
# absolute or climbs out of the target directory (..) — a tampered/crafted
# tarball could otherwise overwrite files outside the extraction directory.
# Also reject symlink/hardlink entries whose targets are absolute or traverse
# parent directories — a safe-named link pointing outside the extraction dir
# is equally dangerous after extraction.
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
#   0 — all entries are safe (relative, no parent traversal, no dangerous links)
#   1 — one or more entries are unsafe (printed to stderr)
#   2 — usage error or tarball unreadable/corrupt

usage() {
	cat <<'EOF'
Usage:
  scripts/verify-tarball-paths.sh <tarball>

Checks every entry in the tarball for path-traversal safety:
  - Rejects absolute paths (leading /)
  - Rejects any path component equal to .. (parent traversal)
  - Rejects symlink/hardlink entries with absolute or parent-traversal targets

Exits 0 if all entries are safe, 1 if any are unsafe, 2 if unreadable/corrupt.
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

# List entries — capture tar output separately so a corrupt/unreadable archive
# is not masked by the awk pipeline's || true.
TAR_OUTPUT=$(tar -tzf "$tarball" 2>&1) || {
	echo "::error::Failed to list tarball (corrupt or unreadable): $tarball" >&2
	exit 2
}

# Check 1: Path-based — flag absolute or parent traversal paths.
BAD=$(printf '%s\n' "$TAR_OUTPUT" | awk -F/ '
	$0 ~ /^\//        { print; next }
	{ for (i=1;i<=NF;i++) if ($i == "..") { print; break } }
')

if [[ -n "$BAD" ]]; then
	echo "::error::Tarball contains unsafe path(s) (absolute or parent traversal):" >&2
	# Quote $BAD so malicious entries with glob chars (e.g. "*") don't expand
	# against the cwd in the error output. Read line-by-line to preserve paths.
	while IFS= read -r line; do
		printf '  %s\n' "$line" >&2
	done <<< "$BAD"
	exit 1
fi

# Check 2: Link-based — reject symlink/hardlink entries whose targets are
# absolute or contain parent traversal. A crafted link with a safe path but
# a dangerous target (e.g. -> /etc/passwd) can still escape the extraction
# directory after extraction.
#
# Verbose listing format: permissions are the first field. Symlinks start
# with 'l' and contain " -> target"; hardlinks start with 'h' and contain
# " link to target".
LINK_BAD=$(tar -tvf "$tarball" 2>/dev/null | awk '
	$1 ~ /^[lh]/ {
		if (match($0, / -> /)) {
			target = substr($0, RSTART + 4)
		} else if (match($0, / link to /)) {
			target = substr($0, RSTART + 9)
		} else {
			target = ""
		}
		if (target == "" || target ~ /^\// || target ~ /(^|\/)\.\.\//) {
			print
		}
	}
') || true

if [[ -n "$LINK_BAD" ]]; then
	echo "::error::Tarball contains symlink/hardlink entries with unsafe targets:" >&2
	while IFS= read -r line; do
		printf '  %s\n' "$line" >&2
	done <<< "$LINK_BAD"
	exit 1
fi

exit 0
