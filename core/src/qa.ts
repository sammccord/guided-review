import type { Verdict } from "./schema";

export type Side = "new" | "old";

export interface Anchor {
  path: string;
  side: Side;
  line: number;
}

/** The stop a request was made at, frozen so the record survives later tour edits. */
export interface StopRef {
  number: number;
  id?: string;
  title: string;
  ask: string;
  anchor: Anchor;
}

export const DECISIONS = ["agree", "disagree", "unsure"] as const;
export type Decision = (typeof DECISIONS)[number];

export const REVIEW_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const REQUEST_ID_PATTERN = /^q-(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-)?\d+$/;
export type RequestId = `q-${string}`;

interface RequestBase {
  id: RequestId;
  seq: number;
  at: string;
  stop: StopRef | null;
}

export type Request =
  | (RequestBase & { kind: "question"; noteId: string; anchor: Anchor; text: string })
  | (RequestBase & { kind: "followup"; noteId: string; parentId: string; anchor: Anchor; text: string })
  | (RequestBase & { kind: "ask"; anchor: Anchor; text: string })
  | (RequestBase & { kind: "decision"; stop: StopRef; decision: Decision; comment: string })
  | (RequestBase & { kind: "comment"; stop: StopRef; body: string });

export type RequestKind = Request["kind"];

export interface Answer {
  id: string;
  commentId: string | null;
  text: string;
  at: string;
}

export interface Heartbeat {
  pid: number;
  until: string;
}

export interface SessionRecord {
  repo: string;
  tourPath: string;
  head: string;
  pid: number;
  openedAt: string;
  activeAt?: string;
  finishedAt?: string;
  closedAt?: string;
  reviewId?: string;
  tourFingerprint?: string;
}

export function ownsSession(onDisk: SessionRecord | null, mine: SessionRecord): boolean {
  return onDisk !== null && onDisk.pid === mine.pid && onDisk.openedAt === mine.openedAt;
}

export interface Mailbox {
  session: SessionRecord | null;
  requests: Request[];
  answers: Map<string, Answer>;
  heartbeat: Heartbeat | null;
}

export function emptyMailbox(): Mailbox {
  return { session: null, requests: [], answers: new Map(), heartbeat: null };
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return isString(value) ? value : null;
}

function parseAnchor(raw: unknown): Anchor | null {
  if (!isObject(raw)) return null;
  const { path, side, line } = raw;
  if (!isString(path) || (side !== "new" && side !== "old") || !isPositiveInteger(line)) return null;
  return { path, side, line };
}

function parseStopRef(raw: unknown): StopRef | null {
  if (!isObject(raw)) return null;
  const { number, id, title, ask } = raw;
  const anchor = parseAnchor(raw.anchor);
  if (!isPositiveInteger(number) || !isString(title) || !isString(ask) || !anchor) return null;
  const parsedId = optionalString(id);
  if (parsedId === null) return null;
  return { number, ...(parsedId === undefined ? {} : { id: parsedId }), title, ask, anchor };
}

function parseBase(raw: Json): RequestBase | null {
  const { id, seq, at } = raw;
  if (!isString(id) || !REQUEST_ID_PATTERN.test(id) || !isPositiveInteger(seq) || !isString(at)) return null;
  const stop = raw.stop === null ? null : parseStopRef(raw.stop);
  if (raw.stop !== null && !stop) return null;
  return { id: id as RequestId, seq, at, stop };
}

export function parseRequest(raw: unknown): Request | null {
  if (!isObject(raw)) return null;
  const base = parseBase(raw);
  if (!base) return null;
  const { kind, text, noteId, parentId } = raw;
  switch (kind) {
    case "question": {
      const anchor = parseAnchor(raw.anchor);
      if (!isString(noteId) || !isString(text) || !anchor) return null;
      return { ...base, kind, noteId, anchor, text };
    }
    case "followup": {
      const anchor = parseAnchor(raw.anchor);
      if (!isString(noteId) || !isString(parentId) || !isString(text) || !anchor) return null;
      return { ...base, kind, noteId, parentId, anchor, text };
    }
    case "ask": {
      const anchor = parseAnchor(raw.anchor);
      if (!isString(text) || !anchor) return null;
      return { ...base, kind, anchor, text };
    }
    case "decision": {
      const { decision, comment } = raw;
      if (!base.stop || !DECISIONS.some((candidate) => candidate === decision) || !isString(comment)) return null;
      return { ...base, kind, stop: base.stop, decision: decision as Decision, comment };
    }
    case "comment": {
      if (!base.stop || !isString(raw.body)) return null;
      return { ...base, kind, stop: base.stop, body: raw.body };
    }
    default:
      return null;
  }
}

export function parseAnswer(raw: unknown): Answer | null {
  if (!isObject(raw)) return null;
  const { id, commentId, text, at } = raw;
  if (!isString(id) || !isString(text) || !isString(at) || (commentId !== null && !isString(commentId))) return null;
  return { id, commentId, text, at };
}

export function parseHeartbeat(raw: unknown): Heartbeat | null {
  if (!isObject(raw)) return null;
  const { pid, until } = raw;
  if (!isPositiveInteger(pid) || !isString(until)) return null;
  return { pid, until };
}

export function parseSession(raw: unknown): SessionRecord | null {
  if (!isObject(raw)) return null;
  const { repo, tourPath, head, pid, openedAt } = raw;
  if (!isString(repo) || !isString(tourPath) || !isString(head) || !isPositiveInteger(pid) || !isString(openedAt)) return null;
  const finishedAt = optionalString(raw.finishedAt);
  const closedAt = optionalString(raw.closedAt);
  const activeAt = optionalString(raw.activeAt);
  const reviewId = optionalString(raw.reviewId);
  const tourFingerprint = optionalString(raw.tourFingerprint);
  if (reviewId === null || (reviewId !== undefined && !REVIEW_ID_PATTERN.test(reviewId)) || tourFingerprint === null) return null;
  if (finishedAt === null || closedAt === null || activeAt === null) return null;
  return {
    repo,
    tourPath,
    head,
    pid,
    openedAt,
    ...(reviewId === undefined ? {} : { reviewId }),
    ...(tourFingerprint === undefined ? {} : { tourFingerprint }),
    ...(activeAt === undefined ? {} : { activeAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(closedAt === undefined ? {} : { closedAt }),
  };
}

export type NoteClass = { kind: "question"; text: string } | { kind: "followup"; parentId: string; text: string } | null;

function threadIds(box: Mailbox): Set<string> {
  const ids = new Set<string>();
  for (const request of box.requests) {
    if (request.kind === "question" || request.kind === "followup") ids.add(request.noteId);
  }
  for (const answer of box.answers.values()) {
    if (answer.commentId) ids.add(answer.commentId);
  }
  return ids;
}

export function classifyNote(
  note: { id: string; parentId?: string; body: string },
  box: Mailbox,
  extraThreadIds: ReadonlySet<string> = new Set(),
): NoteClass {
  const text = note.body.trim();
  if (text === "") return null;
  if (note.parentId !== undefined && (threadIds(box).has(note.parentId) || extraThreadIds.has(note.parentId))) {
    return { kind: "followup", parentId: note.parentId, text };
  }
  return { kind: "question", text };
}

export function needsReply(request: Request): boolean {
  return !(request.kind === "decision" && request.decision === "agree" && request.comment.trim() === "");
}

function bySeq(requests: readonly Request[]): Request[] {
  return [...requests].sort((a, b) => a.seq - b.seq);
}

export function pending(box: Mailbox): Request[] {
  return bySeq(box.requests).filter((request) => needsReply(request) && !box.answers.has(request.id));
}

export function decisions(box: Mailbox): Map<number, Decision> {
  const latest = new Map<number, Decision>();
  for (const request of bySeq(box.requests)) {
    if (request.kind === "decision") latest.set(request.stop.number, request.decision);
  }
  return latest;
}

export type CommentStatus = "none" | "pending" | "posted";

export function approvalBlockers(verdict: Verdict, stopCount: number, box: Mailbox): string[] {
  const blockers: string[] = [];
  if (verdict !== "approve") blockers.push(`verdict is ${verdict}`);
  const latest = decisions(box);
  for (const [stop, decision] of latest) {
    if (decision !== "agree") blockers.push(`stop ${stop}: ${decision}`);
  }
  let undecided = 0;
  for (let stop = 1; stop <= stopCount; stop++) {
    if (!latest.has(stop)) undecided++;
  }
  if (undecided > 0) blockers.push(`${undecided} of ${stopCount} stops undecided`);
  return blockers;
}

export function commentStatus(box: Mailbox, stopNumber: number): CommentStatus {
  const comments = box.requests.filter((request) => request.kind === "comment" && request.stop.number === stopNumber);
  if (comments.some((request) => box.answers.has(request.id))) return "posted";
  return comments.length > 0 ? "pending" : "none";
}

export type AgentStatus = { kind: "listening" } | { kind: "away"; sinceMs: number } | { kind: "never" };

export function reviewerIdleMs(box: Mailbox, now: number): number | null {
  if (!box.session) return null;
  const times = [
    box.session.openedAt,
    ...(box.session.activeAt === undefined ? [] : [box.session.activeAt]),
    ...box.requests.map((request) => request.at),
    ...[...box.answers.values()].map((answer) => answer.at),
  ].map(Date.parse).filter((time) => !Number.isNaN(time));
  const last = Math.max(...times);
  return Math.max(0, now - last);
}

export function agentStatus(box: Mailbox, now: number): AgentStatus {
  if (!box.heartbeat) return { kind: "never" };
  const until = Date.parse(box.heartbeat.until);
  if (Number.isNaN(until)) return { kind: "never" };
  return until > now ? { kind: "listening" } : { kind: "away", sinceMs: now - until };
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function agentText(status: AgentStatus): string {
  switch (status.kind) {
    case "listening":
      return "agent listening";
    case "away":
      return `agent away ${formatDuration(status.sinceMs)}`;
    case "never":
      return "no agent yet";
  }
}

export function statusText(box: Mailbox, stopCount: number, now: number): string {
  const waiting = pending(box).length;
  return `Decided ${decisions(box).size}/${stopCount} · ${waiting} waiting · ${agentText(agentStatus(box, now))}`;
}

export type ReviewEnd = { kind: "finished" } | { kind: "closed" } | null;

export function reviewEnd(box: Mailbox, pidAlive: (pid: number) => boolean): ReviewEnd {
  const { session } = box;
  if (!session) return null;
  if (session.finishedAt !== undefined) return { kind: "finished" };
  if (session.closedAt !== undefined || !pidAlive(session.pid)) return { kind: "closed" };
  return null;
}

export type PostPlan =
  | { kind: "reply"; noteId: string; summary: string; rationale: string }
  | { kind: "anchored"; anchor: Anchor; summary: string; rationale: string };

const SUMMARY_MAX = 80;

function truncate(text: string): string {
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text;
}

function splitLead(text: string): { summary: string; rationale: string } {
  const lines = text.split("\n");
  const lead = lines.findIndex((line) => line.trim() !== "");
  if (lead < 0) return { summary: "", rationale: "" };
  const summary = lines[lead]!.trim().replace(/^- /, "");
  const rationale = lines.slice(lead + 1).join("\n").trim();
  return { summary, rationale };
}

export function decisionLabel(request: Extract<Request, { kind: "decision" }>): string {
  const comment = request.comment.trim();
  return `Stop ${request.stop.number} · ${request.decision}${comment === "" ? "" : `: ${comment}`}`;
}

export function postPlan(request: Request, text: string): PostPlan {
  switch (request.kind) {
    case "question":
    case "followup":
      return { kind: "reply", noteId: request.noteId, ...splitLead(text) };
    case "ask":
      return { kind: "anchored", anchor: request.anchor, summary: truncate(`Q: ${request.text}`), rationale: text };
    case "decision":
      return { kind: "anchored", anchor: request.stop.anchor, summary: truncate(decisionLabel(request)), rationale: text };
    case "comment":
      return { kind: "anchored", anchor: request.stop.anchor, summary: truncate(`Posted to PR: ${request.stop.title}`), rationale: text };
  }
}

export const PLACEHOLDER_TEXT = "⋯ Waiting for the agent";

export function placeholderPlan(request: Request): PostPlan {
  return { ...postPlan(request, ""), summary: PLACEHOLDER_TEXT, rationale: "" };
}

export interface PlaceholderDiff {
  create: Request[];
  remove: string[];
}

export function placeholderDiff(
  waiting: readonly Request[],
  posted: ReadonlyMap<string, string>,
  inFlight: ReadonlySet<string>,
): PlaceholderDiff {
  const ids = new Set<string>(waiting.map((request) => request.id));
  return {
    create: waiting.filter((request) => !posted.has(request.id) && !inFlight.has(request.id)),
    remove: [...posted.keys()].filter((id) => !ids.has(id)),
  };
}

export function requestLabel(request: Request): string {
  switch (request.kind) {
    case "question":
    case "followup":
    case "ask":
      return truncate(request.text);
    case "decision":
      return truncate(decisionLabel(request));
    case "comment":
      return truncate(`Post to PR: #${request.stop.number} ${request.stop.title}`);
  }
}

export type TranscriptStatus = "answered" | "pending" | "noted";

export interface TranscriptEntry {
  request: Request;
  answer: Answer | null;
  status: TranscriptStatus;
}

export function transcript(box: Mailbox): TranscriptEntry[] {
  return bySeq(box.requests).map((request) => {
    const answer = box.answers.get(request.id) ?? null;
    const status: TranscriptStatus = answer ? "answered" : needsReply(request) ? "pending" : "noted";
    return { request, answer, status };
  });
}
