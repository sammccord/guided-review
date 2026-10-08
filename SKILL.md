---
name: guided-review
description: Audit a pull request or branch, pick the few changes that need human judgment, and open them as an ordered, annotated tour in the Hunk diff viewer. Use for "guided review", "tour this PR", "review tour", "walk me through this PR", or a PR link or branch name with a request to review it in hunk. Not for posting review comments to GitHub.
---

# Guided review

The reviewer's time is the scarce resource. Do the exhaustive reading yourself, then hand the human a short tour of the places where their judgment is required. A tour that stops at every hunk has failed.

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

A stop earns its place only if the human must decide something you cannot settle alone. Use one `kind` per stop:

- **blocker.** A bug or regression you traced to a concrete failing path. Show the path.
- **risk.** Code whose safety rests on a fact you could not prove (a caller's behavior, production data, an external system, concurrency).
- **question.** A design, product, or intent call: the code works, but whether it is the right thing is the reviewer's decision.
- **context.** Orientation the reviewer needs to judge later stops, such as the new core abstraction. Two at most.

Usually 3 to 12 stops. More than 12 means you are not filtering. Fewer is fine, and a tour with no stops is valid: zero blockers and zero risks is a legitimate result. Say so in the verdict instead of inflating nits or padding with context.

Leave out style preferences, naming, "I would have done it differently", hypothetical inputs no caller can produce, and anything a linter or the test suite already enforces. List a file in `skipped` only when a reviewer would expect it on the tour (a Core or Contract file with real changes) and you left it off. One line on why. Do not list tests or Mechanical files.

Order the stops as a story, not by file: the context stop first, then the entry point, then each consequence in the order a reader would follow the data. Within that story, put blockers as early as the narrative allows.

## 6. Write the tour

Write the tour to `tourPath` from step 1. It sits beside the worktree, not inside it. The schema is the `Tour` and `Stop` types in [`extension/tour.ts`](extension/tour.ts). Read them before writing.

- `base` and `head` are the SHAs from step 1.
- Anchor each stop on lines of the reviewed diff. Use `side: "new"` with new-file line numbers, or `side: "old"` for code that was deleted. `endLine` covers a short range that stays inside one `@@` range of `git diff <base>...<head>`. Adjacent changed lines can belong to different `@@` ranges.
- `body` is plain text. Say what changed, why it matters, and the evidence: callers, the trace, the test you ran, or what you could not verify.
- `ask` is one concrete decision, phrased so the reviewer can answer it after reading the stop. "Is a 30s timeout acceptable for EU traffic?" is a good ask. "Please review" is not.
- `verdict` is your recommendation: `approve`, `request-changes`, or `discuss`.
- `scope.checked` and `scope.unchecked` say what you verified and what you did not. Be specific ("ran `pkg/policy` tests: pass", "did not exercise the migration against production-sized data").

## 7. Check the tour

From the worktree:

```bash
hunk --extension <skill>/extension tour check <tour.json>
```

It validates the schema and confirms every anchor falls inside a hunk of `base...head`. Fix every reported stop and rerun until it prints `ok`.

## 8. Open it

```bash
<skill>/scripts/open-tour.sh <worktree> <tour.json>
```

Hunk needs a real terminal, so the script opens one through herdr, tmux, or macOS Terminal/iTerm, whichever is available. Otherwise it prints the command for the user to run. Pass `--print` first to skip launching. It always prints a final `Tour command:` line.

In hunk, the Tour pane on the right lists the stops. `>` and `<` step through them in tour order, and the current stop expands with its body and ask. The whole diff stays visible, with tour files sorted first. `{` and `}` jump between annotated hunks, `a` toggles the inline notes, and `c` adds the reviewer's own note.

## 9. Report

Reply with the verdict and the intent statement. List the stops, one line each as `kind`, title, and `path:line`. Include the unchecked scope, the `Tour command:` line, and cleanup with `git worktree remove <worktree> && git branch -D <branch>`.
