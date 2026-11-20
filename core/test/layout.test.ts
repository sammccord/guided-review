import { expect, test } from "bun:test";
import { join } from "node:path";
import { answerFile, currentPointerPath, requestFile, reviewLayout } from "../src/index";
import { answerPath, mailboxPaths, requestPath } from "../src/mailbox";

const reviewId = "12345678-1234-1234-1234-123456789abc";

test("reviewLayout derives legacy and generation paths without reading a pointer", () => {
  const root = "/repo/review.tour.qa";
  expect(reviewLayout("/repo/review.tour.json")).toEqual({
    root, session: `${root}/session.json`, inbox: `${root}/inbox`, answered: `${root}/answered`,
    agent: `${root}/agent.json`, approved: `${root}/approved.json`,
  });
  expect(reviewLayout("/repo/review.tour.json", null)).toEqual(reviewLayout("/repo/review.tour.json"));
  const layout = reviewLayout("/repo/review.tour.json", reviewId);
  expect(layout.root).toBe(`${root}/reviews/${reviewId}`);
  expect(currentPointerPath("/repo/review.tour.json")).toBe(`${root}/current.json`);
  expect(requestFile(layout, "q-1")).toBe(`${layout.root}/inbox/q-1.json`);
  expect(answerFile(layout, "q-1")).toBe(`${layout.root}/answered/q-1.json`);
  expect(() => reviewLayout("tour.json", "../../other")).toThrow("invalid review id");
});

test.each(["tour", "tour.JSON", "tour.json.backup", "dir.json/tour", ".json", "/tour.json", "./dir//../tour.json", "../dir/./tour.json", "dir with spaces/tour.json"])("POSIX layout preserves mailbox behavior for %s", tour => {
  for (const id of [null, reviewId]) {
    const legacyRoot = tour.replace(/\.json$/, "") + ".qa";
    const root = id === null ? legacyRoot : join(legacyRoot, "reviews", id);
    const layout = reviewLayout(tour, id);
    expect(layout).toEqual({
      root, session: join(root, "session.json"), inbox: join(root, "inbox"), answered: join(root, "answered"),
      agent: join(root, "agent.json"), approved: join(root, "approved.json"),
    });
    expect(mailboxPaths(tour, id)).toEqual(layout);
    expect(currentPointerPath(tour)).toBe(join(legacyRoot, "current.json"));
    expect(requestPath(layout, "q-1")).toBe(requestFile(layout, "q-1"));
    expect(answerPath(layout, "q-1")).toBe(answerFile(layout, "q-1"));
  }
});
