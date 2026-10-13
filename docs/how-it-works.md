# How guided-review works

Coding agents write pull requests faster than people can read them. Reading every hunk no longer scales, and skimming misses the one changed conditional that matters. guided-review moves the exhaustive reading to the agent and leaves the human the part only a human can do, which is judging a short list of specific places. This page explains how the pieces fit and why they are shaped the way they are.

## Five steps from pull request to tour

A review passes through five steps. The agent runs the first four. Hunk runs the last.

1. **Prepare.** `scripts/prepare.py <pr-url | pr-number | branch> [base-ref]` runs inside a clone of the repository under review. For a PR it calls `gh pr view`, asks the host whether the PR is part of a stack, and fetches each open PR's head into `refs/guided-review/pr-<n>`. For each review it creates a branch `review/<slug>` checked out in a worktree at `.git/guided-review/<slug>`, where the slug is `pr-<n>` or `branch-<name>`. It prints JSON with one entry per review: the worktree, the `tourPath` beside it, the `base` and `head` SHAs, and the title, description, diff stat, and commits.
2. **Audit.** The agent follows `SKILL.md`. It states the change's intent, sorts every changed file into Core, Contract, Tests, or Mechanical, and reads every Core and Contract hunk with its callers and callees through the lenses in `references/lenses.md`. It runs tests and type checks where it can, because a fact it ran is worth more than a fact it inferred.
3. **Write the tour.** The agent picks the stops, groups them into tracks, links related stops, and writes `tour.json` in the format described in [Tour file format](tour-format.md).
4. **Check.** `hunk --extension <skill> tour check <tour.json>` confirms that the file parses, that every link resolves, and that every anchor falls inside one hunk of `git diff <base>...<head>`. The agent fixes errors and warnings until the check prints `ok` and nothing else.
5. **Open.** `scripts/open-tour.sh <worktree> <tour.json>` runs the check again, then starts `hunk --extension <skill> tour open <tour.json>` in a new herdr tab, tmux window, iTerm2 window, or Terminal.app window. With none of those, it prints the command. Either way its last line is `Tour command: ...`, so the agent can hand the command to you.

### What happens inside Hunk

`hunk tour` is a CLI command the extension registers in `extension/index.tsx`. On `tour open`, the extension validates the tour the same way `tour check` does, keeps the parsed tour in memory, and writes a sidecar file to the system temp directory as `hunk-guided-review-<head>.json`. Then it hands control back to Hunk with a new command line:

```bash
hunk diff <base>...<head> --agent-context <sidecar> --agent-notes
```

From there Hunk shows an ordinary diff review, with three additions from the extension.

- The sidecar, built by `toSidecar` in `extension/sidecar.ts`, turns each stop into one of Hunk's agent annotations. Each stop appears as an inline `guided-review note` on its lines, with its number, kind, track, body, and ask. Files are listed in the order of their first stop, followed by skipped files, so Hunk's file list and the `{` and `}` keys follow the tour.
- The **Tour** pane opens on the right. It shows the title, verdict, stack, summary, every track with its summary and stops, and the checked and unchecked scope. The current stop expands to show its body, its ask, and its links in both directions.
- The commands `>`, `<`, `)`, `(`, `L`, and `B`, plus **Restart tour** in the **Extensions** menu, move through the tour. Each one asks the core library for the next position, reveals that stop's first line in the diff, and prints `Stop <n>/<total> · Track <t>/<tracks> <track title>: <stop title>` in Hunk's status line.

The whole diff stays visible. A tour orders your attention but does not hide anything, and you can leave it at any point to read a file the agent skipped.

## Why a tour instead of GitHub review comments

The skill's description says it is not for posting review comments to GitHub. That is a deliberate choice, not a missing feature.

A review comment speaks to the author, in public, and stays on the PR. An agent's findings are none of those things yet. Some are wrong. Some are right but not worth the author's time. Some are questions only the reviewer can answer, such as whether a 30-second timeout is acceptable for EU traffic. Posting them would hand the author a pile of unvetted claims with the reviewer's name nearby.

A tour speaks to the reviewer, in private, and goes away when you close Hunk. You read each stop, make the call the ask names, and write the comments you agree with yourself, with `c` in Hunk or on GitHub. The agent does the reading. The human keeps the judgment and the voice.

## Why stops are small, and why tracks and links exist

A finding that touches three places becomes three stops: where a value is produced, where it is transformed, and where it is consumed. Each stop covers a few lines, ideally under 10, and `tour check` warns past 20 (`MAX_STOP_LINES`). Small stops keep each judgment small. You can answer "is this bound right?" by looking at seven lines, but not by scanning a 60-line hunk with a paragraph of prose attached.

Small stops lose context. Tracks and links restore it. A track holds one thread you should keep in your head at once, such as a new abstraction and each caller moved onto it. The track summary says how its stops connect and what to conclude after reading them together. Links cross tracks. A stop can write `[[attempts-test]]` to point at the test that pins its behavior, and the pane lists that link under the stop and a back link under the test. `L` follows a link and `B` returns, so you can check a producer and come back to the consumer without losing your place.

The format also pushes prose into `- ` bullet lines and warns on paragraphs. That rule is about the reader, not the format. A tired reviewer in a 48-column pane skims bullets and skips paragraphs.

## Why each review gets its own worktree

`prepare.py` never touches your checkout. It does not switch your branch, stash your changes, or need a clean tree. Each review gets its own branch and worktree under `.git/guided-review/`, so the agent can run tests and builds at the PR's head while you keep working, and two reviews can run side by side.

The worktree is also where the agent reads code. Reading from your checkout would mean reading whatever branch you happen to have open, which is the wrong code for the review.

The cost is disk space and cleanup. The report for each review ends with `git worktree remove <worktree> && git branch -D <branch>`. Those commands leave the fetched `refs/guided-review/pr-<n>` refs in place. Rerunning `prepare.py` for the same PR reuses the worktree and resets its branch to the new head.

## Stacks get one tour per layer

A stacked PR, as managed by the `gh stack` extension, is a chain of PRs, each built on the one below. `prepare.py` asks the host's stacks API (`repos/<owner>/<repo>/stacks?pull_request=<n>`) whether the PR is a layer. If it is, the script fetches every open layer and returns one review per open layer, bottom first. Merged and closed layers get no review but stay in the stack list for context.

Each layer's diff is `git diff <base>...<head>`, where `base` is the PR's base commit as `gh` reports it (`baseRefOid`). A three-dot diff starts from the merge base, so it holds only that layer's commits. The agent writes one tour per layer and never merges layers into one tour. A problem introduced in layer 1 belongs in layer 1's tour, even when the agent notices it while reading layer 3. Mixing them would blame the wrong PR and make each tour harder to act on.

Stacks drift. When the lower layer gets new commits after the upper layer was built, the upper layer's review entry has `needsRebase: true`. `prepare.py` sets it when the lower open layer's head is not an ancestor of this layer's head. The diff still shows only this layer's work, because a three-dot diff starts from the merge base, but nothing proves the layer still applies or builds on the new lower layer. The skill tells the agent to say so in `scope.unchecked`, and to add a `risk` stop when the new lower commits touch code the layer uses.

In Hunk, a stack tour lists every layer under the verdict and marks the one under review. Each layer opens in its own tab or window. In herdr and tmux, the tab is labelled with the worktree name, such as `review pr-102`.

## The core library holds the tour logic

Everything a renderer needs to understand a tour lives in `core/`, which has no UI dependencies. The Hunk extension is one renderer of it, and a web page or an editor plugin could be another. [`core/README.md`](../core/README.md) lists the modules. The design rests on three functions.

- `validateTour(raw, loadRanges)` parses the JSON, then asks the caller for the diff's hunk ranges, then checks anchors and collects warnings. The caller injects `loadRanges`, so core never assumes where the diff comes from. In Node, `readDiffRanges(cwd, base, head)` from `@guided-review/core/git` runs git. A browser that already has the patch text calls `parseDiffRanges(patch)` instead. On success the result carries the tour, its numbered stops, a link index with `linksFrom` and `linksTo`, and the warnings.
- `move(stops, trackCount, cursor, move)` is a pure reducer over a `TourCursor`. The moves are `next`, `prev`, `nextTrack`, `prevTrack`, `goto`, `restart`, `follow`, and `back`. It returns a new cursor, or a reason the move is not possible, such as `End of tour (6 stops)`. `follow` pushes the current stop onto a history and `back` pops it. Every renderer gets the same navigation rules. For example, `prevTrack` first goes to the start of the current track, and steps to the previous track only from there.
- `segmentText(text, index)` splits a body, ask, or summary into plain text and link segments. Each link segment carries its target stop, so the renderer decides what a link looks like and what clicking it does. `formatLink` gives the standard `#<number> <title>` label.

The renderer owns everything else: how a stop is revealed, how messages appear, and any host-specific export. In this repository that export is `extension/sidecar.ts`, which turns a tour into Hunk's agent-context format and sits outside core for that reason.

## Known limits

- **Hunk's extension API is experimental.** `package.json` declares `apiVersion: 25`, and Hunk's own README warns that the API may break between minor releases. The extension was built against Hunk 0.22.0 and the `hunkdiff` 0.23.0 types. On Hunk releases before API 26, the extension cannot tell which files the file filter hides, so a stop in a filtered-out file triggers Hunk's own warning when revealed.
- **Tour notes are read-only.** They come from a sidecar file, so you cannot reply to them, resolve them, or edit them in Hunk. Notes you add with `c` are Hunk's own and never flow back into the tour or to GitHub.
- **The tour lives in memory.** Quitting Hunk forgets your position. Reopening the tour starts before stop 1.
- **Anchors must sit inside the diff.** A stop can only point at lines inside a hunk of `base...head`, context lines included. An unchanged caller in another file cannot be a stop, so the agent cites it in the stop's body instead.
- **GitHub Enterprise works through `gh`, not `hunk gh`.** `prepare.py` calls `gh pr view` and `gh api --hostname <host>`, so any host `gh` is logged in to works. Stack detection also needs the host to offer the stacks API. Without it, `stackLookup` is `unavailable` and each PR is reviewed alone.
- **Terminal launch is best effort.** `open-tour.sh` knows herdr, tmux, iTerm2, and Terminal.app. Anywhere else it prints the command for you to run.
- **Narrow terminals hide the pane.** In testing, the demo needed about 160 columns to show the sidebar, the diff, and the **Tour** pane together. Pressing `s` to hide the sidebar makes room.
