import { execFile } from "node:child_process";
import { resolve } from "node:path";
import type { ExtensionCliCommandContext, ExtensionCliCommandResult, ExtensionCliWriter } from "hunkdiff/extension";
import { decisions, pending, postPlan, reviewEnd, transcript, type Mailbox, type PostPlan, type ReviewEnd } from "../core/src/index";
import { answerPath, mailboxPaths, readMailbox, writeJsonAtomic, type MailboxPaths } from "../core/src/mailbox";

const EXTENSION_DIR = resolve(import.meta.dir, "..");
const WAIT_DEFAULT_SECONDS = 90;
const ANSWERING_SECONDS = 600;
const POLL_MS = 1000;

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

export function sessionAddArgs(plan: PostPlan, repo: string): string[] {
  const target =
    plan.kind === "reply"
      ? ["--reply-to", plan.noteId]
      : ["--file", plan.anchor.path, plan.anchor.side === "new" ? "--new-line" : "--old-line", String(plan.anchor.line)];
  const rationale = plan.rationale === "" ? [] : ["--rationale", plan.rationale];
  return ["session", "comment", "add", "--repo", repo, ...target, "--summary", plan.summary, ...rationale, "--author", "guided-review", "--json"];
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
    commentId = commentIdOf(await runHunk(sessionAddArgs(plan, box.session.repo)));
  } catch (error) {
    await writeLine(ctx.stderr, `tour answer: hunk session comment add failed: ${error instanceof Error ? error.message : String(error)}`);
    return { kind: "exit", code: 1 };
  }
  await writeJsonAtomic(answerPath(paths, request.id), { id: request.id, commentId, text: parsed.text, at: now() });
  await writeLine(ctx.stdout, { id: request.id, status: "posted", commentId });
  return { kind: "exit", code: 0 };
}
