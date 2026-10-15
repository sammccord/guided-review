import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseAnswer, parseHeartbeat, parseRequest, parseSession, REQUEST_ID_PATTERN, REVIEW_ID_PATTERN, type Answer, type Mailbox, type Request, type SessionRecord } from "./qa";

export interface MailboxPaths {
  root: string;
  session: string;
  inbox: string;
  answered: string;
  agent: string;
  approved: string;
}

/** Resolve the active review; an explicit id pins a writer, and null addresses the legacy root. */
export function mailboxPaths(tourPath: string, reviewId?: string | null): MailboxPaths {
  let root = tourPath.replace(/\.json$/, "") + ".qa";
  if (reviewId === undefined) {
    try {
      const current: unknown = JSON.parse(readFileSync(join(root, "current.json"), "utf8"));
      if (!current || typeof current !== "object" || !("reviewId" in current) || typeof current.reviewId !== "string") {
        throw new Error("invalid review pointer");
      }
      reviewId = current.reviewId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (reviewId != null) {
    if (!REVIEW_ID_PATTERN.test(reviewId)) throw new Error("invalid review id");
    root = join(root, "reviews", reviewId);
  }
  return {
    root,
    session: join(root, "session.json"),
    inbox: join(root, "inbox"),
    answered: join(root, "answered"),
    agent: join(root, "agent.json"),
    approved: join(root, "approved.json"),
  };
}

export function requestPath(paths: MailboxPaths, id: string): string {
  return join(paths.inbox, `${id}.json`);
}

export function answerPath(paths: MailboxPaths, id: string): string {
  return join(paths.answered, `${id}.json`);
}

export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function readSessionSync(path: string): SessionRecord | null {
  try {
    return parseSession(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

async function readJsonDir(dir: string): Promise<unknown[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = names.filter((name) => name.endsWith(".json") && REQUEST_ID_PATTERN.test(name.slice(0, -5))).map((name) => readJson(join(dir, name)));
  return Promise.all(files);
}

function parseAll<T>(values: unknown[], parse: (raw: unknown) => T | null): T[] {
  return values.map(parse).filter((value): value is T => value !== null);
}

export async function readMailbox(paths: MailboxPaths): Promise<Mailbox> {
  const [session, inbox, answered, agent] = await Promise.all([
    readJson(paths.session),
    readJsonDir(paths.inbox),
    readJsonDir(paths.answered),
    readJson(paths.agent),
  ]);
  const requests = parseAll<Request>(inbox, parseRequest).sort((a, b) => a.seq - b.seq);
  const answers = new Map(parseAll<Answer>(answered, parseAnswer).map((answer) => [answer.id, answer]));
  return { session: parseSession(session), requests, answers, heartbeat: parseHeartbeat(agent) };
}

let tempCounter = 0;

function tempPath(path: string): string {
  return `${path}.${process.pid}.${tempCounter++}.tmp`;
}

function encode(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = tempPath(path);
  await writeFile(temp, encode(value));
  await rename(temp, path);
}

/** For a process about to exit, where a pending promise would be dropped. */
export function writeJsonAtomicSync(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = tempPath(path);
  writeFileSync(temp, encode(value));
  renameSync(temp, path);
}

export function nextSeq(box: Mailbox): number {
  return box.requests.reduce((max, request) => Math.max(max, request.seq), 0) + 1;
}
