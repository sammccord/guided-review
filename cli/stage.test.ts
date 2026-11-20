import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStageMeta, stageLayout, type Tour } from "../core/src/index";
import { mailboxPaths } from "../core/src/mailbox";
import { stageReview } from "./stage";

const dirs: string[] = [];

export function createStageFixture() {
  const dir = mkdtempSync(join(tmpdir(), "guided-review-stage-"));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  writeFileSync(join(dir, "a.txt"), "before\n");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "base");
  writeFileSync(join(dir, "a.txt"), "after\n");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "head");
  const tour: Tour = { version: 1, title: "Review", base: "HEAD~1", head: "HEAD", verdict: "approve", summary: "- Change.", scope: { checked: [], unchecked: [] }, skipped: [],
    tracks: [{ title: "Change", summary: "- Check.", stops: [{ path: "a.txt", side: "new", line: 1, kind: "inspect", title: "Value", body: "- Changed.", ask: "Correct?" }] }] };
  const tourPath = join(dir, "tour.json");
  writeFileSync(tourPath, JSON.stringify(tour));
  return { dir, tourPath, tour, sharedRoot: join(dir, "shared") };
}

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("stage pins refs, writes a bundle, and resumes or resets its generation", async () => {
  const fixture = createStageFixture();
  const input = { worktree: fixture.dir, tourPath: fixture.tourPath, sharedRoot: fixture.sharedRoot, sessionId: "pty" };
  const staged = await stageReview(input);
  const layout = stageLayout(staged.dir);
  const pinned = JSON.parse(readFileSync(layout.tour, "utf8"));
  expect(pinned.base).toMatch(/^[0-9a-f]{40}$/);
  expect(pinned.head).toMatch(/^[0-9a-f]{40}$/);
  expect(readFileSync(layout.tour, "utf8")).toBe(JSON.stringify(pinned, null, 2) + "\n");
  expect(readFileSync(layout.diff, "utf8")).toContain("-before\n+after");
  expect(parseStageMeta(JSON.parse(readFileSync(layout.meta, "utf8")))).toEqual(staged.meta);
  const session = JSON.parse(readFileSync(mailboxPaths(staged.tour).session, "utf8"));
  expect(session).not.toHaveProperty("pid");
  expect(session.reviewId).toBe(staged.reviewId);
  expect((await stageReview(input)).reviewId).toBe(staged.reviewId);
  expect(readdirSync(join(fixture.sharedRoot, "guided-review"))).toEqual([staged.slug]);
  expect((await stageReview({ ...input, fresh: true })).reviewId).not.toBe(staged.reviewId);
});

test("bad anchors fail before writing anything", async () => {
  const fixture = createStageFixture();
  fixture.tour.tracks[0]!.stops[0]!.line = 900;
  writeFileSync(fixture.tourPath, JSON.stringify(fixture.tour));
  await expect(stageReview({ worktree: fixture.dir, tourPath: fixture.tourPath, sharedRoot: fixture.sharedRoot })).rejects.toThrow();
  expect(existsSync(fixture.sharedRoot)).toBe(false);
});
