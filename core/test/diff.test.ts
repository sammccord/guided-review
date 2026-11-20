import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUnifiedDiff, type DiffFile, type DiffHunk } from "../src/index";
import { readDiffText } from "../src/git";

const repo = mkdtempSync(join(tmpdir(), "guided-review-diff-"));
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
const write = (path: string, text: string) => writeFileSync(join(repo, path), text);
git("init", "-q");
git("config", "user.email", "test@example.com");
git("config", "user.name", "Test");
git("config", "core.filemode", "true");
git("config", "commit.gpgsign", "false");
const baseFiles: Record<string, string> = {
  "modify.txt": "one\ntwo\nthree\n",
  "delete.txt": "deleted\n",
  "rename.txt": "alpha\nbeta\ngamma\ndelta\nepsilon\n",
  "pure.txt": "pure rename\n",
  "binary.dat": "\0old",
  "with space.txt": "before\n",
  "日本語.txt": "before\n",
  'quote"slash\\tab\tline\n.txt': "before\n",
  "no-newline.txt": "before",
  "mode.sh": "echo hello\n",
};
for (const [path, text] of Object.entries(baseFiles)) write(path, text);
git("add", ".");
git("commit", "-qm", "base");
const base = git("rev-parse", "HEAD").trim();
const headFiles = { ...baseFiles };
delete headFiles["delete.txt"];
delete headFiles["rename.txt"];
delete headFiles["pure.txt"];
Object.assign(headFiles, {
  "modify.txt": "one\nTWO\nthree\n",
  "add.txt": "added\n",
  "renamed.txt": "alpha\nBETA\ngamma\ndelta\nepsilon\n",
  "pure renamed.txt": "pure rename\n",
  "binary.dat": "\0new",
  "with space.txt": "after\n",
  "日本語.txt": "after\n",
  'quote"slash\\tab\tline\n.txt': "after\n",
  "no-newline.txt": "after",
});
rmSync(join(repo, "delete.txt"));
renameSync(join(repo, "rename.txt"), join(repo, "renamed.txt"));
renameSync(join(repo, "pure.txt"), join(repo, "pure renamed.txt"));
for (const [path, text] of Object.entries(headFiles)) write(path, text);
chmodSync(join(repo, "mode.sh"), 0o755);
git("add", ".");
git("commit", "-qm", "head");
const head = git("rev-parse", "HEAD").trim();
const patch = await readDiffText(repo, base, head);
const files = parseUnifiedDiff(patch);

afterAll(() => rmSync(repo, { recursive: true, force: true }));

function replaceHunk(before: string, after: string): DiffHunk {
  return {
    header: "@@ -1 +1 @@", oldStart: 1, oldCount: 1, newStart: 1, newCount: 1,
    lines: [{ kind: "del", oldLine: 1, text: before }, { kind: "add", newLine: 1, text: after }],
  };
}

describe("parseUnifiedDiff with real git output", () => {
  test("preserves patch file order and exact file structures", () => {
    const expected: DiffFile[] = [
      { path: "add.txt", status: "added", binary: false, hunks: [{
        header: "@@ -0,0 +1 @@", oldStart: 0, oldCount: 0, newStart: 1, newCount: 1,
        lines: [{ kind: "add", newLine: 1, text: "added" }],
      }] },
      { path: "binary.dat", status: "modified", binary: true, hunks: [] },
      { path: "delete.txt", status: "deleted", binary: false, hunks: [{
        header: "@@ -1 +0,0 @@", oldStart: 1, oldCount: 1, newStart: 0, newCount: 0,
        lines: [{ kind: "del", oldLine: 1, text: "deleted" }],
      }] },
      { path: "mode.sh", status: "modified", binary: false, hunks: [] },
      { path: "modify.txt", status: "modified", binary: false, hunks: [{
        header: "@@ -1,3 +1,3 @@", oldStart: 1, oldCount: 3, newStart: 1, newCount: 3,
        lines: [
          { kind: "context", oldLine: 1, newLine: 1, text: "one" },
          { kind: "del", oldLine: 2, text: "two" },
          { kind: "add", newLine: 2, text: "TWO" },
          { kind: "context", oldLine: 3, newLine: 3, text: "three" },
        ],
      }] },
      { path: "no-newline.txt", status: "modified", binary: false, hunks: [replaceHunk("before", "after")] },
      { path: "pure renamed.txt", oldPath: "pure.txt", status: "renamed", binary: false, hunks: [] },
      { path: 'quote"slash\\tab\tline\n.txt', status: "modified", binary: false, hunks: [replaceHunk("before", "after")] },
      { path: "renamed.txt", oldPath: "rename.txt", status: "renamed", binary: false, hunks: [{
        header: "@@ -1,5 +1,5 @@", oldStart: 1, oldCount: 5, newStart: 1, newCount: 5,
        lines: [
          { kind: "context", oldLine: 1, newLine: 1, text: "alpha" },
          { kind: "del", oldLine: 2, text: "beta" },
          { kind: "add", newLine: 2, text: "BETA" },
          { kind: "context", oldLine: 3, newLine: 3, text: "gamma" },
          { kind: "context", oldLine: 4, newLine: 4, text: "delta" },
          { kind: "context", oldLine: 5, newLine: 5, text: "epsilon" },
        ],
      }] },
      { path: "with space.txt", status: "modified", binary: false, hunks: [replaceHunk("before", "after")] },
      { path: "日本語.txt", status: "modified", binary: false, hunks: [replaceHunk("before", "after")] },
    ];
    expect(files).toEqual(expected);
  });

  test("round-trips both sides against git show at every hunk range", () => {
    const widePatch = git("-c", "core.quotePath=true", "diff", "--no-ext-diff", "--find-renames", "--no-color", "-U1000", `${base}...${head}`);
    for (const file of parseUnifiedDiff(widePatch)) {
      for (const hunk of file.hunks) {
        for (const side of ["old", "new"] as const) {
          const count = side === "old" ? hunk.oldCount : hunk.newCount;
          const start = side === "old" ? hunk.oldStart : hunk.newStart;
          const actual = hunk.lines.filter(line => line.kind !== (side === "old" ? "add" : "del")).map(line => line.text);
          const path = side === "old" ? file.oldPath ?? file.path : file.path;
          const text = count === 0 ? "" : git("show", `${side === "old" ? base : head}:${path}`);
          const source = text.split("\n");
          if (source.at(-1) === "") source.pop();
          expect(actual).toEqual(count === 0 ? [] : source.slice(start - 1, start - 1 + count));
        }
      }
    }
  });

  test("handles binary patches, missing trailing newline, and stripped context markers", () => {
    const binaryPatch = git("diff", "--binary", `${base}...${head}`);
    expect(parseUnifiedDiff(binaryPatch).find(file => file.path === "binary.dat")).toEqual({ path: "binary.dat", status: "modified", binary: true, hunks: [] });
    expect(parseUnifiedDiff(patch.trimEnd())).toEqual(files);
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("garbage\ndiff --git broken\n@@ invalid")).toEqual([]);
    const modified = patch.slice(patch.indexOf("diff --git a/modify.txt"), patch.indexOf("diff --git a/no-newline.txt"));
    const stripped = modified.replace(" one\n", "\n");
    expect(parseUnifiedDiff(stripped)[0]?.hunks[0]?.lines[0]).toEqual({ kind: "context", oldLine: 1, newLine: 1, text: "" });
    expect(parseUnifiedDiff(modified.replace("@@ -1,3 +1,3 @@", "@@ malformed"))[0]?.hunks).toEqual([]);
  });

  test("parses 20k lines under 500 ms", () => {
    const large = "diff --git a/large b/large\n--- a/large\n+++ b/large\n@@ -1,10000 +1,10000 @@\n" + "-before\n".repeat(10000) + "+after\n".repeat(10000);
    const start = performance.now();
    const result = parseUnifiedDiff(large);
    const elapsed = performance.now() - start;
    expect(result[0]?.hunks[0]?.lines).toHaveLength(20000);
    expect(elapsed).toBeLessThan(500);
  });
});
