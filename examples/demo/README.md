# Demo tour

Run a guided-review tour on a throwaway repository. No pull request, `gh`, or agent is needed.

```bash
bun run demo                       # or examples/demo/run.sh
examples/demo/run.sh --print       # check the tour and print the hunk command only
examples/demo/run.sh --print --keep  # keep the temp repo so you can run that command
```

Requires `git` and `hunk` 0.22 or newer.

The script builds a git repository in a temp directory from `repo-base/` and `repo-change/`: a small TypeScript retry helper and token bucket, then a commit that adds jitter, a `shouldRetry` predicate, and an injectable clock. It fills `tour.template.json` with the two commit SHAs, runs `hunk tour check`, and opens the tour with `scripts/open-tour.sh`.

The tour has 2 tracks and 6 stops covering all five stop kinds: an off-by-one blocker in the retry loop, a test that pins the bug, a jitter design question, and a token bucket refill risk. It also shows cross-track `[[id]]` links, a skipped file, and checked and unchecked scope.

When the tour opens in a terminal, the script prints the temp repo path and an `rm -rf` command to remove it.
