# Install guided-review

This guide installs the `guided-review` skill for your coding agent, sets up the Hunk extension on its own, and fixes common problems. It assumes `git`, `python3`, `gh`, and `hunk` 0.22.0 or newer are on your `PATH`.

## Install the skill with `npx skills`

The [skills CLI](https://github.com/vercel-labs/skills) installs the skill from GitHub without a clone. It needs Node.js.

1. Install:

	```bash
	npx skills add sammccord/guided-review -g
	```

	Keep `-g`. Without it, the CLI installs into the current project instead of your user directories.

2. Pick the agents when prompted. To skip the prompt, name the agents and add `-y`:

	```bash
	npx skills add sammccord/guided-review -g -a claude-code -a opencode -y
	```

The CLI copies the repository, without `.git`, to `~/.agents/skills/guided-review`. Agents that read `~/.agents/skills`, such as opencode and Codex, use that copy. Agents that do not, such as Claude Code, get a symlink to it. The folder is named `guided-review`, which the agents and Hunk both need. The CLI records the source and commit in `~/.agents/.skill-lock.json`.

The CLI sends install telemetry. To opt out, set `DISABLE_TELEMETRY=1` or `DO_NOT_TRACK=1` before the command.

To check the install, list the global skills:

```bash
npx skills ls -g
```

## Install from a clone with `scripts/install.sh`

Use a clone when you change the skill, or when Node.js is not available. The script symlinks the clone, so edits take effect at once. If you installed with `npx skills` before, remove that install first, so the agent loads only one copy.

1. Clone the repository. The folder name must be `guided-review`:

	```bash
	git clone https://github.com/sammccord/guided-review.git
	cd guided-review
	```

2. Preview the changes:

	```bash
	scripts/install.sh --dry-run
	```

3. Install:

	```bash
	scripts/install.sh
	```

With no `--agent` flag, the script installs for every agent whose config directory exists. It prints the versions of `git`, `python3`, `hunk`, and `gh` first. A missing `git` stops the script. A missing `python3`, `gh`, or `hunk`, or a `hunk` older than 0.22.0, prints a warning and the install continues. If no agent config directory exists, the script lists the `--agent` choices and exits with status 1.

The script symlinks the repository into each agent's user-level skill directory:

| `--agent` | Config directory that must exist for the default run | Install path |
| --- | --- | --- |
| `opencode` | `${XDG_CONFIG_HOME:-~/.config}/opencode` | `${XDG_CONFIG_HOME:-~/.config}/opencode/skills/guided-review` |
| `claude` | `~/.claude` | `~/.claude/skills/guided-review` |
| `codex` | `${CODEX_HOME:-~/.codex}` | `${CODEX_HOME:-~/.codex}/skills/guided-review` |
| `agents` | `~/.agents` | `~/.agents/skills/guided-review` |

### Choose agents and the install mode

- To install for specific agents, repeat `--agent`. An agent named this way is installed even when its config directory does not exist yet:

	```bash
	scripts/install.sh --agent claude --agent codex
	```

- If the agent cannot follow symlinks, or you want the install to stay at one version, add `--copy`. The script then copies the repository instead of linking it, and leaves out `.git`, `node_modules`, and `__pycache__`.

	```bash
	scripts/install.sh --copy --agent codex
	```

- To see all flags, run `scripts/install.sh --help`.

The script never overwrites a path it did not create. If the install path holds an unrelated directory, or a symlink to something other than a `guided-review` skill, the row says `refused` and the script exits with status 1. A symlink to another checkout of `guided-review` is replaced with a link to this one.

### Keep the folder name `guided-review`

Agent hosts find a skill by its directory name and expect that name to match the `name: guided-review` line in [`SKILL.md`](../SKILL.md). `scripts/install.sh` always names the install `guided-review`, whatever the clone is called. Hunk names an extension installed with `hunk extension install` after its folder, so the clone's folder name matters there too.

## Install the skill by hand

To install without the script, link or copy the repository into the agent's skill directory under the name `guided-review`. For Claude Code:

```bash
mkdir -p ~/.claude/skills
ln -s "$PWD" ~/.claude/skills/guided-review
```

To copy instead:

```bash
mkdir -p ~/.claude/skills
rsync -a --exclude .git --exclude node_modules --exclude __pycache__ ./ ~/.claude/skills/guided-review/
```

Use the install paths in the table above for other agents.

## Use the Hunk extension without an agent

The extension adds the `hunk tour` command, the **Tour** pane, and the tour keys. You can open any tour file with it, for example one an agent wrote earlier or one you wrote by hand.

Because `tour check` and `tour open` run `git diff <base>...<head>` in the current directory, run these commands from the repository the tour reviews.

- To check a tour without opening it:

	```bash
	hunk --extension /path/to/guided-review tour check tour.json
	```

- To open a tour:

	```bash
	hunk --extension /path/to/guided-review tour open tour.json
	```

- To open a tour in a new terminal tab or window, check it first, and print the command it ran:

	```bash
	/path/to/guided-review/scripts/open-tour.sh /path/to/repo tour.json
	```

	Add `--print` to check the tour and print the command without opening a terminal.

Reopening an unchanged tour resumes its decisions and questions. To start over, add `--fresh` to `tour open` or `open-tour.sh`.

Before `hunk tour wait` writes a heartbeat for this review, the **Tour** pane reads `<n> waiting · no agent yet`. Requests from notes, `Q`, `V`, and **Post to PR** wait in the mailbox. You can answer them yourself with `hunk tour answer` while Hunk is open. The [command reference](cli.md) lists every subcommand.

To load the extension in every Hunk session without `--extension`, install it into Hunk:

```bash
hunk extension install sammccord/guided-review
```

The source can also be a git URL or a local clone (`hunk extension install /path/to/guided-review`). Hunk clones the source into `~/.config/hunk/extensions/installed/<name>`, where `<name>` is the source folder's name, so a local clone named `guided-review` installs as `guided-review`. Hunk clones committed history, so uncommitted changes in a local clone are not installed. After that, `hunk tour check tour.json` and `hunk tour open tour.json` work without `--extension`.

The skill always passes `--extension <skill directory>`, so an agent install does not need `hunk extension install`.

## Upgrade

- For an `npx skills` install, run:

	```bash
	npx skills update -g
	```

- For a symlinked install, pull the clone:

	```bash
	git -C /path/to/guided-review pull
	```

- For a copied install, pull the clone, then copy again:

	```bash
	git -C /path/to/guided-review pull
	/path/to/guided-review/scripts/install.sh --copy --agent codex
	```

	A rerun with `--copy` over an earlier copy reports `updated (copy)`.

- For an extension installed with `hunk extension install`, run:

	```bash
	hunk extension update guided-review
	```

## Uninstall

1. Remove the skill. For an `npx skills` install, run:

	```bash
	npx skills remove guided-review -g
	```

	For a clone install, remove it from every agent directory the script knows:

	```bash
	scripts/install.sh --uninstall
	```

	Add `--agent <name>` to remove one agent's install. Add `--dry-run` to preview. The script removes only symlinks and copies of `guided-review`, and leaves the clone in place.

2. If you installed the Hunk extension, remove it:

	```bash
	hunk extension remove guided-review
	```

3. Remove review worktrees the agent left behind. Each review's report gives the command, which removes the worktree, its `review/<slug>` branch, and the fetched PR ref. For example:

	```bash
	git -C ~/src/api worktree remove --force ~/src/api/.git/guided-review/pr-123 && git -C ~/src/api branch -D review/pr-123 && git -C ~/src/api update-ref -d refs/guided-review/pr-123
	```

## Troubleshoot

### `gh pr view failed; check gh auth status for this host`

`scripts/prepare.py` reads pull requests through `gh`, and `gh` keeps one login per host. For a GitHub Enterprise pull request, check the login for that host:

```bash
gh auth status --hostname github.example.com
```

If it reports no login, run `gh auth login --hostname github.example.com`.

### `prepare: gh CLI is required for pull requests`

Install `gh`. Without it, `prepare.py` can review a branch but not a PR URL or PR number.

### `stackLookup` says `unavailable`

`prepare.py` asks the host's stacks API, `repos/<owner>/<repo>/stacks?pull_request=<n>`, whether the PR is a layer of a stack. If that call fails, `stackLookup` is `unavailable: <reason>` and the agent reviews the PR as a single change with no stack. Check `gh auth status --hostname <host>`. A host that does not offer the stacks API always reports `unavailable`.

### Hunk does not open

Hunk needs a real terminal. When an agent runs `scripts/open-tour.sh`, the script opens a new terminal tab or window for Hunk. Inside a Neovim terminal it opens a Neovim tab. Inside [herdr](https://herdr.dev), tmux, or zellij it opens a tab or window there, with a pane fallback for older zellij versions. Inside kitty, WezTerm, Ghostty, Alacritty, Konsole, GNOME Terminal, or foot it opens a tab or window in that terminal. Otherwise it uses iTerm2 when running there or Terminal.app on macOS, and x-terminal-emulator on Linux with a graphical display. If none of those applies, it prints `No terminal launcher found; run the command below yourself.` Copy the `Tour command:` line it prints and run it in a terminal.

kitty needs `allow_remote_control` enabled for the script to open a tab. If remote control is disabled, the script tries the next launcher.

### The **Tour** pane is missing

Hunk drops the pane when the terminal is too narrow for the sidebar, the diff, and the pane. In testing, the demo showed all three at 120 columns and wider. In a narrower terminal, press `s` to hide the file sidebar, or widen the terminal.

### `tour check` prints errors or warnings

Errors stop `tour check` with status 1, and `tour open` refuses to open the tour. Warnings start with `warning:` and never block. The usual errors are an anchor outside every hunk, an anchor that runs past the end of its hunk, a path that is not in the diff, and an unknown `[[id]]` link. The usual warnings are a stop longer than 20 lines and prose that is not `- ` bullet lines. [Tour file format](tour-format.md) lists every rule.

If you run `tour check` in a directory where `base` and `head` do not resolve, it prints `git diff <base>...<head> failed in <directory>: ` followed by git's own message. Run `tour check` from the repository the tour reviews.

### `tour changed or has no saved identity; reopen the tour before answering or approving`

`tour wait`, `tour answer`, and `tour approve` compare the tour file with the one Hunk opened. Editing the tour, or moving a ref that `base` or `head` names, breaks the match. Reopen the tour with `tour open` or `open-tour.sh`. That starts a new review.

### `the Hunk session for this tour (pid <pid>) is not running; reopen the tour`

`tour answer` posts into the running Hunk session that opened the tour. Reopen the tour, then answer again. A request that was already answered reports `already-answered` and is not posted twice.

### `tour has no PR url`

**Post to PR** and approval need the tour's `url` field set to a PR URL such as `https://<host>/<owner>/<repo>/pull/<number>`. Add it, reopen the tour, and try again. `gh` must be logged in to that host. Check with `gh auth status --hostname <host>`.

### `review has not ended; finish or close Hunk first`

`tour approve` runs only after the review ends. Press `F` in Hunk to finish the review, or quit Hunk.

### `PR head moved from <head> to <sha>; re-run the review`

The PR got new commits after the tour was written. An approval would cover code nobody reviewed. Run the review again on the new head.
