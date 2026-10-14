import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCliCommandContext, ExtensionCliCommandResult } from "hunkdiff/extension";
import type { Decision, Request, SessionRecord } from "../core/src/index";
import { answerPath, mailboxPaths, requestPath, writeJsonAtomic } from "../core/src/mailbox";
import { githubCommentArgs, parsePullRequestUrl, qaHint, runAnswer, runWait, sessionAddArgs, sessionIdForPid } from "./qa";

const anchor = { path: "src/a.ts", side: "new" as const, line: 10 };
const stop = { number: 2, title: "Loop bound", ask: "Block?", anchor };

test("QA hints use resolved bindings, omit unbound commands, and fall back on older hosts", () => {
  expect(qaHint()).toBe("V decide · Q ask · F finish");
  expect(qaHint({})).toBe("V decide · Q ask · F finish");
  expect(qaHint({ getKeys: (id) => id === "guided-review.decide" ? ["D", "ctrl+d"] : id === "guided-review.finish" ? ["X"] : [] }))
    .toBe("D/ctrl+d decide · X finish");
  expect(qaHint({ getKeys: () => [] })).toBe("");
});

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

describe("parsePullRequestUrl", () => {
  test("parses GitHub and enterprise PR URLs, including trailing paths and queries", () => {
    expect(parsePullRequestUrl("https://github.com/owner/repo/pull/42")).toEqual({ host: "github.com", owner: "owner", repo: "repo", number: 42 });
    expect(parsePullRequestUrl("https://github.example.com/team/project/pull/123/files?diff=split")).toEqual({
      host: "github.example.com", owner: "team", repo: "project", number: 123,
    });
    expect(parsePullRequestUrl("https://github.com/owner/repo/pull/42?diff=split")?.number).toBe(42);
  });

  test("rejects URLs that do not name a pull request", () => {
    for (const url of ["", "not a URL", "https://github.com/owner/repo", "https://github.com/owner/repo/issues/42", "https://github.com/o/r/pull/nope"]) {
      expect(parsePullRequestUrl(url)).toBeNull();
    }
  });
});

describe("githubCommentArgs", () => {
  const target = { host: "github.example.com", owner: "owner", repo: "repo", number: 42 };

  test("posts at the head SHA and new-side line with the body as one argument", () => {
    expect(githubCommentArgs(target, "abc123", anchor, "Fix 'the bound'.\nKeep evidence.")).toEqual([
      "api", "--hostname", "github.example.com", "--method", "POST", "repos/owner/repo/pulls/42/comments",
      "-f", "body=Fix 'the bound'.\nKeep evidence.", "-f", "commit_id=abc123", "-f", "path=src/a.ts",
      "-F", "line=10", "-f", "side=RIGHT",
    ]);
  });

  test("uses LEFT for an old-side anchor", () => {
    expect(githubCommentArgs(target, "abc123", { path: "deleted.ts", side: "old", line: 7 }, "Restore this.")).toEqual([
      "api", "--hostname", "github.example.com", "--method", "POST", "repos/owner/repo/pulls/42/comments",
      "-f", "body=Restore this.", "-f", "commit_id=abc123", "-f", "path=deleted.ts",
      "-F", "line=7", "-f", "side=LEFT",
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

  test("comment requests reach wait, but answer fails without a PR URL", async () => {
    const tour = join(dir, "comment.tour.json");
    const paths = mailboxPaths(tour);
    const request: Request = { id: "q-1", seq: 1, at: "t1", kind: "comment", stop, body: "- Runs one extra attempt." };
    await writeJsonAtomic(paths.session, session(tour));
    await writeJsonAtomic(requestPath(paths, request.id), request);
    expect(json((await run(runWait, [tour], dir)).stdout).items).toEqual([{ tour, ...request }]);
    for (const value of [{}, { url: "not a PR" }, { url: 42 }]) {
      await writeJsonAtomic(tour, value);
      const result = await run(runAnswer, [tour, request.id, "--text", "Fix the loop bound."], dir);
      expect(result.result).toEqual({ kind: "exit", code: 1 });
      expect(result.stderr).toContain('tour has no PR url; add "url" to the tour or post the comment yourself');
      expect(await Bun.file(answerPath(paths, request.id)).exists()).toBe(false);
    }
  });

  test.each([false, true])("comment answer posts to GitHub before Hunk, gh failure=%s", async (failGh) => {
    const bin = mkdtempSync(join(dir, "bin-"));
    const tour = join(bin, "post.tour.json");
    const paths = mailboxPaths(tour);
    const callsPath = join(bin, "calls.jsonl");
    const text = "Use < instead of <= to avoid an extra attempt.";
    const htmlUrl = "https://github.example.com/o/r/pull/42#discussion_r123";
    await writeJsonAtomic(tour, { url: "https://github.example.com/o/r/pull/42" });
    await writeJsonAtomic(paths.session, session(tour, { repo: bin }));
    await writeJsonAtomic(requestPath(paths, "q-1"), { id: "q-1", seq: 1, at: "t1", kind: "comment", stop, body: "- Extra attempt." });
    for (const command of ["gh", "hunk"]) {
      writeFileSync(join(bin, command), `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ command: "${command}", args, cwd: process.cwd() }) + "\\n");
if ("${command}" === "gh" && ${failGh}) {
  console.error("gh: line must be part of the diff (HTTP 422)");
  process.exit(1);
}
console.log(JSON.stringify("${command}" === "gh"
  ? { html_url: ${JSON.stringify(htmlUrl)} }
  : args[1] === "list"
    ? { sessions: [{ sessionId: "mine", pid: ${process.pid} }] }
    : { result: { commentId: "mcp:42" } }));
`, { mode: 0o755 });
    }
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ""}`;
    try {
      const result = await run(runAnswer, [tour, "q-1", "--text", text], dir);
      const calls = (await Bun.file(callsPath).text()).trim().split("\n").map(json);
      expect(calls[0]).toEqual({
        command: "gh",
        args: githubCommentArgs({ host: "github.example.com", owner: "o", repo: "r", number: 42 }, "bbb", anchor, text),
        cwd: realpathSync(bin),
      });
      if (failGh) {
        expect(result.result).toEqual({ kind: "exit", code: 1 });
        expect(result.stderr).toContain("gh: line must be part of the diff (HTTP 422)");
        expect(calls).toHaveLength(1);
        expect(await Bun.file(answerPath(paths, "q-1")).exists()).toBe(false);
      } else {
        expect(result.result).toEqual({ kind: "exit", code: 0 });
        expect(result.stderr).toBe("");
        expect(calls.map((call) => call.command)).toEqual(["gh", "hunk", "hunk"]);
        expect(calls[2].args).toEqual(sessionAddArgs({ kind: "anchored", anchor, summary: "Posted to PR: Loop bound", rationale: `${text}\n\n${htmlUrl}` }, "mine"));
        expect(await Bun.file(answerPath(paths, "q-1")).json()).toMatchObject({ id: "q-1", commentId: "mcp:42", text });
        expect(json((await run(runAnswer, [tour, "q-1", "--text", text], dir)).stdout).status).toBe("already-answered");
        expect((await Bun.file(callsPath).text()).trim().split("\n")).toHaveLength(3);
      }
    } finally {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
    }
  });
});
