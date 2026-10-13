#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $(basename "$0") [--print] [--keep]" >&2
  exit 2
}

print_only=0
keep=0
for arg in "$@"; do
  case "$arg" in
    --print) print_only=1 ;;
    --keep) keep=1 ;;
    *) usage ;;
  esac
done

command -v git >/dev/null 2>&1 || { echo "git is required" >&2; exit 1; }
command -v hunk >/dev/null 2>&1 || {
  echo "hunk is required: curl -fsSL https://hunk.dev/install.sh | sh, brew install hunk, or npm i -g hunkdiff" >&2
  echo "See https://github.com/modem-dev/hunk#install" >&2
  exit 1
}

DEMO="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="$(cd "$DEMO/../.." && pwd -P)"
TMP_ROOT="${TMPDIR:-/tmp}"
WORK="$(mktemp -d "${TMP_ROOT%/}/hunk-tour-demo.XXXXXX")"
REPO="$WORK/hunk-tour-demo"
TOUR="$WORK/tour.json"

if [[ $print_only -eq 1 && $keep -eq 0 ]]; then
  trap 'rm -rf "$WORK"' EXIT
fi

# Fixed identity and dates make the demo SHAs identical on every run.
commit() {
  GIT_AUTHOR_DATE="$2" GIT_COMMITTER_DATE="$2" \
    git -C "$REPO" -c user.name="Demo Author" -c user.email="demo@example.com" \
    -c commit.gpgsign=false commit -q --no-verify -m "$1"
}

mkdir -p "$REPO"
git -C "$REPO" init -q
cp -R "$DEMO/repo-base/." "$REPO/"
git -C "$REPO" add -A
commit "feat: retry helper and token bucket" "2026-01-05T10:00:00Z"
BASE="$(git -C "$REPO" rev-parse HEAD)"

git -C "$REPO" rm -rq .
cp -R "$DEMO/repo-change/." "$REPO/"
git -C "$REPO" add -A
commit "feat(retry): jitter, shouldRetry, injectable clock" "2026-01-06T10:00:00Z"
HEAD="$(git -C "$REPO" rev-parse HEAD)"

sed -e "s/__BASE__/$BASE/" -e "s/__HEAD__/$HEAD/" "$DEMO/tour.template.json" >"$TOUR"

# open-tour.sh runs the check again and prints its ok line, so print this one only on failure.
check="$(cd "$REPO" && hunk --extension "$ROOT" tour check "$TOUR" 2>&1)" || true
if [[ "$check" != ok:* || "$check" == *$'\n'* ]]; then
  echo "$check" >&2
  echo "demo tour check reported errors or warnings" >&2
  exit 1
fi

open_args=()
[[ $print_only -eq 1 ]] && open_args+=(--print)
"$ROOT/scripts/open-tour.sh" "${open_args[@]+"${open_args[@]}"}" "$REPO" "$TOUR"

cat <<'EOF'

What to try in hunk:
  >  <   next / previous stop
  )  (   next / previous track
  L      follow a [[link]] from the current stop
  B      go back after following a link
  a      toggle inline notes
  q      quit
EOF

echo
if [[ $print_only -eq 1 && $keep -eq 0 ]]; then
  echo "Demo repo removed on exit. Pass --keep to run the Tour command yourself."
else
  echo "Demo repo: $REPO"
  echo "Clean up:  rm -rf $(printf '%q' "$WORK")"
fi
