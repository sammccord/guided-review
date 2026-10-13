# Install guided-review

This guide installs the `guided-review` skill for your coding agent, sets up the Hunk extension on its own, and fixes common problems. It assumes `git`, `python3`, `gh`, and `hunk` 0.22.0 or newer are on your `PATH`.

## Install the skill with `scripts/install.sh`

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

- To copy the repository instead of linking it, add `--copy`. The copy leaves out `.git`, `node_modules`, and `__pycache__`. Use a copy when the agent cannot follow symlinks or when you want the install frozen at one version.

	```bash
	scripts/install.sh --copy --agent codex
	```

- To see all flags, run `scripts/install.sh --help`.

The script never overwrites a path it did not create. If the install path holds an unrelated directory, or a symlink to something other than a `guided-review` skill, the row says `refused` and the script exits with status 1. A symlink to another checkout of `guided-review` is replaced with a link to this one.

### Keep the folder name `guided-review`

Agent hosts find a skill by its directory name and expect that name to match the `name: guided-review` line in `SKILL.md`. `scripts/install.sh` always names the install `guided-review`, whatever the clone is called. Hunk names an extension installed with `hunk extension install` after its folder, so the clone's folder name matters there too.

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

Run these commands from the repository the tour reviews, because `tour check` and `tour open` run `git diff <base>...<head>` in the current directory.

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

To load the extension in every Hunk session without `--extension`, install it into Hunk:

```bash
hunk extension install /path/to/guided-review
```

The source can also be `sammccord/guided-review` or a git URL. Hunk clones the source into `~/.config/hunk/extensions/installed/<name>`, where `<name>` is the source folder's name, so a local clone named `guided-review` installs as `guided-review`. Hunk clones committed history, so uncommitted changes in a local clone are not installed. After that, `hunk tour check tour.json` and `hunk tour open tour.json` work without `--extension`.

The skill always passes `--extension <skill directory>`, so an agent install does not need `hunk extension install`.

## Upgrade

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

1. Remove the skill from every agent directory the script knows:

	```bash
	scripts/install.sh --uninstall
	```

	Add `--agent <name>` to remove one agent's install. Add `--dry-run` to preview. The script removes only symlinks and copies of `guided-review`, and leaves the clone in place.

2. If you installed the Hunk extension, remove it:

	```bash
	hunk extension remove guided-review
	```

3. Remove review worktrees the agent left behind. Each review's report gives the command, for example:

	```bash
	git worktree remove .git/guided-review/pr-123 && git branch -D review/pr-123
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

Hunk needs a real terminal. When an agent runs `scripts/open-tour.sh`, the script opens a herdr tab, a tmux window, an iTerm2 window, or a Terminal.app window, in that order of preference. If none is available, it prints `No terminal launcher found; run the command below yourself.` Copy the `Tour command:` line it prints and run it in a terminal.

### The **Tour** pane is missing

Hunk hides the pane when the terminal is too narrow for the sidebar, the diff, and the pane. Widen the terminal, or press `s` to hide the file sidebar. In testing, the demo showed the pane at 160 columns, and at 140 columns only with the sidebar hidden.

### `tour check` prints errors or warnings

Errors stop `tour check` with status 1, and `tour open` refuses to open the tour. Warnings start with `warning:` and never block. The usual errors are an anchor outside every hunk, an anchor that runs past the end of its hunk, a path that is not in the diff, and an unknown `[[id]]` link. The usual warnings are a stop longer than 20 lines and prose that is not `- ` bullet lines. [Tour file format](tour-format.md) lists every rule.

Run `tour check` from the repository the tour reviews. In another directory, `tour check` prints `git diff <base>...<head> failed in <directory>` followed by git's own message.
