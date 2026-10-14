import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { useSyncExternalStore } from "react";
import type {
  ExtensionCliCommandContext,
  ExtensionCliCommandResult,
  ExtensionCliWriter,
  ExtensionCommandContext,
  ExtensionEventContext,
  ExtensionReviewNote,
  HunkExtensionAPI,
} from "hunkdiff/extension";
import {
  classifyNote,
  DECISIONS,
  decisions,
  emptyMailbox,
  ownsSession,
  pending,
  postPlan,
  requestLabel,
  reviewEnd,
  statusText,
  transcript,
  type Anchor,
  type Decision,
  type Mailbox,
  type PostPlan,
  type Request,
  type ReviewEnd,
  type SessionRecord,
  type StopRef,
  type TourStop,
} from "../core/src/index";
import {
  answerPath,
  mailboxPaths,
  nextSeq,
  readMailbox,
  readSessionSync,
  requestPath,
  writeJsonAtomic,
  writeJsonAtomicSync,
  type MailboxPaths,
} from "../core/src/mailbox";

const EXTENSION_DIR = resolve(import.meta.dir, "..");
const WAIT_DEFAULT_SECONDS = 90;
const ANSWERING_SECONDS = 600;
const POLL_MS = 1000;
const TUI_POLL_MS = 2000;
const STATUS_ID = "qa";

export const QA_USAGE = [
  "usage: hunk tour check|open <tour.json>",
  "       hunk tour wait <tour.json>... [--timeout <seconds>]",
  "       hunk tour answer <tour.json> <id> --text <answer>",
];

function now(): string {
  return new Date().toISOString();
}

async function writeLine(writer: ExtensionCliWriter, value: unknown) {
  await writer.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      done();
    });
  });
}

interface WaitArgs {
  tours: string[];
  timeoutMs: number;
}

function parseWaitArgs(args: readonly string[], cwd: string): WaitArgs | string {
  const tours: string[] = [];
  let timeoutMs = WAIT_DEFAULT_SECONDS * 1000;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--timeout") {
      const seconds = Number(args[++i]);
      if (!Number.isFinite(seconds) || seconds <= 0) return "--timeout needs a positive number of seconds";
      timeoutMs = seconds * 1000;
    } else if (arg.startsWith("--")) {
      return `unknown option ${arg}`;
    } else {
      tours.push(resolve(cwd, arg));
    }
  }
  if (tours.length === 0) return "wait needs at least one tour file";
  return { tours, timeoutMs };
}

interface TourBox {
  tour: string;
  paths: MailboxPaths;
  box: Mailbox;
}

async function readAll(tours: readonly string[]): Promise<TourBox[]> {
  return Promise.all(
    tours.map(async (tour) => {
      const paths = mailboxPaths(tour);
      return { tour, paths, box: await readMailbox(paths) };
    }),
  );
}

function heartbeat(boxes: readonly TourBox[], seconds: number): Promise<unknown> {
  const until = new Date(Date.now() + seconds * 1000).toISOString();
  return Promise.all(boxes.map(({ paths }) => writeJsonAtomic(paths.agent, { pid: process.pid, until })));
}

function answerCommand(tour: string, id: string): string {
  return `hunk --extension ${EXTENSION_DIR} tour answer ${tour} ${id} --text '<answer>'`;
}

function finalPayload(boxes: readonly TourBox[], ends: readonly Exclude<ReviewEnd, null>[]) {
  return {
    kind: ends.every((end) => end.kind === "finished") ? "finished" : "closed",
    decisions: boxes.flatMap(({ tour, box }) => [...decisions(box)].map(([stop, decision]) => ({ tour, stop, decision }))),
    transcript: boxes.flatMap(({ tour, box }) => transcript(box).map((entry) => ({ tour, ...entry }))),
    next: "write the review draft",
  };
}

export async function runWait(args: readonly string[], ctx: ExtensionCliCommandContext): Promise<ExtensionCliCommandResult> {
  const parsed = parseWaitArgs(args, ctx.cwd);
  if (typeof parsed === "string") {
    await writeLine(ctx.stderr, `tour wait: ${parsed}`);
    return { kind: "exit", code: 2 };
  }
  const deadline = Date.now() + parsed.timeoutMs;
  let boxes = await readAll(parsed.tours);
  await heartbeat(boxes, parsed.timeoutMs / 1000);

  while (!ctx.signal.aborted) {
    const ends = boxes.map(({ box }) => reviewEnd(box, pidAlive));
    const items = boxes.flatMap(({ tour, box }, index) => (ends[index] ? [] : pending(box).map((request) => ({ tour, ...request }))));
    if (items.length > 0) {
      await heartbeat(boxes, ANSWERING_SECONDS);
      const first = items[0]!;
      await writeLine(ctx.stdout, {
        kind: "pending",
        items,
        next: `answer each with: ${answerCommand(first.tour, first.id)} then wait again`,
      });
      return { kind: "exit", code: 0 };
    }
    if (ends.every((end) => end !== null)) {
      await writeLine(ctx.stdout, finalPayload(boxes, ends.filter((end) => end !== null)));
      return { kind: "exit", code: 0 };
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(POLL_MS, deadline - Date.now()), ctx.signal);
    boxes = await readAll(parsed.tours);
  }
  await writeLine(ctx.stdout, { kind: "idle", next: "wait again" });
  return { kind: "exit", code: 0 };
}

/** `--repo` is ambiguous when two Hunk sessions share the worktree, so answers address the mailbox owner's session by pid. */
export function sessionIdForPid(list: unknown, pid: number): string | null {
  if (typeof list !== "object" || list === null) return null;
  const sessions = (list as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) return null;
  for (const entry of sessions) {
    const { sessionId, pid: entryPid } = (entry ?? {}) as { sessionId?: unknown; pid?: unknown };
    if (entryPid === pid && typeof sessionId === "string") return sessionId;
  }
  return null;
}

export function sessionAddArgs(plan: PostPlan, sessionId: string): string[] {
  const target =
    plan.kind === "reply"
      ? ["--reply-to", plan.noteId]
      : ["--file", plan.anchor.path, plan.anchor.side === "new" ? "--new-line" : "--old-line", String(plan.anchor.line)];
  const rationale = plan.rationale === "" ? [] : ["--rationale", plan.rationale];
  return ["session", "comment", "add", sessionId, ...target, "--summary", plan.summary, ...rationale, "--author", "guided-review", "--json"];
}

function runHunk(args: readonly string[]): Promise<string> {
  return new Promise((done, fail) => {
    execFile("hunk", args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) fail(new Error(String(stderr).trim() || error.message));
      else done(String(stdout));
    });
  });
}

function commentIdOf(output: string): string | null {
  try {
    const parsed: unknown = JSON.parse(output);
    if (typeof parsed !== "object" || parsed === null) return null;
    const result = (parsed as { result?: unknown }).result;
    if (typeof result !== "object" || result === null) return null;
    const id = (result as { commentId?: unknown }).commentId;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

function parseAnswerArgs(args: readonly string[], cwd: string): { tour: string; id: string; text: string } | string {
  const [tour, id, flag, text, ...extra] = args;
  if (!tour || !id || flag !== "--text" || text === undefined || extra.length > 0) return QA_USAGE.join("\n");
  if (text.trim() === "") return "tour answer: --text must not be empty";
  return { tour: resolve(cwd, tour), id, text };
}

export async function runAnswer(args: readonly string[], ctx: ExtensionCliCommandContext): Promise<ExtensionCliCommandResult> {
  const parsed = parseAnswerArgs(args, ctx.cwd);
  if (typeof parsed === "string") {
    await writeLine(ctx.stderr, parsed);
    return { kind: "exit", code: 2 };
  }
  const paths = mailboxPaths(parsed.tour);
  const box = await readMailbox(paths);
  const request = box.requests.find((candidate) => candidate.id === parsed.id);
  if (!request) {
    await writeLine(ctx.stderr, `tour answer: no request ${parsed.id} in ${paths.inbox}`);
    return { kind: "exit", code: 1 };
  }
  if (box.answers.has(request.id)) {
    await writeLine(ctx.stdout, { id: request.id, status: "already-answered" });
    return { kind: "exit", code: 0 };
  }
  if (!box.session) {
    await writeLine(ctx.stderr, `tour answer: ${paths.session} is missing; open the tour in Hunk first`);
    return { kind: "exit", code: 1 };
  }
  const plan = postPlan(request, parsed.text);
  if (plan.summary === "") {
    await writeLine(ctx.stderr, "tour answer: the answer has no text on its first line");
    return { kind: "exit", code: 2 };
  }
  let commentId: string | null;
  try {
    const sessionId = sessionIdForPid(JSON.parse(await runHunk(["session", "list", "--json"])), box.session.pid);
    if (!sessionId) {
      await writeLine(ctx.stderr, `tour answer: the Hunk session for this tour (pid ${box.session.pid}) is not running; reopen the tour`);
      return { kind: "exit", code: 1 };
    }
    commentId = commentIdOf(await runHunk(sessionAddArgs(plan, sessionId)));
  } catch (error) {
    await writeLine(ctx.stderr, `tour answer: hunk session failed: ${error instanceof Error ? error.message : String(error)}`);
    return { kind: "exit", code: 1 };
  }
  await writeJsonAtomic(answerPath(paths, request.id), { id: request.id, commentId, text: parsed.text, at: now() });
  await writeLine(ctx.stdout, { id: request.id, status: "posted", commentId });
  return { kind: "exit", code: 0 };
}

interface QaState {
  paths: MailboxPaths | null;
  session: SessionRecord | null;
  box: Mailbox;
}

let state: QaState = { paths: null, session: null, box: emptyMailbox() };
const listeners = new Set<() => void>();

function setState(next: QaState) {
  state = next;
  for (const listener of listeners) listener();
}

export function useMailbox(): Mailbox {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state.box,
  );
}

export function decisionBadge(decision: Decision): string {
  switch (decision) {
    case "agree":
      return "✓";
    case "disagree":
      return "✗";
    case "unsure":
      return "?";
  }
}

/** Called from `tour open`, in the process that becomes the TUI, so `pid` is the TUI's own. */
export async function openSession(input: { repo: string; tourPath: string; head: string }): Promise<void> {
  const paths = mailboxPaths(input.tourPath);
  const session: SessionRecord = { ...input, pid: process.pid, openedAt: now() };
  await writeJsonAtomic(paths.session, session);
  setState({ paths, session, box: await readMailbox(paths) });
}

async function writeSession(patch: Partial<SessionRecord>): Promise<void> {
  if (!state.paths || !state.session) return;
  if (!ownsSession(readSessionSync(state.paths.session), state.session)) return;
  const session = { ...state.session, ...patch };
  setState({ ...state, session });
  await writeJsonAtomic(state.paths.session, session);
}

function stopRef(entry: TourStop): StopRef {
  const { number, stop } = entry;
  return {
    number,
    ...(stop.id === undefined ? {} : { id: stop.id }),
    title: stop.title,
    ask: stop.ask,
    anchor: { path: stop.path, side: stop.side, line: stop.line },
  };
}

type RequestBody = Request extends infer R ? (R extends Request ? Omit<R, "id" | "seq" | "at"> : never) : never;

async function writeRequest(paths: MailboxPaths, body: RequestBody): Promise<void> {
  const box = await readMailbox(paths);
  const seq = nextSeq(box);
  const request = { id: `q-${seq}`, seq, at: now(), ...body } as Request;
  await writeJsonAtomic(requestPath(paths, request.id), request);
  setState({ ...state, box: { ...box, requests: [...box.requests, request] } });
}

export interface TourAccess {
  currentStop(): TourStop | null;
  stopCount(): number;
}

function currentStopRef(access: TourAccess): StopRef | null {
  const current = access.currentStop();
  return current ? stopRef(current) : null;
}

async function onNoteCreated(note: ExtensionReviewNote, ctx: ExtensionEventContext, access: TourAccess) {
  const { paths } = state;
  if (!paths || note.draft) return;
  const kind = classifyNote(note, await readMailbox(paths));
  if (!kind) return;
  const anchor: Anchor = { path: note.filePath, side: note.side, line: note.line };
  const stop = currentStopRef(access);
  await writeRequest(
    paths,
    kind.kind === "question"
      ? { kind: "question", noteId: note.id, anchor, text: kind.text, stop }
      : { kind: "followup", noteId: note.id, parentId: kind.parentId, anchor, text: kind.text, stop },
  );
  ctx.notify("Question sent to the agent");
}

function selectedAnchor(ctx: ExtensionCommandContext): Anchor | null {
  const { file, currentLine } = ctx.selection;
  return file && currentLine ? { path: file.path, side: currentLine.side, line: currentLine.line } : null;
}

const NO_TOUR = "No tour loaded. Start one with `hunk tour open <tour.json>`.";

async function ask(ctx: ExtensionCommandContext, access: TourAccess) {
  const { paths } = state;
  if (!paths) {
    ctx.notify(NO_TOUR, "warning");
    return;
  }
  const stop = currentStopRef(access);
  const anchor = selectedAnchor(ctx) ?? stop?.anchor ?? null;
  if (!anchor) {
    ctx.notify("Move to a line first", "warning");
    return;
  }
  const text = await ctx.dialogs.input({ title: "Ask the agent", placeholder: "Your question" });
  if (text === null || text.trim() === "") return;
  await writeRequest(paths, { kind: "ask", anchor, text: text.trim(), stop });
  ctx.notify("Question sent to the agent");
}

async function decide(ctx: ExtensionCommandContext, access: TourAccess) {
  const { paths } = state;
  if (!paths) {
    ctx.notify(NO_TOUR, "warning");
    return;
  }
  const stop = currentStopRef(access);
  if (!stop) {
    ctx.notify("No current stop. Press > to start the tour.");
    return;
  }
  const picked = await ctx.dialogs.select({ title: `Stop ${stop.number}: ${stop.ask}`, options: DECISIONS });
  const decision = DECISIONS.find((candidate) => candidate === picked);
  if (!decision) return;
  const comment = await ctx.dialogs.input({ title: "Comment (Enter to skip)" });
  if (comment === null) return;
  await writeRequest(paths, { kind: "decision", stop, decision, comment: comment.trim() });
  ctx.notify(`Stop ${stop.number}: ${decision}`);
}

async function finish(ctx: ExtensionCommandContext) {
  if (!state.session) {
    ctx.notify(NO_TOUR, "warning");
    return;
  }
  await writeSession({ finishedAt: now() });
  ctx.notify("Review finished. The agent will draft the review from your decisions.");
}

function close() {
  if (!state.paths || !state.session) return;
  if (!ownsSession(readSessionSync(state.paths.session), state.session)) return;
  writeJsonAtomicSync(state.paths.session, { ...state.session, closedAt: now() });
}

let poller: ReturnType<typeof setInterval> | null = null;
// Event controls expire on reload, so the poller reads the latest ctx instead of capturing one.
let host: ExtensionEventContext | null = null;
let seenAnswers: Set<string> | null = null;

async function poll(access: TourAccess) {
  const { paths } = state;
  if (!paths || !host) return;
  const box = await readMailbox(paths);
  setState({ ...state, box });
  // Hunk 0.22 hosts have no status line; the Tour pane shows the same text there.
  (host as Partial<ExtensionEventContext>).statusLine?.set({
    id: STATUS_ID,
    spans: [{ text: statusText(box, access.stopCount(), Date.now()), tone: "muted" }],
  });
  if (seenAnswers) {
    for (const request of box.requests) {
      if (box.answers.has(request.id) && !seenAnswers.has(request.id)) host.notify(`Answered: ${requestLabel(request)}`);
    }
  }
  seenAnswers = new Set(box.answers.keys());
}

function startPolling(ctx: ExtensionEventContext, access: TourAccess) {
  host = ctx;
  if (poller || !state.paths) return;
  poller = setInterval(() => void poll(access), TUI_POLL_MS);
  void poll(access);
}

export function registerQa(hunk: HunkExtensionAPI, access: TourAccess) {
  hunk.on("changeset_loaded", (_payload, ctx) => startPolling(ctx, access));
  hunk.on("session_reload", (_payload, ctx) => startPolling(ctx, access));
  hunk.on("note_created", ({ note }, ctx) => onNoteCreated(note, ctx, access));
  hunk.on("shutdown", () => {
    if (poller) clearInterval(poller);
    close();
  });
  hunk.registerCommand({ id: "ask", title: "Ask the agent", key: "Q" }, (ctx) => ask(ctx, access));
  hunk.registerCommand({ id: "decide", title: "Decide this stop", key: "V" }, (ctx) => decide(ctx, access));
  hunk.registerCommand({ id: "finish", title: "Finish review" }, finish);
}
