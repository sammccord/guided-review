import { describe, expect, test } from "bun:test";
import { checkAnchors, type DiffRanges } from "../src/index";
import { stop, tour, track } from "./fixtures";

describe("checkAnchors", () => {
  const ranges: DiffRanges = new Map([
    [
      "src/a.ts",
      [
        { side: "old", start: 5, end: 12 },
        { side: "new", start: 5, end: 14 },
        { side: "new", start: 30, end: 40 },
      ],
    ],
    ["lib/util/helpers.ts", [{ side: "new", start: 1, end: 3 }]],
  ]);

  test("passes anchors inside one hunk", () => {
    expect(checkAnchors(tour({ stops: [stop(), stop({ line: 30, endLine: 40 }), stop({ side: "old", line: 12 })] }), ranges)).toEqual([]);
  });

  test("reports a missing path and suggests the closest basename", () => {
    const messages = checkAnchors(tour({ stops: [stop(), stop({ path: "src/util/helpers.ts", title: "Helper" })] }), ranges);
    expect(messages).toEqual(['stop 2 "Helper": path src/util/helpers.ts is not in the diff (did you mean lib/util/helpers.ts?)']);
    expect(checkAnchors(tour({ stops: [stop({ path: "nope.ts" })] }), ranges)[0]).toEndWith("is not in the diff");
  });

  test("numbers problems globally across tracks", () => {
    const sample = tour({ tracks: [track([stop(), stop()]), track([stop({ line: 20, title: "Later" })])] });
    expect(checkAnchors(sample, ranges)).toEqual(['stop 3 "Later": line 20 (new) is outside every hunk (hunks: 5-14, 30-40)']);
  });

  test("reports a line outside every hunk", () => {
    expect(checkAnchors(tour({ stops: [stop({ line: 20 })] }), ranges)).toEqual([
      'stop 1 "Retry loop": line 20 (new) is outside every hunk (hunks: 5-14, 30-40)',
    ]);
    expect(checkAnchors(tour({ stops: [stop({ side: "old", line: 13 })] }), ranges)).toEqual([
      'stop 1 "Retry loop": line 13 (old) is outside every hunk (hunks: 5-12)',
    ]);
  });

  test("rejects a range spanning two hunks", () => {
    expect(checkAnchors(tour({ stops: [stop({ line: 10, endLine: 35 })] }), ranges)).toEqual([
      'stop 1 "Retry loop": lines 10-35 (new) runs past hunk 5-14; an anchor must stay inside one hunk (hunks: 5-14, 30-40)',
    ]);
  });
});
