#!/usr/bin/env bash
# Deletes one Claude Code conversation: <project-dir>/<session-id>.jsonl and its <session-id>/ folder.
#
# Usage: delete-session.sh <project-dir> <session-id> [current-session-id]
#
#   <project-dir>         the project's transcript folder, ~/.claude/projects/<project-key>
#                         ($CLAUDE_CONFIG_DIR/projects/<project-key> when that variable is set)
#   <session-id>          the conversation to delete (a UUID)
#   [current-session-id]  the running session's id: refused as a target
#
# Exits 0 after deleting, non-zero with a message on stderr otherwise.
set -euo pipefail

fail() {
  echo "delete-session: $1" >&2
  exit "${2:-1}"
}

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "usage: delete-session.sh <project-dir> <session-id> [current-session-id]" >&2
  exit 2
fi

project_dir=$1
id=$2
current=${3:-}

uuid='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
[[ $id =~ $uuid ]] || fail "not a session id (UUID): $id" 3
[[ -z $current || $id != "$current" ]] || fail "refusing to delete the current session: $id" 4

config_dir=${CLAUDE_CONFIG_DIR:-${HOME:?HOME is not set}/.claude}
root=$(realpath -e -- "$config_dir/projects" 2>/dev/null) || fail "no projects folder at $config_dir/projects" 5
dir=$(realpath -e -- "$project_dir" 2>/dev/null) || fail "no such project folder: $project_dir" 5
# Only a direct child of the projects root: never the root itself, nothing outside it.
[[ -d $dir && $(dirname -- "$dir") == "$root" ]] || fail "refusing a folder outside $root: $project_dir" 6

transcript="$dir/$id.jsonl"
folder="$dir/$id"
if [[ ! -e $transcript && ! -L $transcript && ! -e $folder && ! -L $folder ]]; then
  fail "no session $id in $dir" 7
fi
if [[ -e $transcript && ! -L $transcript && ! -f $transcript ]]; then
  fail "not a regular file: $transcript" 8
fi

# A link is removed itself, never followed.
if [[ -e $transcript || -L $transcript ]]; then
  rm -f -- "$transcript"
fi
if [[ -L $folder ]]; then
  rm -f -- "$folder"
elif [[ -d $folder ]]; then
  rm -rf -- "$folder"
fi

echo "deleted session $id"
