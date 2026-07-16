#!/usr/bin/env bash
set -euo pipefail

# Tests for scripts/verify-tarball-paths.sh
#
# Creates safe and malicious tarballs in a temp directory and asserts the guard
# accepts/rejects them correctly. Malicious tarballs are crafted with Python's
# tarfile module so paths like ../ and /etc/ can be injected without needing
# GNU tar's --transform (macOS uses bsdtar which has different syntax).
#
# Run with:
#   bash scripts/verify-tarball-paths.test.sh
#
# Exits 0 if all tests pass, 1 if any fail.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$SCRIPT_DIR/verify-tarball-paths.sh"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

PASS=0
FAIL=0

assert_accepts() {
	local label="$1"
	local tarball="$2"
	if bash "$GUARD" "$tarball" >/dev/null 2>&1; then
		PASS=$((PASS + 1))
		echo "  PASS: $label"
	else
		FAIL=$((FAIL + 1))
		echo "  FAIL: $label (expected accept, got reject)"
	fi
}

assert_rejects() {
	local label="$1"
	local tarball="$2"
	set +e
	bash "$GUARD" "$tarball" >/dev/null 2>&1
	local code=$?
	set -e
	if [[ "$code" -eq 1 ]]; then
		PASS=$((PASS + 1))
		echo "  PASS: $label"
	else
		FAIL=$((FAIL + 1))
		echo "  FAIL: $label (expected exit 1, got $code)"
	fi
}

assert_exit_code() {
	local label="$1"
	local tarball="$2"
	local expected="$3"
	set +e
	bash "$GUARD" "$tarball" >/dev/null 2>&1
	local code=$?
	set -e
	if [[ "$code" -eq "$expected" ]]; then
		PASS=$((PASS + 1))
		echo "  PASS: $label"
	else
		FAIL=$((FAIL + 1))
		echo "  FAIL: $label (expected exit $expected, got $code)"
	fi
}

# Create a tarball with the given entry paths. Uses Python tarfile so we can
# inject arbitrary paths (absolute, ../) without filesystem or tar-variant
# quirks. Each entry is a small regular file.
make_tarball() {
	local out="$1"
	shift
	python3 -c "
import sys, tarfile, io
out = sys.argv[1]
paths = sys.argv[2:]
with tarfile.open(out, 'w:gz') as t:
    for p in paths:
        info = tarfile.TarInfo(name=p)
        data = b'x'
        info.size = len(data)
        t.addfile(info, io.BytesIO(data))
" "$out" "$@"
}

# Create a tarball with symlink/hardlink entries. Each argument is a
# pipe-delimited spec: name|type|target where type is "symlink" or "hardlink".
make_tarball_with_links() {
	local out="$1"
	shift
	python3 -c "
import sys, tarfile, io
out = sys.argv[1]
specs = sys.argv[2:]
with tarfile.open(out, 'w:gz') as t:
    for spec in specs:
        name, ltype, target = spec.split('|')
        info = tarfile.TarInfo(name=name)
        if ltype == 'symlink':
            info.type = tarfile.SYMTYPE
        else:
            info.type = tarfile.LNKTYPE
        info.linkname = target
        info.size = 0
        t.addfile(info)
" "$out" "$@"
}

echo "Running verify-tarball-paths.sh tests..."

# --- Safe tarballs (should be accepted) ---

make_tarball "$TMPDIR/safe-simple.tgz" "catalog.json" "images/01.jpg"
assert_accepts "simple relative paths" "$TMPDIR/safe-simple.tgz"

make_tarball "$TMPDIR/safe-nested.tgz" "images/sub/deep/01.jpg"
assert_accepts "nested relative paths" "$TMPDIR/safe-nested.tgz"

make_tarball "$TMPDIR/safe-dotfile.tgz" ".catalog.json" "images/.hidden"
assert_accepts "dotfiles (not parent traversal)" "$TMPDIR/safe-dotfile.tgz"

# --- Unsafe tarballs (should be rejected) ---

make_tarball "$TMPDIR/abs-path.tgz" "/etc/catalog.json"
assert_rejects "absolute path entry" "$TMPDIR/abs-path.tgz"

make_tarball "$TMPDIR/traversal.tgz" "../evil.txt"
assert_rejects "parent traversal (..)" "$TMPDIR/traversal.tgz"

make_tarball "$TMPDIR/deep-traversal.tgz" "images/../../evil.txt"
assert_rejects "deep parent traversal (images/../../evil.txt)" "$TMPDIR/deep-traversal.tgz"

make_tarball "$TMPDIR/mixed.tgz" "images/01.jpg" "../../../catalog.json"
assert_rejects "mixed safe + unsafe entries" "$TMPDIR/mixed.tgz"

make_tarball "$TMPDIR/dotdot-only.tgz" ".."
assert_rejects "bare .. entry" "$TMPDIR/dotdot-only.tgz"

# --- Unsafe symlink/hardlink entries (should be rejected) ---

make_tarball_with_links "$TMPDIR/symlink-abs.tgz" \
	"evil.link|symlink|/etc/passwd"
assert_rejects "symlink with absolute target" "$TMPDIR/symlink-abs.tgz"

make_tarball_with_links "$TMPDIR/symlink-traversal.tgz" \
	"evil.link|symlink|../../etc/passwd"
assert_rejects "symlink with parent traversal target" "$TMPDIR/symlink-traversal.tgz"

make_tarball_with_links "$TMPDIR/hardlink-abs.tgz" \
	"evil.link|hardlink|/etc/passwd"
assert_rejects "hardlink with absolute target" "$TMPDIR/hardlink-abs.tgz"

make_tarball_with_links "$TMPDIR/hardlink-traversal.tgz" \
	"evil.link|hardlink|../../etc/passwd"
assert_rejects "hardlink with parent traversal target" "$TMPDIR/hardlink-traversal.tgz"

# Safe symlink (relative, no traversal) should be accepted.
make_tarball_with_links "$TMPDIR/symlink-safe.tgz" \
	"link.txt|symlink|target.txt"
assert_accepts "symlink with safe relative target" "$TMPDIR/symlink-safe.tgz"

# --- Edge cases ---

assert_exit_code "missing tarball" "$TMPDIR/nonexistent.tgz" 2
assert_exit_code "no argument (usage)" "" 2

# Corrupt tarball (not valid gzip) should exit 2, not be masked as safe.
printf 'this is not a valid gzip archive' > "$TMPDIR/corrupt.tgz"
assert_exit_code "corrupt tarball" "$TMPDIR/corrupt.tgz" 2

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
	exit 1
fi
exit 0
