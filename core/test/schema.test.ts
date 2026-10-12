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

  describe("stack", () => {
    const layers = [
      { number: 10, title: "base", state: "merged" },
      { number: 11, title: "middle", url: "https://example.com/pr/11", state: "open" },
      { number: 12, title: "top", state: "closed" },
    ] as const;
    const stack = { number: 9, url: "https://example.com/stack/9", current: 11, layers };

    test("accepts a valid stack and leaves stackless tours unchanged", () => {
      const input = { ...tour(), stack };
      expect(parseTour(input)).toEqual({ ok: true, tour: tour({ stack: { ...stack, layers: [...layers] } }) });
      const result = parseTour(tour());
      expect(result.ok && "stack" in result.tour).toBe(false);
    });

    test("current may be a closed layer", () => {
      expect(parseTour({ ...tour(), stack: { ...stack, current: 12 } }).ok).toBe(true);
    });

    test("collects every stack error with a location", () => {
      const result = parseTour({
        ...tour(),
        stack: {
          number: 0,
          url: "",
          current: 99,
          layers: [
            { number: 10, title: "base", state: "merged" },
            "nope",
            { number: 10, title: "", url: 3, state: "draft" },
            { number: 1.5, title: "t", state: "open" },
          ],
        },
      });
      expect(result).toEqual({
        ok: false,
        errors: [
          "stack.number must be a positive integer",
          "stack.url must be a non-empty string when present",
          "stack.layers[1] must be an object",
          "stack.layers[2].title must be a non-empty string",
          "stack.layers[2].url must be a non-empty string when present",
          "stack.layers[2].state must be one of open, merged, closed",
          "stack.layers[3].number must be a positive integer",
          "stack.layers[2].number 10 duplicates stack.layers[0]",
          "stack.current 99 is not one of the stack's layers",
        ],
      });
    });

    test("rejects a merged current layer, empty layers, and non-objects", () => {
      expect(parseTour({ ...tour(), stack: { ...stack, current: 10 } })).toEqual({
        ok: false,
        errors: ["stack.current 10 is already merged; review an open layer"],
      });
      expect(parseTour({ ...tour(), stack: { number: 9, current: 1, layers: [] } })).toEqual({
        ok: false,
        errors: ["stack.layers must be a non-empty array"],
      });
      expect(parseTour({ ...tour(), stack: { number: 9, current: "11", layers } })).toEqual({
        ok: false,
        errors: ["stack.current must be a positive integer"],
      });
      expect(parseTour({ ...tour(), stack: [] })).toEqual({ ok: false, errors: ["stack must be an object when present"] });
    });
  });
});
