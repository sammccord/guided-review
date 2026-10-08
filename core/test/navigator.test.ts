import { describe, expect, test } from "bun:test";
import { initialCursor, move, tourStops, type MoveResult, type TourCursor, type TourMove } from "../src/index";
import { stop, tour, track } from "./fixtures";

const stops = tourStops(
  tour({
    tracks: [
      track([stop({ title: "a" }), stop({ title: "b" })], { title: "One" }),
      track([stop({ title: "c" })], { title: "Two" }),
      track([stop({ title: "d" }), stop({ title: "e" })], { title: "Three" }),
    ],
  }),
);
const trackCount = 3;
const at = (current: number, history: number[] = []): TourCursor => ({ current, history });
const step = (current: number, tourMove: TourMove): MoveResult => move(stops, trackCount, at(current), tourMove);
const to = (current: number, history: number[] = []): MoveResult => ({ ok: true, cursor: { current, history } });
const refused = (reason: string): MoveResult => ({ ok: false, reason });

describe("move", () => {
  test("starts before the first stop", () => {
    expect(initialCursor()).toEqual({ current: -1, history: [] });
  });

  test("not started: next and nextTrack begin the tour, prev and prevTrack refuse", () => {
    const start = initialCursor();
    expect(move(stops, trackCount, start, { kind: "next" })).toEqual(to(0));
    expect(move(stops, trackCount, start, { kind: "nextTrack" })).toEqual(to(0));
    expect(move(stops, trackCount, start, { kind: "prev" })).toEqual(refused("Already at the first stop"));
    expect(move(stops, trackCount, start, { kind: "prevTrack" })).toEqual(refused("Already at the first stop"));
  });

  test("next and prev step one stop and stop at the ends", () => {
    expect(step(1, { kind: "next" })).toEqual(to(2));
    expect(step(2, { kind: "prev" })).toEqual(to(1));
    expect(step(4, { kind: "next" })).toEqual(refused("End of tour (5 stops)"));
    expect(step(0, { kind: "prev" })).toEqual(refused("Already at the first stop"));
  });

  test("nextTrack jumps to the first stop of the following track", () => {
    expect(step(0, { kind: "nextTrack" })).toEqual(to(2));
    expect(step(1, { kind: "nextTrack" })).toEqual(to(2));
    expect(step(2, { kind: "nextTrack" })).toEqual(to(3));
    expect(step(3, { kind: "nextTrack" })).toEqual(refused("Already in the last track (3 tracks)"));
    expect(step(4, { kind: "nextTrack" })).toEqual(refused("Already in the last track (3 tracks)"));
  });

  test("prevTrack rewinds to the track start, then to the previous track", () => {
    expect(step(4, { kind: "prevTrack" })).toEqual(to(3));
    expect(step(3, { kind: "prevTrack" })).toEqual(to(2));
    expect(step(2, { kind: "prevTrack" })).toEqual(to(0));
    expect(step(1, { kind: "prevTrack" })).toEqual(to(0));
    expect(step(0, { kind: "prevTrack" })).toEqual(refused("Already in the first track"));
  });

  test("goto and restart", () => {
    expect(step(-1, { kind: "goto", index: 3 })).toEqual(to(3));
    expect(step(1, { kind: "goto", index: 5 })).toEqual(refused("End of tour (5 stops)"));
    expect(step(1, { kind: "goto", index: -1 })).toEqual(refused("Already at the first stop"));
    expect(step(4, { kind: "restart" })).toEqual(to(0));
    expect(step(-1, { kind: "restart" })).toEqual(to(0));
  });

  test("an empty tour refuses every move", () => {
    const empty = (tourMove: TourMove) => move([], 0, initialCursor(), tourMove);
    expect(empty({ kind: "next" })).toEqual(refused("End of tour (0 stops)"));
    expect(empty({ kind: "prev" })).toEqual(refused("Already at the first stop"));
    expect(empty({ kind: "nextTrack" })).toEqual(refused("Already in the last track (0 tracks)"));
    expect(empty({ kind: "prevTrack" })).toEqual(refused("Already at the first stop"));
    expect(empty({ kind: "restart" })).toEqual(refused("End of tour (0 stops)"));
    expect(empty({ kind: "goto", index: 0 })).toEqual(refused("End of tour (0 stops)"));
  });

  test("does not mutate the cursor it is given", () => {
    const cursor = at(1);
    step(1, { kind: "next" });
    move(stops, trackCount, cursor, { kind: "next" });
    expect(cursor).toEqual({ current: 1, history: [] });
  });
});

describe("link history", () => {
  const from = (cursor: TourCursor, tourMove: TourMove): MoveResult => move(stops, trackCount, cursor, tourMove);

  test("follow pushes the current stop and goes to the target", () => {
    expect(from(at(1), { kind: "follow", index: 4 })).toEqual(to(4, [1]));
    expect(from(at(4, [1]), { kind: "follow", index: 0 })).toEqual(to(0, [1, 4]));
  });

  test("follow before the tour starts records nothing", () => {
    expect(from(initialCursor(), { kind: "follow", index: 2 })).toEqual(to(2));
  });

  test("follow to a missing stop refuses and leaves history alone", () => {
    expect(from(at(1), { kind: "follow", index: 9 })).toEqual(refused("End of tour (5 stops)"));
  });

  test("back pops the most recent stop", () => {
    expect(from(at(0, [1, 4]), { kind: "back" })).toEqual(to(4, [1]));
    expect(from(at(4, [1]), { kind: "back" })).toEqual(to(1));
    expect(from(at(1), { kind: "back" })).toEqual(refused("No earlier stop to go back to"));
    expect(from(initialCursor(), { kind: "back" })).toEqual(refused("No earlier stop to go back to"));
  });

  test("follow then back round-trips", () => {
    const followed = from(at(2), { kind: "follow", index: 4 });
    expect(followed.ok && from(followed.cursor, { kind: "back" })).toEqual(to(2));
  });

  test("ordinary moves keep history; restart clears it", () => {
    const history = [3, 0];
    expect(from(at(1, history), { kind: "next" })).toEqual(to(2, history));
    expect(from(at(1, history), { kind: "prev" })).toEqual(to(0, history));
    expect(from(at(1, history), { kind: "nextTrack" })).toEqual(to(2, history));
    expect(from(at(4, history), { kind: "prevTrack" })).toEqual(to(3, history));
    expect(from(at(1, history), { kind: "goto", index: 4 })).toEqual(to(4, history));
    expect(from(at(4, history), { kind: "restart" })).toEqual(to(0));
  });
});
