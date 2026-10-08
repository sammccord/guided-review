import { describe, expect, test } from "bun:test";
import { MAX_STOP_LINES, checkStopSize, tourStops } from "../src/index";
import { stop, tour, track } from "./fixtures";

describe("tourStops", () => {
  test("numbers stops globally in track order", () => {
    const first = track([stop({ title: "a" }), stop({ title: "b" })], { title: "One" });
    const second = track([stop({ title: "c" })], { title: "Two" });
    const third = track([stop({ title: "d" }), stop({ title: "e" })], { title: "Three" });
    const stops = tourStops(tour({ tracks: [first, second, third] }));
    expect(stops.map(({ number, stop, trackIndex }) => [number, stop.title, trackIndex])).toEqual([
      [1, "a", 0],
      [2, "b", 0],
      [3, "c", 1],
      [4, "d", 2],
      [5, "e", 2],
    ]);
    expect(stops[2]!.track).toBe(second);
    expect(tourStops(tour({ tracks: [] }))).toEqual([]);
  });
});

describe("checkStopSize", () => {
  test("flags stops longer than the limit with their global number", () => {
    const sample = tour({
      tracks: [
        track([stop({ line: 1, endLine: MAX_STOP_LINES })]),
        track([stop({ line: 5 }), stop({ line: 10, endLine: 10 + MAX_STOP_LINES, title: "Huge" })]),
      ],
    });
    expect(checkStopSize(sample)).toEqual([
      `stop 3 "Huge": spans ${MAX_STOP_LINES + 1} lines; split it into smaller stops (max ${MAX_STOP_LINES})`,
    ]);
  });
});
