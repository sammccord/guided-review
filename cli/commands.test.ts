import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noNotes, type CliContext, type CliResult, type NoteSink } from "./context";
import type { Decision, Request, SessionRecord, Tour } from "../core/src/index";
import { answerPath, mailboxPaths, requestPath, writeJsonAtomic } from "../core/src/mailbox";
import { runAnswer, runApprove, runWait } from "./commands";
import { githubApproveArgs, githubCommentArgs } from "./github";
import { hunkNotes, sessionAddArgs } from "./hunk";
import { tourFingerprint } from "./session";

const anchor = { path: "src/a.ts", side: "new" as const, line: 10 };
const stop = { number: 2, title: "Loop bound", ask: "Block?", anchor };
const HEAD = "b".repeat(40);
const tourData: Tour = {
  version: 1, title: "Review", url: "https://github.example.com/o/r/pull/42", base: "a".repeat(40), head: HEAD, verdict: "approve",
  summary: "- Safe change.", scope: { checked: [], unchecked: [] }, skipped: [],
  tracks: [{ title: "Bounds", summary: "- Check bounds.", stops: [1, 2].map(() => ({ ...anchor, kind: "inspect", title: stop.title, ask: stop.ask, body: "- Bound." })) }],
};

interface Run {
  result: CliResult;
  stdout: string;
  stderr: string;
}

async function run(handler: typeof runWait, args: string[], cwd: string, notes: NoteSink = hunkNotes): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const ctx: CliContext = {
    cwd,
    notes,
    signal: new AbortController().signal,
    program: `hunk --extension ${new URL("..", import.meta.url).pathname.replace(/\/$/, "")} tour`,
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
    head: HEAD,
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
    for (const value of ["x", "0", "-1", "Infinity", undefined]) {
      const result = await run(runWait, ["a.tour.json", "--away", ...(value === undefined ? [] : [value])], dir);
      expect(result.result).toEqual({ kind: "exit", code: 2 });
      expect(result.stderr).toBe("tour wait: --away needs a positive number of minutes\n");
    }
    expect((await run(runAnswer, ["a.tour.json", "q-1"], dir)).result).toEqual({ kind: "exit", code: 2 });
    expect((await run(runAnswer, ["a.tour.json", "q-1", "--text", "  "], dir)).result).toEqual({ kind: "exit", code: 2 });
  });

  test("idle after the timeout, with a heartbeat on disk", async () => {
    const tour = join(dir, "idle.tour.json");
    const { result, stdout } = await run(runWait, ["idle.tour.json", "--timeout", "0.2"], dir);
    expect(result).toEqual({ kind: "exit", code: 0 });
    expect(json(stdout)).toEqual({ kind: "idle", idleMinutes: 0, next: "wait again; do not end your turn" });
    const beat = await Bun.file(mailboxPaths(tour).agent).json();
    expect(beat.pid).toBe(process.pid);
    expect(Date.parse(beat.until)).toBeGreaterThan(Date.now() - 5000);
  });

  test("away after 30 minutes without reviewer activity", async () => {
    const tour = join(dir, "away.tour.json");
    await writeJsonAtomic(mailboxPaths(tour).session, session(tour, { openedAt: new Date(Date.now() - 31 * 60_000).toISOString() }));
    const { result, stdout } = await run(runWait, [tour, "--timeout", "0.01"], dir);
    expect(result).toEqual({ kind: "exit", code: 0 });
    expect(json(stdout)).toEqual({
      kind: "away", idleMinutes: 31, next: "stop waiting; tell the reviewer the agent paused and to say when to resume",
    });
  });

  test("recent activity keeps an old session idle", async () => {
    const tour = join(dir, "active.tour.json");
    await writeJsonAtomic(mailboxPaths(tour).session, session(tour, {
      openedAt: new Date(Date.now() - 60 * 60_000).toISOString(), activeAt: new Date().toISOString(),
    }));
    const { result, stdout } = await run(runWait, [tour, "--timeout", "0.01"], dir);
    expect(result).toEqual({ kind: "exit", code: 0 });
    expect(json(stdout)).toEqual({ kind: "idle", idleMinutes: 0, next: "wait again; do not end your turn" });
  });

  test("away accepts a custom positive threshold", async () => {
    const tour = join(dir, "custom-away.tour.json");
    await writeJsonAtomic(mailboxPaths(tour).session, session(tour, { openedAt: new Date(Date.now() - 60_000).toISOString() }));
    expect(json((await run(runWait, [tour, "--timeout", "0.01", "--away", "0.5"], dir)).stdout).kind).toBe("away");
  });

  test("most recently active open tour wins, including an unopened tour", async () => {
    const old = join(dir, "stack-old.tour.json");
    const recent = join(dir, "stack-recent.tour.json");
    const unopened = join(dir, "stack-unopened.tour.json");
    await writeJsonAtomic(mailboxPaths(old).session, session(old, { openedAt: new Date(Date.now() - 60 * 60_000).toISOString() }));
    await writeJsonAtomic(mailboxPaths(recent).session, session(recent, { openedAt: new Date().toISOString() }));
    expect(json((await run(runWait, [old, recent, "--timeout", "0.01"], dir)).stdout).kind).toBe("idle");
    await writeJsonAtomic(mailboxPaths(recent).session, session(recent, { openedAt: new Date().toISOString(), finishedAt: "t9" }));
    expect(json((await run(runWait, [old, recent, "--timeout", "0.01"], dir)).stdout).kind).toBe("away");
    expect(json((await run(runWait, [old, unopened, "--timeout", "0.01"], dir)).stdout).kind).toBe("idle");
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
    await writeJsonAtomic(tour, tourData);
    await writeJsonAtomic(paths.session, session(tour, { finishedAt: "t9" }));
    await writeJsonAtomic(requestPath(paths, "q-1"), decision(1, "agree"));
    await writeJsonAtomic(requestPath(paths, "q-2"), decision(2, "unsure"));
    const { stdout } = await run(runWait, [tour, "--timeout", "5"], dir);
    const payload = json(stdout);
    expect(payload.kind).toBe("finished");
    expect(payload.decisions).toEqual([{ tour, stop: 2, decision: "unsure" }]);
    expect(payload.approval).toEqual([{ tour, eligible: true, blockers: [] }]);
    expect(payload.transcript.map((entry: { request: Request; status: string }) => [entry.request.id, entry.status])).toEqual([
      ["q-1", "noted"],
      ["q-2", "pending"],
    ]);
    expect(payload.next).toBe("write the review draft");
  });

  test("closed when the TUI process is gone", async () => {
    const tour = join(dir, "gone.tour.json");
    await writeJsonAtomic(tour, tourData);
    await writeJsonAtomic(mailboxPaths(tour).session, session(tour, { pid: 2 ** 22 - 1 }));
    expect(json((await run(runWait, [tour], dir)).stdout).kind).toBe("closed");
  });

  test("final approval reports each tour independently", async () => {
    const tours = [join(dir, "eligible.tour.json"), join(dir, "ineligible.tour.json")];
    for (const [index, tour] of tours.entries()) {
      await writeJsonAtomic(tour, { ...tourData, verdict: index === 0 ? "approve" : "discuss" });
      const paths = mailboxPaths(tour);
      await writeJsonAtomic(paths.session, session(tour, { closedAt: "t9" }));
      await writeJsonAtomic(requestPath(paths, "q-1"), { ...decision(1, "agree"), stop: { ...stop, number: 1 } });
      await writeJsonAtomic(requestPath(paths, "q-2"), decision(2, "agree"));
    }
    expect(json((await run(runWait, tours, dir)).stdout).approval).toEqual([
      { tour: tours[0], eligible: true, blockers: [] },
      { tour: tours[1], eligible: false, blockers: ["verdict is discuss"] },
    ]);
  });

  test("approve rejects bad arguments and missing tours", async () => {
    for (const args of [[], ["x", "--text", "x"], ["x", "--body"], ["x", "--body", " "], ["x", "--body", "x", "extra"]]) {
      expect((await run(runApprove, args, dir)).result).toEqual({ kind: "exit", code: 2 });
    }
    expect((await run(runApprove, ["missing.json"], dir)).result).toEqual({ kind: "exit", code: 1 });
  });

  test.each(["open", "disagree", "verdict", "no-url"])("approve refuses %s before contacting GitHub", async (scenario) => {
    const tour = join(dir, `refuse-${scenario}.tour.json`);
    const paths = mailboxPaths(tour);
    await writeJsonAtomic(tour, { ...tourData, verdict: scenario === "verdict" ? "discuss" : "approve", url: scenario === "no-url" ? undefined : tourData.url });
    await writeJsonAtomic(paths.session, session(tour, scenario === "open" ? {} : { finishedAt: "t9" }));
    await writeJsonAtomic(requestPath(paths, "q-1"), { ...decision(1, "agree"), stop: { ...stop, number: 1 } });
    await writeJsonAtomic(requestPath(paths, "q-2"), decision(2, scenario === "disagree" ? "disagree" : "agree"));
    if (scenario === "disagree") {
      await writeJsonAtomic(answerPath(paths, "q-2"), { id: "q-2", commentId: null, text: "Answered", at: "t8" });
    }
    const result = await run(runApprove, [tour], dir);
    expect(result.result).toEqual({ kind: "exit", code: 1 });
    const reason = { open: "review has not ended", disagree: "stop 2: disagree", verdict: "verdict is discuss", "no-url": "tour has no PR url" }[scenario];
    expect(result.stderr).toContain(reason!);
    expect(await Bun.file(paths.approved).exists()).toBe(false);
  });

  test.each(["new", "unsure", "silent", "existing", "cached", "moved", "failure", "bad-response"])("approve handles %s with a pinned head and retry record", async (scenario) => {
    const bin = mkdtempSync(join(dir, "approve-bin-"));
    const tour = join(bin, "approve.tour.json");
    const paths = mailboxPaths(tour);
    const callsPath = join(bin, "calls.jsonl");
    const url = "https://github.example.com/o/r/pull/42#pullrequestreview-123";
    await writeJsonAtomic(tour, tourData);
    await writeJsonAtomic(paths.session, session(tour, { repo: bin, tourFingerprint: tourFingerprint(bin, tourData), closedAt: "t9" }));
    if (scenario !== "silent") {
      await writeJsonAtomic(requestPath(paths, "q-1"), { ...decision(1, "agree"), stop: { ...stop, number: 1 } });
      await writeJsonAtomic(requestPath(paths, "q-2"), decision(2, scenario === "unsure" ? "unsure" : "agree"));
    }
    if (scenario === "cached") await writeJsonAtomic(paths.approved, { url, head: HEAD, at: "t8" });
    else await writeJsonAtomic(paths.approved, { url: "old", head: "aaa", at: "t0" });
    writeFileSync(join(bin, "gh"), `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
if (${JSON.stringify(scenario)} === "failure") { console.error("gh: denied (HTTP 403)"); process.exit(1); }
const endpoint = "repos/o/r/pulls/42";
if (args.includes(endpoint)) console.log(JSON.stringify({ head: { sha: ${JSON.stringify(scenario === "moved" ? "ccc" : HEAD)} } }));
else if (args.includes("user")) console.log("reviewer");
else if (args.includes("--paginate")) console.log(JSON.stringify([
  [{ user: { login: "other" }, state: "APPROVED", commit_id: "${HEAD}" },
   { user: { login: "reviewer" }, state: "APPROVED", commit_id: "aaa" },
   { user: { login: "reviewer" }, state: "COMMENTED", commit_id: "${HEAD}" }],
  ${scenario === "existing" ? JSON.stringify([{ user: { login: "reviewer" }, state: "APPROVED", commit_id: HEAD, html_url: url }]) : "[]"}
]));
else console.log(JSON.stringify(${JSON.stringify(scenario === "bad-response" ? {} : { html_url: url })}));
`, { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ""}`;
    try {
      const result = await run(runApprove, [tour, "--body", "Reviewed bounds."], dir);
      const calls = await Bun.file(callsPath).exists() ? (await Bun.file(callsPath).text()).trim().split("\n").map(json) : [];
      const posts = ["new", "unsure", "silent"].includes(scenario);
      const succeeds = posts || ["existing", "cached"].includes(scenario);
      expect(result.result).toEqual({ kind: "exit", code: succeeds ? 0 : 1 });
      expect(calls).toHaveLength(scenario === "cached" ? 0 : scenario === "moved" || scenario === "failure" ? 1 : scenario === "existing" ? 3 : 4);
      if (scenario === "moved") expect(result.stderr).toContain(`PR head moved from ${HEAD} to ccc; re-run the review`);
      if (scenario === "failure") expect(result.stderr).toContain("gh: denied (HTTP 403)");
      if (scenario === "bad-response") expect(result.stderr).toContain("gh returned no review html_url");
      if (!succeeds) {
        expect((await Bun.file(paths.approved).json()).head).toBe("aaa");
        return;
      }
      expect(json(result.stdout)).toEqual({ status: posts ? "approved" : "already-approved", url });
      expect(await Bun.file(paths.approved).json()).toMatchObject({ url, head: HEAD });
      if (scenario !== "cached") {
        expect(calls[0]).toEqual({ args: ["api", "--hostname", "github.example.com", "repos/o/r/pulls/42"], cwd: realpathSync(bin) });
        expect(calls[1].args).toEqual(["api", "--hostname", "github.example.com", "user", "--jq", ".login"]);
        expect(calls[2].args).toEqual(["api", "--hostname", "github.example.com", "--paginate", "--slurp", "repos/o/r/pulls/42/reviews"]);
      }
      if (posts) expect(calls[3].args).toEqual(githubApproveArgs({ host: "github.example.com", owner: "o", repo: "r", number: 42 }, HEAD, "Reviewed bounds."));
      expect(json((await run(runApprove, [tour], dir)).stdout)).toEqual({ status: "already-approved", url });
      expect(await Bun.file(callsPath).exists() ? (await Bun.file(callsPath).text()).trim().split("\n").length : 0).toBe(calls.length);
    } finally {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
    }
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

  test("a host without notes records a process-free answer without invoking Hunk", async () => {
    const bin = mkdtempSync(join(dir, "no-notes-bin-"));
    const tour = join(bin, "answer.tour.json");
    const paths = mailboxPaths(tour);
    const callsPath = join(bin, "hunk-called");
    writeFileSync(join(bin, "hunk"), `#!/bin/sh\ntouch '${callsPath}'\nexit 1\n`, { mode: 0o755 });
    const { pid, ...hostSession } = session(tour);
    await writeJsonAtomic(paths.session, hostSession);
    await writeJsonAtomic(requestPath(paths, "q-1"), decision(1, "unsure"));
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ""}`;
    try {
      const result = await run(runAnswer, [tour, "q-1", "--text", "Answer"], dir, noNotes);
      expect(result).toEqual({ result: { kind: "exit", code: 0 }, stdout: '{"id":"q-1","status":"posted","commentId":null}\n', stderr: "" });
      expect(await Bun.file(answerPath(paths, "q-1")).json()).toMatchObject({ id: "q-1", commentId: null, text: "Answer" });
      expect(await Bun.file(callsPath).exists()).toBe(false);
      await expect(hunkNotes.post({ kind: "anchored", anchor, summary: "Answer", rationale: "" }, hostSession)).rejects.toThrow("the Hunk session for this tour is not running; reopen the tour");
      expect(await Bun.file(callsPath).exists()).toBe(false);
    } finally {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
    }
  });

  test.each([
    ["comment", "Posted to PR: Loop bound", false, true],
    ["comment", "Posted to PR: Loop bound", true, true],
    ["reviewer-comment", "Commented on PR: Loop bound", false, true],
    ["reviewer-comment", "Commented on PR: Loop bound", true, true],
    ["comment", "Posted to PR: Loop bound", false, false],
    ["reviewer-comment", "Commented on PR: Loop bound", false, false],
  ] as const)("%s answer posts to GitHub first, summary=%s gh failure=%s host notes=%s", async (kind, summary, failGh, hostNotes) => {
    const bin = mkdtempSync(join(dir, "bin-"));
    const tour = join(bin, "post.tour.json");
    const paths = mailboxPaths(tour);
    const callsPath = join(bin, "calls.jsonl");
    const text = "Use < instead of <= to avoid an extra attempt.";
    const htmlUrl = "https://github.example.com/o/r/pull/42#discussion_r123";
    await writeJsonAtomic(tour, { url: "https://github.example.com/o/r/pull/42" });
    await writeJsonAtomic(paths.session, session(tour, { repo: bin }));
    await writeJsonAtomic(requestPath(paths, "q-1"), { id: "q-1", seq: 1, at: "t1", kind, stop, body: "- Extra attempt." });
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
      const result = await run(runAnswer, [tour, "q-1", "--text", text], dir, hostNotes ? hunkNotes : noNotes);
      const calls = (await Bun.file(callsPath).text()).trim().split("\n").map(json);
      expect(calls[0]).toEqual({
        command: "gh",
        args: githubCommentArgs({ host: "github.example.com", owner: "o", repo: "r", number: 42 }, HEAD, anchor, text),
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
        expect(calls.map((call) => call.command)).toEqual(hostNotes ? ["gh", "hunk", "hunk"] : ["gh"]);
        if (hostNotes) expect(calls[2].args).toEqual(sessionAddArgs({ kind: "anchored", anchor, summary, rationale: `${text}\n\n${htmlUrl}` }, "mine"));
        expect(json(result.stdout)).toEqual({ id: "q-1", status: "posted", commentId: hostNotes ? "mcp:42" : null });
        expect(await Bun.file(answerPath(paths, "q-1")).json()).toMatchObject({ id: "q-1", commentId: hostNotes ? "mcp:42" : null, text });
        expect(json((await run(runAnswer, [tour, "q-1", "--text", text], dir)).stdout).status).toBe("already-answered");
        expect((await Bun.file(callsPath).text()).trim().split("\n")).toHaveLength(hostNotes ? 3 : 1);
      }
    } finally {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
    }
  });
});
