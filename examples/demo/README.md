# Demo tour

Run a guided-review tour on a throwaway repository. The demo needs no pull request, `gh`, or agent.

```bash
bun run demo                       # or examples/demo/run.sh
examples/demo/run.sh --print       # check the tour and print the Hunk command only
examples/demo/run.sh --print --keep  # keep the temp repo so you can run that command
```

Requires `git` and `hunk` 0.22.0 or newer.

The script builds a git repository in a temp directory with two commits. The first commit, from `repo-base/`, adds a small TypeScript retry helper and token bucket. The second, from `repo-change/`, adds jitter, a `shouldRetry` predicate, and an injectable clock. The script fills `tour.template.json` with the two commit SHAs, runs `hunk tour check`, and opens the tour with `scripts/open-tour.sh`.

The tour has 2 tracks and 6 stops, and it uses all five stop kinds. A context stop explains the new meaning of `maxAttempts`. A blocker finds an off-by-one in the retry loop. Two inspect stops cover the test that pins the bug and the injectable clock. A question asks about full jitter, and a risk flags the token bucket refill. The tour also shows cross-track `[[id]]` links, a skipped file, and checked and unchecked scope.

With `--print` alone, the script removes the temp repo on exit. Otherwise it prints the temp repo path and an `rm -rf` command that removes it.
