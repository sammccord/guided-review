# @guided-review/core

Renderer-agnostic logic for guided review tours. An agent writes a tour JSON file; this library validates it against the reviewed diff and steps a reader through its stops. It has no UI dependencies, so a hunk extension, a web page, or an editor plugin can share it.

## Modules

| Module | Exports |
| --- | --- |
| `schema.ts` | `Tour`, `Track`, `Stop`, `SkippedFile`, `TourStop`, `STOP_KINDS`, `VERDICTS`, `TOUR_VERSION`, `parseTour` |
| `stops.ts` | `tourStops` (flattens tracks into numbered stops), `checkStopSize`, `MAX_STOP_LINES` |
| `anchors.ts` | `parseDiffRanges` (pure `git diff` parsing), `checkAnchors`, `HunkRange`, `DiffRanges` |
| `validate.ts` | `validateTour`: parse, then anchor errors, then stop-size warnings |
| `navigator.ts` | `initialCursor`, `move`: a pure reducer over `next`, `prev`, `nextTrack`, `prevTrack`, `goto`, `restart` |
| `git.ts` | `readDiffRanges`: runs `git diff base...head`. Node only, so it is exported as `@guided-review/core/git`, not from the index. |

## Using it from a renderer

```ts
import { initialCursor, move, parseTour, validateTour, type TourMove } from "@guided-review/core";
import { readDiffRanges } from "@guided-review/core/git";

const raw = JSON.parse(await readFile(tourPath, "utf8"));
const parsed = parseTour(raw);
if (!parsed.ok) return fail(parsed.errors);
const ranges = await readDiffRanges(cwd, parsed.tour.base, parsed.tour.head);
const result = validateTour(raw, ranges);
if (!result.ok) return fail(result.errors);
result.warnings.forEach(warn);

let cursor = initialCursor();
function step(tourMove: TourMove) {
  const next = move(result.stops, result.tour.tracks.length, cursor, tourMove);
  if (!next.ok) return notify(next.reason);
  cursor = next.cursor;
  show(result.stops[cursor.current]!);
}
```

A browser renderer that already has the diff text can call `parseDiffRanges(patch)` instead of `readDiffRanges`.

The renderer owns everything else: how a stop is revealed, how messages are shown, and any host-specific export such as hunk's agent-context sidecar (`extension/sidecar.ts`).

## Tests

`bun test core` from the repository root.
