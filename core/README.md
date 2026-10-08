# @guided-review/core

Renderer-agnostic logic for guided review tours. An agent writes a tour JSON file; this library validates it against the reviewed diff and steps a reader through its stops. It has no UI dependencies, so a hunk extension, a web page, or an editor plugin can share it.

## Modules

| Module | Exports |
| --- | --- |
| `schema.ts` | `Tour`, `Track`, `Stop`, `SkippedFile`, `TourStop`, `STOP_KINDS`, `VERDICTS`, `TOUR_VERSION`, `parseTour` (also rejects bad or duplicate stop ids and unresolved `[[id]]` references) |
| `stops.ts` | `tourStops` (flattens tracks into numbered stops), `checkStopSize`, `MAX_STOP_LINES` |
| `anchors.ts` | `parseDiffRanges` (pure `git diff` parsing), `checkAnchors`, `HunkRange`, `DiffRanges` |
| `links.ts` | `indexStops` (`byId`, `linksFrom`, `linksTo`), `segmentText`, `formatLink`, `TextSegment`, `StopIndex` |
| `validate.ts` | `validateTour`: parse, load diff ranges, then anchor errors, then stop-size warnings |
| `navigator.ts` | `initialCursor`, `move`: a pure reducer over `next`, `prev`, `nextTrack`, `prevTrack`, `goto`, `restart`, `follow`, `back` |
| `git.ts` | `readDiffRanges`: runs `git diff base...head`. Node only, so it is exported as `@guided-review/core/git`, not from the index. |

## Using it from a renderer

```ts
import { formatLink, initialCursor, move, segmentText, validateTour, type TourMove } from "@guided-review/core";
import { readDiffRanges } from "@guided-review/core/git";

const raw = JSON.parse(await readFile(tourPath, "utf8"));
const result = await validateTour(raw, (base, head) => readDiffRanges(cwd, base, head));
if (!result.ok) return fail(result.errors);
result.warnings.forEach(warn);
const { tour, stops, index } = result;

let cursor = initialCursor();
function step(tourMove: TourMove) {
  const next = move(stops, tour.tracks.length, cursor, tourMove);
  if (!next.ok) return notify(next.reason);
  cursor = next.cursor;
  const { stop } = stops[cursor.current]!;
  show(
    segmentText(stop.body, index).map((segment) =>
      segment.kind === "text" ? segment.text : link(formatLink(segment.target), () => step({ kind: "follow", index: segment.target.number - 1 })),
    ),
  );
  showLinks(index.linksFrom(cursor.current), index.linksTo(cursor.current));
}
```

Stops reference each other with `[[id]]` in `body`, `ask`, and track `summary`. `follow` records where the reader came from and `back` returns there; `restart` forgets that history.

A browser renderer that already has the diff text can call `parseDiffRanges(patch)` instead of `readDiffRanges`.

The renderer owns everything else: how a stop is revealed, how messages are shown, and any host-specific export such as hunk's agent-context sidecar (`extension/sidecar.ts`).

## Tests

`bun test core` from the repository root.
