# @guided-review/core

Renderer-agnostic logic for guided review tours. An agent writes a tour JSON file; this library validates it against the reviewed diff and steps a reader through its stops. It has no UI dependencies, so a hunk extension, a web page, or an editor plugin can share it.

## Modules

`core/src` holds these modules. `index.ts` re-exports every module except `git.ts`.

| Module | Exports |
| --- | --- |
| `schema.ts` | `Tour`, `Track`, `Stop`, `TourStop`, `SkippedFile`, `StackLayer`, `TourStack`, `StopKind`, `Verdict`, `StackLayerState`, `ParseResult`, `STOP_KINDS`, `VERDICTS`, `STACK_LAYER_STATES`, `TOUR_VERSION`, `parseTour`. `parseTour` also rejects bad or duplicate stop ids and unresolved `[[id]]` references. |
| `stops.ts` | `tourStops`, which flattens tracks into numbered stops, plus `checkStopSize`, `checkBullets`, and `MAX_STOP_LINES` |
| `anchors.ts` | `parseDiffRanges`, which parses `git diff` output with no I/O, plus `checkAnchors`, `HunkRange`, and `DiffRanges` |
| `links.ts` | `indexStops` (`byId`, `linksFrom`, `linksTo`), `segmentText`, `formatLink`, `referencedIds`, `STOP_ID_PATTERN`, `TextSegment`, `StopIndex` |
| `stack.ts` | `stackPosition`, which gives the current layer's 1-based position, the layer count, and the layers below and above it, plus `StackPosition` |
| `validate.ts` | `validateTour`, which parses, loads the diff ranges, and checks anchors, then returns `checkStopSize` and `checkBullets` warnings, plus `ValidateResult` |
| `navigator.ts` | `initialCursor` and `move`, a pure reducer over `next`, `prev`, `nextTrack`, `prevTrack`, `goto`, `restart`, `follow`, and `back`, plus `TourCursor`, `TourMove`, and `MoveResult` |
| `git.ts` | `readDiffRanges`, which runs `git diff base...head`. It needs Node, so `@guided-review/core/git` exports it and the index does not. |
| `index.ts` | Everything above except `git.ts` |

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

Stops reference each other with `[[id]]` in `body`, `ask`, track `summary`, and the tour `summary`. `follow` records where the reader came from and `back` returns there; `restart` forgets that history.

A browser renderer that already has the diff text can call `parseDiffRanges(patch)` instead of `readDiffRanges`.

The renderer owns everything else: how a stop is revealed, how messages are shown, and any host-specific export such as hunk's agent-context sidecar (`extension/sidecar.ts`).

## Tests

`bun test core` from the repository root.
