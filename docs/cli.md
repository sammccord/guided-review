# `hunk tour` command reference

The extension registers one Hunk command, `hunk tour`, with five subcommands. This page lists each subcommand's arguments, output, exit status, and error messages. [How guided-review works](how-it-works.md) explains why the pieces have this shape. [Tour file format](tour-format.md) lists the rules `tour check` enforces.

Load the extension with `--extension`, or install it once with `hunk extension install` and drop the flag:

```bash
hunk --extension /path/to/guided-review tour <subcommand> ...
```

A usage error prints this text to stderr and exits with status 2:

```text
usage: hunk tour check <tour.json> | open <tour.json> [--fresh]
       hunk tour wait <tour.json>... [--timeout <seconds>] [--away <minutes>]
       hunk tour answer <tour.json> <id> --text <answer>
       hunk tour approve <tour.json> [--body <text>]
```

`wait` and `approve` print their own one-line usage errors instead, listed in their sections.

| Exit status | Meaning |
| --- | --- |
| `0` | Success. Also returned when the work was already done, such as an answer that was already posted. |
| `1` | The command ran and failed. The reason goes to stderr. |
| `2` | Bad arguments. |

`wait`, `answer`, and `approve` print one JSON object per line to stdout. Handled errors start with `tour wait: `, `tour answer: `, or `tour approve: `. Malformed `answer` arguments print the shared usage text without a prefix. Empty-answer errors retain the prefix.

## `tour check`

```bash
hunk tour check <tour.json>
```

Validates the tour against `git diff <base>...<head>` in the current directory. Prints warnings to stderr, each prefixed with `warning: `, then `ok: <stops> stops in <tracks> tracks across <files> files, verdict <verdict>`. [Tour file format](tour-format.md#tour-check) lists every error and warning.

Stack tours append ` · stack #<number> layer <position>/<layers>`.

## `tour open`

```bash
hunk tour open <tour.json> [--fresh]
```

Runs the same checks as `tour check`. Errors stop it with status 1. Then it pins `base` and `head` to commit IDs, prepares the review mailbox, and starts `hunk diff <base>...<head>` with the tour loaded.

`--fresh` starts a new review generation even when the tour has not changed. Without it, reopening an unchanged tour resumes the same generation, with its decisions, questions, and answers. A changed repository, base, head, or tour content always starts a new generation. Old generations stay on disk and never enter the new review.

## `tour wait`

```bash
hunk tour wait <tour.json>... [--timeout <seconds>] [--away <minutes>]
```

The agent's half of the loop. It writes the agent heartbeat, reads the mailbox of each tour once a second, and prints one JSON line when something happens or the timeout runs out.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--timeout` | `90` | Seconds to wait before printing `idle` or `away`. Must be a positive number. |
| `--away` | `30` | Minutes of reviewer inactivity after which a timeout prints `away` instead of `idle`. Must be a positive number. |

The heartbeat promises the agent listens until the timeout ends. When `wait` returns requests, it extends that promise to 600 seconds, so the reviewer sees `agent listening` while the agent writes answers.

The output's `kind` field is one of these values:

| `kind` | When | Other fields |
| --- | --- | --- |
| `pending` | At least one open tour has a request that needs a reply. | `items`, each request with its `tour` path added. `next` is an instruction string containing the first item's `tour answer` command, shaped as `answer each with: <command> then wait again`. |
| `finished` | Every tour ended, and all have `finishedAt`. This takes precedence over `closedAt` or a dead Hunk process. | `decisions`, `transcript`, `approval`, and `next: "write the review draft"`. |
| `closed` | Every tour ended, and at least one has no `finishedAt` but has `closedAt` or a dead Hunk process. | Same as `finished`. |
| `idle` | The timeout ran out, and at least one unfinished tour has no session yet or saw activity within `--away` minutes. | `idleMinutes`, and `next: "wait again; do not end your turn"`. |
| `away` | The timeout ran out, and no open tour saw activity for `--away` minutes. | `idleMinutes`, and `next` tells the agent to stop and tell the reviewer it paused. |

In the final payload:

- `decisions` lists `{tour, stop, decision}` with the latest decision per stop.
- `transcript` lists `{tour, request, answer, status}` in request order. `status` is `answered`, `pending`, or `noted`. `noted` marks an `agree` with no comment, which needs no reply.
- `approval` lists `{tour, eligible, blockers}` per tour. A blocker reads `verdict is <verdict>` or `stop <n>: disagree`.

A tour that was never opened in Hunk has no session, so `wait` keeps waiting for it.

Errors:

| Message | Status |
| --- | --- |
| `tour wait: wait needs at least one tour file` | 2 |
| `tour wait: --timeout needs a positive number of seconds` | 2 |
| `tour wait: --away needs a positive number of minutes` | 2 |
| `tour wait: unknown option <option>` | 2 |
| `tour wait: tour changed or has no saved identity; reopen the tour before answering or approving` | 1 |
| `tour wait: <path>: <errors>`, for tour-schema validation failures | 1 |
| `tour wait: <error>`, for file reads, JSON syntax, ref resolution, or mailbox failures | 1 |

## `tour answer`

```bash
hunk tour answer <tour.json> <id> --text <answer>
```

Answers one request from `wait`. The answer appears in Hunk as a note, threaded under the reviewer's note when the request came from one. `tour answer` then records the answer in `answered/<id>.json`. The Hunk session for the tour must be running, and `hunk` must be on your `PATH`.

You can run it by hand. Take the `id` from the `inbox/` file name, or from the `next` field of a `pending` result.

For a **Post to PR** request, `--text` is the comment for the author. `tour answer` posts it through `gh api` as a review comment at the session's head commit, on the stop's anchor. Then it adds a Hunk note with the comment's GitHub link. The tour needs a PR `url`, and `gh` must be logged in to the PR's host.

Output:

| stdout | Meaning |
| --- | --- |
| `{"id": "<id>", "status": "posted", "commentId": "<hunk-comment-id>"}` | The answer was posted and recorded. `commentId` is `null` if Hunk's response has no recognizable comment id. |
| `{"id": "<id>", "status": "already-answered"}` | An answer was recorded earlier. Nothing is posted again. |

Errors:

| Message | Status |
| --- | --- |
| the shared usage text, without a `tour answer: ` prefix | 2 |
| `tour answer: --text must not be empty` | 2 |
| `tour answer: the answer has no text on its first line` | 2 |
| `tour answer: no request <id> in <inbox>` | 1 |
| `tour answer: <session.json path> is missing; open the tour in Hunk first` | 1 |
| `tour answer: tour changed or has no saved identity; reopen the tour before answering or approving` | 1 |
| `tour answer: tour has no PR url; add "url" to the tour or post the comment yourself` | 1 |
| `tour answer: PR comment failed: <gh error>` | 1 |
| `tour answer: the Hunk session for this tour (pid <pid>) is not running; reopen the tour` | 1 |
| `tour answer: hunk session failed: <error>` | 1 |

A **Post to PR** answer posts to GitHub before it reaches Hunk. If Hunk is gone at that point, the command fails without recording the answer, and a retry posts the PR comment again.

## `tour approve`

```bash
hunk tour approve <tour.json> [--body <text>]
```

Submits a GitHub approval for the tour's PR, pinned to the reviewed head commit. The agent runs it only after you say yes in the agent chat. `--body` adds a review body. It must not be blank.

Checks, in order:

1. The review ended, through **Finish review**, by closing Hunk, or because the Hunk process exited.
2. The tour's refs resolve in the session's repository.
3. The verdict is `approve`, and no stop's latest decision is `disagree`.
4. The tour's `url` parses as a PR URL such as `https://<host>/<owner>/<repo>/pull/<number>`.
5. The tour still matches the one that was reviewed.
6. If `approved.json` records this head and an approval URL, report `already-approved` without calling GitHub.
7. Otherwise, check that GitHub's current PR head equals the reviewed head.
8. Check the current user's reviews for an `APPROVED` review at that commit. If found, record it and report `already-approved`.
9. Otherwise, submit the approval and record it.

Output:

| stdout | Meaning |
| --- | --- |
| `{"status": "approved", "url": "<review url>"}` | The approval was submitted. |
| `{"status": "already-approved", "url": "<review url>"}` | An approval at this head already exists. |

Errors:

| Message | Status |
| --- | --- |
| `tour approve: expected <tour.json> [--body <text>]` | 2 |
| `tour approve: review has not ended; finish or close Hunk first` | 1 |
| `tour approve: approval blocked:` followed by one blocker per line | 1 |
| `tour approve: tour has no PR url` | 1 |
| `tour approve: tour changed or has no saved identity; reopen the tour before answering or approving` | 1 |
| `tour approve: PR head moved from <head> to <sha>; re-run the review` | 1 |
| `tour approve: gh returned no PR head.sha` | 1 |
| `tour approve: gh returned no current user login` | 1 |
| `tour approve: gh returned invalid PR reviews` | 1 |
| `tour approve: gh returned no review html_url` | 1 |
| `tour approve: <gh error>`, when a `gh` call fails | 1 |

## The mailbox

Hunk and the agent never share a process. They exchange files under a directory beside the tour, named after it. `review.tour.json` gets `review.tour.qa/`. Its `current.json` holds `{"reviewId": "<uuid>"}`, and the active review lives in `reviews/<review-id>/`:

| Path | Writer | Content |
| --- | --- | --- |
| `session.json` | Hunk | repo, tour path, head, review id, tour fingerprint, Hunk process id, `openedAt`, `activeAt` after activity, and `finishedAt` or `closedAt` once set |
| `inbox/<id>.json` | Hunk | one request, never changed after it is written |
| `answered/<id>.json` | `tour answer` | request id, Hunk comment id, answer text, and time |
| `agent.json` | `tour wait` | the agent's process id and the time it promised to listen until |
| `approved.json` | `tour approve` | approval URL, reviewed head, and time |

A request id reads `q-<review-id>-<seq>`. A request is one of five kinds:

| `kind` | Sent by | Fields beyond `id`, `seq`, `at`, `stop` |
| --- | --- | --- |
| `question` | a new note in Hunk | `noteId`, `anchor`, `text` |
| `followup` | a reply under a recorded reviewer note, an agent answer, or a waiting placeholder | `noteId`, `parentId`, `anchor`, `text` |
| `ask` | `Q` | `anchor`, `text` |
| `decision` | `V` or the **Decide** button | `decision` (`agree`, `disagree`, or `unsure`), `comment` |
| `comment` | the **Post to PR** button | `body` |

An `anchor` is `{path, side, line}`. `stop` is the stop that was current when the request was sent, or `null` when no stop was current.

Invalid JSON in `current.json` raises a JSON parse error. A missing or non-string `reviewId` raises `invalid review pointer`. A non-UUID `reviewId` raises `invalid review id`.

`scripts/prepare.py` adds `rm -rf <worktree>.tour.qa` to each review's `cleanup` command.

## Status text in Hunk

The top of the **Tour** pane reads `<n> waiting · <agent>`, where `<agent>` is one of:

- `agent listening`, while the heartbeat in `agent.json` is in the future.
- `agent away <duration>`, after it lapses, as in `agent away 4m`.
- `no agent yet`, before `tour wait` writes a heartbeat for this review.

A spinner appears beside the waiting count and each affected stop while requests need replies, until answered or the review ends.

A request that needs a reply shows a `⋯ Waiting for the agent` note until the answer arrives. The answer brings a notice that starts with `Answered: `.

## `scripts/open-tour.sh`

```bash
scripts/open-tour.sh [--print] [--fresh] <repo-or-worktree-dir> <tour.json>
```

Runs `tour check`, then starts `tour open` in a new terminal tab or window in `<repo-or-worktree-dir>`, with a pane fallback in zellij. The herdr, tmux, zellij, kitty, WezTerm, GNOME Terminal, and foot launchers pass the title `review <directory name>`, such as `review pr-102`. After a successful check and launch, the last line is `Tour command: <command>`. A failed tour check stops the script first with status 1.

- `--print` checks the tour and prints the command without opening a terminal.
- `--fresh` passes `--fresh` to `tour open`.

Wrong argument count or `--help` prints usage and exits with status 2. `not a directory: <dir>` and `no such tour file: <file>` exit with status 2 without usage. [`SKILL.md`](../SKILL.md) lists the order in which the script tries terminals.
