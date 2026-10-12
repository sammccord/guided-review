#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $(basename "$0") [--print] <repo-or-worktree-dir> <tour.json>" >&2
  exit 2
}

print_only=0
positional=()
for arg in "$@"; do
  case "$arg" in
    --print) print_only=1 ;;
    -h|--help) usage ;;
    *) positional+=("$arg") ;;
  esac
done
[[ ${#positional[@]} -eq 2 ]] || usage

abspath() {
  if [[ -d "$1" ]]; then
    (cd "$1" && pwd -P)
  else
    echo "$(cd "$(dirname "$1")" && pwd -P)/$(basename "$1")"
  fi
}

# Single-quote for a POSIX shell: ' becomes '\''.
shquote() {
  local escaped="'\\''"
  printf "'%s'" "${1//\'/$escaped}"
}

[[ -d "${positional[0]}" ]] || { echo "not a directory: ${positional[0]}" >&2; exit 2; }
[[ -f "${positional[1]}" ]] || { echo "no such tour file: ${positional[1]}" >&2; exit 2; }
DIR="$(abspath "${positional[0]}")"
TOUR="$(abspath "${positional[1]}")"
LABEL="review $(basename "$DIR")"
EXT="$(abspath "$(dirname "$0")/../extension")"

(cd "$DIR" && hunk --extension "$EXT" tour check "$TOUR")

CMD="hunk --extension $(shquote "$EXT") tour open $(shquote "$TOUR")"
FULL="cd $(shquote "$DIR") && $CMD"

launch() {
  if [[ -n "${HERDR_SOCKET_PATH:-}" ]] && command -v herdr >/dev/null 2>&1; then
    local created pane
    created="$(herdr tab create --cwd "$DIR" --label "$LABEL" --focus)"
    if command -v python3 >/dev/null 2>&1; then
      pane="$(printf '%s' "$created" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])')"
    else
      pane="$(printf '%s' "$created" | tr -d '\n' | sed -n 's/.*"root_pane"[^}]*"pane_id"[[:space:]]*:[[:space:]]*"\{0,1\}\([^",}]*\)"\{0,1\}.*/\1/p')"
    fi
    [[ -n "$pane" ]] || { echo "could not read pane id from herdr output: $created" >&2; return 1; }
    herdr pane run "$pane" "$CMD"
    echo "Opened tour in herdr pane $pane"
    return 0
  fi

  if [[ -n "${TMUX:-}" ]]; then
    tmux new-window -n "$LABEL" -c "$DIR" "$CMD"
    echo "Opened tour in tmux window '$LABEL'"
    return 0
  fi

  if [[ "$(uname)" == "Darwin" ]] && command -v osascript >/dev/null 2>&1; then
    local escaped="${FULL//\\/\\\\}"
    escaped="${escaped//\"/\\\"}"
    if [[ "${TERM_PROGRAM:-}" == "iTerm.app" ]]; then
      osascript \
        -e 'tell application "iTerm2"' \
        -e 'activate' \
        -e 'set w to (create window with default profile)' \
        -e "tell current session of w to write text \"$escaped\"" \
        -e 'end tell' >/dev/null
      echo "Opened tour in a new iTerm2 window"
    else
      osascript \
        -e 'tell application "Terminal"' \
        -e 'activate' \
        -e "do script \"$escaped\"" \
        -e 'end tell' >/dev/null
      echo "Opened tour in a new Terminal.app window"
    fi
    return 0
  fi

  echo "No terminal launcher found; run the command below yourself."
}

if [[ $print_only -eq 0 ]]; then
  launch
fi
echo "Tour command: $FULL"
