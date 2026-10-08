#!/usr/bin/env bash
set -euo pipefail

die() { echo "prepare: $*" >&2; exit 1; }

[ $# -ge 1 ] || die "usage: prepare.sh <pr-url | pr-number | branch> [base-ref]"
target=$1
base_ref=${2:-}

repo=$(git rev-parse --show-toplevel 2>/dev/null) || die "run inside a clone of the repository under review"
cd "$repo"
remote=$(git remote | grep -qx origin && echo origin || git remote | head -n1)
[ -n "$remote" ] || die "repository has no remote"

title="" url="" number="" body=""
if [[ $target =~ ^https?:// || $target =~ ^[0-9]+$ ]]; then
  command -v gh >/dev/null || die "gh CLI is required for pull requests"
  pr=$(gh pr view "$target" --json number,title,url,body,baseRefName,baseRefOid,headRefOid) ||
    die "gh pr view failed; check gh auth status for this host"
  field() { python3 -c 'import json,sys;print(json.load(sys.stdin)[sys.argv[1]])' "$1" <<<"$pr"; }
  number=$(field number) title=$(field title) url=$(field url) body=$(field body)
  head=$(field headRefOid)
  base=$(field baseRefOid)
  git fetch --quiet "$remote" "+refs/pull/$number/head:refs/guided-review/pr-$number" "$(field baseRefName)" ||
    die "could not fetch pull/$number/head from $remote"
  git cat-file -e "$base^{commit}" 2>/dev/null || base=$(git rev-parse FETCH_HEAD)
  slug="pr-$number"
else
  git fetch --quiet "$remote" 2>/dev/null || true
  head=$(git rev-parse --verify "$target^{commit}" 2>/dev/null ||
    git rev-parse --verify "$remote/$target^{commit}" 2>/dev/null) || die "unknown branch or ref: $target"
  if [ -z "$base_ref" ]; then
    base_ref=$(git symbolic-ref --quiet --short "refs/remotes/$remote/HEAD" 2>/dev/null || echo "$remote/main")
  fi
  base=$(git rev-parse --verify "$base_ref^{commit}") || die "unknown base ref: $base_ref"
  title=$(git log -1 --format=%s "$head")
  slug="branch-$(printf '%s' "$target" | tr -c 'A-Za-z0-9._-' '-')"
fi

merge_base=$(git merge-base "$base" "$head") || die "no merge base between $base and $head"
worktree="$(cd "$(git rev-parse --git-common-dir)" && pwd)/guided-review/$slug"
branch="review/$slug"

if [ -d "$worktree" ]; then
  git -C "$worktree" checkout --quiet -B "$branch" "$head"
else
  mkdir -p "$(dirname "$worktree")"
  git worktree add --quiet -B "$branch" "$worktree" "$head"
fi

python3 - "$repo" "$worktree" "$branch" "$base" "$head" "$merge_base" "$title" "$url" "$number" "$body" <<'PY'
import json, subprocess, sys
repo, worktree, branch, base, head, merge_base, title, url, number, body = sys.argv[1:]
def git(*args):
    return subprocess.run(["git", "-C", worktree, *args], check=True, capture_output=True, text=True).stdout
print(json.dumps({
    "repo": repo,
    "worktree": worktree,
    "tourPath": worktree + ".tour.json",
    "branch": branch,
    "base": base,
    "head": head,
    "mergeBase": merge_base,
    "title": title,
    "url": url or None,
    "number": int(number) if number else None,
    "description": body or None,
    "stat": git("diff", "--shortstat", f"{base}...{head}").strip(),
    "commits": git("log", "--format=%h %s", f"{merge_base}..{head}").splitlines(),
}, indent=2))
PY
