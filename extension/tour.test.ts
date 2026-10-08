import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAnchors, parseTour, readDiffRanges, toSidecar, type DiffRanges, type Stop, type Tour } from "./tour";

function stop(overrides: Partial<Stop> = {}): Stop {
  return {
    path: "src/a.ts",
    side: "new",
    line: 10,
    kind: "risk",
    title: "Retry loop",
    body: "Retries forever.",
    ask: "Is unbounded retry acceptable?",
    ...overrides,
  };
}

function tour(overrides: Partial<Tour> = {}): Tour {
  return {
    version: 1,
    title: "Add retries",
    base: "aaa",
    head: "bbb",
    verdict: "request-changes",
    summary: "Adds retry logic.",
    scope: { checked: ["unit tests"], unchecked: ["load"] },
    stops: [stop()],
    skipped: [],
    ...overrides,
  };
}

describe("parseTour", () => {
  test("accepts a valid tour and ignores unknown keys", () => {
    const input = { ...tour({ url: "https://example.com/pr/1", stops: [stop({ endLine: 12 })] }), extra: true };
    const result = parseTour(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tour).toEqual(tour({ url: "https://example.com/pr/1", stops: [stop({ endLine: 12 })] }));
      expect("extra" in result.tour).toBe(false);
    }
  });

  test("collects every error with a location", () => {
    const result = parseTour({
      version: 2,
      title: "",
      base: "aaa",
      verdict: "lgtm",
      summary: "s",
      scope: { checked: ["ok", 3], unchecked: "nope" },
      stops: [stop(), { ...stop(), side: "both", line: 0, endLine: 1 }, stop({ line: 5, endLine: 4, kind: "nit" as never })],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        "version must be 1",
        "title must be a non-empty string",
        "head must be a non-empty string",
        "verdict must be one of approve, request-changes, discuss",
        "scope.checked[1] must be a string",
        "scope.unchecked must be an array of strings",
        "stops[1].side must be one of new, old",
        "stops[1].line must be a positive integer",
        "stops[2].endLine must be >= line",
        "stops[2].kind must be one of blocker, risk, question, context",
        "skipped must be an array (may be empty)",
      ]);
    }
  });

  test("accepts a tour with no stops and rejects non-objects", () => {
    expect(parseTour(null)).toEqual({ ok: false, errors: ["tour must be a JSON object"] });
    expect(parseTour({ ...tour(), stops: [] })).toEqual({ ok: true, tour: tour({ stops: [] }) });
    expect(parseTour({ ...tour(), stops: {} })).toEqual({ ok: false, errors: ["stops must be an array"] });
  });
});

describe("toSidecar", () => {
  const sample = tour({
    stops: [
      stop({ path: "b.ts", line: 3, title: "B first" }),
      stop({ path: "a.ts", side: "old", line: 7, endLine: 9, kind: "blocker", title: "A old" }),
      stop({ path: "b.ts", line: 20, kind: "question", title: "B again" }),
    ],
    skipped: [
      { path: "lock.json", reason: "generated" },
      { path: "a.ts", reason: "already a stop" },
    ],
  });
  const doc = toSidecar(sample);

  test("orders files by first stop with one entry per file, skipped files last", () => {
    expect(doc.files.map((file) => file.path)).toEqual(["b.ts", "a.ts", "lock.json"]);
    expect(doc.files.map((file) => file.summary)).toEqual(["Tour stops 1, 3", "Tour stop 2", "Skipped: generated"]);
    expect(doc.files[2]!.annotations).toEqual([]);
  });

  test("annotations carry ids, side ranges, and narrative summaries", () => {
    const [b, a] = doc.files;
    expect(b!.annotations.map((note) => note.id)).toEqual(["stop-1", "stop-3"]);
    expect(b!.annotations[0]).toEqual({
      id: "stop-1",
      newRange: [3, 3],
      summary: "1/3 [risk] B first",
      rationale: "Retries forever.\n\nAsk: Is unbounded retry acceptable?",
      tags: ["risk"],
      source: "guided-review",
      author: "guided-review",
    });
    expect(a!.annotations[0]!.oldRange).toEqual([7, 9]);
    expect(a!.annotations[0]!.newRange).toBeUndefined();
    expect(a!.annotations[0]!.summary).toBe("2/3 [blocker] A old");
  });

  test("top-level summary leads with the verdict", () => {
    expect(doc.version).toBe(1);
    expect(doc.summary).toBe("REQUEST-CHANGES · Add retries\n\nAdds retry logic.");
  });
});

describe("checkAnchors", () => {
  const ranges: DiffRanges = new Map([
    [
      "src/a.ts",
      [
        { side: "old", start: 5, end: 12 },
        { side: "new", start: 5, end: 14 },
        { side: "new", start: 30, end: 40 },
      ],
    ],
    ["lib/util/helpers.ts", [{ side: "new", start: 1, end: 3 }]],
  ]);

  test("passes anchors inside one hunk", () => {
    expect(checkAnchors(tour({ stops: [stop(), stop({ line: 30, endLine: 40 }), stop({ side: "old", line: 12 })] }), ranges)).toEqual([]);
  });

  test("reports a missing path and suggests the closest basename", () => {
    const messages = checkAnchors(tour({ stops: [stop(), stop({ path: "src/util/helpers.ts", title: "Helper" })] }), ranges);
    expect(messages).toEqual(['stop 2 "Helper": path src/util/helpers.ts is not in the diff (did you mean lib/util/helpers.ts?)']);
    expect(checkAnchors(tour({ stops: [stop({ path: "nope.ts" })] }), ranges)[0]).toEndWith("is not in the diff");
  });

  test("reports a line outside every hunk", () => {
    expect(checkAnchors(tour({ stops: [stop({ line: 20 })] }), ranges)).toEqual([
      'stop 1 "Retry loop": line 20 (new) is outside every hunk (hunks: 5-14, 30-40)',
    ]);
    expect(checkAnchors(tour({ stops: [stop({ side: "old", line: 13 })] }), ranges)).toEqual([
      'stop 1 "Retry loop": line 13 (old) is outside every hunk (hunks: 5-12)',
    ]);
  });

  test("rejects a range spanning two hunks", () => {
    expect(checkAnchors(tour({ stops: [stop({ line: 10, endLine: 35 })] }), ranges)).toEqual([
      'stop 1 "Retry loop": lines 10-35 (new) runs past hunk 5-14; an anchor must stay inside one hunk (hunks: 5-14, 30-40)',
    ]);
  });
});

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

  test("throws with git's stderr on a bad revision", async () => {
    await expect(readDiffRanges(repo, "nope", head)).rejects.toThrow(/git diff nope\.\.\..* failed .*nope/s);
  });
});
