import { useEffect, useState, useSyncExternalStore } from "react";
import type {
  ExtensionCommandContext,
  ExtensionEventContext,
  ExtensionPaneProps,
  ExtensionReviewNote,
  HunkExtensionAPI,
} from "hunkdiff/extension";
import {
  classifyNote,
  DECISIONS,
  emptyMailbox,
  ownsSession,
  pending,
  placeholderDiff,
  placeholderPlan,
  requestLabel,
  reviewEnd,
  statusText,
  type Anchor,
  type Decision,
  type Mailbox,
  type Request,
  type SessionRecord,
  type StopRef,
  type TourStop,
} from "../core/src/index";
import {
  nextSeq,
  readMailbox,
  readSessionSync,
  requestPath,
  writeJsonAtomic,
  writeJsonAtomicSync,
  type MailboxPaths,
} from "../core/src/mailbox";
import { prepareSession } from "../cli/session";
import { pidAlive } from "../cli/commands";
import { commentIdOf, runHunk, sessionAddArgs, sessionIdForPid } from "../cli/hunk";

const TUI_POLL_MS = 2000;
const ACTIVITY_WRITE_MS = 15_000;
const STATUS_ID = "qa";

export const QA_KEYS = { ask: "Q", comment: "C", decide: "V", finish: "F" } as const;

/** Button text for a command, with its current key unless the command is unbound. */
export function actionLabel(title: string, command: keyof typeof QA_KEYS, keybindings?: Partial<ExtensionPaneProps["keybindings"]>): string {
  const keys = keybindings?.getKeys?.(`guided-review.${command}`) ?? [QA_KEYS[command]];
  return `[ ${[title, ...(keys.length ? [keys.join("/")] : [])].join(" · ")} ]`;
}

function now(): string {
  return new Date().toISOString();
}

const placeholders = new Map<string, string>();
const placing = new Set<string>();
const repliedTo = new Set<string>();
let ownId: string | null = null;
let syncing: Promise<void> | null = null;
let placeholderBox: Mailbox | null = null;

async function ownSessionId(): Promise<string | null> {
  ownId ??= sessionIdForPid(JSON.parse(await runHunk(["session", "list", "--json"])), process.pid);
  return ownId;
}

async function syncPlaceholders(box: Mailbox): Promise<void> {
  placeholderBox = box;
  if (syncing) return syncing;
  syncing = (async () => {
    while (placeholderBox) {
      const current = placeholderBox;
      placeholderBox = null;
      let sessionId: string | null;
      try {
        sessionId = await ownSessionId();
      } catch {
        continue;
      }
      if (!sessionId) continue;
      const waiting = reviewEnd(current, pidAlive) ? [] : pending(current);
      const diff = placeholderDiff(waiting, placeholders, placing);
      for (const request of diff.create) {
        placing.add(request.id);
        const id = await runHunk(sessionAddArgs(placeholderPlan(request), sessionId)).then(commentIdOf, () => null);
        placing.delete(request.id);
        if (id !== null) placeholders.set(request.id, id);
      }
      for (const id of diff.remove) {
        const commentId = placeholders.get(id)!;
        placeholders.delete(id);
        if (!repliedTo.has(commentId)) await runHunk(["session", "comment", "rm", sessionId, commentId, "--json"]).catch(() => null);
      }
    }
  })().finally(() => { syncing = null; });
  return syncing;
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

export function useWaiting(): Request[] {
  const box = useMailbox();
  return reviewEnd(box, pidAlive) ? [] : pending(box);
}

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function useSpinnerFrame(active: boolean): string {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setIndex((value) => (value + 1) % SPINNER_FRAMES.length), 120);
    return () => clearInterval(timer);
  }, [active]);
  return active ? SPINNER_FRAMES[index]! : "";
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
export async function openSession(input: Parameters<typeof prepareSession>[0]): Promise<void> {
  setState(await prepareSession({ ...input, pid: process.pid }));
}

let sessionWrite: Promise<void> = Promise.resolve();

async function writeSession(patch: Partial<SessionRecord>): Promise<void> {
  if (!state.paths || !state.session) return;
  if (!ownsSession(readSessionSync(state.paths.session), state.session)) return;
  const session = { ...state.session, ...patch };
  const path = state.paths.session;
  setState({ ...state, session });
  const write = sessionWrite.then(() => writeJsonAtomic(path, session));
  sessionWrite = write.catch(() => {});
  await write;
}

function touchActivity(): void {
  if (!state.session) return;
  if (Date.now() - Date.parse(state.session.activeAt ?? state.session.openedAt) > ACTIVITY_WRITE_MS) {
    void writeSession({ activeAt: now() });
  }
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
  const request = { id: box.session?.reviewId ? `q-${box.session.reviewId}-${seq}` : `q-${seq}`, seq, at: now(), ...body } as Request;
  await writeJsonAtomic(requestPath(paths, request.id), request);
  setState({ ...state, box: { ...box, requests: [...box.requests, request] } });
  void syncPlaceholders(state.box);
}

export async function requestComment(entry: TourStop): Promise<void> {
  if (!state.paths) return;
  await writeRequest(state.paths, { kind: "comment", stop: stopRef(entry), body: entry.stop.body });
}

export interface TourAccess {
  currentStop(): TourStop | null;
}

function currentStopRef(access: TourAccess): StopRef | null {
  const current = access.currentStop();
  return current ? stopRef(current) : null;
}

async function onNoteCreated(note: ExtensionReviewNote, ctx: ExtensionEventContext, access: TourAccess) {
  const { paths } = state;
  if (!paths || note.draft) return;
  const placeholderIds = new Set(placeholders.values());
  if (note.parentId !== undefined && placeholderIds.has(note.parentId)) repliedTo.add(note.parentId);
  const kind = classifyNote(note, await readMailbox(paths), placeholderIds);
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

async function ask(ctx: Pick<ExtensionCommandContext, "dialogs" | "notify">, selected: Anchor | null, entry: TourStop | null) {
  touchActivity();
  const { paths } = state;
  if (!paths) {
    ctx.notify(NO_TOUR, "warning");
    return;
  }
  const stop = entry ? stopRef(entry) : null;
  const anchor = selected ?? stop?.anchor ?? null;
  if (!anchor) {
    ctx.notify("Move to a line first", "warning");
    return;
  }
  const text = await ctx.dialogs.input({ title: "Ask the agent", placeholder: "Your question" });
  if (text === null || text.trim() === "") return;
  await writeRequest(paths, { kind: "ask", anchor, text: text.trim(), stop });
  ctx.notify("Question sent to the agent");
}

async function decide(ctx: Pick<ExtensionCommandContext, "dialogs" | "notify">, entry: TourStop | null) {
  touchActivity();
  const { paths } = state;
  if (!paths) {
    ctx.notify(NO_TOUR, "warning");
    return;
  }
  const stop = entry ? stopRef(entry) : null;
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

export async function requestAsk(entry: TourStop): Promise<void> {
  if (host) await ask(host, null, entry);
}

async function commentOnPr(ctx: Pick<ExtensionCommandContext, "dialogs" | "notify">, entry: TourStop | null) {
  touchActivity();
  const { paths } = state;
  if (!paths) {
    ctx.notify(NO_TOUR, "warning");
    return;
  }
  if (!entry) {
    ctx.notify("No current stop. Press > to start the tour.");
    return;
  }
  const text = await ctx.dialogs.input({ title: `Comment on PR at stop ${entry.number}`, placeholder: "Your comment, posted as written" });
  if (text === null || text.trim() === "") return;
  await writeRequest(paths, { kind: "reviewer-comment", stop: stopRef(entry), body: text.trim() });
  ctx.notify("Sent to the agent to post");
}

export async function requestReviewerComment(entry: TourStop): Promise<void> {
  if (host) await commentOnPr(host, entry);
}

export async function finish(ctx: Pick<ExtensionCommandContext, "notify">) {
  if (!state.session) {
    ctx.notify(NO_TOUR, "warning");
    return;
  }
  await writeSession({ finishedAt: now() });
  if (state.paths) {
    const box = await readMailbox(state.paths);
    setState({ ...state, box });
    await syncPlaceholders(box);
  }
  ctx.notify("Review finished. The agent will draft the review from your notes.");
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

async function poll() {
  const { paths } = state;
  if (!paths || !host) return;
  const box = await readMailbox(paths);
  setState({ ...state, box });
  // Hunk 0.22 hosts have no status line; the Tour pane shows the same text there.
  (host as Partial<ExtensionEventContext>).statusLine?.set({
    id: STATUS_ID,
    spans: [{ text: statusText(box, Date.now()), tone: "muted" }],
  });
  if (seenAnswers) {
    for (const request of box.requests) {
      if (box.answers.has(request.id) && !seenAnswers.has(request.id)) host.notify(`Answered: ${requestLabel(request)}`);
    }
  }
  seenAnswers = new Set(box.answers.keys());
  void syncPlaceholders(box);
}

function startPolling(ctx: ExtensionEventContext) {
  host = ctx;
  if (poller || !state.paths) return;
  poller = setInterval(() => void poll(), TUI_POLL_MS);
  void poll();
}

export function registerQa(hunk: HunkExtensionAPI, access: TourAccess) {
  hunk.on("changeset_loaded", (_payload, ctx) => startPolling(ctx));
  hunk.on("session_reload", (_payload, ctx) => startPolling(ctx));
  hunk.on("command_executed", touchActivity);
  hunk.on("selection_changed", touchActivity);
  hunk.on("file_viewed", touchActivity);
  hunk.on("hunk_viewed", touchActivity);
  hunk.on("filter_changed", touchActivity);
  hunk.on("note_created", touchActivity);
  hunk.on("note_edited", touchActivity);
  hunk.on("note_created", ({ note }, ctx) => onNoteCreated(note, ctx, access));
  hunk.on("shutdown", () => {
    if (poller) clearInterval(poller);
    close();
  });
  hunk.registerCommand({ id: "ask", title: "Ask the agent", key: QA_KEYS.ask }, (ctx) => ask(ctx, selectedAnchor(ctx), access.currentStop()));
  hunk.registerCommand({ id: "comment", title: "Comment on PR", key: QA_KEYS.comment }, (ctx) => commentOnPr(ctx, access.currentStop()));
  hunk.registerCommand({ id: "decide", title: "Mark this stop (agree/disagree/unsure)", key: QA_KEYS.decide }, (ctx) => decide(ctx, access.currentStop()));
  hunk.registerCommand({ id: "finish", title: "Finish review", key: QA_KEYS.finish }, (ctx) => finish(ctx));
}
