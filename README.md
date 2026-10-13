# guided-review

guided-review is an agent skill and Hunk extension that turns a pull request into an ordered review tour in the Hunk terminal diff viewer. It is for reviewers who get more agent-written pull requests than they can read line by line. You give your coding agent a PR link, a PR number, or a branch. The agent audits the whole change, then opens [Hunk](https://github.com/modem-dev/hunk) on a tour of the few places that need your judgment, each one small, grouped into tracks, linked to related stops, and ending in a concrete question.

A stacked PR, as managed by the `gh stack` extension, gets one tour per layer. The tour logic lives in a TypeScript library, `core/`, that has no UI code, so other renderers can reuse it.

## What a tour looks like

The demo tour opens Hunk with the file sidebar on the left, the diff in the middle, and the **Tour** pane on the right. This excerpt of the pane was captured after pressing `>` twice in a 200-column terminal:

```text
 Demo: retry jitter, shouldRetry, injectable
 clock
 REQUEST-CHANGES

 • Intent: add jitter and a shouldRetry
   predicate; make the bucket clock injectable.
 • Blocker: retry makes one attempt more than
   maxAttempts.
 • The test was bumped to match the bug instead
   of catching it.
 • Bucket refill can starve fast pollers;
   depends on caller rates.

 Stops (6)

 ▸Track 1: Retry attempts and backoff (4 stops)
  • RetryOptions renames retries to maxAttempts
    and changes its meaning.
  • The loop kept the old bound; see #2 Loop
    bound is off by one.
  • The test pins the extra attempt; see #3
    Test expectation moved from 4 to 5.
  • Jitter feeds the bucket risk in track 2;
    see #4 Full jitter on by default.
  1. ↔ [context] maxAttempts now counts the
 first attempt
     src/retry.ts:3-11
 ▸2. [blocker] Loop bound is off by one
     src/retry.ts:31-37
     • `attempt <= maxAttempts` runs
       maxAttempts + 1 times.
     • Bound was right for the old meaning; see
       #1 maxAttempts now counts the first
       attempt.
     • Default config now makes 5 calls, not 4.
     • Fix: `attempt < maxAttempts`, delay
       while `attempt < maxAttempts - 1`.

     Ask: Block on this, and is the proposed
     fix right?

     Links
     → #1 maxAttempts now counts the first
     attempt  src/retry.ts:3

     Linked from
     ← #3 Test expectation moved from 4 to 5
     test/retry.test.ts:18
```

The same stops also appear in the diff as inline notes:

```text
╭─ guided-review note - src/retry.ts R3–R11 ───────────────────────┬┤
│                                                                  ││
│ 1/6 [context] Retry attempts and backoff › maxAttempts now       ││
│ counts the first attempt                                         ││
│ - Old field: retries after the first attempt (default 3).        ││
│ - New field: total attempts, first included (default 4).         ││
│ - Same total for defaults; the loop must change with it.         ││
│                                                                  ││
│ Ask: Is renaming the field enough warning for callers that set   ││
│ retries?                                                         ││
╰──────────────────────────────────────────────────────────────────╯│
```

## Requirements

- `hunk` 0.22.0 or newer. Install it with `brew install hunk` or `npm i -g hunkdiff`.
- `git`.
- `python3`, for `scripts/prepare.py`.
- `gh`, authenticated for the PR's host, to review pull requests. Branch reviews work without it.
- An agent host that loads skills from a directory, such as opencode, Claude Code, or Codex.

## Quick start

1. Clone the repository into a folder named `guided-review`:

	```bash
	git clone https://github.com/sammccord/guided-review.git
	cd guided-review
	```

2. Install the skill for every agent whose config directory exists:

	```bash
	scripts/install.sh
	```

3. Open the demo tour. It needs no pull request, `gh`, or agent:

	```bash
	examples/demo/run.sh
	```

	With `bun` installed, `bun run demo` runs the same script.

4. Ask your agent for a review:

	```text
	guided review of https://github.com/<owner>/<repo>/pull/<number>
	```

	The agent works in a clone of the repository under review. Start it from inside that clone, or it looks for one or runs `gh repo clone`. Add a stop budget to change the depth, such as `quick`, `deep`, or `12 stops`.

## Key bindings

These keys work while a tour is open in Hunk:

| Key | Action | Source |
| --- | --- | --- |
| `>` | Next tour stop | guided-review |
| `<` | Previous tour stop | guided-review |
| `)` | First stop of the next track | guided-review |
| `(` | Start of the current track, then the previous track | guided-review |
| `L` | Follow a link from the current stop. With more than one link, Hunk asks which. | guided-review |
| `B` | Back to the stop you left by following a link | guided-review |
| none | **Restart tour**, from the **Extensions** menu | guided-review |
| `{` `}` | Previous or next annotated hunk | Hunk |
| `a` | Show or hide the inline notes | Hunk |
| `c` | Add your own review note | Hunk |
| `s` | Hide or show the file sidebar, which makes room for the **Tour** pane in a narrow terminal | Hunk |
| `q` | Quit | Hunk |

Clicking a stop in the **Tour** pane jumps to it. Clicking a link row follows the link.

## Repository layout

- `SKILL.md` is the agent skill, the audit and tour workflow the agent follows.
- `references/` holds the audit lenses the skill applies.
- `scripts/` holds `prepare.py`, `open-tour.sh`, `install.sh`, and `test-install.sh`.
- `extension/` is the Hunk extension, with the `hunk tour` command, the **Tour** pane, and the key bindings.
- `core/` is the renderer-independent TypeScript library for validating and stepping through tours.
- `examples/demo/` builds a throwaway repository and opens a sample tour.
- `docs/` holds the guides linked below.

## Documentation

- [Install guided-review](docs/install.md) covers each agent, manual installs, use without an agent, upgrades, removal, and troubleshooting.
- [Tour file format](docs/tour-format.md) lists every field of `tour.json` and every rule `hunk tour check` enforces.
- [How guided-review works](docs/how-it-works.md) explains the pipeline, the design choices, and the known limits.
- [Changelog](CHANGELOG.md).
- [`core/README.md`](core/README.md) describes the library's modules.

## Development

Development needs [Bun](https://bun.sh).

```bash
bun install                # install type packages and test dependencies
bun run check              # tsc --noEmit, then bun test core extension
bun run demo               # open the demo tour
scripts/test-install.sh    # test install.sh against a throwaway HOME
```

## License

MIT. See [LICENSE](LICENSE).
