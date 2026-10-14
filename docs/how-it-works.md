# How guided-review works

Coding agents write pull requests faster than people can read them. Reading every hunk does not scale. Skimming misses the one changed conditional that matters. guided-review gives the line-by-line reading to the agent, and the human judges a short list of specific places. This page explains how the pieces fit and why they have this shape.

## Five steps from pull request to tour

A review passes through five steps. The agent runs the first four. Hunk runs the last.

1. **Prepare.** `scripts/prepare.py <pr-url | pr-number | branch> [base-ref]` runs inside a clone of the repository under review. For a PR it calls `gh pr view`, asks the host whether the PR is part of a stack, and fetches each open PR's head into `refs/guided-review/pr-<n>`. For each review it creates a branch `review/<slug>` checked out in a worktree at `.git/guided-review/<slug>`, where the slug is `pr-<n>` or `branch-<name>`. It prints JSON with one entry per review: the worktree, the `tourPath` beside it, the `base` and `head` SHAs, the title, description, diff stat, and commits, and a `cleanup` command.
2. **Audit.** The agent follows `SKILL.md`. It states the change's intent, sorts every changed file into Core, Contract, Tests, or Mechanical, and reads every Core and Contract hunk with its callers and callees through the lenses in [`references/lenses.md`](../references/lenses.md). It runs tests and type checks where it can, because a fact it ran is worth more than a fact it inferred.
3. **Write the tour.** The agent picks the stops, groups them into tracks, links related stops, and writes `tour.json` in the format described in [Tour file format](tour-format.md).
4. **Check.** `hunk --extension <skill> tour check <tour.json>` confirms that the file parses, that every link resolves, and that every anchor falls inside one hunk of `git diff <base>...<head>`. The agent fixes errors and warnings until the check prints `ok` and nothing else.
5. **Open.** `scripts/open-tour.sh <worktree> <tour.json>` runs the check again, then starts `hunk --extension <skill> tour open <tour.json>` in a new terminal tab or window. Inside a Neovim terminal it opens a Neovim tab. Inside [herdr](https://herdr.dev), tmux, or zellij it opens a tab or window there, with a pane fallback for older zellij versions. Inside kitty, WezTerm, Ghostty, Alacritty, Konsole, GNOME Terminal, or foot it opens a tab or window in that terminal. Otherwise it uses iTerm2 when running there or Terminal.app on macOS, and x-terminal-emulator on Linux with a graphical display. With none of those, it prints the command. Either way its last line is `Tour command: ...`, so the agent can hand the command to you.

### What happens inside Hunk

`hunk tour` is a CLI command the extension registers in [`extension/index.tsx`](../extension/index.tsx). On `tour open`, the extension validates the tour the same way `tour check` does, keeps the parsed tour in memory, and writes a sidecar file to the system temp directory as `hunk-guided-review-<head>.json`. Then it hands control back to Hunk with a new command line:

```bash
hunk diff <base>...<head> --agent-context <sidecar> --agent-notes
```

From there Hunk shows an ordinary diff review, with three additions from the extension.

- `toSidecar` in [`extension/sidecar.ts`](../extension/sidecar.ts) builds the sidecar. It turns each stop into one of Hunk's agent annotations, which Hunk shows as an inline tour note titled `guided-review note` on the stop's lines, with its number, kind, track, body, and ask. Files are listed in the order of their first stop, followed by skipped files, so Hunk's file list and the `{` and `}` keys follow the tour.
- The **Tour** pane opens on the right. It shows the title, verdict, stack, summary, every track with its summary and stops, and the checked and unchecked scope. The current stop expands to show its body, its ask, and its links in both directions.
- The tour commands move through the tour. The [key bindings](../README.md#key-bindings) in the README list them. Each command asks the core library for the next position and reveals that stop's first line in the diff. Hunk's status line then shows `Stop <n>/<total> · Track <t>/<tracks> <track title>: <stop title>`. After `B`, it shows `Back to stop <n>/<total>: <stop title>`. When a move is not possible, it shows the reason, such as `End of tour (6 stops)`. When the stop's file is hidden by the file filter or is not in the review, it shows a warning that starts with `Stop <n>: <path>`.

The whole diff stays visible. A tour orders your attention but does not hide anything, and you can leave it at any point to read a file the agent skipped.

## Asking the agent from inside Hunk

The agent that wrote the tour holds the whole audit in its context. The reviewer can use that without leaving Hunk. Every note the reviewer adds is a question. A reply under one of the agent's answers is a follow-up. `Q` sends a question. `V` sends a decision on the current stop: `agree`, `disagree`, or `unsure` with an optional comment. The agent answers inline as threaded notes through `hunk session comment add`, and uses the decisions to draft the review at the end.

The current stop shows a muted key hint below **Ask:** and a **Decide** button beside **Post to PR**. The hint follows rebound keys and omits unbound commands. `F` finishes the review and asks for confirmation if stops remain undecided. At the last stop, `>` points to the finish key.

The two sides never share a process, so they talk through files. The mailbox is a directory beside the tour, `<tour>.tour.qa/`:

| Path | Writer | Content |
| --- | --- | --- |
| `session.json` | the extension in Hunk | repo, tour path, head, the Hunk process id, `openedAt`, and `finishedAt` or `closedAt` once set |
| `inbox/q-<seq>.json` | the extension in Hunk | one request, never changed after it is written |
| `answered/q-<seq>.json` | `hunk tour answer` | the request id, the Hunk comment id, the answer text, and the time |
| `agent.json` | `hunk tour wait` | the agent's process id and how long it promised to listen |
| `approved.json` | `hunk tour approve` | approval URL, reviewed head, and time; prevents duplicate approval at that head |

Each path has one writer, so there are no locks. Every write goes to a temp file first and is renamed into place, and readers skip files that do not parse. Everything shown to either side is a projection of these files. That covers the pending list the agent sees, the status text and decision badges the reviewer sees, and the transcript in the final payload. The model and its projections live in [`core/src/qa.ts`](../core/src/qa.ts), the file layout in [`core/src/mailbox.ts`](../core/src/mailbox.ts), and the Hunk wiring in [`extension/qa.ts`](../extension/qa.ts).

The agent's loop is two commands. `hunk tour wait <tour.json>... [--timeout <seconds>]` writes its heartbeat, polls the mailbox once a second, and prints one JSON line. It is `pending` with the requests, `idle` after the timeout, or `finished` or `closed` with the decisions, transcript, and approval eligibility and blockers per tour. `hunk tour answer <tour.json> <id> --text <answer>` posts the note, then records the answer. A crash between those two steps can post the same answer twice on retry. That window is a few milliseconds and the cost is a duplicate note, so delivery is at least once and nothing is lost. A request that is already answered is reported as such and not posted again.

`wait` treats the review as over when `session.json` carries `finishedAt`, set by **Finish review**, or `closedAt`, set when Hunk shuts down, or when the Hunk process id is no longer alive. Reopening the tour writes a fresh `session.json` and keeps the inbox and answers, so decisions survive a restart and badges come back. An `agree` with no comment needs no reply and is never sent to the agent. Hunk 0.22 has no extension status line, so the status text sits at the top of the **Tour** pane; on hosts that have one, it is also set there.

## Why a tour instead of GitHub review comments

The agent does not post its audit findings to GitHub on its own. That is a deliberate choice.

A review comment speaks to the author, in public, and stays on the PR. An agent's findings are none of those things yet. Some are wrong. Some are right but not worth the author's time. Some are questions only the reviewer can answer, such as whether a 30-second timeout is acceptable for EU traffic. Posting them would give the author a list of claims that no human has checked, with the reviewer's name nearby.

A tour speaks to the reviewer, in private, and goes away when you close Hunk. You read each stop, make the call the ask names, and write the comments you agree with yourself, with `c` in Hunk or on GitHub. The agent does the reading. The human keeps the judgment and the voice.

Two exceptions require the reviewer's action:

- **Post to PR** starts with a click on a stop. The agent rewords that stop as feedback for the author. `tour answer` posts it through `gh api` at the tour's `head`, then adds a Hunk note with the GitHub link. A stop anchored outside the PR's diff, or a tour without a PR `url`, fails loudly. A failure after GitHub accepts the comment but before the answer is recorded can duplicate the PR comment on retry.
- **Approval** requires an explicit yes in the agent chat after the review draft. The agent asks only when the tour is eligible and the transcript has no unresolved concerns. `tour approve <tour.json> [--body <text>]` requires an ended review, an `approve` verdict, every stop agreed, and no pending replies. It checks the PR head against the session head and submits approval pinned to that commit. A moved head requires a fresh review. The CLI checks both `approved.json` and the current user's GitHub reviews to avoid duplicate approval on retry. Each stack layer needs its own confirmation and approval.

## Why stops are small, and why tracks and links exist

A finding that touches three places becomes three stops: where a value is produced, where it is transformed, and where it is consumed. Each stop covers a few lines, ideally under 10, and `tour check` warns past 20 (`MAX_STOP_LINES`). Small stops keep each judgment small. You can answer "is this bound right?" by looking at seven lines, but not by scanning a 60-line hunk with a paragraph of prose attached.

Small stops lose context. Tracks and links restore it. A track holds stops you should read together, such as a new abstraction and each caller moved onto it. The track summary says how its stops connect and what to conclude after reading them. Links cross tracks. A stop can write `[[attempts-test]]` to point at the test that pins its behavior, and the pane lists that link under the stop and a back link under the test. `L` follows a link and `B` returns, so you can check a producer and come back to the consumer without losing your place.

The format also pushes prose into `- ` bullet lines and warns on paragraphs. That rule is about the reader, not the format. A tired reviewer in a 48-column pane skims bullets and skips paragraphs.

## Why each review gets its own worktree

`prepare.py` never touches your checkout. It does not switch your branch, stash your changes, or need a clean tree. Each review gets its own branch and worktree under `.git/guided-review/`, so the agent can run tests and builds at the PR's head while you keep working, and two reviews can run side by side.

The worktree is also where the agent reads code. Reading from your checkout would mean reading whatever branch you happen to have open, which is the wrong code for the review.

The cost is disk space and cleanup. Each review entry carries a `cleanup` command that removes the worktree, the `review/<slug>` branch, and, for a PR, the fetched `refs/guided-review/pr-<n>` ref. The agent's report ends with that command for each review. Rerunning `prepare.py` for the same PR reuses the worktree and resets its branch to the new head.

## Stacks get one tour per layer

A stacked PR, as managed by the `gh stack` extension, is a chain of PRs. Each stack layer is built on the one below. `prepare.py` asks the host's stacks API (`repos/<owner>/<repo>/stacks?pull_request=<n>`) whether the PR is a stack layer. If it is, the script fetches every open layer and returns one review per open layer, bottom first. Merged and closed layers get no review but stay in the stack list for context.

Each layer's diff is `git diff <base>...<head>`, where `base` is the PR's base commit as `gh` reports it (`baseRefOid`). A three-dot diff starts from the merge base, so it holds only that layer's commits. The agent writes one tour per layer and never merges layers into one tour. A problem introduced in layer 1 belongs in layer 1's tour, even when the agent notices it while reading layer 3. Mixing them would blame the wrong PR and make each tour harder to act on.

A lower layer can get new commits after the upper layer was built on it. `prepare.py` checks whether the lower open layer's head is an ancestor of the upper layer's head. If it is not, the upper layer's review entry has `needsRebase: true`. The diff still shows only the upper layer's work, because a three-dot diff starts from the merge base, but nothing proves the layer still applies or builds on the new lower layer. The skill tells the agent to say so in `scope.unchecked`, and to add a `risk` stop when the new lower commits touch code the layer uses.

In Hunk, a stack tour lists every layer under the verdict and marks the one under review. Each layer opens in its own tab or window. The herdr tab or tmux window takes the worktree name as its label, such as `review pr-102`.

## The core library holds the tour logic

Everything a renderer needs to understand a tour lives in `core/`, which has no UI dependencies. The Hunk extension is one renderer. A web page or an editor plugin could be another. [`core/README.md`](../core/README.md) lists the modules. The design rests on three functions.

- `validateTour(raw, loadRanges)` parses the JSON, then asks the caller for the diff's hunk ranges, then checks anchors and collects warnings. The caller injects `loadRanges`, so core never assumes where the diff comes from. In Node, `readDiffRanges(cwd, base, head)` from `@guided-review/core/git` runs git. A browser that already has the patch text calls `parseDiffRanges(patch)` instead. On success the result carries the tour, its numbered stops, a link index with `linksFrom` and `linksTo`, and the warnings.
- `move(stops, trackCount, cursor, move)` is a pure reducer over a `TourCursor`. The moves are `next`, `prev`, `nextTrack`, `prevTrack`, `goto`, `restart`, `follow`, and `back`. It returns a new cursor, or a reason the move is not possible, such as `End of tour (6 stops)`. `follow` pushes the current stop onto a history and `back` pops it. Every renderer gets the same navigation rules. For example, `prevTrack` first goes to the start of the current track, and steps to the previous track only from there.
- `segmentText(text, index)` splits a body, ask, or summary into plain text and link segments. Each link segment carries its target stop, so the renderer decides what a link looks like and what clicking it does. `formatLink` gives the standard `#<number> <title>` label.

The renderer owns everything else: how a stop is revealed, how messages appear, and any host-specific export. In this repository that export is `extension/sidecar.ts`. It turns a tour into Hunk's agent-context format, so it lives outside core.

## Known limits

- **Hunk's extension API is experimental.** `package.json` declares `apiVersion: 25`, and Hunk's own README warns that the API may break between minor releases. The extension was built against Hunk 0.22.0 and the `hunkdiff` 0.23.0 types. On Hunk releases before API 26, the extension cannot tell which files the file filter hides, so a stop in a filtered-out file triggers Hunk's own warning when revealed.
- **Inline tour notes are read-only.** They come from a sidecar file, so you cannot reply to them, resolve them, or edit them in Hunk. Notes you add with `c` never flow to GitHub. While a tour is open, every note goes to the agent, and its answer arrives as a reply under the note. Only clicking a stop's **Post to PR** button asks the agent to post that stop to GitHub.
- **The tour lives in memory.** Quitting Hunk forgets your position. Reopening the tour starts before stop 1. Decisions and questions are files beside the tour and survive a restart.
- **Anchors must sit inside the diff.** A stop can only point at lines inside a hunk of `base...head`, context lines included. An unchanged caller in another file cannot be a stop, so the agent cites it in the stop's body instead.
- **GitHub Enterprise works through `gh`, not `hunk gh`.** `prepare.py` calls `gh pr view` and `gh api --hostname <host>`, so any host `gh` is logged in to works. Stack detection also needs the host to offer the stacks API. Without it, `stackLookup` is `unavailable` and each PR is reviewed alone.
- **Terminal launch is best effort.** `open-tour.sh` tries Neovim first, then herdr, tmux, or zellij, then kitty, WezTerm, Ghostty, Alacritty, iTerm2, Konsole, GNOME Terminal, or foot. It falls back to Terminal.app on macOS or x-terminal-emulator on Linux with a graphical display. If no launcher applies, it prints the command for you to run.
- **Below 120 columns the pane needs the sidebar's space.** Hunk hides its side panes below 160 columns until something opens one, so the extension opens the **Tour** pane when the tour loads. The pane takes 30% of the width, between 32 and 64 columns. In testing, the demo showed the sidebar, the diff, and the pane together at 120 columns and wider. At 100 columns, Hunk drops the pane to keep 48 columns for the diff, and pressing `s` to hide the sidebar brings it back.
