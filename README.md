# guided-review

guided-review turns a pull request into an ordered review tour in [Hunk](https://github.com/modem-dev/hunk), a terminal diff viewer, or in **Cursor** with a native tour plan, inline code comments, and code lenses. It is an agent skill plus two renderers, for reviewers who get more agent-written pull requests than they can read line by line.

You give your coding agent a PR link, a PR number, or a branch. The agent audits the whole change and picks the few places that need your judgment. Then it opens Hunk on a tour of those places. Each stop covers a few lines and ends in a concrete question. Tracks group related stops, and links connect stops across tracks.

A stacked PR, as managed by the `gh stack` extension, gets one tour per stack layer. The tour logic lives in `core/`, a TypeScript library with no UI code, so other renderers can reuse it.

## Cursor port

The [Cursor extension](cursor-extension/README.md) reuses the same tour JSON and validation core. Put its native **Tour Plan** tree in the right sidebar, click stops to open the exact Git revision, and read the evidence and decision in inline comment threads. Follow links, step through tracks, and mark stops reviewed without leaving the editor.

```sh
bun install
bun run package:cursor
cursor --install-extension cursor-extension/guided-review-cursor-0.1.0.vsix
examples/demo/run.sh --cursor
```

Use **Guided Review: Move Plan to Right Sidebar…** once and select the Secondary Side Bar destination; Cursor remembers the placement. Hunk remains the default for existing commands. Add `--cursor` to `scripts/open-tour.sh` to use Cursor instead. The requirements and terminal controls below describe the Hunk renderer; see the [Cursor guide](cursor-extension/README.md) for editor controls and development.

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

The same stops also appear in the diff as inline tour notes:

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

- `hunk` 0.22.0 or newer. Install it with `curl -fsSL https://hunk.dev/install.sh | sh`, `brew install hunk`, or `npm i -g hunkdiff`. [Hunk's install guide](https://github.com/modem-dev/hunk#install) lists the other methods.
- `git`.
- `python3`, for `scripts/prepare.py`.
- `gh`, authenticated for the PR's host, to review pull requests. Branch reviews work without it.
- Node.js, for `npx skills`. A clone install with `scripts/install.sh` works without it.
- An agent host that loads skills from a directory, such as opencode, Claude Code, or Codex.

## Quick start

1. Install the skill with the [skills CLI](https://github.com/vercel-labs/skills):

	```bash
	npx skills add sammccord/guided-review -g
	```

	The command asks which agents to install for. To skip the prompt, name them, such as `-a claude-code -a opencode -y`. The skill lands in `~/.agents/skills/guided-review`. Agents that read that directory use it there. The others get a symlink to it. No clone is needed.

2. Open the demo tour. The demo needs no pull request, `gh`, or agent:

	```bash
	~/.agents/skills/guided-review/examples/demo/run.sh
	```

	The script opens Hunk in a new terminal tab or window, because Hunk needs a real terminal. Inside a Neovim terminal it opens a Neovim tab. Inside [herdr](https://herdr.dev), tmux, or zellij it opens a tab or window there, with a pane fallback for older zellij versions. Inside kitty, WezTerm, Ghostty, Alacritty, Konsole, GNOME Terminal, or foot it opens a tab or window in that terminal. Otherwise it uses iTerm2 when running there or Terminal.app on macOS, and x-terminal-emulator on Linux with a graphical display. With none of those, it prints the command. To print the command and run it yourself instead, add `--print --keep`.

3. Ask your agent for a review:

	```text
	guided review of https://github.com/<owner>/<repo>/pull/<number>
	```

	The agent works in a clone of the repository under review. Start it from inside that clone, or it looks for one or runs `gh repo clone`. Add a stop budget to change the depth, such as `quick`, `deep`, or `12 stops`.

To update the skill, run `npx skills update -g`. To remove it, run `npx skills remove guided-review -g`. [docs/install.md](docs/install.md) covers installing from a clone, telemetry, and troubleshooting.

## Open a tour you wrote

Run `hunk tour check` and `hunk tour open` from inside the repository the tour reviews, because both run `git diff` in the current directory. To check and open a tour file you wrote or kept from an earlier review:

```bash
cd /path/to/reviewed-repo
hunk --extension ~/.agents/skills/guided-review tour check tour.json
hunk --extension ~/.agents/skills/guided-review tour open tour.json
```

With a clone install, pass the clone's path to `--extension` instead.

`tour check` prints an `ok:` line when the tour is valid. `tour open` starts Hunk in the current terminal. [Tour file format](docs/tour-format.md) lists every field and every rule.

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
| `a` | Show or hide the inline tour notes | Hunk |
| `c` | Add your own review note | Hunk |
| `s` | Hide or show the file sidebar, which makes room for the **Tour** pane in a narrow terminal | Hunk |
| `q` | Quit | Hunk |

Clicking a stop in the **Tour** pane jumps to it. Clicking a link row follows the link.

## Repository layout

- `SKILL.md` is the agent skill, the audit and tour workflow the agent follows.
- `references/` holds the audit lenses the skill applies.
- `scripts/` holds `prepare.py`, `open-tour.sh`, `install.sh`, and `test-install.sh`.
- `extension/` is the Hunk extension, with the `hunk tour` command, the **Tour** pane, and the key bindings.
- `cursor-extension/` is the Cursor/VS Code extension, with a native Tour Plan, inline comments, code lenses, and Git snapshots.
- `core/` is the renderer-independent TypeScript library for validating and stepping through tours.
- `examples/demo/` builds a throwaway repository and opens a sample tour.
- `docs/` holds the guides linked below.

## Documentation

- [Install guided-review](docs/install.md) covers each agent, manual installs, use without an agent, upgrades, removal, and troubleshooting.
- [Tour file format](docs/tour-format.md) lists every field of a tour file and every rule `hunk tour check` enforces.
- [How guided-review works](docs/how-it-works.md) explains the pipeline, the design choices, and the known limits.
- [Changelog](CHANGELOG.md).
- [`core/README.md`](core/README.md) describes the library's modules.

## Development

Development needs [Bun](https://bun.sh). Work from a clone, and install the skill from it with `scripts/install.sh`, which symlinks the clone into each agent's skill directory so your edits take effect at once. Remove an `npx skills` install first, so the agent loads only one copy.

```bash
bun install                # install type packages and test dependencies
bun run check              # type-check both renderers and run their tests
bun run demo               # open the demo tour
scripts/test-install.sh    # test install.sh against a throwaway HOME
```

## License

MIT. See [LICENSE](LICENSE).
