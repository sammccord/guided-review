import { describe, expect, test } from "bun:test";
import { stop, tour, track } from "../core/test/fixtures";
import { toSidecar } from "./sidecar";

describe("toSidecar", () => {
  const sample = tour({
    tracks: [
      track(
        [
          stop({ path: "b.ts", line: 3, title: "B first" }),
          stop({ path: "a.ts", side: "old", line: 7, endLine: 9, kind: "blocker", title: "A old" }),
        ],
        { title: "Retry loop" },
      ),
      track([stop({ path: "b.ts", line: 20, kind: "question", title: "B again" })], { title: "Config" }),
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
      summary: "1/3 [risk] Retry loop › B first",
      rationale: "- Retries forever.\n\nAsk: Is unbounded retry acceptable?",
      tags: ["risk"],
      source: "guided-review",
      author: "guided-review",
    });
    expect(a!.annotations[0]!.oldRange).toEqual([7, 9]);
    expect(a!.annotations[0]!.newRange).toBeUndefined();
    expect(a!.annotations[0]!.summary).toBe("2/3 [blocker] Retry loop › A old");
    expect(b!.annotations[1]!.summary).toBe("3/3 [question] Config › B again");
  });

  test("top-level summary leads with the verdict and lists tracks", () => {
    expect(doc.version).toBe(1);
    expect(doc.summary).toBe(
      "REQUEST-CHANGES · Add retries\n\n- Adds retry logic.\n\nTracks:\n1. Retry loop (stops 1-2)\n2. Config (stop 3)",
    );
    expect(toSidecar(tour({ tracks: [] })).summary).toBe("REQUEST-CHANGES · Add retries\n\n- Adds retry logic.");
  });

  test("links render as number, quoted title, and location in rationale and track summaries", () => {
    const linked = toSidecar(
      tour({
        tracks: [
          track(
            [
              stop({ id: "release", path: "a.ts", line: 4, title: "Release contract" }),
              stop({ path: "b.ts", line: 9, body: "Breaks [[release]].", ask: "Commit like [[sign]]?" }),
            ],
            { title: "Contract", summary: "Read [[release]] before [[sign]]." },
          ),
          track([stop({ id: "sign", path: "c.ts", side: "old", line: 30, title: "Sign commits" })], { title: "Sign" }),
        ],
      }),
    );
    expect(linked.files[1]!.annotations[0]!.rationale).toBe(
      'Breaks #1 "Release contract" (a.ts:4).\n\nAsk: Commit like #3 "Sign commits" (c.ts:30)?',
    );
    expect(linked.summary).toBe(
      "REQUEST-CHANGES · Add retries\n\n- Adds retry logic.\n\nTracks:\n" +
        "1. Contract (stops 1-2)\n" +
        '   Read #1 "Release contract" (a.ts:4) before #3 "Sign commits" (c.ts:30).\n' +
        "2. Sign (stop 3)",
    );
  });
});
