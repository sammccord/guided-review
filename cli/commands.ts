import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  approvalBlockers,
  decisions,
  parseTour,
  pending,
  postPlan,
  reviewEnd,
  reviewerIdleMs,
  transcript,
  type Mailbox,
  type ReviewEnd,
} from "../core/src/index";
import { answerPath, mailboxPaths, readMailbox, readJson, writeJsonAtomic, type MailboxPaths } from "../core/src/mailbox";
import { writeLine, type CliContext, type CliResult } from "./context";
import { assertPrHostIsRemote, githubApproveArgs, githubCommentArgs, parsePullRequestUrl, runGh, reviewUrl } from "./github";
import { assertSessionTour, pinTourRefs } from "./session";

const WAIT_DEFAULT_SECONDS = 90;
const AWAY_DEFAULT_MINUTES = 30;
const ANSWERING_SECONDS = 600;
const POLL_MS = 1000;

export const QA_USAGE = [
  "usage: hunk tour check <tour.json> | open <tour.json> [--fresh]",
  "       hunk tour wait <tour.json>... [--timeout <seconds>] [--away <minutes>]",
  "       hunk tour answer <tour.json> <id> --text <answer>",
  "       hunk tour approve <tour.json> [--body <text>]",
];

function now(): string {
  return new Date().toISOString();
}

export function pidAlive(pid: number): boolean {
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
  awayMs: number;
}

function parseWaitArgs(args: readonly string[], cwd: string): WaitArgs | string {
  const tours: string[] = [];
  let timeoutMs = WAIT_DEFAULT_SECONDS * 1000;
  let awayMs = AWAY_DEFAULT_MINUTES * 60_000;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--timeout") {
      const seconds = Number(args[++i]);
      if (!Number.isFinite(seconds) || seconds <= 0) return "--timeout needs a positive number of seconds";
      timeoutMs = seconds * 1000;
    } else if (arg === "--away") {
      const minutes = Number(args[++i]);
      if (!Number.isFinite(minutes) || minutes <= 0) return "--away needs a positive number of minutes";
      awayMs = minutes * 60_000;
    } else if (arg.startsWith("--")) {
      return `unknown option ${arg}`;
    } else {
      tours.push(resolve(cwd, arg));
    }
  }
  if (tours.length === 0) return "wait needs at least one tour file";
  return { tours, timeoutMs, awayMs };
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
      const box = await readMailbox(paths);
      if (box.session?.tourFingerprint) assertSessionTour(box.session, await readTour(tour, box.session.repo));
      return { tour, paths, box };
    }),
  );
}

function heartbeat(boxes: readonly TourBox[], seconds: number): Promise<unknown> {
  const until = new Date(Date.now() + seconds * 1000).toISOString();
  return Promise.all(boxes.map(({ paths }) => writeJsonAtomic(paths.agent, { pid: process.pid, until })));
}


async function readTour(path: string, repo?: string) {
  const parsed = parseTour(JSON.parse(await readFile(path, "utf8")));
  if (!parsed.ok) throw new Error(`${path}: ${parsed.errors.join("; ")}`);
  return repo === undefined ? parsed.tour : pinTourRefs(repo, parsed.tour);
}

async function finalPayload(boxes: readonly TourBox[], ends: readonly Exclude<ReviewEnd, null>[]) {
  const approval = await Promise.all(boxes.map(async ({ tour, box }) => {
    const loaded = await readTour(tour, box.session?.repo);
    if (box.session?.tourFingerprint) assertSessionTour(box.session, loaded);
    const blockers = approvalBlockers(loaded.verdict, box);
    return { tour, eligible: blockers.length === 0, blockers };
  }));
  return {
    kind: ends.every((end) => end.kind === "finished") ? "finished" : "closed",
    decisions: boxes.flatMap(({ tour, box }) => [...decisions(box)].map(([stop, decision]) => ({ tour, stop, decision }))),
    transcript: boxes.flatMap(({ tour, box }) => transcript(box).map((entry) => ({ tour, ...entry }))),
    approval,
    next: "write the review draft",
  };
}

async function waitForReview(args: readonly string[], ctx: CliContext): Promise<CliResult> {
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
        next: `answer each with: ${ctx.program} answer ${first.tour} ${first.id} --text '<answer>' then wait again`,
      });
      return { kind: "exit", code: 0 };
    }
    if (ends.every((end) => end !== null)) {
      try {
        await writeLine(ctx.stdout, await finalPayload(boxes, ends.filter((end) => end !== null)));
      } catch (error) {
        await writeLine(ctx.stderr, `tour wait: ${error instanceof Error ? error.message : String(error)}`);
        return { kind: "exit", code: 1 };
      }
      return { kind: "exit", code: 0 };
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(POLL_MS, deadline - Date.now()), ctx.signal);
    boxes = await readAll(parsed.tours);
  }
  const idles = boxes.filter(({ box }) => !reviewEnd(box, pidAlive)).map(({ box }) => reviewerIdleMs(box, Date.now()) ?? 0);
  const idle = idles.length === 0 ? 0 : Math.min(...idles);
  const idleMinutes = Math.floor(idle / 60_000);
  await writeLine(ctx.stdout, idle >= parsed.awayMs
    ? { kind: "away", idleMinutes, next: "stop waiting; tell the reviewer the agent paused and to say when to resume" }
    : { kind: "idle", idleMinutes, next: "wait again; do not end your turn" });
  return { kind: "exit", code: 0 };
}

export async function runWait(args: readonly string[], ctx: CliContext): Promise<CliResult> {
  try {
    return await waitForReview(args, ctx);
  } catch (error) {
    await writeLine(ctx.stderr, `tour wait: ${error instanceof Error ? error.message : String(error)}`);
    return { kind: "exit", code: 1 };
  }
}

export async function runApprove(args: readonly string[], ctx: CliContext): Promise<CliResult> {
  const [file, flag, body, ...extra] = args;
  if (!file || (flag !== undefined && (flag !== "--body" || body === undefined || !body.trim())) || extra.length > 0) {
    await writeLine(ctx.stderr, "tour approve: expected <tour.json> [--body <text>]");
    return { kind: "exit", code: 2 };
  }
  try {
    const path = resolve(ctx.cwd, file);
    let tour = await readTour(path);
    const paths = mailboxPaths(path);
    const box = await readMailbox(paths);
    const session = box.session;
    if (!session || !reviewEnd(box, pidAlive)) throw new Error("review has not ended; finish or close Hunk first");
    tour = await pinTourRefs(session.repo, tour);
    const blockers = approvalBlockers(tour.verdict, box);
    if (blockers.length) throw new Error(`approval blocked:\n${blockers.join("\n")}`);
    const target = tour.url ? parsePullRequestUrl(tour.url) : null;
    if (!target) throw new Error("tour has no PR url");
    assertSessionTour(session, tour);
    const head = session.head;
    const approved = await readJson(paths.approved);
    if (typeof approved === "object" && approved !== null && "head" in approved && approved.head === head && "url" in approved && typeof approved.url === "string") {
      await writeLine(ctx.stdout, { status: "already-approved", url: approved.url });
      return { kind: "exit", code: 0 };
    }
    await assertPrHostIsRemote(session.repo, target);
    const api = ["api", "--hostname", target.host];
    const endpoint = `repos/${target.owner}/${target.repo}/pulls/${target.number}`;
    const pr: unknown = JSON.parse(await runGh([...api, endpoint], session.repo));
    if (typeof pr !== "object" || pr === null || !("head" in pr) || typeof pr.head !== "object" || pr.head === null || !("sha" in pr.head) || typeof pr.head.sha !== "string") {
      throw new Error("gh returned no PR head.sha");
    }
    if (pr.head.sha !== head) throw new Error(`PR head moved from ${head} to ${pr.head.sha}; re-run the review`);
    const login = (await runGh([...api, "user", "--jq", ".login"], session.repo)).trim();
    if (!login) throw new Error("gh returned no current user login");
    const pages: unknown = JSON.parse(await runGh([...api, "--paginate", "--slurp", `${endpoint}/reviews`], session.repo));
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error("gh returned invalid PR reviews");
    const existing = pages.flat().find((review: unknown) =>
      typeof review === "object" && review !== null && "state" in review && review.state === "APPROVED" &&
      "commit_id" in review && review.commit_id === head && "user" in review && typeof review.user === "object" &&
      review.user !== null && "login" in review.user && review.user.login === login,
    );
    const url = reviewUrl(existing ?? JSON.parse(await runGh(githubApproveArgs(target, head, body), session.repo)));
    await writeJsonAtomic(paths.approved, { url, head, at: now() });
    await writeLine(ctx.stdout, { status: existing ? "already-approved" : "approved", url });
    return { kind: "exit", code: 0 };
  } catch (error) {
    await writeLine(ctx.stderr, `tour approve: ${error instanceof Error ? error.message : String(error)}`);
    return { kind: "exit", code: 1 };
  }
}

function parseAnswerArgs(args: readonly string[], cwd: string): { tour: string; id: string; text: string } | string {
  const [tour, id, flag, text, ...extra] = args;
  if (!tour || !id || flag !== "--text" || text === undefined || extra.length > 0) return QA_USAGE.join("\n");
  if (text.trim() === "") return "tour answer: --text must not be empty";
  return { tour: resolve(cwd, tour), id, text };
}

export async function runAnswer(args: readonly string[], ctx: CliContext): Promise<CliResult> {
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
  if (box.session.tourFingerprint) {
    try {
      assertSessionTour(box.session, await readTour(parsed.tour, box.session.repo));
    } catch (error) {
      await writeLine(ctx.stderr, `tour answer: ${error instanceof Error ? error.message : String(error)}`);
      return { kind: "exit", code: 1 };
    }
  }
  let text = parsed.text;
  if (request.kind === "comment" || request.kind === "reviewer-comment") {
    try {
      const tour: unknown = JSON.parse(await readFile(box.session.tourPath, "utf8"));
      const target =
        typeof tour === "object" && tour !== null && "url" in tour && typeof tour.url === "string" ? parsePullRequestUrl(tour.url) : null;
      if (!target) {
        await writeLine(ctx.stderr, 'tour answer: tour has no PR url; add "url" to the tour or post the comment yourself');
        return { kind: "exit", code: 1 };
      }
      await assertPrHostIsRemote(box.session.repo, target);
      const result: unknown = JSON.parse(await runGh(githubCommentArgs(target, box.session.head, request.stop.anchor, text), box.session.repo));
      if (typeof result !== "object" || result === null || !("html_url" in result) || typeof result.html_url !== "string") {
        throw new Error("gh returned no comment html_url");
      }
      text = `${text}\n\n${result.html_url}`;
    } catch (error) {
      await writeLine(ctx.stderr, `tour answer: PR comment failed: ${error instanceof Error ? error.message : String(error)}`);
      return { kind: "exit", code: 1 };
    }
  }
  const plan = postPlan(request, text);
  if (plan.summary === "") {
    await writeLine(ctx.stderr, "tour answer: the answer has no text on its first line");
    return { kind: "exit", code: 2 };
  }
  let commentId: string | null;
  try {
    commentId = await ctx.notes.post(plan, box.session);
  } catch (error) {
    await writeLine(ctx.stderr, `tour answer: ${error instanceof Error ? error.message : String(error)}`);
    return { kind: "exit", code: 1 };
  }
  await writeJsonAtomic(answerPath(paths, request.id), { id: request.id, commentId, text, at: now() });
  await writeLine(ctx.stdout, { id: request.id, status: "posted", commentId });
  return { kind: "exit", code: 0 };
}
