import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stop, tour } from "../../core/test/fixtures";
import { loadTour, parseChanges, readRevision, revisionFile } from "../src/repository";

let repo = "", base = "", head = "", baseTip = "", file = "";
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`).join("");
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "guided-review-cursor-test-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "old name.txt"), lines);
  writeFileSync(join(repo, "deleted.txt"), "gone\n");
  git("add", "."); git("commit", "-qm", "base");
  base = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "old name.txt"), `base branch tip\n${lines}`);
  git("add", "."); git("commit", "-qm", "base advanced");
  baseTip = git("rev-parse", "HEAD");
  git("checkout", "-qb", "review", base);
  renameSync(join(repo, "old name.txt"), join(repo, "renamed ü.txt"));
  writeFileSync(join(repo, "renamed ü.txt"), lines.replace("line 10\n", "changed 10\n"));
  unlinkSync(join(repo, "deleted.txt"));
  writeFileSync(join(repo, "added.txt"), "new\n");
  git("add", "-A"); git("commit", "-qm", "head");
  head = git("rev-parse", "HEAD");
  file = join(repo, "tour.json");
  writeFileSync(file, JSON.stringify(tour({ base: baseTip, head, stops: [
    stop({ path: "renamed ü.txt", side: "old", line: 10 }),
    stop({ path: "renamed ü.txt", line: 10 }),
    stop({ path: "deleted.txt", side: "old", line: 1 }),
    stop({ path: "added.txt", line: 1 }),
  ] })));
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("Cursor Git snapshots", () => {
  test("pins the merge base, resolves renamed old-side paths, and handles additions/deletions", async () => {
    const loaded = await loadTour(file, repo);
    expect(loaded.mergeBase).toBe(base);
    expect(loaded.head).toBe(head);
    expect(revisionFile(loaded, loaded.stops[0]!.stop)).toEqual({ ref: base, path: "old name.txt" });
    expect(revisionFile(loaded, loaded.stops[1]!.stop)).toEqual({ ref: head, path: "renamed ü.txt" });
    expect(revisionFile(loaded, loaded.stops[2]!.stop, "new")).toBeUndefined();
    expect(revisionFile(loaded, loaded.stops[3]!.stop, "old")).toBeUndefined();
  });
  test("dirty workspace contents do not shift the tour's code", async () => {
    const loaded = await loadTour(file, repo);
    writeFileSync(join(repo, "renamed ü.txt"), "dirty workspace\n");
    const revision = revisionFile(loaded, loaded.stops[1]!.stop)!;
    expect(await readRevision(repo, revision.ref, revision.path)).toContain("changed 10\n");
    expect(await readRevision(repo, base, "old name.txt")).toBe(lines);
  });
  test("rejects invalid anchors and unknown refs", async () => {
    const invalid = join(repo, "invalid.json");
    writeFileSync(invalid, JSON.stringify(tour({ base, head, stops: [stop({ path: "added.txt", line: 99 })] })));
    await expect(loadTour(invalid, repo)).rejects.toThrow("outside every hunk");
    writeFileSync(invalid, JSON.stringify(tour({ base: "--help", head, stops: [] })));
    await expect(loadTour(invalid, repo)).rejects.toThrow();
  });
  test("accepts a zero-stop tour", async () => {
    const empty = join(repo, "empty.json");
    writeFileSync(empty, JSON.stringify(tour({ base, head, tracks: [] })));
    expect((await loadTour(empty, repo)).stops).toEqual([]);
  });
  test("handles NUL-delimited paths without whitespace splitting", () => {
    const changes = parseChanges("R098\0before\tname\0after\nname\0A\0space name\0D\0ü.txt\0");
    expect(changes.get("after\nname")).toEqual({ oldPath: "before\tname", newPath: "after\nname" });
    expect(changes.get("space name")).toEqual({ newPath: "space name" });
    expect(changes.get("ü.txt")).toEqual({ oldPath: "ü.txt" });
  });
});
