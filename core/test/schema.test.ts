import { describe, expect, test } from "bun:test";
import { parseTour } from "../src/index";
import { stop, tour, track } from "./fixtures";

describe("parseTour", () => {
  test("accepts a valid tour and ignores unknown keys", () => {
    const input = { ...tour({ url: "https://example.com/pr/1", stops: [stop({ endLine: 12 })] }), extra: true };
    const result = parseTour(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tour).toEqual(tour({ url: "https://example.com/pr/1", stops: [stop({ endLine: 12 })] }));
      expect("extra" in result.tour).toBe(false);
    }
  });

  test("accepts an inspect stop", () => {
    const input = tour({ stops: [stop({ kind: "inspect" })] });
    expect(parseTour(input)).toEqual({ ok: true, tour: input });
  });

  test("collects every error with a location", () => {
    const result = parseTour({
      version: 2,
      title: "",
      base: "aaa",
      verdict: "lgtm",
      summary: "s",
      scope: { checked: ["ok", 3], unchecked: "nope" },
      tracks: [
        track([stop()]),
        { ...track([]), stops: [stop(), { ...stop(), side: "both", line: 0, endLine: 1 }, stop({ line: 5, endLine: 4, kind: "nit" as never })] },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        "version must be 1",
        "title must be a non-empty string",
        "head must be a non-empty string",
        "verdict must be one of approve, request-changes, discuss",
        "scope.checked[1] must be a string",
        "scope.unchecked must be an array of strings",
        "tracks[1].stops[1].side must be one of new, old",
        "tracks[1].stops[1].line must be a positive integer",
        "tracks[1].stops[2].endLine must be >= line",
        "tracks[1].stops[2].kind must be one of blocker, risk, question, inspect, context",
        "skipped must be an array (may be empty)",
      ]);
    }
  });

  test("accepts a tour with no tracks and rejects non-objects", () => {
    expect(parseTour(null)).toEqual({ ok: false, errors: ["tour must be a JSON object"] });
    expect(parseTour({ ...tour(), tracks: [] })).toEqual({ ok: true, tour: tour({ tracks: [] }) });
    expect(parseTour({ ...tour(), tracks: {} })).toEqual({ ok: false, errors: ["tracks must be an array (may be empty)"] });
  });

  test("validates each track", () => {
    const result = parseTour({
      ...tour(),
      tracks: [track([]), { title: "No summary", stops: [stop()] }, "nope", { title: "t", summary: "s" }],
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        "tracks[0].stops must be a non-empty array",
        "tracks[1].summary must be a non-empty string",
        "tracks[2] must be an object",
        "tracks[3].stops must be a non-empty array",
      ],
    });
  });

  test("rejects the legacy flat stops field", () => {
    const { tracks: _, ...legacy } = tour();
    expect(parseTour({ ...legacy, stops: [stop()] })).toEqual({
      ok: false,
      errors: ["stops is no longer supported; group stops under tracks[]", "tracks must be an array (may be empty)"],
    });
    expect(parseTour({ ...tour(), stops: [] })).toEqual({
      ok: false,
      errors: ["stops is no longer supported; group stops under tracks[]"],
    });
  });
});
