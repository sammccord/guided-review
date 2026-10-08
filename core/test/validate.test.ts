import { describe, expect, test } from "bun:test";
import { MAX_STOP_LINES, tourStops, validateTour, type DiffRanges } from "../src/index";
import { stop, tour, track } from "./fixtures";

describe("validateTour", () => {
  const ranges: DiffRanges = new Map([["src/a.ts", [{ side: "new", start: 1, end: 60 }]]]);

  test("parse errors short-circuit before anchors are checked", () => {
    expect(validateTour({ ...tour({ stops: [stop({ path: "nope.ts" })] }), title: "" }, ranges)).toEqual({
      ok: false,
      errors: ["title must be a non-empty string"],
    });
  });

  test("anchor problems are errors", () => {
    expect(validateTour(tour({ stops: [stop({ path: "nope.ts" })] }), ranges)).toEqual({
      ok: false,
      errors: ['stop 1 "Retry loop": path nope.ts is not in the diff'],
    });
  });

  test("oversized stops are warnings on a valid tour", () => {
    const sample = tour({ tracks: [track([stop(), stop({ line: 10, endLine: 10 + MAX_STOP_LINES, title: "Huge" })])] });
    expect(validateTour(sample, ranges)).toEqual({
      ok: true,
      tour: sample,
      stops: tourStops(sample),
      warnings: [`stop 2 "Huge": spans ${MAX_STOP_LINES + 1} lines; split it into smaller stops (max ${MAX_STOP_LINES})`],
    });
  });
});
