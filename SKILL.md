---
name: guided-review
description: Audit a pull request or branch, pick the changes that need human judgment, and open them as an ordered, annotated tour of small stops grouped into tracks in the Hunk diff viewer. Use for "guided review", "tour this PR", "review tour", "walk me through this PR", or a PR link or branch name with a request to review it in hunk. Not for posting review comments to GitHub.
---

# Guided review

The reviewer's time is the scarce resource. Do the exhaustive reading yourself, then hand the human a tour of the places where their judgment is required. Each stop is small: a few lines and one point. Related stops form a track, so the reviewer sees how the significant changes connect. A tour that stops at every hunk has failed.

## Inputs

- **Target.** A PR URL, a PR number, or a branch name, plus an optional base ref.
- **Stop budget.** Optional. The user may name a number ("12 stops", "stops=30") or a depth: `quick` is about 8, `standard` about 20, `deep` about 40. Default `standard`. The budget counts stops, not findings. Fill it with findings first, then with `inspect` stops in order of significance. Fall short only when the diff runs out of significant changes, and say so in the report. Never pad with nits or Mechanical files to reach it.

`<skill>` below means the directory containing this file.

Requires `git`, `python3`, `hunk` 0.22 or newer, and `gh` authenticated for the PR's host (`gh auth status`). GitHub Enterprise works because nothing goes through `hunk gh`.

## 1. Prepare the worktree

Run from inside a clone of the repository under review. If the user is elsewhere, find the clone or `gh repo clone` it first.

```bash
<skill>/scripts/prepare.sh <pr-url | pr-number | branch> [base-ref]
```

It fetches the change, creates branch `review/<slug>` in a worktree under `.git/guided-review/`, and prints JSON with `worktree`, `tourPath`, `base`, `head`, `title`, `url`, `description`, `stat`, and `commits`. The user's checkout is untouched. Read code from the worktree, not the user's checkout. Every diff in this skill is `git diff <base>...<head>`.

## 2. State the intent

Write two or three sentences on what the change is trying to do, from the description, the commit messages, and linked tickets you can reach. In a stacked PR the ticket describes the whole stack; judge only what `base...head` delivers. Every later judgment is measured against this. A finding that ignores the intent is a bad finding.

## 3. Map the diff

Run `git diff --stat <base>...<head>` and sort every changed file into one bucket:

- **Core.** Behavior changes: logic, control flow, data handling.
- **Contract.** Public API, schema, migration, config, permissions, dependency versions.
- **Tests.** Added, changed, or deleted tests.
- **Mechanical.** Renames, moves, formatting, generated code, lockfiles.

Mechanical files get a sampled check that they are what they claim (a "pure rename" with a changed line is not mechanical). Core and Contract files get the full audit. Deleted tests count as Contract.

## 4. Audit

Read every Core and Contract hunk in full context, plus the callers and callees it touches. Apply the lenses in [references/lenses.md](references/lenses.md).

If your host can run parallel subagents, give each one a slice (by lens or by subsystem) with the intent statement, base, head, and worktree path, and ask for findings with `file:line` evidence. Otherwise run the lenses yourself in sequence. A slice that fails to report is noted as unchecked, not silently dropped.

Run things when you can: the tests for the touched packages, the type checker, a quick repro of a suspected bug. A fact you ran beats a fact you inferred, and the tour says which is which.

## 5. Choose the stops

A stop either carries a finding or points at a significant change a human should inspect with their own eyes. Use one `kind` per stop:

- **blocker.** A bug or regression you traced to a concrete failing path. Show the path. The reviewer's decision is whether it blocks the merge and whether your proposed fix is right.
- **risk.** Code whose safety rests on a fact you could not prove (a caller's behavior, production data, an external system, concurrency).
- **question.** A design, product, or intent call: the code works, but whether it is the right thing is the reviewer's decision.
- **inspect.** A significant change with no defect found that still deserves human eyes: rewritten core logic, a contract or schema change, deleted behavior, a new abstraction's callers. The ask says what to confirm.
- **context.** A definition the reviewer must see before the stops that use it. At most one per track, as its first stop.

Prefer more, smaller stops over fewer large ones. One stop makes one point about a few lines, ideally under 10 and never over 20 (`tour check` warns past 20). A finding that touches three places is three stops: where the value is produced, where it is transformed, where it is consumed. A test that asserts the behavior in question is its own stop. Each stop carries its own short body and ask. Split until each stop's body fits in a few sentences, then stop splitting.

Size the tour to the stop budget from the inputs. A tour with no stops is valid: zero blockers and zero risks is a legitimate result. Say so in the verdict instead of inflating nits or padding with context.

Leave out style preferences, naming, "I would have done it differently", hypothetical inputs no caller can produce, and anything a linter or the test suite already enforces. List a file in `skipped` only when it is a Core or Contract file with real changes and no stop. One line on why. At most 15 entries, the riskiest first; count the rest in `scope.checked`. Do not list tests or Mechanical files.

Group the stops into tracks. A track is one thread the reviewer should hold in their head at once: a causal chain (a new abstraction and each caller migrated onto it), a single concern that spans files (every place the rate limiter is committed or rolled back), or one subsystem. A stop belongs to exactly one track. Usually 2 to 6 tracks. A small tour may use one track, a tour with no stops has no tracks, and a track with one stop is fine when the point really stands alone.

The track `summary` is where relationships live. Say how its stops connect and what the reviewer should conclude after reading them together, such as "the runner commits on every path except the swap handler; stops 4 to 6 show the three paths". Name dependencies on other tracks ("assumes the Release contract from track 1").

Order tracks so each one only depends on tracks before it: the core abstraction first, then its consequences, then independent concerns. Within a track, order stops the way a reader follows the data or the call chain. Put the track holding the most severe blocker as early as those dependencies allow.

## 6. Write the tour

Write the tour to `tourPath` from step 1. It sits beside the worktree, not inside it. The schema is the `Tour`, `Track`, and `Stop` types in [`extension/tour.ts`](extension/tour.ts). Read them before writing.

- `base` and `head` are the SHAs from step 1.
- Anchor each stop on lines of the reviewed diff. Use `side: "new"` with new-file line numbers, or `side: "old"` for code that was deleted. `endLine` covers a short range that stays inside one `@@` range of `git diff <base>...<head>`. Adjacent changed lines can belong to different `@@` ranges.
- `body` is plain text. Say what changed, why it matters, and the evidence: callers, the trace, the test you ran, or what you could not verify.
- `ask` is one concrete decision, phrased so the reviewer can answer it after reading the stop. "Is a 30s timeout acceptable for EU traffic?" is a good ask. "Please review" is not. Stops split from one finding ask narrower questions, such as what to confirm at this spot.
- `verdict` is your recommendation: `approve`, `request-changes`, or `discuss`.
- `scope.checked` and `scope.unchecked` say what you verified and what you did not. Be specific ("ran `pkg/policy` tests: pass", "did not exercise the migration against production-sized data"). A check that failed and passed on a rerun with a workaround goes in `checked` with both results; the unresolved cause goes in `unchecked`.

## 7. Check the tour

From the worktree:

```bash
hunk --extension <skill>/extension tour check <tour.json>
```

It validates the schema and confirms every anchor falls inside a hunk of `base...head`. Fix every reported stop and rerun until it prints `ok`. Split any stop it warns about.

## 8. Open it

```bash
<skill>/scripts/open-tour.sh <worktree> <tour.json>
```

Hunk needs a real terminal, so the script opens one through herdr, tmux, or macOS Terminal/iTerm, whichever is available. Otherwise it prints the command for the user to run. Pass `--print` first to skip launching. It always prints a final `Tour command:` line.

In hunk, the Tour pane on the right lists the tracks, each with its summary and its stops. `>` and `<` step through stops in tour order. `)` and `(` jump to the next or previous track. The current stop expands with its body and ask. The whole diff stays visible, with tour files sorted first. `{` and `}` jump between annotated hunks, `a` toggles the inline notes, and `c` adds the reviewer's own note.

## 9. Report

Reply with the verdict and the intent statement. List the tracks, each with a one-line summary and its stops, one line each as number, `kind`, title, and `path:line`. If you used fewer stops than the budget, say why. Include the unchecked scope, the `Tour command:` line (`open-tour.sh --print` gives it without opening a terminal), and cleanup with `git worktree remove <worktree> && git branch -D <branch>`.
