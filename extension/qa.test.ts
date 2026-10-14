import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCliCommandContext, ExtensionCliCommandResult } from "hunkdiff/extension";
import type { Decision, Request, SessionRecord } from "../core/src/index";
import { answerPath, mailboxPaths, requestPath, writeJsonAtomic } from "../core/src/mailbox";
import { runAnswer, runWait, sessionAddArgs } from "./qa";

const anchor = { path: "src/a.ts", side: "new" as const, line: 10 };
const stop = { number: 2, title: "Loop bound", ask: "Block?", anchor };

describe("sessionAddArgs", () => {
  test("replies thread under the note", () => {
    expect(sessionAddArgs({ kind: "reply", noteId: "user:1", summary: "Because.", rationale: "More." }, "/repo")).toEqual([
      "session", "comment", "add", "--repo", "/repo", "--reply-to", "user:1",
      "--summary", "Because.", "--rationale", "More.", "--author", "guided-review", "--json",
    ]);
  });

  test("anchored answers name the file and side, and skip an empty rationale", () => {
    expect(sessionAddArgs({ kind: "anchored", anchor: { ...anchor, side: "old" }, summary: "Stop 2 · unsure", rationale: "" }, "/repo")).toEqual([
      "session", "comment", "add", "--repo", "/repo", "--file", "src/a.ts", "--old-line", "10",
      "--summary", "Stop 2 · unsure", "--author", "guided-review", "--json",
    ]);
    expect(sessionAddArgs({ kind: "anchored", anchor, summary: "Q: x", rationale: "y" }, "/r").slice(5, 9)).toEqual([
      "--file", "src/a.ts", "--new-line", "10",
    ]);
  });
});

interface Run {
  result: ExtensionCliCommandResult;
  stdout: string;
  stderr: string;
}

async function run(handler: typeof runWait, args: string[], cwd: string): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const ctx: ExtensionCliCommandContext = {
    cwd,
    signal: new AbortController().signal,
    stdin: (async function* () {})(),
    stdout: { write: async (chunk) => void (stdout += String(chunk)) },
    stderr: { write: async (chunk) => void (stderr += String(chunk)) },
  };
  return { result: await handler(args, ctx), stdout, stderr };
}

const json = (out: string) => JSON.parse(out.trim());

describe("tour wait and answer", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "guided-review-qa-cli-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const session = (tour: string, rest: Partial<SessionRecord> = {}): SessionRecord => ({
    repo: dir,
    tourPath: tour,
    head: "bbb",
    pid: process.pid,
    openedAt: "t0",
    ...rest,
  });
  const decision = (seq: number, decision: Decision, comment = ""): Request => ({
    id: `q-${seq}`,
    seq,
    at: `t${seq}`,
    kind: "decision",
    stop,
    decision,
    comment,
  });

  test("rejects bad arguments", async () => {
    expect((await run(runWait, [], dir)).result).toEqual({ kind: "exit", code: 2 });
    expect((await run(runWait, ["a.tour.json", "--timeout", "x"], dir)).stderr).toContain("--timeout");
    expect((await run(runAnswer, ["a.tour.json", "q-1"], dir)).result).toEqual({ kind: "exit", code: 2 });
    expect((await run(runAnswer, ["a.tour.json", "q-1", "--text", "  "], dir)).result).toEqual({ kind: "exit", code: 2 });
  });

  test("idle after the timeout, with a heartbeat on disk", async () => {
    const tour = join(dir, "idle.tour.json");
    const { result, stdout } = await run(runWait, ["idle.tour.json", "--timeout", "0.2"], dir);
    expect(result).toEqual({ kind: "exit", code: 0 });
    expect(json(stdout)).toEqual({ kind: "idle", next: "wait again" });
    const beat = await Bun.file(mailboxPaths(tour).agent).json();
    expect(beat.pid).toBe(process.pid);
    expect(Date.parse(beat.until)).toBeGreaterThan(Date.now() - 5000);
  });

  test("pending items across tours, and a long heartbeat while answering", async () => {
    const a = join(dir, "a.tour.json");
    const b = join(dir, "b.tour.json");
    await writeJsonAtomic(requestPath(mailboxPaths(a), "q-1"), decision(1, "agree"));
    await writeJsonAtomic(requestPath(mailboxPaths(b), "q-1"), decision(1, "disagree", "no"));
    await writeJsonAtomic(requestPath(mailboxPaths(b), "q-2"), decision(2, "unsure"));
    await writeJsonAtomic(answerPath(mailboxPaths(b), "q-2"), { id: "q-2", commentId: "mcp:1", text: "- a", at: "t" });
    const { stdout } = await run(runWait, [a, b, "--timeout", "5"], dir);
    const payload = json(stdout);
    expect(payload.kind).toBe("pending");
    expect(payload.items).toEqual([{ tour: b, ...decision(1, "disagree", "no") }]);
    expect(payload.next).toContain(`tour answer ${b} q-1 --text`);
    const beat = await Bun.file(mailboxPaths(a).agent).json();
    expect(Date.parse(beat.until)).toBeGreaterThan(Date.now() + 500_000);
  });

  test("finished once every tour has ended, with decisions and transcript", async () => {
    const tour = join(dir, "done.tour.json");
    const paths = mailboxPaths(tour);
    await writeJsonAtomic(paths.session, session(tour, { finishedAt: "t9" }));
    await writeJsonAtomic(requestPath(paths, "q-1"), decision(1, "agree"));
    await writeJsonAtomic(requestPath(paths, "q-2"), decision(2, "unsure"));
    const { stdout } = await run(runWait, [tour, "--timeout", "5"], dir);
    const payload = json(stdout);
    expect(payload.kind).toBe("finished");
    expect(payload.decisions).toEqual([{ tour, stop: 2, decision: "unsure" }]);
    expect(payload.transcript.map((entry: { request: Request; status: string }) => [entry.request.id, entry.status])).toEqual([
      ["q-1", "noted"],
      ["q-2", "pending"],
    ]);
    expect(payload.next).toBe("write the review draft");
  });

  test("closed when the TUI process is gone", async () => {
    const tour = join(dir, "gone.tour.json");
    await writeJsonAtomic(mailboxPaths(tour).session, session(tour, { pid: 2 ** 22 - 1 }));
    expect(json((await run(runWait, [tour], dir)).stdout).kind).toBe("closed");
  });

  test("answer reports an unknown or already answered request without posting", async () => {
    const tour = join(dir, "ans.tour.json");
    const paths = mailboxPaths(tour);
    await writeJsonAtomic(requestPath(paths, "q-1"), decision(1, "unsure"));
    await writeJsonAtomic(answerPath(paths, "q-1"), { id: "q-1", commentId: null, text: "- a", at: "t" });
    expect(json((await run(runAnswer, [tour, "q-1", "--text", "x"], dir)).stdout)).toEqual({ id: "q-1", status: "already-answered" });
    const missing = await run(runAnswer, [tour, "q-9", "--text", "x"], dir);
    expect(missing.result).toEqual({ kind: "exit", code: 1 });
    expect(missing.stderr).toContain("no request q-9");
    await writeJsonAtomic(requestPath(paths, "q-2"), decision(2, "unsure"));
    const unopened = await run(runAnswer, [tour, "q-2", "--text", "x"], dir);
    expect(unopened.result).toEqual({ kind: "exit", code: 1 });
    expect(unopened.stderr).toContain("open the tour in Hunk first");
  });
});
