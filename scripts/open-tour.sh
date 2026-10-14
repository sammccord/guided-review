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
EXT="$(abspath "$(dirname "$0")/..")"

(cd "$DIR" && hunk --extension "$EXT" tour check "$TOUR")

CMD="hunk --extension $(shquote "$EXT") tour open $(shquote "$TOUR")"
FULL="cd $(shquote "$DIR") && $CMD"

vimquote() {
  local escaped="''"
  printf "'%s'" "${1//\'/$escaped}"
}

applescript_escape() {
  local escaped="${1//\\/\\\\}"
  printf '%s' "${escaped//\"/\\\"}"
}

spawn() {
  nohup "$@" >/dev/null 2>&1 & disown
}

launch_nvim() {
  [[ -n "${NVIM:-}" ]] && command -v nvim >/dev/null 2>&1 || return 1
  local cmd dir
  cmd="$(vimquote "$CMD")"
  dir="$(vimquote "$DIR")"
  # termopen() is deprecated from 0.11, where jobstart() gained the term option.
  nvim --server "$NVIM" --remote-expr "execute('tabnew') .. (has('nvim-0.11') ? jobstart($cmd, {'term': v:true, 'cwd': $dir}) : termopen($cmd, {'cwd': $dir}))" >/dev/null || return 1
  echo "Opened tour in a new Neovim tab"
}

launch_herdr() {
  [[ -n "${HERDR_SOCKET_PATH:-}" ]] && command -v herdr >/dev/null 2>&1 || return 1
  local created pane
  created="$(herdr tab create --cwd "$DIR" --label "$LABEL" --focus)" || return 1
  if command -v python3 >/dev/null 2>&1; then
    pane="$(printf '%s' "$created" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])')" || return 1
  else
    pane="$(printf '%s' "$created" | tr -d '\n' | sed -n 's/.*"root_pane"[^}]*"pane_id"[[:space:]]*:[[:space:]]*"\{0,1\}\([^",}]*\)"\{0,1\}.*/\1/p')" || return 1
  fi
  [[ -n "$pane" ]] || { echo "could not read pane id from herdr output: $created" >&2; return 1; }
  herdr pane run "$pane" "$CMD" || return 1
  echo "Opened tour in herdr pane $pane"
}

launch_tmux() {
  [[ -n "${TMUX:-}" ]] || return 1
  tmux new-window -n "$LABEL" -c "$DIR" "$CMD" || return 1
  echo "Opened tour in tmux window '$LABEL'"
}

launch_zellij() {
  [[ -n "${ZELLIJ:-}" ]] && command -v zellij >/dev/null 2>&1 || return 1
  if zellij action new-tab --name "$LABEL" --cwd "$DIR" --close-on-exit -- sh -c "$CMD" >/dev/null; then
    echo "Opened tour in zellij tab '$LABEL'"
  else
    zellij run --name "$LABEL" --cwd "$DIR" --close-on-exit -- sh -c "$CMD" >/dev/null || return 1
    echo "Opened tour in a zellij pane"
  fi
}

launch_kitty() {
  [[ -n "${KITTY_WINDOW_ID:-}" ]] && command -v kitty >/dev/null 2>&1 || return 1
  kitty @ launch --type=tab --tab-title "$LABEL" --cwd "$DIR" sh -c "$CMD" >/dev/null || return 1
  echo "Opened tour in a new kitty tab"
}

launch_wezterm() {
  # WEZTERM_EXECUTABLE names wezterm-gui, which has no `cli`; its sibling does.
  local wez=wezterm pane
  command -v wezterm >/dev/null 2>&1 || wez="$(dirname "${WEZTERM_EXECUTABLE:-.}")/wezterm"
  [[ -n "${WEZTERM_PANE:-}" ]] && command -v "$wez" >/dev/null 2>&1 || return 1
  pane="$("$wez" cli spawn --cwd "$DIR" -- sh -c "$CMD")" || return 1
  "$wez" cli set-tab-title --pane-id "$pane" "$LABEL" >/dev/null 2>&1 || true
  echo "Opened tour in a new WezTerm tab"
}

launch_ghostty() {
  [[ "${TERM_PROGRAM:-}" == "ghostty" ]] || return 1
  if [[ "$(uname)" == "Darwin" ]]; then
    # Ghostty 1.3 added AppleScript; older versions only take a new instance through open.
    if osascript \
      -e 'tell application "Ghostty"' \
      -e 'set cfg to new surface configuration' \
      -e "set initial working directory of cfg to \"$(applescript_escape "$DIR")\"" \
      -e "set command of cfg to \"$(applescript_escape "$CMD")\"" \
      -e 'if (count of windows) > 0 then' \
      -e 'new tab in front window with configuration cfg' \
      -e 'else' \
      -e 'new window with configuration cfg' \
      -e 'end if' \
      -e 'activate' \
      -e 'end tell' >/dev/null 2>&1; then
      echo "Opened tour in a new Ghostty tab"
      return 0
    fi
    spawn open -na Ghostty --args --working-directory="$DIR" -e sh -c "$CMD" || return 1
  else
    command -v ghostty >/dev/null 2>&1 || return 1
    spawn ghostty --working-directory="$DIR" -e sh -c "$CMD" || return 1
  fi
  echo "Opened tour in a new Ghostty window"
}

launch_alacritty() {
  [[ -n "${ALACRITTY_WINDOW_ID:-}" || -n "${ALACRITTY_SOCKET:-}" ]] || return 1
  if command -v alacritty >/dev/null 2>&1; then
    alacritty msg create-window --working-directory "$DIR" -e sh -c "$CMD" ||
      spawn alacritty --working-directory "$DIR" -e sh -c "$CMD" || return 1
  elif [[ "$(uname)" == "Darwin" ]]; then
    spawn open -na Alacritty --args --working-directory "$DIR" -e sh -c "$CMD" || return 1
  else
    return 1
  fi
  echo "Opened tour in a new Alacritty window"
}

launch_iterm2() {
  [[ "${TERM_PROGRAM:-}" == "iTerm.app" && "$(uname)" == "Darwin" ]] && command -v osascript >/dev/null 2>&1 || return 1
  local escaped
  escaped="$(applescript_escape "$FULL")"
  osascript \
    -e 'tell application "iTerm2"' \
    -e 'activate' \
    -e 'set w to (create window with default profile)' \
    -e "tell current session of w to write text \"$escaped\"" \
    -e 'end tell' >/dev/null || return 1
  echo "Opened tour in a new iTerm2 window"
}

launch_konsole() {
  [[ -n "${KONSOLE_VERSION:-}" ]] && command -v konsole >/dev/null 2>&1 || return 1
  spawn konsole --new-tab --workdir "$DIR" -e sh -c "$CMD" || return 1
  echo "Opened tour in a new Konsole tab"
}

launch_gnome_terminal() {
  [[ -n "${GNOME_TERMINAL_SCREEN:-}" ]] && command -v gnome-terminal >/dev/null 2>&1 || return 1
  gnome-terminal --tab --title="$LABEL" --working-directory="$DIR" -- sh -c "$CMD" || return 1
  echo "Opened tour in a new GNOME Terminal tab"
}

launch_foot() {
  [[ "${TERM:-}" == "foot" || "${TERM:-}" == "foot-extra" ]] && command -v foot >/dev/null 2>&1 || return 1
  spawn foot --working-directory="$DIR" --title="$LABEL" sh -c "$CMD" || return 1
  echo "Opened tour in a new foot window"
}

launch_terminal_app() {
  [[ "$(uname)" == "Darwin" ]] && command -v osascript >/dev/null 2>&1 || return 1
  local escaped
  escaped="$(applescript_escape "$FULL")"
  osascript \
    -e 'tell application "Terminal"' \
    -e 'activate' \
    -e "do script \"$escaped\"" \
    -e 'end tell' >/dev/null || return 1
  echo "Opened tour in a new Terminal.app window"
}

launch_x_terminal_emulator() {
  [[ "$(uname)" == "Linux" && ( -n "${DISPLAY:-}" || -n "${WAYLAND_DISPLAY:-}" ) ]] && command -v x-terminal-emulator >/dev/null 2>&1 || return 1
  spawn x-terminal-emulator -e sh -c "$FULL" || return 1
  echo "Opened tour in a new terminal window"
}

LAUNCHERS=(nvim herdr tmux zellij kitty wezterm ghostty alacritty iterm2 konsole gnome_terminal foot terminal_app x_terminal_emulator)
launch() {
  local name
  for name in "${LAUNCHERS[@]}"; do
    "launch_$name" && return 0
  done
  echo "No terminal launcher found; run the command below yourself."
}

if [[ $print_only -eq 0 ]]; then
  launch
fi
echo "Tour command: $FULL"
