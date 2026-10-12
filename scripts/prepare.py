#!/usr/bin/env python3
import json
import re
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

PR_FIELDS = "number,title,url,body,state,baseRefName,baseRefOid,headRefOid"
PR_URL = re.compile(r"^https?://([^/]+)/([^/]+)/([^/]+)/pull/(\d+)")


class PrepareError(Exception):
    pass


def run(*args, cwd=None, check=True):
    proc = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if check and proc.returncode != 0:
        raise subprocess.CalledProcessError(proc.returncode, args, proc.stdout, proc.stderr)
    return proc


def git(repo, *args, check=True):
    return run("git", "-C", repo, *args, check=check)


def rev(repo, ref):
    proc = git(repo, "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}", check=False)
    return proc.stdout.strip() if proc.returncode == 0 else None


def gh_pr_view(target):
    proc = run("gh", "pr", "view", str(target), "--json", PR_FIELDS, check=False)
    return json.loads(proc.stdout) if proc.returncode == 0 else None


def short_reason(stderr):
    lines = [line.strip() for line in stderr.splitlines() if line.strip()]
    return (lines[-1] if lines else "unknown error")[:120]


def lookup_stack(pr):
    match = PR_URL.match(pr["url"])
    if not match:
        return None, "unavailable: unrecognized pull request url"
    host, owner, name, number = match.groups()
    proc = run(
        "gh", "api", "--hostname", host,
        f"repos/{owner}/{name}/stacks?pull_request={number}",
        check=False,
    )
    if proc.returncode != 0:
        return None, f"unavailable: {short_reason(proc.stderr or proc.stdout)}"
    try:
        stacks = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None, "unavailable: malformed response"
    if not stacks:
        return None, "none"
    return stacks[0], "found"


def layer_state(entry):
    if entry.get("merged_at"):
        return "merged"
    return "open" if entry.get("state") == "open" else "closed"


def layer_url(pr_url, number):
    host, owner, name, _ = PR_URL.match(pr_url).groups()
    return f"https://{host}/{owner}/{name}/pull/{number}"


def remote_of(repo):
    remotes = git(repo, "remote").stdout.split()
    if not remotes:
        raise PrepareError("repository has no remote")
    return "origin" if "origin" in remotes else remotes[0]


def checkout_worktree(repo, slug, head):
    common = Path(git(repo, "rev-parse", "--git-common-dir").stdout.strip())
    if not common.is_absolute():
        common = Path(repo) / common
    worktree = common.resolve() / "guided-review" / slug
    branch = f"review/{slug}"
    if worktree.is_dir():
        git(str(worktree), "checkout", "--quiet", "-B", branch, head)
    else:
        worktree.parent.mkdir(parents=True, exist_ok=True)
        git(repo, "worktree", "add", "--quiet", "-B", branch, str(worktree), head)
    return str(worktree), branch


def build_review(repo, slug, base, head, title, url=None, number=None, body=None, stack=None):
    merge_base = git(repo, "merge-base", base, head, check=False).stdout.strip()
    if not merge_base:
        raise PrepareError(f"no merge base between {base} and {head}")
    worktree, branch = checkout_worktree(repo, slug, head)
    return {
        "worktree": worktree,
        "tourPath": worktree + ".tour.json",
        "branch": branch,
        "base": base,
        "head": head,
        "mergeBase": merge_base,
        "title": title,
        "url": url or None,
        "number": number,
        "description": body or None,
        "stat": git(worktree, "diff", "--shortstat", f"{base}...{head}").stdout.strip(),
        "commits": git(worktree, "log", "--format=%h %s", f"{merge_base}..{head}").stdout.splitlines(),
        "stack": stack,
    }


def fetch_prs(repo, remote, prs):
    refspecs = [f"+refs/pull/{pr['number']}/head:refs/guided-review/pr-{pr['number']}" for pr in prs]
    refspecs += sorted({pr["baseRefName"] for pr in prs})
    proc = git(repo, "fetch", "--quiet", remote, *refspecs, check=False)
    if proc.returncode != 0:
        numbers = ", ".join(str(pr["number"]) for pr in prs)
        raise PrepareError(f"could not fetch pull request(s) {numbers} from {remote}: {short_reason(proc.stderr)}")


def review_pr(repo, remote, pr, stack=None):
    base = pr["baseRefOid"]
    if not rev(repo, base):
        base = rev(repo, f"{remote}/{pr['baseRefName']}") or rev(repo, pr["baseRefName"])
        if not base:
            raise PrepareError(f"could not resolve base {pr['baseRefName']} for #{pr['number']}")
    return build_review(
        repo, f"pr-{pr['number']}", base, pr["headRefOid"],
        pr["title"], pr["url"], pr["number"], pr["body"], stack,
    )


def review_branch(repo, remote, target, base_ref):
    git(repo, "fetch", "--quiet", remote, check=False)
    head = rev(repo, target) or rev(repo, f"{remote}/{target}")
    if not head:
        raise PrepareError(f"unknown branch or ref: {target}")
    if not base_ref:
        proc = git(repo, "symbolic-ref", "--quiet", "--short", f"refs/remotes/{remote}/HEAD", check=False)
        base_ref = proc.stdout.strip() if proc.returncode == 0 else f"{remote}/main"
    base = rev(repo, base_ref)
    if not base:
        raise PrepareError(f"unknown base ref: {base_ref}")
    title = git(repo, "log", "-1", "--format=%s", head).stdout.strip()
    slug = "branch-" + re.sub(r"[^A-Za-z0-9._-]", "-", target)
    return build_review(repo, slug, base, head, title)


def resolve_pr(target):
    is_pr_ref = bool(re.match(r"^https?://", target) or target.isdigit())
    if not shutil.which("gh"):
        if is_pr_ref:
            raise PrepareError("gh CLI is required for pull requests")
        return None
    pr = gh_pr_view(target)
    if pr is None and is_pr_ref:
        raise PrepareError("gh pr view failed; check gh auth status for this host")
    return pr


def prepare_stack(repo, remote, pr, stack_info):
    entries = stack_info["pull_requests"]
    urls = [layer_url(pr["url"], entry["number"]) for entry in entries]
    with ThreadPoolExecutor(max_workers=8) as pool:
        details = list(pool.map(gh_pr_view, urls))
    layers = []
    for entry, url, detail in zip(entries, urls, details):
        if detail is None:
            raise PrepareError(f"gh pr view failed for stack layer #{entry['number']}")
        layers.append({"number": entry["number"], "title": detail["title"], "url": detail["url"],
                       "state": layer_state(entry)})
    open_prs = [d for e, d in zip(entries, details) if layer_state(e) == "open"]
    if not open_prs:
        open_prs = [pr]
    fetch_prs(repo, remote, open_prs)
    reviews = [
        review_pr(repo, remote, layer_pr, {"number": stack_info["number"], "current": layer_pr["number"], "layers": layers})
        for layer_pr in open_prs
    ]
    stack = {"number": stack_info["number"], "trunk": stack_info.get("base", {}).get("ref"), "layers": layers}
    return stack, reviews


def prepare(target, base_ref):
    proc = run("git", "rev-parse", "--show-toplevel", check=False)
    if proc.returncode != 0:
        raise PrepareError("run inside a clone of the repository under review")
    repo = proc.stdout.strip()
    remote = remote_of(repo)
    pr = resolve_pr(target)
    if pr is None:
        return {"repo": repo, "stack": None, "stackLookup": "not-a-pr",
                "reviews": [review_branch(repo, remote, target, base_ref)]}
    stack_info, lookup = lookup_stack(pr)
    if stack_info is None:
        fetch_prs(repo, remote, [pr])
        return {"repo": repo, "stack": None, "stackLookup": lookup, "reviews": [review_pr(repo, remote, pr)]}
    stack, reviews = prepare_stack(repo, remote, pr, stack_info)
    return {"repo": repo, "stack": stack, "stackLookup": lookup, "reviews": reviews}


def main(argv):
    if len(argv) not in (2, 3):
        print("usage: prepare.py <pr-url | pr-number | branch> [base-ref]", file=sys.stderr)
        return 1
    try:
        result = prepare(argv[1], argv[2] if len(argv) == 3 else None)
    except PrepareError as err:
        print(f"prepare: {err}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as err:
        print(f"prepare: {' '.join(err.cmd)} failed: {short_reason(err.stderr or '')}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
