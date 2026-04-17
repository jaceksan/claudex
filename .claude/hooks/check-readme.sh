#!/usr/bin/env bash
# Claude Code PreToolUse hook: nudges when a `git commit` touches user-visible
# surface without updating README.md. Contract: reads a JSON event on stdin
# ({tool_name, tool_input, ...}); exit 2 with stderr blocks the tool call and
# surfaces the message to the agent.
#
# Bypass for bugfixes/refactors/docs-only edits by including the literal
# `CLAUDEX_SKIP_README=1` anywhere in the commit command line.

set -euo pipefail

payload=$(cat)

tool=$(printf '%s' "$payload" | jq -r '.tool_name // empty' 2>/dev/null || true)
[[ "$tool" == "Bash" ]] || exit 0

cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
[[ -n "$cmd" ]] || exit 0

# Only fire on `git commit …` (not `git commit-tree`, not `git log commit`, etc.).
if [[ ! "$cmd" =~ (^|[^[:alnum:]_/])git[[:space:]]+commit([[:space:]]|$) ]]; then
  exit 0
fi

# Explicit bypass.
if [[ "$cmd" == *"CLAUDEX_SKIP_README=1"* ]]; then
  exit 0
fi

staged=$(git diff --cached --name-only 2>/dev/null || true)
[[ -n "$staged" ]] || exit 0

# User-visible surface: changes here typically warrant a README feature bullet.
# Broadened carefully — tests, build config, and server internals (session/, db, git)
# are deliberately excluded.
surface_re='^(src/web/(pages|components)/|src/server/ws/envelope\.ts$|src/server/commands\.ts$|src/server/worktree\.ts$|src/server/notifications\.ts$)'

if ! printf '%s\n' "$staged" | grep -Eq "$surface_re"; then
  exit 0
fi

if printf '%s\n' "$staged" | grep -Fxq 'README.md'; then
  exit 0
fi

cat >&2 <<'EOF'
[claudex/readme-check] This commit touches user-visible surface (web pages/components or a server feature file) but README.md is not staged.

If this change adds or alters a user-visible feature, update the "Why use it" section of README.md and stage it into this commit.

Bypass for pure bugfixes/refactors/internal edits by including the literal
  CLAUDEX_SKIP_README=1
anywhere in your commit command line (e.g. `CLAUDEX_SKIP_README=1 git commit -m …`).
EOF

exit 2
