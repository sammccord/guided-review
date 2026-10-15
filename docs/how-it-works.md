# How guided-review works

Coding agents write pull requests faster than people can read them. Reading every hunk does not scale. Skimming misses the one changed conditional that matters. guided-review gives the line-by-line reading to the agent, and the human judges a short list of specific places. This page explains how the pieces fit and why they have this shape.

## Five steps from pull request to tour

A review passes through five steps. The agent runs the first four. Hunk runs the last.

1. **Prepare.** `scripts/prepare.py <pr-url | pr-number | branch> [base-ref]` runs inside a clone of the repository under review. For a PR it calls `gh pr view`, asks the host whether the PR is part of a stack, and fetches each open PR's head into `refs/guided-review/pr-<n>`. For each review it creates a branch `review/<slug>` checked out in a worktree at `.git/guided-review/<slug>`, where the slug is `pr-<n>` or `branch-<name>`. It prints JSON with one entry per review: the worktree, the `tourPath` beside it, the `base` and `head` SHAs, the title, description, diff stat, and commits, and a `cleanup` command. Given tour files instead, `scripts/prepare.py <tour.json>...` checks out each tour's own `base` and `head` in a `shared-pr-<n>` worktree, fetching missing commits from the remote, and copies the tour to `tourPath`. The agent skips the audit and opens the shared tour as is.
2. **Audit.** The agent follows `SKILL.md`. It states the change's intent, sorts every changed file into Core, Contract, Tests, or Mechanical, and reads every Core and Contract hunk with its callers and callees through the lenses in [`references/lenses.md`](../references/lenses.md). It runs tests and type checks where it can, because a fact it ran is worth more than a fact it inferred.
3. **Write the tour.** The agent picks the stops, groups them into tracks, links related stops, and writes `tour.json` in the format described in [Tour file format](tour-format.md).
4. **Check.** `hunk --extension <skill> tour check <tour.json>` confirms that the file parses, that every link resolves, and that every anchor falls inside one hunk of `git diff <base>...<head>`. The agent fixes errors and warnings until the check prints `ok` and nothing else.
5. **Open.** `scripts/open-tour.sh <worktree> <tour.json>` runs the check again, then starts `hunk --extension <skill> tour open <tour.json>` in a new terminal tab or window. Inside a Neovim terminal it opens a Neovim tab. Inside [herdr](https://herdr.dev), tmux, or zellij it opens a tab or window there, with a pane fallback for older zellij versions. Inside kitty, WezTerm, Ghostty, Alacritty, Konsole, GNOME Terminal, or foot it opens a tab or window in that terminal. Otherwise it uses iTerm2 when running there or Terminal.app on macOS, and x-terminal-emulator on Linux with a graphical display. With none of those, it prints the command. Either way its last line is `Tour command: ...`, so the agent can hand the command to you.

### What happens inside Hunk

`hunk tour` is a CLI command the extension registers in [`extension/index.tsx`](../extension/index.tsx). On `tour open`, the extension validates the tour the same way `tour check` does, keeps the parsed tour in memory, and writes a sidecar file to a unique `hunk-guided-review-*/context.json` directory under the system temp directory. Each open owns its sidecar, even when two tours share a head; shutdown removes it. Then it hands control back to Hunk with a new command line:

```bash
hunk diff <base>...<head> --agent-context <sidecar> --agent-notes
```

From there Hunk shows an ordinary diff review, with three additions from the extension.

- `toSidecar` in [`extension/sidecar.ts`](../extension/sidecar.ts) builds the sidecar. It turns each stop into one of Hunk's agent annotations, which Hunk shows as an inline tour note titled `guided-review note` on the stop's lines, with its number, kind, track, body, and ask. A changeset transform groups **all** diff files by directory, including unannotated and skipped files. Direct children precede subdirectories, so both flat and tree sidebars show each folder once. The diff and `{`/`}` navigation follow that file order; `>`/`<` and the Tour pane retain narrative stop order.
- The **Tour** pane opens on the right. It shows the title, verdict, stack, summary, every track with its summary and stops, and the checked and unchecked scope. The current stop expands to show its body, its ask, and its links in both directions.
- The tour commands move through the tour. The [key bindings](../README.md#key-bindings) in the README list them. Each command asks the core library for the next position and reveals that stop's first line in the diff. Hunk then shows a notice reading `Stop <n>/<total> · Track <t>/<tracks> <track title>: <stop title>`. After `B`, it shows `Back to stop <n>/<total>: <stop title>`. When a move is not possible, it shows the reason, such as `Already at the first stop`. Pressing `>` at the last stop shows `End of tour. Press F to finish the review.` A file outside the review triggers a warning starting with `Stop <n>: <path>`. Filtered-out files get this warning on API 26 hosts; older hosts use Hunk's own warning.

The whole diff stays visible. A tour orders your attention but does not hide anything, and you can leave it at any point to read a file the agent skipped.

## Asking the agent from inside Hunk

The agent that wrote the tour holds the whole audit in its context. The reviewer can use that without leaving Hunk. Every note the reviewer adds is a question. A reply under one of the agent's answers is a follow-up. `Q` sends a question. Notes and `Q` show the notice `Question sent to the agent`. `V` sends `agree`, `disagree`, or `unsure` on the current stop with an optional comment. Decisions are optional. Silence means agreement with the agent's verdict and the stop's framing. The agent answers inline as threaded notes through `hunk session comment add`. It drafts the review from notes, any decisions, and the conversation.

The current stop shows a muted key hint below **Ask:** and a **Decide** button beside **Post to PR**. The hint follows rebound keys and omits unbound commands. `F` finishes the review by default. At the last stop, `>` prompts you to press `F`.

The two sides never share a process, so they talk through files. The mailbox sits beside the tour. `review.tour.json` gets `review.tour.qa/`, and each review generation gets its own directory inside it. Hunk writes the session record and one file per request. `tour wait` writes the agent heartbeat. `tour answer` writes one file per answer, and `tour approve` records the approval. The [command reference](cli.md#the-mailbox) lists every file and request kind.

While a request waits, Hunk shows a `⋯ Waiting for the agent` note on its line. The note lives only in that Hunk process. Hunk compares the notes with the mailbox on each poll and removes a note once its request is answered or the review ends. A note the reviewer replied to stays, so the reply is not lost.

While requests need replies, a spinner appears beside the waiting count and each affected stop in the **Tour** pane until answered or the review ends. **Post to PR** reads `Posting to PR…` after a request and `✓ Posted to PR` once the answer is recorded. Further clicks send no new request.

Each path has one writer, so there are no locks. Every write goes to a temp file first and is renamed into place, and readers skip files that do not parse. Everything shown to either side is a projection of these files. That covers the pending list the agent sees, the status text and decision badges the reviewer sees, and the transcript in the final payload. The model and its projections live in [`core/src/qa.ts`](../core/src/qa.ts), the file layout in [`core/src/mailbox.ts`](../core/src/mailbox.ts), and the Hunk wiring in [`extension/qa.ts`](../extension/qa.ts).

Two Hunk processes can open the same tour. Before each session write, the older process checks the on-disk process id and `openedAt`. It skips writes once another process owns the file. Shutdown checks synchronously. Answers go to the process named in `session.json`.

The agent's loop is two commands. `hunk tour wait` writes its heartbeat, polls the mailbox once a second, and prints one JSON line. It is `pending` with the requests, `idle` after the timeout, `away` after prolonged inactivity, or `finished` or `closed` with the decisions, transcript, and approval eligibility and blockers per tour. The [command reference](cli.md#tour-wait) lists the flags, defaults, and fields. `idle` means the reviewer is still around or has not started yet. The agent keeps running `wait` and never ends its turn on `idle`, however many arrive in a row. It runs `wait` again immediately after answering and stops only on `finished`, `closed`, or `away`. On `away`, it tells the user the review looks paused and that saying "resume" restarts the wait loop.

`away` needs 30 minutes of inactivity by default. Reviewer activity through navigation, commands, notes, and requests resets the clock, as do agent answers. Hunk records activity in `activeAt` at most once every 15 seconds. The clock uses the latest of `openedAt`, `activeAt`, request times, and answer times across open tours. A tour without a session keeps the agent waiting.

`hunk tour answer` posts the note before recording the answer, so a crash or failed write between the two can make a retry post a duplicate note. Delivery is at least once. Once recorded, retries report `already-answered`.

`wait` treats the review as over when `session.json` carries `finishedAt`, set by **Finish review**, or `closedAt`, set when Hunk shuts down, or when the Hunk process id is no longer alive. Reopening an unchanged tour writes a fresh session record in the same review generation and preserves its decisions and answers. A changed repository, PR/layer, base/head, stop order, or tour content starts a new generation; `tour open <tour.json> --fresh` (also accepted by `open-tour.sh`) does so explicitly. Previous generations and legacy mailboxes stay on disk but are not imported into the new review. Request IDs include the generation, so a delayed answer cannot address a new review's request. The agent must never replay historical live notes unless the reviewer explicitly requests an import. An `agree` with no comment needs no reply, so `wait` never returns it as pending. It still appears in the final transcript as `noted`. Hunk 0.22 has no extension status line, so the status text sits at the top of the **Tour** pane, as in `1 waiting · agent listening`. On hosts that have a status line, it is also set there.

## Sharing a summary after the review

A tour lives in Hunk, and its decisions and Q&A sit in a mailbox under `.git`. To hand the outcome to someone who was not in the session, ask for a summary when you request the review:

```text
guided review of https://github.com/<owner>/<repo>/pull/<number> with summary
guided review of https://github.com/<owner>/<repo>/pull/<number> summary=~/reviews/pr-42.md
```

The option is off by default. `summary`, `share summary`, or `summary=on` turns it on with the default path, which is the review's `tourPath` with `.json` replaced by `.md`, as in `.git/guided-review/pr-42.tour.md`. `summary=<path>` names a file for a single review. For a stack, `<path>` is a directory, and each layer gets its own `<slug>.md` there.

The agent writes the file only when `tour wait` returns `finished` or `closed`. An `away` review has not concluded, so it gets no summary. The agent builds the file from the tour JSON and the final payload's `decisions` and `transcript`. It writes the file after its review draft and before asking to approve. If you then confirm an approval, it updates the Outcome line. The reply ends with the file's absolute path.

Each file holds:

- A header with the PR link, the `base...head` range, the verdict, and the outcome: approved at a head, not approved with the reason, or ended without a decision.
- The intent statement, the tour summary, and the stack layers, with the reviewed layer marked.
- One section per track: its summary and a table of its stops with number, kind, title, `path:line`, and your latest decision and comment. Each stop's body and ask sit in a collapsed `<details>` block.
- The reviewer discussion: each question, note, and decision comment with the agent's answer, plus links to comments posted to the PR.
- The scope: what the agent checked, what it did not, and the files it skipped.

Stop numbers match the numbers Hunk shows, and `[[id]]` links become `#<n> <title>`. A stop you did not decide has an empty reviewer cell, because silence means agreement with the agent's framing. The file leaves out secrets, local paths, the worktree, and the `cleanup` command. It is plain GitHub-flavored markdown, so it can be pasted into a PR comment, a ticket, or chat.

The agent posts the summary nowhere. Sharing it is your decision. The review's `cleanup` command does not delete it. With the default path, it stays in `.git/guided-review/` after the worktree is removed. Pass `summary=<path>` to keep it somewhere easier to find.

## Why a tour instead of GitHub review comments

The agent does not post its audit findings to GitHub on its own. That is a deliberate choice.

A review comment speaks to the author, in public, and stays on the PR. An agent's findings are none of those things yet. Some are wrong. Some are right but not worth the author's time. Some are questions only the reviewer can answer, such as whether a 30-second timeout is acceptable for EU traffic. Posting them would give the author a list of claims that no human has checked, with the reviewer's name nearby.

A tour speaks to the reviewer, in private, and goes away when you close Hunk. You read each stop, make the call the ask names, and write the comments you agree with yourself, with `c` in Hunk or on GitHub. The agent does the reading. The human keeps the judgment and the voice.

Two exceptions require the reviewer's action:

- **Post to PR** starts with a click on a stop. The agent rewords that stop as feedback for the author. `tour answer` posts it through `gh api` at the tour's `head`, then adds a Hunk note with the GitHub link. A stop anchored outside the PR's diff, or a tour without a PR `url`, fails loudly. A failure after GitHub accepts the comment but before the answer is recorded can duplicate the PR comment on retry.
- **Approval** requires an explicit yes in the agent chat after the review draft. The agent asks only when the tour is eligible and the transcript has no unresolved concerns. An empty transcript is agreement. The agent judges notes, questions, decision comments, `unsure` decisions, and posted PR comments. Posted comments do not by themselves block approval. The agent judges whether they ask for changes before merge. `tour approve <tour.json> [--body <text>]` requires an ended review. Its hard blockers are a non-approve verdict or a stop whose latest decision is `disagree`. It checks the PR head against the session head and submits approval pinned to that commit. A moved head requires a fresh review. The CLI checks both `approved.json` and the current user's GitHub reviews to avoid duplicate approval on retry. Each stack layer needs its own confirmation and approval.

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

In Hunk, a stack tour lists every layer under the verdict and marks the one under review. Each layer opens in its own tab or window, with a pane fallback in zellij. The herdr, tmux, zellij, kitty, WezTerm, GNOME Terminal, and foot launchers pass the title `review <directory name>`, such as `review pr-102`.

## The core library holds the tour logic

Everything a renderer needs to understand a tour lives in `core/`, which has no UI dependencies. The Hunk extension is one renderer. A web page or an editor plugin could be another. [`core/README.md`](../core/README.md) lists the modules. The design rests on three functions.

- `validateTour(raw, loadRanges)` parses the JSON, then asks the caller for the diff's hunk ranges, then checks anchors and collects warnings. The caller injects `loadRanges`, so core never assumes where the diff comes from. In Node, `readDiffRanges(cwd, base, head)` from `@guided-review/core/git` runs git. A browser that already has the patch text calls `parseDiffRanges(patch)` instead. On success the result carries the tour, its numbered stops, a link index with `linksFrom` and `linksTo`, and the warnings.
- `move(stops, trackCount, cursor, move)` is a pure reducer over a `TourCursor`. The moves are `next`, `prev`, `nextTrack`, `prevTrack`, `goto`, `restart`, `follow`, and `back`. It returns a new cursor, or a reason the move is not possible, such as `End of tour (6 stops)`. `follow` pushes the current stop onto a history and `back` pops it. Every renderer gets the same navigation rules. For example, `prevTrack` first goes to the start of the current track, and steps to the previous track only from there.
- `segmentText(text, index)` splits a body, ask, or summary into plain text and link segments. Each link segment carries its target stop, so the renderer decides what a link looks like and what clicking it does. `formatLink` gives the standard `#<number> <title>` label.

The renderer owns everything else: how a stop is revealed, how messages appear, and any host-specific export. In this repository that export is `extension/sidecar.ts`. It turns a tour into Hunk's agent-context format, so it lives outside core.

## Known limits

- **Hunk's extension API is experimental.** `package.json` declares `apiVersion: 25`, and Hunk's own README warns that the API may break between minor releases. The extension was built against Hunk 0.22.0 and the `hunkdiff` 0.23.0 types. On Hunk releases before API 26, the extension cannot tell which files the file filter hides, so a stop in a filtered-out file triggers Hunk's own warning when revealed.
- **Inline tour notes are read-only.** They come from a sidecar file, so you cannot reply to them, resolve them, or edit them in Hunk. Notes you add with `c` never flow to GitHub. While a tour is open, every note goes to the agent, and its answer arrives as a reply under the note. Only clicking a stop's **Post to PR** button asks the agent to post that stop to GitHub.
- **The tour lives in memory.** Quitting Hunk forgets your position. Reopening the same unchanged tour starts before stop 1 and resumes its saved decisions and questions. Changed tours and `--fresh` use isolated review generations; historical live notes are never automatically replayed.
- **Anchors must sit inside the diff.** A stop can only point at lines inside a hunk of `base...head`, context lines included. An unchanged caller in another file cannot be a stop, so the agent cites it in the stop's body instead.
- **GitHub Enterprise works through `gh`, not `hunk gh`.** `prepare.py` calls `gh pr view` and `gh api --hostname <host>`, so any host `gh` is logged in to works. Stack detection also needs the host to offer the stacks API. Without it, `stackLookup` is `unavailable` and each PR is reviewed alone.
- **Terminal launch is best effort.** `open-tour.sh` tries Neovim first, then herdr, tmux, or zellij, then kitty, WezTerm, Ghostty, Alacritty, iTerm2, Konsole, GNOME Terminal, or foot. It falls back to Terminal.app on macOS or x-terminal-emulator on Linux with a graphical display. If no launcher applies, it prints the command for you to run.
- **Below 120 columns the pane needs the sidebar's space.** Hunk hides its side panes below 160 columns until something opens one, so the extension opens the **Tour** pane when the tour loads. The pane takes 30% of the width, between 32 and 64 columns. In testing, the demo showed the sidebar, the diff, and the pane together at 120 columns and wider. At 100 columns, Hunk drops the pane to keep 48 columns for the diff, and pressing `s` to hide the sidebar brings it back.
