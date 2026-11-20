import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStageMeta, stageLayout, type Tour } from "../core/src/index";
import { mailboxPaths } from "../core/src/mailbox";
import { stageReview } from "./stage";

const dirs: string[] = [];

export function createStageFixture(name?: string) {
  const root = mkdtempSync(join(tmpdir(), "guided-review-stage-"));
  dirs.push(root);
  const dir = name === undefined ? root : join(root, name);
  mkdirSync(dir, { recursive: true });
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

const SLUG = /^[a-z0-9][a-z0-9._-]{0,127}$/;

test.each([
  ["My Worktree", /^my-worktree-[0-9a-f]{8}$/],
  ["UPPER", /^upper-[0-9a-f]{8}$/],
  ["..--Hidden Dir", /^hidden-dir-[0-9a-f]{8}$/],
  ["***", /^review-[0-9a-f]{8}$/],
  ["x".repeat(200), new RegExp(`^${"x".repeat(100)}-[0-9a-f]{8}$`)],
])("stage derives a valid slug from the worktree name %s", async (name, expected) => {
  const fixture = createStageFixture(name);
  const staged = await stageReview({ worktree: fixture.dir, tourPath: fixture.tourPath, sharedRoot: fixture.sharedRoot });
  expect(staged.slug).toMatch(SLUG);
  expect(staged.slug).toMatch(expected);
  expect(staged.dir).toBe(join(fixture.sharedRoot, "guided-review", staged.slug));
});

test("stage refuses a diff larger than the Toshi panel reads", async () => {
  const fixture = createStageFixture();
  writeFileSync(join(fixture.dir, "big.txt"), `${"0123456789abcdef".repeat(4)}\n`.repeat(9 * 16 * 1024));
  execFileSync("git", ["-C", fixture.dir, "add", "."]);
  execFileSync("git", ["-C", fixture.dir, "-c", "user.name=T", "-c", "user.email=t", "-c", "commit.gpgsign=false", "commit", "-qm", "big"]);
  fixture.tour.head = "HEAD";
  fixture.tour.base = "HEAD~2";
  writeFileSync(fixture.tourPath, JSON.stringify(fixture.tour));
  await expect(stageReview({ worktree: fixture.dir, tourPath: fixture.tourPath, sharedRoot: fixture.sharedRoot }))
    .rejects.toThrow(/^diff is 9\.\d MiB; the Toshi panel reads at most 8 MiB\. Review a smaller range or split the PR\.$/);
  expect(existsSync(fixture.sharedRoot)).toBe(false);
});
