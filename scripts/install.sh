#!/usr/bin/env bash
# Install this repo as the `guided-review` skill for AI coding agents.
set -euo pipefail

SKILL_NAME="guided-review"
MIN_HUNK="0.22.0"
ALL_AGENTS="opencode claude codex agents"

usage() {
  cat <<EOF
usage: scripts/install.sh [--agent <name>]... [--copy] [--uninstall] [--dry-run]

Installs this repo as the '$SKILL_NAME' skill by symlinking it into each
agent's user-level skill directory.

  --agent <name>  opencode | claude | codex | agents (repeatable).
                  Default: every agent whose config directory exists.
  --copy          copy the repo instead of symlinking it
  --uninstall     remove $SKILL_NAME installs this script recognizes
  --dry-run       print what would change, change nothing
  -h, --help      show this help
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

warn() {
  printf 'warning: %s\n' "$*" >&2
}

agent_root() {
  case "$1" in
    opencode) printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/opencode" ;;
    claude) printf '%s\n' "$HOME/.claude" ;;
    codex) printf '%s\n' "${CODEX_HOME:-$HOME/.codex}" ;;
    agents) printf '%s\n' "$HOME/.agents" ;;
    *) return 1 ;;
  esac
}

agent_skill_dir() {
  printf '%s/skills\n' "$(agent_root "$1")"
}

agents=()
mode="symlink"
uninstall=0
dry_run=0

while [ $# -gt 0 ]; do
  case "$1" in
    --agent)
      [ $# -ge 2 ] || die "--agent needs a value"
      agent_root "$2" >/dev/null || die "unknown agent '$2' (expected one of: $ALL_AGENTS)"
      agents+=("$2")
      shift 2
      ;;
    --agent=*)
      value="${1#--agent=}"
      agent_root "$value" >/dev/null || die "unknown agent '$value' (expected one of: $ALL_AGENTS)"
      agents+=("$value")
      shift
      ;;
    --copy) mode="copy"; shift ;;
    --uninstall) uninstall=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument '$1'" ;;
  esac
done

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

is_skill_dir() {
  [ -f "$1/SKILL.md" ] && grep -q "^name: ${SKILL_NAME}[[:space:]]*$" "$1/SKILL.md"
}

is_skill_dir "$ROOT" || die "$ROOT/SKILL.md does not declare 'name: $SKILL_NAME'"

resolve_dir() {
  (cd -P "$1" 2>/dev/null && pwd -P)
}

run() {
  if [ "$dry_run" -eq 1 ]; then
    printf '  would run: %s\n' "$*"
  else
    "$@"
  fi
}

version_lt() {
  local a b i x y
  IFS=. read -r -a a <<<"$1"
  IFS=. read -r -a b <<<"$2"
  for i in 0 1 2; do
    x="${a[$i]:-0}"
    y="${b[$i]:-0}"
    if [ "$x" -lt "$y" ]; then return 0; fi
    if [ "$x" -gt "$y" ]; then return 1; fi
  done
  return 1
}

check_prereqs() {
  local version
  printf 'Prerequisites\n'
  if command -v git >/dev/null 2>&1; then
    printf '  git      %s\n' "$(git --version)"
  else
    die "git is required and was not found on PATH"
  fi
  if command -v python3 >/dev/null 2>&1; then
    printf '  python3  %s\n' "$(python3 --version 2>&1)"
  else
    warn "python3 not found: scripts/prepare.py needs it"
  fi
  if command -v hunk >/dev/null 2>&1; then
    version="$(hunk --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true)"
    printf '  hunk     %s\n' "${version:-unknown version}"
    if [ -z "$version" ]; then
      warn "could not read hunk version; $MIN_HUNK or newer is required"
    elif version_lt "$version" "$MIN_HUNK"; then
      warn "hunk $version is older than $MIN_HUNK; run 'hunk update'"
    fi
  else
    warn "hunk not found: install hunk $MIN_HUNK or newer (https://github.com/modem-dev/hunk)"
  fi
  if command -v gh >/dev/null 2>&1; then
    printf '  gh       %s\n' "$(gh --version 2>/dev/null | head -n 1)"
  else
    warn "gh not found: needed to review pull requests"
  fi
  printf '\n'
}

# Prints one of: absent, ours-link, old-link, ours-copy, repo, foreign-link, foreign.
classify() {
  local dest="$1" target resolved
  if [ -L "$dest" ]; then
    target="$(readlink "$dest")"
    resolved="$(resolve_dir "$dest" || true)"
    if [ "$target" = "$ROOT" ] || [ "$resolved" = "$ROOT" ]; then
      printf 'ours-link\n'
    elif [ -n "$resolved" ] && is_skill_dir "$resolved"; then
      printf 'old-link\n'
    else
      printf 'foreign-link\n'
    fi
  elif [ -e "$dest" ]; then
    resolved="$(resolve_dir "$dest" || true)"
    if [ "$resolved" = "$ROOT" ]; then
      printf 'repo\n'
    elif [ -d "$dest" ] && is_skill_dir "$dest"; then
      printf 'ours-copy\n'
    else
      printf 'foreign\n'
    fi
  else
    printf 'absent\n'
  fi
}

copy_repo() {
  local dest="$1"
  if command -v rsync >/dev/null 2>&1; then
    run mkdir -p "$dest"
    run rsync -a --delete --exclude .git --exclude node_modules --exclude __pycache__ "$ROOT/" "$dest/"
  else
    run rm -rf "$dest"
    run cp -R "$ROOT" "$dest"
    run rm -rf "$dest/.git" "$dest/node_modules"
  fi
}

remove_existing() {
  local dest="$1" kind="$2"
  case "$kind" in
    ours-link | old-link) run rm -f "$dest" ;;
    ours-copy) run rm -rf "$dest" ;;
  esac
}

verb() {
  if [ "$dry_run" -eq 1 ]; then
    printf 'would be %s' "$1"
  else
    printf '%s' "$1"
  fi
}

refusal() {
  case "$1" in
    foreign-link) status="refused: symlink to $(readlink "$2") is not a $SKILL_NAME install" ;;
    foreign) status="refused: existing path is not a $SKILL_NAME install" ;;
    repo) status="skipped: this repo lives here" ;;
  esac
}

install_one() {
  local dest="$1" kind
  kind="$(classify "$dest")"
  case "$kind" in
    foreign-link | foreign | repo)
      refusal "$kind" "$dest"
      return
      ;;
  esac
  if [ "$mode" = "symlink" ] && [ "$kind" = "ours-link" ]; then
    status="already installed"
    return
  fi
  run mkdir -p "$(dirname "$dest")"
  if [ "$mode" = "copy" ] && [ "$kind" = "ours-copy" ]; then
    copy_repo "$dest"
    status="$(verb updated) (copy)"
    return
  fi
  remove_existing "$dest" "$kind"
  if [ "$mode" = "copy" ]; then
    copy_repo "$dest"
  else
    run ln -s "$ROOT" "$dest"
  fi
  if [ "$kind" = "absent" ]; then
    status="$(verb installed) ($mode)"
  else
    status="$(verb replaced) ($mode)"
  fi
}

uninstall_one() {
  local dest="$1" kind
  kind="$(classify "$dest")"
  case "$kind" in
    absent) status="not installed" ;;
    foreign-link | foreign | repo) refusal "$kind" "$dest" ;;
    *)
      remove_existing "$dest" "$kind"
      status="$(verb removed)"
      ;;
  esac
}

if [ ${#agents[@]} -eq 0 ]; then
  for agent in $ALL_AGENTS; do
    if [ "$uninstall" -eq 1 ] || [ -d "$(agent_root "$agent")" ]; then
      agents+=("$agent")
    fi
  done
fi

if [ ${#agents[@]} -eq 0 ]; then
  printf 'No agent config directory found. Pick agents explicitly with --agent:\n' >&2
  for agent in $ALL_AGENTS; do
    printf '  --agent %-9s -> %s\n' "$agent" "$(agent_skill_dir "$agent")/$SKILL_NAME" >&2
  done
  exit 1
fi

[ "$uninstall" -eq 1 ] || check_prereqs

seen=" "
refused=0
rows=()
for agent in "${agents[@]}"; do
  case "$seen" in *" $agent "*) continue ;; esac
  seen="$seen$agent "
  dest="$(agent_skill_dir "$agent")/$SKILL_NAME"
  status=""
  if [ "$uninstall" -eq 1 ]; then
    uninstall_one "$dest"
  else
    install_one "$dest"
  fi
  case "$status" in refused:*) refused=1 ;; esac
  rows+=("$agent"$'\t'"$dest"$'\t'"$status")
done

printf '%-9s %-56s %s\n' AGENT PATH STATUS
for row in "${rows[@]}"; do
  IFS=$'\t' read -r agent dest status <<<"$row"
  printf '%-9s %-56s %s\n' "$agent" "$dest" "$status"
done

if [ "$uninstall" -eq 0 ] && [ "$dry_run" -eq 0 ] && [ "$refused" -eq 0 ]; then
  cat <<EOF

Next: ask your agent "guided review of <PR URL>".
To see a demo tour, run $ROOT/examples/demo/run.sh
(no bun needed), or 'bun run demo' from $ROOT.
EOF
fi

exit "$refused"
