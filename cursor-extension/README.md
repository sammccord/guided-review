# Guided Review for Cursor

A native Cursor/VS Code renderer for the same version-1 tour JSON used by Hunk. No terminal, embedded browser, or separate tour format.

- **Tour Plan:** a native tree of tracks and stops, summaries, verdict, stack layers, checked/unchecked scope, and skipped files.
- **In code:** native inline comment threads with each stop's evidence, question, and clickable cross-stop links. Code lenses jump to stops and mark them reviewed. The current anchor is highlighted.
- **Navigation:** previous/next stop and track, follow link/back, restart, and a status-bar progress indicator.
- **Safe snapshots:** stops open read-only Git revisions, so local edits cannot shift the anchors. Old-side stops use the merge base (not the base branch tip); renames resolve to their original paths. “Show Stop Diff” opens Cursor's native diff. Your checkout is never changed.
- **Local progress:** reviewed stops survive reopening the exact same tour in the same workspace. Closing or restarting a tour does not erase reviewed marks. Nothing is posted to GitHub.

## Build and install

From the repository root:

```sh
bun install
bun run check
bun run package:cursor
cursor --install-extension cursor-extension/guided-review-cursor-0.1.0.vsix
```

Requires Node.js 20 or newer, Git, Cursor (VS Code API 1.96 or newer), and a trusted local workspace. Bun is only needed for development. You can also install the VSIX with **Extensions: Install from VSIX…**.

For development, open this repository in Cursor and launch **Guided Review in Cursor** with F5 after installing dependencies. In the Extension Development Host, open the repository being reviewed, then run **Guided Review: Open Tour…** and select its JSON file. In a multi-root workspace, choose which repository the tour reviews.

## Put the plan on the right

Run **Guided Review: Move Plan to Right Sidebar…**, then choose **New Secondary Side Bar entry** in Cursor's native picker (the exact label may vary by Cursor version). You can also drag the Guided Review view into the right sidebar or use the view header's **Move View** menu.

Cursor remembers this placement. Stable extension APIs do not allow a custom view to declare the Secondary Side Bar as its default location; this one-time action avoids changing the position of your Explorer, chat, or other views. Until moved, Guided Review appears in its own activity-bar container.

## Open an agent-generated tour

```sh
scripts/open-tour.sh --cursor /path/to/review-worktree /path/to/tour.json
examples/demo/run.sh --cursor
```

The launcher validates the tour with the shared core, then opens a small temporary `.code-workspace` file containing the review folder and the `guidedReview.tourFile` setting. The installed extension reads the setting when that trusted workspace starts. No files are written into the reviewed repository. The temporary workspace may be deleted after closing the window; its path is printed on launch.

`--print` validates and prints a runnable launch command without opening Cursor. For a persistent demo fixture, use `examples/demo/run.sh --cursor --print --keep`.

Automation can also open `cursor://guided-review.guided-review-cursor/open?repo=<encoded-absolute-repo>&tour=<encoded-absolute-json>` in a window already containing that repository. The handler refuses repositories outside the current window.

## Controls

| Control | Action |
| --- | --- |
| Click a plan stop or its code lens | Open the anchored Git snapshot |
| Ctrl+Alt+Right / Ctrl+Alt+Left | Next / previous stop (in tour snapshots, outside text inputs) |
| Plan header arrows | Previous / next stop |
| Mark reviewed / ✓ Reviewed code lens | Toggle local reviewed state |
| Stop's check action in the plan | Toggle reviewed state |
| Click a linked stop | Follow it and save a return point |
| Guided Review: Back After Link | Return to that point |
| Guided Review: Next Track / Previous Track | Navigate tracks |
| Guided Review: Show Stop Diff | Compare merge-base/head in a native diff |
| Guided Review: Close Tour | Remove comments, lenses, highlights and active state |

Snapshots are intentionally read-only. Edit the actual workspace file when fixing code; regenerate the tour to review a new revision. Comment threads are tour annotations, not editable GitHub review comments. In a native diff, the old-side thread appears on the original/left side; normal stop navigation opens that exact revision directly.

## Validation without Hunk

```sh
node cursor-extension/dist/check.js /path/to/review-worktree /path/to/tour.json
```

This checks the same schema, cross-stop links, Git diff anchors and warnings as Hunk's checker. Invalid tours never replace the currently open tour. A zero-stop tour still displays its verdict and scope.

## Native smoke test

Run `bun run test:cursor:smoke` to launch an isolated Cursor Extension Development Host against a throwaway demo. The test checks activation, code lenses, exact stop selection, navigation, link/back history, reviewed progress, cleanup, and native diffs. It does not install the extension into your normal Cursor profile. On macOS it uses `/Applications/Cursor.app`; elsewhere set `CURSOR_EXECUTABLE` to Cursor's Electron executable. The fixture and profile/log paths are printed for diagnosis.
