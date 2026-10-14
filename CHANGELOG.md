# Changelog

This file lists all notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- After the review draft, the agent can ask for explicit approval of an eligible PR at its reviewed head. `tour approve` enforces structural blockers, checks the PR head, and records approval for safe retries.
- Current stops show decide, ask, and finish keys and a **Decide** button. `F` finishes the review, with confirmation for undecided stops.
- **Post to PR** on the current tour stop. The agent rewords the chosen stop for the author, posts a PR line comment through `gh api`, and confirms in Hunk with the link. Requires the tour's PR `url`.
- Reviewer to agent Q&A inside Hunk. `V` records a decision on the current stop: agree, disagree, or unsure, with an optional comment. `Q` asks a question about the current line. Every note added with `c` goes to the agent too, and the agent replies under it. Each decided stop shows a badge in the **Tour** pane, which also shows how many questions wait and whether the agent is listening. **Finish review** in the **Extensions** menu ends the review.
- `hunk tour wait` and `hunk tour answer`, the agent's side of the Q&A. `wait` blocks until a request arrives, the timeout passes, or the review ends, and prints one JSON line. `answer` posts the reply as a threaded Hunk note and records it. Requests and answers are files in a `.tour.qa` directory beside the tour, with one writer per path.
- `SKILL.md` step 9, "Answer the reviewer", and a review draft from the decisions in the report.
- `core/src/qa.ts` and `core/src/mailbox.ts`, the Q&A model, its projections, and the mailbox files.
- Tour launch support for Neovim terminals, zellij, kitty, WezTerm, Ghostty, Alacritty, Konsole, GNOME Terminal, foot, and Linux's x-terminal-emulator.

### Changed

- The `cleanup` command from `prepare.py` also removes the review's `.tour.qa` directory.
- The README and install guide lead with `npx skills add sammccord/guided-review -g`, which installs the skill without a clone. The clone and `scripts/install.sh` route remains for contributors.

## 0.1.0 - 2026-10-13

### Added

- `SKILL.md`, the `guided-review` agent skill. It audits a PR, a stacked PR, or a branch, then writes a tour of the places that need human judgment, with a stop budget of `quick`, `standard`, `deep`, or a stop count.
- `references/lenses.md`, the audit lenses for correctness, preserved behavior, contracts, security, concurrency, and verification.
- Tour format version 1, with tracks of stops, five stop kinds (`blocker`, `risk`, `question`, `inspect`, `context`), a verdict, checked and unchecked scope, and skipped files.
- Stop ids and `[[id]]` links between stops, validated for unknown, duplicate, and self references.
- A `stack` field in tours that lists the stack's layers and names the one under review, so each stack layer gets its own tour.
- The Hunk extension, with `hunk tour check` and `hunk tour open`, a **Tour** pane, and inline tour notes through Hunk's agent-context sidecar.
- Tour keys in Hunk: `>` and `<` for stops, `)` and `(` for tracks, `L` to follow a link, `B` to go back, and **Restart tour** in the **Extensions** menu.
- Anchor validation against `git diff <base>...<head>`, which requires each stop to stay inside one hunk.
- `tour check` warnings for stops longer than 20 lines and for prose that is not `- ` bullet lines.
- `core/`, a TypeScript library with no UI dependencies that holds tour parsing, validation, links, and a navigation reducer for other renderers.
- `scripts/prepare.py`, which creates one review worktree per PR or stack layer, detects GitHub stacks through `gh`, and flags layers that need a rebase with `needsRebase`.
- `scripts/open-tour.sh`, which checks a tour and opens it in a new terminal tab or window, or prints the command. It supports [herdr](https://herdr.dev), a terminal workspace manager, as well as tmux, iTerm2, and Terminal.app.
- `scripts/install.sh`, which installs the skill for opencode, Claude Code, Codex, and `~/.agents` by symlink or copy, with `--dry-run` and `--uninstall`.
- `examples/demo/`, a self-contained demo tour on a throwaway repository.
- A root `package.json` with a `hunk` manifest, so `hunk --extension <repo>` and `hunk extension install` load the extension.
