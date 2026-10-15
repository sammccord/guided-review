import { expect, test } from "bun:test";
import { TourSession } from "../src/session";
import { loadedTour } from "./fixtures";

test("Cursor navigation reuses the core's track order and link history", () => {
  const session = new TourSession(loadedTour());
  expect(session.move({ kind: "next" })).toBeUndefined();
  expect(session.cursor.current).toBe(0);
  session.move({ kind: "follow", index: 2 });
  expect(session.cursor.history).toEqual([0]);
  session.move({ kind: "back" });
  expect(session.cursor.current).toBe(0);
  session.move({ kind: "nextTrack" });
  expect(session.cursor.current).toBe(2);
  session.move({ kind: "prevTrack" });
  expect(session.cursor.current).toBe(0);
});

test("invalid and fractional positions cannot corrupt the cursor", () => {
  const session = new TourSession(loadedTour());
  for (const index of [-1, 99, 0.5, NaN]) expect(session.move({ kind: "goto", index })).toBe("Unknown tour stop");
  expect(session.cursor.current).toBe(-1);
});

test("review progress is bounded, toggleable, and survives restart", () => {
  const session = new TourSession(loadedTour(), [0, 2, 200, -1, 0.2]);
  expect([...session.reviewed]).toEqual([0, 2]);
  session.toggleReviewed(0);
  session.toggleReviewed(1);
  session.toggleReviewed(200);
  session.move({ kind: "restart" });
  expect([...session.reviewed]).toEqual([2, 1]);
});

test("progress identity changes with the repo, tour content, and reviewed revisions", () => {
  const a = new TourSession(loadedTour());
  expect(new TourSession(loadedTour()).progressKey).toBe(a.progressKey);
  const modified = loadedTour();
  modified.tour.head = "different";
  expect(new TourSession(modified).progressKey).not.toBe(a.progressKey);
  const elsewhere = loadedTour();
  elsewhere.root = "/other";
  expect(new TourSession(elsewhere).progressKey).not.toBe(a.progressKey);
  const movedRef = loadedTour();
  movedRef.head = "resolved-to-a-new-commit";
  expect(new TourSession(movedRef).progressKey).not.toBe(a.progressKey);
});
