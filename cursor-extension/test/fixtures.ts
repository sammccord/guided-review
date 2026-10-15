import { indexStops, tourStops } from "../../core/src/index";
import { stop, tour, track } from "../../core/test/fixtures";
import type { LoadedTour } from "../src/repository";

export function loadedTour(): LoadedTour {
  const value = tour({ tracks: [
    track([
      stop({ id: "first", title: "First", body: "- Depends on [[third]].", ask: "Is [[third]] safe?" }),
      stop({ id: "second", title: "Second", line: 12 }),
    ]),
    track([stop({ id: "third", title: "Third", path: "src/b.ts", side: "old", line: 3 })], { title: "Other track" }),
  ] });
  const stops = tourStops(value);
  return {
    file: "/repo/tour.json", root: "/repo", tour: value, stops, index: indexStops(stops), warnings: [],
    mergeBase: "aaa", head: "bbb",
    changes: new Map([["src/a.ts", { oldPath: "src/a.ts", newPath: "src/a.ts" }], ["src/b.ts", { oldPath: "src/b.ts" }]]),
  };
}
