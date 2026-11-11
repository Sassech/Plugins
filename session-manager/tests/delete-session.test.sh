#!/usr/bin/env bash
# Tests scripts/delete-session.sh against a throwaway CLAUDE_CONFIG_DIR.
# Run: bash session-manager/tests/delete-session.test.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
script="$here/../scripts/delete-session.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

export CLAUDE_CONFIG_DIR="$tmp/claude"
projects="$CLAUDE_CONFIG_DIR/projects"
proj="$projects/-work-demo"
mkdir -p "$proj"

target='11111111-1111-4111-8111-111111111111'
other='22222222-2222-4222-8222-222222222222'
current='33333333-3333-4333-8333-333333333333'

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

expect_exit() {
  local want=$1
  shift
  local output
  local got=0
  set +e
  output=$("$script" "$@" 2>&1)
  got=$?
  set -e
  if [[ $got -ne $want ]]; then
    fail "expected exit $want, got $got: $output"
  fi
}

expect_present() {
  [[ -e $1 ]] || fail "expected $1 to survive"
}

expect_absent() {
  [[ ! -e $1 && ! -L $1 ]] || fail "expected $1 to be gone"
}

# A transcript and its folder for the target, plus another session that must survive every case.
printf '{"type":"user"}\n' >"$proj/$target.jsonl"
mkdir -p "$proj/$target"
printf 'tool output\n' >"$proj/$target/tool.txt"
printf '{"type":"user"}\n' >"$proj/$other.jsonl"

# 1. A successful delete removes the transcript and its folder, and nothing else.
expect_exit 0 "$proj" "$target"
expect_absent "$proj/$target.jsonl"
expect_absent "$proj/$target"
expect_present "$proj/$other.jsonl"
expect_present "$proj"

# 2. A name that is not a UUID is refused (exit 3).
expect_exit 3 "$proj" 'not-a-uuid'
expect_present "$proj/$other.jsonl"

# 3. The running session is refused (exit 4).
expect_exit 4 "$proj" "$other" "$other"
expect_present "$proj/$other.jsonl"

# 4. A folder outside the projects root is refused (exit 6).
mkdir -p "$tmp/outside"
expect_exit 6 "$tmp/outside" "$other"
expect_present "$proj/$other.jsonl"

# 5. A UUID with no transcript and no folder fails (exit 7).
expect_exit 7 "$proj" '44444444-4444-4444-8444-444444444444'
expect_present "$projects"

echo "All delete-session.sh cases passed."
