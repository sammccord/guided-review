import { describe, expect, test } from "bun:test";
import { MAX_STOP_LINES, tourStops, validateTour, type DiffRanges } from "../src/index";
import { stop, tour, track } from "./fixtures";

describe("validateTour", () => {
  const ranges: DiffRanges = new Map([["src/a.ts", [{ side: "new", start: 1, end: 60 }]]]);
  const load = async () => ranges;

  test("parse errors short-circuit before ranges load", async () => {
    let loaded = false;
    const result = await validateTour({ ...tour({ stops: [stop({ path: "nope.ts" })] }), title: "" }, async () => {
      loaded = true;
      return ranges;
    });
    expect(result).toEqual({ ok: false, errors: ["title must be a non-empty string"] });
    expect(loaded).toBe(false);
  });

  test("loads ranges for the tour's base and head", async () => {
    const seen: string[][] = [];
    await validateTour(tour(), async (base, head) => {
      seen.push([base, head]);
      return ranges;
    });
    expect(seen).toEqual([["aaa", "bbb"]]);
  });

  test("a loader failure becomes an error message", async () => {
    expect(await validateTour(tour(), () => Promise.reject(new Error("git diff failed")))).toEqual({
      ok: false,
      errors: ["git diff failed"],
    });
  });

  test("anchor problems are errors", async () => {
    expect(await validateTour(tour({ stops: [stop({ path: "nope.ts" })] }), load)).toEqual({
      ok: false,
      errors: ['stop 1 "Retry loop": path nope.ts is not in the diff'],
    });
  });

  test("oversized stops are warnings on a valid tour", async () => {
    const sample = tour({ tracks: [track([stop(), stop({ line: 10, endLine: 10 + MAX_STOP_LINES, title: "Huge" })])] });
    const result = await validateTour(sample, load);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tour).toEqual(sample);
    expect(result.stops).toEqual(tourStops(sample));
    expect(result.warnings).toEqual([
      `stop 2 "Huge": spans ${MAX_STOP_LINES + 1} lines; split it into smaller stops (max ${MAX_STOP_LINES})`,
    ]);
  });

  test("a valid tour carries its stop index", async () => {
    const sample = tour({ stops: [stop({ id: "a" }), stop({ id: "b", body: "See [[a]]." })] });
    const result = await validateTour(sample, load);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.index.byId.get("a")).toBe(result.stops[0]!);
    expect(result.index.linksTo(0)).toEqual([result.stops[1]!]);
  });
});
