# Tour file format

A tour file is one JSON file. The agent writes it to the `tourPath` that `scripts/prepare.py` prints, beside the review worktree. `hunk tour check` validates it and `hunk tour open` presents it.

The TypeScript types in [`core/src/schema.ts`](../core/src/schema.ts) are the source of truth, and `parseTour` in the same file enforces them. This page follows the order of that file. Version 1 is the only version.

## Conventions

- "Non-empty string" means a JSON string with at least one character that is not whitespace.
- "Positive integer" means a JSON number that is a whole number greater than 0.
- `parseTour` ignores fields it does not know, except a top-level `stops` key. Any top-level `stops` key is an error, whatever its value.
- `parseTour` collects every error in one pass. It does not stop at the first.

## `Stop`

One place the reviewer must look. A stop's position in its track's `stops` array is its reading order.

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `id` | string | no | Must match `^[a-z0-9][a-z0-9-]*$`, so lowercase letters, digits, and hyphens, starting with a letter or digit. Unique across the tour. Other stops, track summaries, and the tour summary reference it as `[[id]]`. |
| `path` | string | yes | Non-empty. The path as git reports it, which is the new path, or the old path for a deleted file. A renamed file uses its new path. |
| `side` | `"new"` \| `"old"` | yes | `"new"` for new-file line numbers. `"old"` for deleted code, with old-file line numbers. |
| `line` | number | yes | Positive integer. First line of the anchor. |
| `endLine` | number | no | Positive integer, `>= line`. Last line of the anchor. Without it, the anchor is the single line `line`. |
| `kind` | string | yes | One of `blocker`, `risk`, `question`, `inspect`, `context` (`STOP_KINDS`). |
| `title` | string | yes | Non-empty. |
| `body` | string | yes | Non-empty. What changed and why it matters, as `- ` bullet lines. May contain `[[id]]` links. |
| `ask` | string | yes | Non-empty. The decision the reviewer makes at this stop. May contain `[[id]]` links. |

The stop kinds mean:

- `blocker` is a bug or regression traced to a concrete failing path.
- `risk` is code whose safety rests on a fact the agent could not prove.
- `question` is a design, product, or intent decision.
- `inspect` is a significant change with no defect found that still needs a human look.
- `context` is a definition the reviewer needs before the stops that use it.

## `Track`

Stops that belong together, such as one causal chain, one subsystem, or one concern.

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `title` | string | yes | Non-empty. |
| `summary` | string | yes | Non-empty. How the stops relate, as `- ` bullet lines. May contain `[[id]]` links. |
| `stops` | `Stop[]` | yes | Non-empty array. |

## `TourStop`

`TourStop` is not part of the file. `tourStops` in `core/src/stops.ts` derives it by walking the tracks in order and numbering every stop from 1. Messages from `tour check` name stops by this number, as in `stop 3 "Loop bound is off by one"`.

| Field | Type | Meaning |
| --- | --- | --- |
| `number` | number | 1-based position in the whole tour. |
| `stop` | `Stop` | The stop. |
| `track` | `Track` | The track that holds it. |
| `trackIndex` | number | 0-based index of that track. |

## `SkippedFile`

A Core or Contract file with real changes and no stop.

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `path` | string | yes | Non-empty. Not checked against the diff. |
| `reason` | string | yes | Non-empty. |

## `StackLayer`

One pull request in a stack, as listed in `TourStack.layers`.

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `number` | number | yes | Positive integer. The PR number. Unique within `layers`. |
| `title` | string | yes | Non-empty. |
| `url` | string | no | Non-empty when present. |
| `state` | string | yes | One of `open`, `merged`, `closed` (`STACK_LAYER_STATES`). |

## `TourStack`

The stack that the reviewed pull request belongs to. Each open layer has its own tour, and every tour in the stack carries the same `layers`.

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `number` | number | yes | Positive integer. The stack number. |
| `url` | string | no | Non-empty when present. |
| `current` | number | yes | Positive integer. The PR number of the layer this tour reviews. Must equal the `number` of one entry in `layers`, and that entry's `state` must not be `merged`. |
| `layers` | `StackLayer[]` | yes | Non-empty array, ordered from the layer closest to the trunk to the top of the stack. |

## `Tour`

The top-level object.

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `version` | number | yes | Must be `1` (`TOUR_VERSION`). |
| `title` | string | yes | Non-empty. |
| `url` | string | no | Non-empty when present. |
| `base` | string | yes | Non-empty. A commit SHA or ref that `git` resolves in the directory where `tour check` runs. |
| `head` | string | yes | Non-empty. Same as `base`. The reviewed diff is `git diff <base>...<head>`. |
| `verdict` | string | yes | One of `approve`, `request-changes`, `discuss` (`VERDICTS`). |
| `summary` | string | yes | Non-empty. The intent of the change and the bottom line, as `- ` bullet lines. May contain `[[id]]` links. |
| `scope` | object | yes | An object with `checked` and `unchecked`, both arrays of strings. Either array may be empty. |
| `scope.checked` | `string[]` | yes | What the agent verified. |
| `scope.unchecked` | `string[]` | yes | What the agent did not verify. |
| `tracks` | `Track[]` | yes | Array. May be empty. Track order, then stop order within each track, is the tour order. |
| `skipped` | `SkippedFile[]` | yes | Array. May be empty. |
| `stack` | `TourStack` | no | Present when the reviewed PR is one layer of a stack. |

A top-level `stops` key with any value, `null` included, produces the error `stops is no longer supported; group stops under tracks[]`.

## Links

A link is `[[id]]`, where `id` is a stop's `id`. The text between the brackets cannot contain `[`, `]`, or a newline.

- `parseTour` checks links in the tour `summary` and in every track `summary`, stop `body`, and stop `ask`. A link to an unknown id is an error. When a known id is close in spelling, the message suggests it, as in `references unknown stop [[atempt-loop]] (did you mean [[attempt-loop]]?)`.
- A stop that links to its own `id` is an error.
- The links listed under a stop in the **Tour** pane come from its `body` and `ask` only. Links in the tour `summary` and in a track `summary` render as links but are not listed under any stop.
- A link renders as `#<number> <title>`, for example `#2 Loop bound is off by one`. In Hunk's inline tour notes it renders as `#2 "Loop bound is off by one" (src/retry.ts:31)`.

## `tour check`

```bash
hunk --extension <guided-review> tour check <tour.json>
```

`tour check` runs from the repository the tour reviews. It reads the file, runs `parseTour`, and stops there if parsing fails. For a tour that parses, it runs `git diff --find-renames <base>...<head>` in the current directory and checks every anchor against the hunks. If every anchor passes, it computes the warnings.

| Exit status | Meaning |
| --- | --- |
| `0` | No errors. Prints warnings, if any, to stderr, each prefixed with `warning: `. Then prints `ok: <stops> stops in <tracks> tracks across <files> files, verdict <verdict>` to stdout. A tour with a `stack` adds ` · stack #<number> layer <position>/<layers>`. |
| `1` | The file cannot be read, is not JSON, fails `parseTour`, the `git diff` fails, or an anchor fails. Prints one error per line to stderr. |
| `2` | Usage error. Prints `usage: hunk tour check\|open <tour.json>`. |

`tour open` runs the same checks before it opens Hunk. Errors block it. Warnings do not.

### Errors

Errors from `parseTour` cover every rule in the tables above, plus duplicate stop ids, duplicate layer numbers, unknown or self links, and a `stack.current` that names no layer or a merged layer.

Anchor errors come from `checkAnchors` in `core/src/anchors.ts`. Each hunk of the diff is a line range on the old side and a line range on the new side, read from its `@@ -a,b +c,d @@` header. The range includes the context lines git prints around the change. A stop passes when one range on its `side` contains every line from `line` to `endLine`, where `endLine` defaults to `line`. Otherwise the stop gets one error, prefixed with `stop <n> "<title>": `. In these messages, `<lines>` is `line <line>` for a single line or `lines <line>-<endLine>` for a range, and `<hunks>` lists the file's hunk ranges on that side, as in `3-11, 28-40`.

- `path <path> is not in the diff`, with a ` (did you mean <path>?)` suggestion when another changed file has the same file name.
- `<lines> (<side>): file has no hunks on the <side> side`, for example `side: "old"` on a new file.
- `<lines> (<side>) runs past hunk <start>-<end>; an anchor must stay inside one hunk (hunks: <hunks>)`, when the anchor starts inside a hunk and ends outside it.
- `<lines> (<side>) is outside every hunk (hunks: <hunks>)`.

### Warnings

Warnings come from `checkStopSize` and `checkBullets` in `core/src/stops.ts`. They never change the exit status.

- A stop whose anchor spans more than `MAX_STOP_LINES` lines, which is 20. The span is `endLine - line + 1`, where `endLine` defaults to `line`. Message: `stop <n> "<title>": spans <span> lines; split it into smaller stops (max 20)`.
- A tour `summary`, track `summary`, or stop `body` with a non-blank line that does not start with `- ` after its leading spaces. Message: `<where>: write it as "- " bullet lines`, where `<where>` is `summary`, `track <n> "<title>" summary`, or `stop <n> "<title>" body`. `checkBullets` does not check the `ask` field.

## Example

This tour is a shortened copy of [`examples/demo/tour.template.json`](../examples/demo/tour.template.json). Replace `__BASE__` and `__HEAD__` with the two commit SHAs of the demo repository, which `examples/demo/run.sh --print --keep` builds. `tour check` then prints `ok: 2 stops in 1 tracks across 1 files, verdict request-changes`.

```json
{
	"version": 1,
	"title": "Demo: retry jitter, shouldRetry, injectable clock",
	"base": "__BASE__",
	"head": "__HEAD__",
	"verdict": "request-changes",
	"summary": "- Intent: add jitter and a shouldRetry predicate.\n- Blocker: retry makes one attempt more than maxAttempts.",
	"scope": {
		"checked": ["ran `bun test`: 3 pass, including the 5-call expectation"],
		"unchecked": ["jitter behavior under real load"]
	},
	"tracks": [
		{
			"title": "Retry attempts and backoff",
			"summary": "- RetryOptions renames retries to maxAttempts and changes its meaning.\n- The loop kept the old bound; see [[attempt-loop]].",
			"stops": [
				{
					"id": "retry-options",
					"path": "src/retry.ts",
					"side": "new",
					"line": 3,
					"endLine": 11,
					"kind": "context",
					"title": "maxAttempts now counts the first attempt",
					"body": "- Old field: retries after the first attempt (default 3).\n- New field: total attempts, first included (default 4).",
					"ask": "Is renaming the field enough warning for callers that set retries?"
				},
				{
					"id": "attempt-loop",
					"path": "src/retry.ts",
					"side": "new",
					"line": 31,
					"endLine": 37,
					"kind": "blocker",
					"title": "Loop bound is off by one",
					"body": "- `attempt <= maxAttempts` runs maxAttempts + 1 times.\n- Bound was right for the old meaning; see [[retry-options]].",
					"ask": "Block on this, and is the proposed fix right?"
				}
			]
		}
	],
	"skipped": [
		{
			"path": "src/index.ts",
			"reason": "Adds delay and Clock re-exports; no logic."
		}
	]
}
```

A tour for a stack layer adds a `stack` field. With this field added to the tour above, `tour check` appends ` · stack #4 layer 2/3`:

```json
"stack": {
	"number": 4,
	"current": 102,
	"layers": [
		{ "number": 101, "title": "Extract RetryOptions", "url": "https://github.com/acme/api/pull/101", "state": "merged" },
		{ "number": 102, "title": "Retry jitter and shouldRetry", "url": "https://github.com/acme/api/pull/102", "state": "open" },
		{ "number": 103, "title": "Use shouldRetry in the HTTP client", "state": "open" }
	]
}
```
