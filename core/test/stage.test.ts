import { expect, test } from "bun:test";
import { parseStageMeta, stageLayout, type StageMeta } from "../src/index";

const meta: StageMeta = { version: 1, slug: "repo-12345678", title: "Review", reviewId: "12345678-1234-1234-1234-123456789abc", stagedAt: "now" };

test("stage metadata validates required and optional fields", () => {
  expect(parseStageMeta(meta)).toEqual(meta);
  expect(parseStageMeta({ ...meta, url: "https://example.com", sessionId: "pty" })).toMatchObject({ sessionId: "pty" });
  for (const raw of [null, [], {}, { ...meta, version: 2 }, { ...meta, reviewId: "bad" }, { ...meta, title: 1 }, { ...meta, url: null }, { ...meta, sessionId: 1 }]) {
    expect(parseStageMeta(raw)).toBeNull();
  }
});

test("stage layout normalizes POSIX paths", () => {
  expect(stageLayout("/shared//guided-review/./repo/")).toEqual({ dir: "/shared/guided-review/repo", tour: "/shared/guided-review/repo/review.tour.json", diff: "/shared/guided-review/repo/review.diff", meta: "/shared/guided-review/repo/meta.json" });
  expect(stageLayout("repo/../stage").tour).toBe("stage/review.tour.json");
});
