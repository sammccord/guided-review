import { expect, test } from "bun:test";
import { buildRequest, emptyMailbox, nextSeq, stopRef, type RequestBody, type TourStop } from "../src/index";

const body: RequestBody = { kind: "ask", stop: null, anchor: { path: "a.ts", side: "new", line: 1 }, text: "Why?" };

test("buildRequest preserves legacy ids and advances past the largest sequence", () => {
  const box = emptyMailbox();
  const request = buildRequest(box, body, "t1");
  expect(request).toEqual({ id: "q-1", seq: 1, at: "t1", ...body });
  box.requests = [{ ...request, id: "q-7", seq: 7 }, request];
  expect(nextSeq(box)).toBe(8);
  expect(buildRequest(box, body, "t2")).toEqual({ id: "q-8", seq: 8, at: "t2", ...body });
});

test("buildRequest includes the session review id", () => {
  const box = emptyMailbox();
  const reviewId = "12345678-1234-1234-1234-123456789abc";
  box.session = { repo: "/repo", tourPath: "tour.json", head: "abc", openedAt: "t0", reviewId };
  expect(buildRequest(box, body, "t1")).toEqual({ id: `q-${reviewId}-1`, seq: 1, at: "t1", ...body });
});

test("stopRef freezes only request fields, omitting absent ids", () => {
  const stop = { path: "a.ts", side: "old", line: 3, kind: "inspect", title: "Title", ask: "Ask", body: "Body" } as const;
  const entry: TourStop = { number: 2, stop, trackIndex: 0, track: { title: "Track", summary: "Summary", stops: [stop] } };
  const ref = { number: 2, title: "Title", ask: "Ask", anchor: { path: "a.ts", side: "old", line: 3 } } as const;
  expect(stopRef(entry)).toEqual(ref);
  expect(Object.hasOwn(stopRef(entry), "id")).toBe(false);
  expect(stopRef({ ...entry, stop: { ...stop, id: "stable" } })).toEqual({ ...ref, id: "stable" });
});
