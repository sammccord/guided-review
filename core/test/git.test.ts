import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDiffRanges, resolveDiffRefs } from "../src/git";
import { checkAnchors } from "../src/index";
import { stop, tour } from "./fixtures";

describe("readDiffRanges", () => {
  let repo = "";
  let base = "";
  let head = "";
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  const numbered = (count: number, label = "line") => Array.from({ length: count }, (_, i) => `${label} ${i + 1}`).join("\n") + "\n";

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "guided-review-test-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "Test");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "keep.txt"), numbered(40));
    writeFileSync(join(repo, "old-name.txt"), numbered(30, "rename"));
    writeFileSync(join(repo, "doomed.txt"), "--- not a header\n-- also not\nbye\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    base = git("rev-parse", "HEAD");

    const kept = numbered(40).split("\n");
    kept[2] = "changed 3";
    kept[34] = "changed 35";
    writeFileSync(join(repo, "keep.txt"), kept.join("\n"));
    git("mv", "old-name.txt", "new-name.txt");
    const renamed = numbered(30, "rename").split("\n");
    renamed[19] = "edited 20";
    writeFileSync(join(repo, "new-name.txt"), renamed.join("\n"));
    unlinkSync(join(repo, "doomed.txt"));
    writeFileSync(join(repo, "fresh.txt"), "one\ntwo\n");
    git("add", "-A");
    git("commit", "-q", "-m", "head");
    head = git("rev-parse", "HEAD");
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("collects per-side hunk ranges keyed by git's path", async () => {
    const ranges = await readDiffRanges(repo, base, head);
    expect([...ranges.keys()].sort()).toEqual(["doomed.txt", "fresh.txt", "keep.txt", "new-name.txt"]);
    expect(ranges.get("keep.txt")).toEqual([
      { side: "old", start: 1, end: 6 },
      { side: "new", start: 1, end: 6 },
      { side: "old", start: 32, end: 38 },
      { side: "new", start: 32, end: 38 },
    ]);
    expect(ranges.get("new-name.txt")).toEqual([
      { side: "old", start: 17, end: 23 },
      { side: "new", start: 17, end: 23 },
    ]);
    expect(ranges.get("doomed.txt")).toEqual([{ side: "old", start: 1, end: 3 }]);
    expect(ranges.get("fresh.txt")).toEqual([{ side: "new", start: 1, end: 2 }]);
  });

  test("anchors validate against the real diff", async () => {
    const ranges = await readDiffRanges(repo, base, head);
    const sample = tour({
      base,
      head,
      stops: [
        stop({ path: "new-name.txt", line: 20 }),
        stop({ path: "doomed.txt", side: "old", line: 1, endLine: 3 }),
        stop({ path: "old-name.txt", title: "Old path" }),
      ],
    });
    expect(checkAnchors(sample, ranges)).toEqual(['stop 3 "Old path": path old-name.txt is not in the diff']);
  });

  test("resolves symbolic refs to pinned commits and rejects option-like refs", async () => {
    expect(await resolveDiffRefs(repo, "HEAD~1", "HEAD")).toEqual({ base, head });
    expect(await resolveDiffRefs(repo, base.toUpperCase(), head)).toEqual({ base, head });
    await expect(resolveDiffRefs(repo, "--help", "HEAD")).rejects.toThrow("cannot resolve --help");
  });

  test("throws with git's stderr on a bad revision", async () => {
    await expect(readDiffRanges(repo, "nope", head)).rejects.toThrow(/git diff nope\.\.\..* failed .*nope/s);
  });
});
