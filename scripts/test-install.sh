#!/usr/bin/env bash
# Exercises scripts/install.sh against a throwaway HOME.
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
INSTALL="$ROOT/scripts/install.sh"

FAKE_HOME="$(mktemp -d)"
trap 'rm -rf "$FAKE_HOME"' EXIT
export HOME="$FAKE_HOME"
unset XDG_CONFIG_HOME CODEX_HOME

# gh writes ~/.local/state/gh on any invocation, so snapshot only agent roots.
snapshot() {
  find "$HOME/.claude" "$HOME/.config" "$HOME/.codex" "$HOME/.agents" 2>/dev/null | sort || true
}

failures=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); }
check() {
  local name="$1"
  shift
  if "$@"; then pass "$name"; else fail "$name"; fi
}

out="$("$INSTALL" 2>&1)" && code=0 || code=$?
check "no config roots exits 1" [ "$code" -eq 1 ]
check "no config roots prints --agent guidance" grep -q -- '--agent claude' <<<"$out"

mkdir -p "$HOME/.claude" "$HOME/.config/opencode"
claude="$HOME/.claude/skills/guided-review"
opencode="$HOME/.config/opencode/skills/guided-review"
codex="$HOME/.codex/skills/guided-review"

before="$(snapshot)"
"$INSTALL" --dry-run >/dev/null 2>&1
check "dry-run changes nothing" [ "$before" = "$(snapshot)" ]

"$INSTALL" >/dev/null 2>&1
check "claude symlink created" [ -L "$claude" ]
check "opencode symlink created" [ -L "$opencode" ]
check "symlink is absolute repo root" [ "$(readlink "$claude")" = "$ROOT" ]
check "symlink resolves to SKILL.md" [ -f "$claude/SKILL.md" ]
check "codex/agents skipped without config root (1)" [ ! -e "$codex" ]
check "codex/agents skipped without config root (2)" [ ! -e "$HOME/.agents" ]

out="$("$INSTALL" 2>&1)"
check "rerun reports already installed" [ "$(grep -c 'already installed' <<<"$out")" -eq 2 ]

"$INSTALL" --copy --agent codex >/dev/null 2>&1
check "codex copy is a real dir (1)" [ -d "$codex" ]
check "codex copy is a real dir (2)" [ ! -L "$codex" ]
check "codex copy has SKILL.md" [ -f "$codex/SKILL.md" ]
check "codex copy excludes .git and node_modules (1)" [ ! -e "$codex/.git" ]
check "codex copy excludes .git and node_modules (2)" [ ! -e "$codex/node_modules" ]
out="$("$INSTALL" --copy --agent codex 2>&1)"
check "copy rerun updates" grep -q 'updated (copy)' <<<"$out"

before="$(snapshot)"
"$INSTALL" --uninstall --dry-run >/dev/null 2>&1
check "uninstall dry-run changes nothing" [ "$before" = "$(snapshot)" ]

"$INSTALL" --uninstall >/dev/null 2>&1
check "uninstall removed all (1)" [ ! -e "$claude" ]
check "uninstall removed all (2)" [ ! -L "$claude" ]
check "uninstall removed all (3)" [ ! -e "$opencode" ]
check "uninstall removed all (4)" [ ! -e "$codex" ]
check "uninstall kept the repo" [ -f "$ROOT/SKILL.md" ]

mkdir -p "$claude"
printf 'mine\n' >"$claude/notes.txt"
out="$("$INSTALL" --agent claude 2>&1)" && code=0 || code=$?
check "unrelated dir refused with exit 1" [ "$code" -eq 1 ]
check "unrelated dir refusal message" grep -q 'refused: existing path is not a guided-review install' <<<"$out"
check "unrelated dir left intact" [ -f "$claude/notes.txt" ]
"$INSTALL" --uninstall --agent claude >/dev/null 2>&1 || true
check "uninstall leaves unrelated dir" [ -f "$claude/notes.txt" ]
rm -rf "$claude"

other="$(mktemp -d)"
ln -s "$other" "$claude"
out="$("$INSTALL" --agent claude 2>&1)" && code=0 || code=$?
check "foreign symlink refused (1)" [ "$code" -eq 1 ]
check "foreign symlink refused (2)" [ "$(readlink "$claude")" = "$other" ]
rm -f "$claude"
rmdir "$other"

old="$(mktemp -d)"
cp "$ROOT/SKILL.md" "$old/SKILL.md"
ln -s "$old" "$claude"
"$INSTALL" --agent claude >/dev/null 2>&1
check "previous guided-review symlink replaced" [ "$(readlink "$claude")" = "$ROOT" ]
rm -rf "$old"

out="$("$INSTALL" --agent bogus 2>&1)" && code=0 || code=$?
check "unknown agent rejected" [ "$code" -eq 1 ]

if [ "$failures" -eq 0 ]; then
  printf 'all passed\n'
else
  printf '%d failed\n' "$failures"
  exit 1
fi
