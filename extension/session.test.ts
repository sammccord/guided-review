import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalBlockers, decisions, pending, type Request, type Tour } from "../core/src/index";
import { answerPath, mailboxPaths, readMailbox, requestPath, writeJsonAtomic } from "../core/src/mailbox";
import { stop, tour } from "../core/test/fixtures";
import { assertSessionTour, prepareSession, tourFingerprint } from "./session";
import { runAnswer, runApprove, runWait } from "./qa";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function setup() {
  const repo = await mkdtemp(join(tmpdir(), "guided-review-session-"));
  dirs.push(repo);
  const input = { repo, tourPath: join(repo, "review.tour.json"), tour: tour({ base: "a".repeat(40), head: "b".repeat(40), verdict: "approve", stops: [stop(), stop({ path: "second.go", title: "Second stop" })] }) };
  await writeJsonAtomic(input.tourPath, input.tour);
  return input;
}
async function seed(paths: ReturnType<typeof mailboxPaths>, reviewId?: string) {
  const id = reviewId ? `q-${reviewId}-1` as const : "q-1";
  const request: Request = { id, seq: 1, at: "old", kind: "decision", decision: "agree", comment: "", stop: { number: 1, title: "Old stop", ask: "Agree?", anchor: { path: "old.go", side: "new", line: 3 } } };
  await writeJsonAtomic(requestPath(paths, id), request);
  await writeJsonAtomic(answerPath(paths, id), { id, commentId: "old-note", text: "Old reply", at: "old" });
  await writeJsonAtomic(paths.agent, { pid: 1, until: "2099-01-01T00:00:00Z" });
  await writeJsonAtomic(paths.approved, { head: "old", url: "old" });
  return request;
}

test("an unchanged tour resumes decisions and answers, but refreshes close/finish markers", async () => {
  const input = await setup();
  const first = await prepareSession(input);
  await seed(first.paths, first.session.reviewId);
  await writeJsonAtomic(first.paths.session, { ...first.session, closedAt: "old", finishedAt: "old" });
  const resumed = await prepareSession(input);
  expect(resumed.paths).toEqual(first.paths);
  expect(resumed.session.reviewId).toBe(first.session.reviewId);
  expect(resumed.session.closedAt).toBeUndefined();
  expect(resumed.session.finishedAt).toBeUndefined();
  expect(decisions(resumed.box).get(1)).toBe("agree");
  expect(resumed.box.answers.size).toBe(1);
});

test.each(["head", "base", "url", "layer", "stop", "order", "fresh", "repo"])("isolates saved history on changed %s", async change => {
  const input = await setup();
  const first = await prepareSession(input);
  const oldRequest = await seed(first.paths, first.session.reviewId);
  const next = { ...input, tour: structuredClone(input.tour) };
  if (change === "head") next.tour.head = "c".repeat(40);
  if (change === "base") next.tour.base = "d".repeat(40);
  if (change === "url") next.tour.url = "https://github.com/other/repo/pull/2";
  if (change === "layer") next.tour.stack = { number: 5, current: 2, layers: [{ number: 2, title: "Layer", state: "open" }] };
  if (change === "stop") next.tour.tracks[0]!.stops[0]!.ask = "Different decision?";
  if (change === "order") next.tour.tracks[0]!.stops.reverse();
  if (change === "repo") next.repo = join(input.repo, "another-repo");
  const opened = await prepareSession({ ...next, fresh: change === "fresh" });
  expect(opened.session.reviewId).not.toBe(first.session.reviewId);
  expect(opened.paths).toEqual(mailboxPaths(input.tourPath));
  expect(opened.box.requests).toEqual([]);
  expect(opened.box.answers.size).toBe(0);
  expect(opened.box.heartbeat).toBeNull();
  expect(decisions(opened.box).size).toBe(0);
  expect(pending(opened.box)).toEqual([]);
  expect(approvalBlockers("approve", 1, opened.box)).toEqual(["1 of 1 stops undecided"]);
  expect(await Bun.file(opened.paths.approved).exists()).toBe(false);
  // Late old-generation writers cannot contaminate the active review.
  await seed(first.paths, first.session.reviewId);
  expect((await readMailbox(mailboxPaths(input.tourPath))).requests).toEqual([]);
  expect((await readMailbox(first.paths)).requests).toEqual([oldRequest]);
  let stderr = "";
  const result = await runAnswer([input.tourPath, oldRequest.id, "--text", "Late answer"], {
    cwd: input.repo, signal: new AbortController().signal, stdin: (async function* () {})(),
    stdout: { write: async () => {} }, stderr: { write: async text => { stderr += text; } },
  });
  expect(result).toEqual({ kind: "exit", code: 1 });
  expect(stderr).toContain("no request");
});

test("a fresh tour does not resurrect unanswered questions or their old replies", async () => {
  const input = await setup();
  const old = await prepareSession(input);
  await seed(old.paths, old.session.reviewId);
  const id = `q-${old.session.reviewId}-2` as const;
  await writeJsonAtomic(requestPath(old.paths, id), {
    id, seq: 2, at: "old", kind: "ask", text: "Question from the previous tour", stop: null,
    anchor: { path: "src/a.ts", side: "new", line: 10 },
  });
  expect(pending(await readMailbox(old.paths))).toHaveLength(1);
  const fresh = await prepareSession({ ...input, fresh: true });
  expect(pending(fresh.box)).toEqual([]);
  expect(fresh.box.answers.size).toBe(0);
  expect(pending(await readMailbox(old.paths))[0]!.id).toBe(id);
});

test("keeps stack layers isolated and never imports a legacy mailbox implicitly", async () => {
  const input = await setup();
  const legacy = mailboxPaths(input.tourPath);
  await seed(legacy);
  await writeJsonAtomic(legacy.session, { repo: input.repo, tourPath: input.tourPath, head: input.tour.head, pid: 1, openedAt: "old" });
  const first = await prepareSession(input);
  expect(first.box.requests).toEqual([]);
  expect((await readMailbox(legacy)).requests).toHaveLength(1);
  await seed(first.paths, first.session.reviewId);
  const layer = await prepareSession({ ...input, tourPath: join(input.repo, "layer.tour.json") });
  expect(layer.box.requests).toEqual([]);
  expect(layer.paths.root).not.toBe(first.paths.root);
});

test("fingerprint ignores object property order but detects edits before answering or approving", async () => {
  const input = await setup();
  const reordered = Object.fromEntries(Object.entries(input.tour).reverse()) as unknown as Tour;
  expect(tourFingerprint(input.repo, reordered)).toBe(tourFingerprint(input.repo, input.tour));
  const opened = await prepareSession(input);
  expect(() => assertSessionTour(opened.session, reordered)).not.toThrow();
  expect(() => assertSessionTour(opened.session, { ...input.tour, verdict: "discuss" })).toThrow("tour changed");
  expect(() => assertSessionTour({ ...opened.session, tourFingerprint: undefined }, input.tour)).toThrow("no saved identity");
});

test("wait, answer, and approval reject a tour edited without reopening, before external commands", async () => {
  const input = await setup();
  input.tour.url = "https://github.invalid/o/r/pull/42";
  await writeJsonAtomic(input.tourPath, input.tour);
  const opened = await prepareSession(input);
  const old = await seed(opened.paths, opened.session.reviewId);
  const secondId = `q-${opened.session.reviewId}-2`;
  await writeJsonAtomic(requestPath(opened.paths, secondId), { ...old, id: secondId, seq: 2, stop: { ...old.stop!, number: 2 } });
  const questionId = `q-${opened.session.reviewId}-3`;
  await writeJsonAtomic(requestPath(opened.paths, questionId), { id: questionId, seq: 3, at: "old", kind: "ask", anchor: old.stop!.anchor, stop: null, text: "Question" });
  await writeJsonAtomic(opened.paths.session, { ...opened.session, closedAt: "old" });
  input.tour.tracks[0]!.stops[0]!.ask = "Changed decision?";
  await writeJsonAtomic(input.tourPath, input.tour);
  // A regressed guard may invoke tools, but must never contact a real service in this test.
  const bin = join(input.repo, "bin");
  await Bun.write(join(bin, "gh"), '#!/bin/sh\necho "unexpected external call" >&2\nexit 1\n');
  await chmod(join(bin, "gh"), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  try {
    for (const [handler, args] of [[runWait, [input.tourPath]], [runAnswer, [input.tourPath, questionId, "--text", "Answer"]], [runApprove, [input.tourPath]]] as const) {
      let stderr = "";
      const result = await handler([...args], {
        cwd: input.repo, signal: new AbortController().signal, stdin: (async function* () {})(),
        stdout: { write: async () => {} }, stderr: { write: async text => { stderr += text; } },
      });
      expect(result).toEqual({ kind: "exit", code: 1 });
      expect(stderr).toContain("tour changed");
      expect(stderr).not.toContain("unexpected external call");
    }
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
  }
});
