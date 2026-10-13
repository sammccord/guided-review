import { describe, expect, test } from "bun:test";
import { formatLink, indexStops, parseTour, segmentText, tourStops } from "../src/index";
import { stop, tour, track } from "./fixtures";

const sample = tour({
  tracks: [
    track(
      [
        stop({ id: "release", title: "Release contract", body: "Base for [[swap]] and [[sign]]." }),
        stop({ id: "swap", title: "Swap refunds", body: "Breaks [[release]].", ask: "Commit like [[sign]] or [[release]]?" }),
      ],
      { summary: "Read [[release]] first." },
    ),
    track([
      stop({ id: "sign", title: "Sign commits", body: "Follows [[release]]." }),
      stop({ title: "No id", body: "Contrast [[swap]] with [[sign]], then [[swap]] again." }),
    ]),
  ],
});
const stops = tourStops(sample);
const index = indexStops(stops);
const [release, swap, sign, noId] = stops;

describe("indexStops", () => {
  test("maps ids to stops; stops without ids are absent", () => {
    expect([...index.byId.keys()]).toEqual(["release", "swap", "sign"]);
    expect(index.byId.get("sign")).toBe(sign!);
  });

  test("linksFrom lists distinct targets from body then ask, in first-appearance order", () => {
    expect(index.linksFrom(0)).toEqual([swap!, sign!]);
    expect(index.linksFrom(1)).toEqual([release!, sign!]);
    expect(index.linksFrom(3)).toEqual([swap!, sign!]);
  });

  test("linksTo lists referencing stops in tour order; track summaries do not count", () => {
    expect(index.linksTo(0)).toEqual([swap!, sign!]);
    expect(index.linksTo(1)).toEqual([release!, noId!]);
    expect(index.linksTo(2)).toEqual([release!, swap!, noId!]);
    expect(index.linksTo(3)).toEqual([]);
  });

  test("out-of-range positions have no links", () => {
    expect(index.linksFrom(-1)).toEqual([]);
    expect(index.linksTo(99)).toEqual([]);
  });
});

describe("segmentText", () => {
  test("splits text around resolved references", () => {
    expect(segmentText("Contrast [[swap]] with [[sign]].", index)).toEqual([
      { kind: "text", text: "Contrast " },
      { kind: "link", id: "swap", target: swap! },
      { kind: "text", text: " with " },
      { kind: "link", id: "sign", target: sign! },
      { kind: "text", text: "." },
    ]);
  });

  test("handles references at the edges and back to back", () => {
    expect(segmentText("[[swap]][[sign]]", index)).toEqual([
      { kind: "link", id: "swap", target: swap! },
      { kind: "link", id: "sign", target: sign! },
    ]);
  });

  test("plain and empty text", () => {
    expect(segmentText("no links", index)).toEqual([{ kind: "text", text: "no links" }]);
    expect(segmentText("", index)).toEqual([]);
  });

  test("unresolved references stay literal", () => {
    expect(segmentText("a [[nope]] b [[swap]]", index)).toEqual([
      { kind: "text", text: "a [[nope]] b " },
      { kind: "link", id: "swap", target: swap! },
    ]);
  });
});

test("formatLink", () => {
  expect(formatLink(sign!)).toBe("#3 Sign commits");
});

describe("parseTour references", () => {
  const errorsOf = (input: unknown) => {
    const result = parseTour(input);
    return result.ok ? [] : result.errors;
  };

  test("accepts a tour whose references resolve", () => {
    expect(parseTour(sample)).toEqual({ ok: true, tour: sample });
  });

  test("ids must be lowercase slugs", () => {
    expect(errorsOf(tour({ stops: [stop({ id: "Swap" }), stop({ id: "-x" }), stop({ id: 3 as never }), stop({ id: "ok-1" })] }))).toEqual([
      "tracks[0].stops[0].id must be lowercase letters, digits and hyphens, starting with a letter or digit",
      "tracks[0].stops[1].id must be lowercase letters, digits and hyphens, starting with a letter or digit",
      "tracks[0].stops[2].id must be lowercase letters, digits and hyphens, starting with a letter or digit",
    ]);
  });

  test("ids are unique across the tour", () => {
    const input = tour({
      tracks: [track([stop(), stop({ id: "swap-commit" })]), track([stop(), stop(), stop({ id: "swap-commit" })])],
    });
    expect(errorsOf(input)).toEqual(['tracks[1].stops[2].id "swap-commit" duplicates tracks[0].stops[1]']);
  });

  test("unknown references name the location and suggest the closest id", () => {
    const input = tour({
      tracks: [
        track([stop({ id: "swap-commit" }), stop({ body: "See [[swp-commit]].", ask: "And [[zzzzzzzz]]?" })], {
          summary: "Starts at [[swap-comit]].",
        }),
      ],
    });
    expect(errorsOf(input)).toEqual([
      "tracks[0].summary references unknown stop [[swap-comit]] (did you mean [[swap-commit]]?)",
      "tracks[0].stops[1].body references unknown stop [[swp-commit]] (did you mean [[swap-commit]]?)",
      "tracks[0].stops[1].ask references unknown stop [[zzzzzzzz]]",
    ]);
  });

  test("the tour summary may link any stop and reports unknown ids first", () => {
    const ok = tour({ summary: "- Start at [[swap-commit]].", tracks: [track([stop({ id: "swap-commit" })])] });
    expect(errorsOf(ok)).toEqual([]);
    const bad = tour({
      summary: "- Start at [[swap-comit]], then [[swap-comit]].",
      tracks: [track([stop({ id: "swap-commit", body: "See [[nope]]." })])],
    });
    expect(errorsOf(bad)).toEqual([
      "summary references unknown stop [[swap-comit]] (did you mean [[swap-commit]]?)",
      "tracks[0].stops[0].body references unknown stop [[nope]]",
    ]);
  });

  test("a stop may not reference itself; repeats report once", () => {
    const input = tour({ stops: [stop({ id: "loop", body: "[[loop]] and [[loop]]", ask: "[[loop]]?" })] });
    expect(errorsOf(input)).toEqual([
      "tracks[0].stops[0].body references its own stop [[loop]]",
      "tracks[0].stops[0].ask references its own stop [[loop]]",
    ]);
  });
});
