import { describe, expect, test } from "bun:test";
import {
  agentStatus,
  classifyNote,
  decisions,
  emptyMailbox,
  needsReply,
  ownsSession,
  parseAnswer,
  parseHeartbeat,
  parseRequest,
  parseSession,
  pending,
  postPlan,
  requestLabel,
  reviewEnd,
  statusText,
  transcript,
  type Answer,
  type Mailbox,
  type Request,
  type SessionRecord,
  type StopRef,
} from "../src/index";

const anchor = { path: "src/a.ts", side: "new" as const, line: 10 };
const stopRef: StopRef = { number: 2, id: "loop", title: "Loop bound", ask: "Block on this?", anchor };

type Of<K extends Request["kind"]> = Extract<Request, { kind: K }>;

function base(seq: number) {
  return { id: `q-${seq}` as const, seq, at: `2026-10-14T10:00:0${seq}Z`, stop: null };
}

const samples = {
  question: (seq: number, rest: Partial<Of<"question">> = {}): Request =>
    ({ ...base(seq), kind: "question", noteId: "user:1", anchor, text: "why", ...rest }) as Of<"question">,
  followup: (seq: number, rest: Partial<Of<"followup">> = {}): Request =>
    ({ ...base(seq), kind: "followup", noteId: "user:2", parentId: "mcp:1", anchor, text: "still why", ...rest }) as Of<"followup">,
  ask: (seq: number, rest: Partial<Of<"ask">> = {}): Request => ({ ...base(seq), kind: "ask", anchor, text: "general", ...rest }) as Of<"ask">,
  decision: (seq: number, rest: Partial<Of<"decision">> = {}): Of<"decision"> =>
    ({ ...base(seq), kind: "decision", stop: stopRef, decision: "agree", comment: "", ...rest }) as Of<"decision">,
};

function request<K extends Request["kind"]>(seq: number, { kind, ...rest }: { kind: K } & Partial<Of<K>>): Request {
  return samples[kind](seq, rest as never);
}

function answer(id: string, commentId: string | null = "mcp:1"): Answer {
  return { id, commentId, text: "- because", at: "2026-10-14T10:05:00Z" };
}

function mailbox(requests: Request[], answers: Answer[] = [], rest: Partial<Mailbox> = {}): Mailbox {
  return { ...emptyMailbox(), requests, answers: new Map(answers.map((a) => [a.id, a])), ...rest };
}

const session: SessionRecord = {
  repo: "/repo",
  tourPath: "/repo/.git/guided-review/pr-1.tour.json",
  head: "bbb",
  pid: 4242,
  openedAt: "2026-10-14T09:00:00Z",
};

describe("parse", () => {
  test("round-trips every request kind and rejects bad shapes", () => {
    const samples = [
      request(1, { kind: "question" }),
      request(2, { kind: "followup" }),
      request(3, { kind: "ask", stop: stopRef }),
      request(4, { kind: "decision", decision: "disagree", comment: "no" }),
    ];
    for (const sample of samples) expect(parseRequest(JSON.parse(JSON.stringify(sample)))).toEqual(sample);
    expect(parseRequest(null)).toBeNull();
    expect(parseRequest({ ...request(1, { kind: "question" }), id: "1" })).toBeNull();
    expect(parseRequest({ ...request(1, { kind: "question" }), noteId: 7 })).toBeNull();
    expect(parseRequest({ ...request(1, { kind: "decision" }), stop: null })).toBeNull();
    expect(parseRequest({ ...request(1, { kind: "decision" }), decision: "maybe" })).toBeNull();
    expect(parseRequest({ ...request(1, { kind: "ask" }), kind: "shout" })).toBeNull();
    expect(parseRequest({ ...request(1, { kind: "ask" }), stop: { number: 1 } })).toBeNull();
  });

  test("answers, heartbeats, and sessions", () => {
    expect(parseAnswer(answer("q-1"))).toEqual(answer("q-1"));
    expect(parseAnswer(answer("q-1", null))).toEqual(answer("q-1", null));
    expect(parseAnswer({ id: "q-1", at: "x" })).toBeNull();
    expect(parseHeartbeat({ pid: 1, until: "2026" })).toEqual({ pid: 1, until: "2026" });
    expect(parseHeartbeat({ pid: 0, until: "2026" })).toBeNull();
    expect(parseSession(session)).toEqual(session);
    const ended = { ...session, finishedAt: "t1", closedAt: "t2" };
    expect(parseSession(ended)).toEqual(ended);
    expect(parseSession({ ...session, finishedAt: 3 })).toBeNull();
    expect(parseSession({ ...session, pid: "4242" })).toBeNull();
  });
});

describe("classifyNote", () => {
  const box = mailbox([request(1, { kind: "question", noteId: "user:1" })], [answer("q-1", "mcp:9")]);

  test("every top-level note is a question", () => {
    expect(classifyNote({ id: "user:5", body: "Is this comment too verbose?" }, box)).toEqual({ kind: "question", text: "Is this comment too verbose?" });
    expect(classifyNote({ id: "user:5", body: "  plain note  " }, box)).toEqual({ kind: "question", text: "plain note" });
    expect(classifyNote({ id: "user:5", body: "? why" }, box)).toEqual({ kind: "question", text: "? why" });
    expect(classifyNote({ id: "user:5", body: "   " }, box)).toBeNull();
  });

  test("a reply inside a Q&A thread is a follow-up", () => {
    expect(classifyNote({ id: "user:6", parentId: "mcp:9", body: "and the test?" }, box)).toEqual({
      kind: "followup",
      parentId: "mcp:9",
      text: "and the test?",
    });
    expect(classifyNote({ id: "user:6", parentId: "user:1", body: "more" }, box)).toEqual({ kind: "followup", parentId: "user:1", text: "more" });
    expect(classifyNote({ id: "user:6", parentId: "user:77", body: "outside a thread" }, box)).toEqual({ kind: "question", text: "outside a thread" });
  });
});

describe("projections", () => {
  const requests = [
    request(3, { kind: "decision", decision: "unsure", comment: "" }),
    request(1, { kind: "question" }),
    request(2, { kind: "decision", decision: "agree", comment: "" }),
    request(4, { kind: "decision", stop: { ...stopRef, number: 5 }, decision: "agree", comment: "with a caveat" }),
    request(5, { kind: "ask" }),
  ];

  test("needsReply is false only for a bare agree", () => {
    expect(needsReply(request(1, { kind: "decision", decision: "agree", comment: " " }))).toBe(false);
    expect(needsReply(request(1, { kind: "decision", decision: "agree", comment: "but" }))).toBe(true);
    expect(needsReply(request(1, { kind: "decision", decision: "disagree", comment: "" }))).toBe(true);
    expect(needsReply(request(1, { kind: "ask" }))).toBe(true);
  });

  test("pending lists unanswered requests that need a reply, by seq", () => {
    expect(pending(mailbox(requests)).map((r) => r.id)).toEqual(["q-1", "q-3", "q-4", "q-5"]);
    expect(pending(mailbox(requests, [answer("q-1"), answer("q-4")])).map((r) => r.id)).toEqual(["q-3", "q-5"]);
  });

  test("decisions keep the latest per stop number", () => {
    expect([...decisions(mailbox(requests))]).toEqual([
      [2, "unsure"],
      [5, "agree"],
    ]);
  });

  test("transcript pairs every request with its answer status", () => {
    const entries = transcript(mailbox(requests, [answer("q-1")]));
    expect(entries.map((e) => [e.request.id, e.status, e.answer?.commentId ?? null])).toEqual([
      ["q-1", "answered", "mcp:1"],
      ["q-2", "noted", null],
      ["q-3", "pending", null],
      ["q-4", "pending", null],
      ["q-5", "pending", null],
    ]);
  });

  test("requestLabel names a request in one line", () => {
    expect(requestLabel(request(1, { kind: "ask", text: "x".repeat(100) }))).toBe(`${"x".repeat(79)}…`);
    expect(requestLabel(request(4, { kind: "decision", decision: "disagree", comment: "nope" }))).toBe("Stop 2 · disagree: nope");
  });
});

describe("agent status and status text", () => {
  const now = Date.parse("2026-10-14T10:00:00Z");

  test("heartbeat decides listening, away, or never", () => {
    expect(agentStatus(emptyMailbox(), now)).toEqual({ kind: "never" });
    const live = mailbox([], [], { heartbeat: { pid: 1, until: "2026-10-14T10:01:00Z" } });
    expect(agentStatus(live, now)).toEqual({ kind: "listening" });
    const stale = mailbox([], [], { heartbeat: { pid: 1, until: "2026-10-14T09:57:00Z" } });
    expect(agentStatus(stale, now)).toEqual({ kind: "away", sinceMs: 180_000 });
  });

  test("statusText summarises decisions, waiting count, and the agent", () => {
    const box = mailbox(
      [request(1, { kind: "decision", decision: "disagree", comment: "" }), request(2, { kind: "ask" })],
      [answer("q-2")],
      { heartbeat: { pid: 1, until: "2026-10-14T09:57:00Z" } },
    );
    expect(statusText(box, 6, now)).toBe("Decided 1/6 · 1 waiting · agent away 3m");
    expect(statusText(emptyMailbox(), 6, now)).toBe("Decided 0/6 · 0 waiting · no agent yet");
  });
});

describe("reviewEnd", () => {
  const alive = () => true;
  const dead = () => false;

  test("needs a session, then finished beats closed, then a dead TUI counts as closed", () => {
    expect(reviewEnd(emptyMailbox(), dead)).toBeNull();
    expect(reviewEnd(mailbox([], [], { session }), alive)).toBeNull();
    expect(reviewEnd(mailbox([], [], { session: { ...session, finishedAt: "t", closedAt: "t" } }), dead)).toEqual({ kind: "finished" });
    expect(reviewEnd(mailbox([], [], { session: { ...session, closedAt: "t" } }), alive)).toEqual({ kind: "closed" });
    expect(reviewEnd(mailbox([], [], { session }), dead)).toEqual({ kind: "closed" });
  });
});

describe("ownsSession", () => {
  test("only the same pid and openedAt own the session on disk", () => {
    expect(ownsSession(null, session)).toBe(false);
    expect(ownsSession({ ...session, pid: session.pid + 1 }, session)).toBe(false);
    expect(ownsSession({ ...session, openedAt: "2026-10-14T10:00:00Z" }, session)).toBe(false);
    expect(ownsSession({ ...session }, session)).toBe(true);
  });
});

describe("postPlan", () => {
  test("questions and follow-ups reply in the thread with the first line as summary", () => {
    expect(postPlan(request(1, { kind: "question", noteId: "user:1" }), "- Because N counts the first try.\n\nSee the loop.\nAnd the test.")).toEqual({
      kind: "reply",
      noteId: "user:1",
      summary: "Because N counts the first try.",
      rationale: "See the loop.\nAnd the test.",
    });
    expect(postPlan(request(2, { kind: "followup", noteId: "user:2" }), "\nShort.")).toEqual({
      kind: "reply",
      noteId: "user:2",
      summary: "Short.",
      rationale: "",
    });
  });

  test("asks anchor at the request line with a Q: summary", () => {
    const long = "w".repeat(90);
    expect(postPlan(request(3, { kind: "ask", text: long }), "answer")).toEqual({
      kind: "anchored",
      anchor,
      summary: `Q: ${"w".repeat(76)}…`,
      rationale: "answer",
    });
  });

  test("decisions anchor at the stop with the decision and comment", () => {
    expect(postPlan(request(4, { kind: "decision", decision: "disagree", comment: "too strict" }), "Fair point.")).toEqual({
      kind: "anchored",
      anchor,
      summary: "Stop 2 · disagree: too strict",
      rationale: "Fair point.",
    });
    expect(postPlan(request(5, { kind: "decision", decision: "unsure", comment: "" }), "x").summary).toBe("Stop 2 · unsure");
  });
});
