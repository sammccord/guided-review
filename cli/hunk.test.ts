import { describe, expect, test } from "bun:test";
import { sessionAddArgs, sessionIdForPid } from "./hunk";

const anchor = { path: "src/a.ts", side: "new" as const, line: 10 };

describe("sessionAddArgs", () => {
  test("replies thread under the note", () => {
    expect(sessionAddArgs({ kind: "reply", noteId: "user:1", summary: "Because.", rationale: "More." }, "sid-1")).toEqual([
      "session", "comment", "add", "sid-1", "--reply-to", "user:1",
      "--summary", "Because.", "--rationale", "More.", "--author", "guided-review", "--json",
    ]);
  });

  test("anchored answers name the file and side, and skip an empty rationale", () => {
    expect(sessionAddArgs({ kind: "anchored", anchor: { ...anchor, side: "old" }, summary: "Stop 2 · unsure", rationale: "" }, "sid-1")).toEqual([
      "session", "comment", "add", "sid-1", "--file", "src/a.ts", "--old-line", "10",
      "--summary", "Stop 2 · unsure", "--author", "guided-review", "--json",
    ]);
    expect(sessionAddArgs({ kind: "anchored", anchor, summary: "Q: x", rationale: "y" }, "sid-1").slice(4, 8)).toEqual([
      "--file", "src/a.ts", "--new-line", "10",
    ]);
  });
});

describe("sessionIdForPid", () => {
  const list = {
    sessions: [
      { sessionId: "older", pid: 66797, repoRoot: "/wt" },
      { sessionId: "mine", pid: 74077, repoRoot: "/wt" },
    ],
  };

  test("picks the session of the TUI that owns the mailbox, even when several share the worktree", () => {
    expect(sessionIdForPid(list, 74077)).toBe("mine");
  });

  test("returns null when that TUI is gone or the output is not a session list", () => {
    expect(sessionIdForPid(list, 1)).toBeNull();
    expect(sessionIdForPid({ nope: true }, 74077)).toBeNull();
    expect(sessionIdForPid({ sessions: [{ pid: 74077 }] }, 74077)).toBeNull();
  });
});

