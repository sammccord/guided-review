import { currentPointerPath, joinPosixPaths, requestFile, reviewLayout, type ReviewLayout } from "./layout";
import { parseAnswer, parseHeartbeat, parseRequest, parseSession, REQUEST_ID_PATTERN, type Mailbox, type Request, type SessionRecord } from "./qa";
import { buildRequest, nextSeq, nextSeqFromNames, type RequestBody } from "./requests";

export interface MailboxPort {
  readText(path: string): Promise<string | undefined>;
  listNames(dir: string): Promise<string[]>;
  writeText(path: string, text: string): Promise<void>;
}

/** A read that hit a half-written file; the caller should skip this tick and read again. */
export class TransientReadError extends Error {
  override name = "TransientReadError";
}

const MAX_READS_IN_FLIGHT = 16;
const RESERVE_ATTEMPTS = 5;
const readLimiters = new WeakMap<MailboxPort, MailboxPort>();
const postQueues = new WeakMap<MailboxPort, Promise<unknown>>();

export function encodeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Hosts such as the Toshi bridge reject reads past a fixed number in flight, and a mailbox read fans out over every file. */
function limitReads(port: MailboxPort): MailboxPort {
  const existing = readLimiters.get(port);
  if (existing) return existing;
  let active = 0;
  const waiting: (() => void)[] = [];
  const limited: MailboxPort = {
    async readText(path) {
      if (active < MAX_READS_IN_FLIGHT) active++;
      else await new Promise<void>((resolve) => waiting.push(resolve));
      try {
        return await port.readText(path);
      } finally {
        const next = waiting.shift();
        if (next) next();
        else active--;
      }
    },
    listNames: (dir) => port.listNames(dir),
    writeText: (path, text) => port.writeText(path, text),
  };
  readLimiters.set(port, limited);
  return limited;
}

/** Hosts write some files in place, so a SyntaxError means half-written and reads as missing. */
async function readJsonVia(port: MailboxPort, path: string): Promise<unknown> {
  const text = await port.readText(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function readJsonDirVia(port: MailboxPort, dir: string): Promise<unknown[]> {
  const names = await port.listNames(dir);
  const files = names.filter((name) => name.endsWith(".json") && REQUEST_ID_PATTERN.test(name.slice(0, -5))).map((name) => readJsonVia(port, joinPosixPaths(dir, name)));
  return Promise.all(files);
}

function parseAll<T>(values: unknown[], parse: (raw: unknown) => T | null): T[] {
  return values.map(parse).filter((value): value is T => value !== null);
}

export async function readMailboxVia(port: MailboxPort, layout: ReviewLayout): Promise<Mailbox> {
  const limited = limitReads(port);
  const [session, inbox, answered, agent] = await Promise.all([
    readJsonVia(limited, layout.session),
    readJsonDirVia(limited, layout.inbox),
    readJsonDirVia(limited, layout.answered),
    readJsonVia(limited, layout.agent),
  ]);
  const requests = parseAll(inbox, parseRequest).sort((a, b) => a.seq - b.seq);
  const answers = new Map(parseAll(answered, parseAnswer).map((answer) => [answer.id, answer]));
  return { session: parseSession(session), requests, answers, heartbeat: parseHeartbeat(agent) };
}

export async function resolveLayoutVia(port: MailboxPort, tourPath: string): Promise<ReviewLayout> {
  const path = currentPointerPath(tourPath);
  const text = await port.readText(path);
  if (text === undefined) return reviewLayout(tourPath, null);
  let current: unknown;
  try {
    current = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new TransientReadError(`half-written ${path}: ${error.message}`, { cause: error });
    throw error;
  }
  if (!current || typeof current !== "object" || !("reviewId" in current) || typeof current.reviewId !== "string") {
    throw new Error("invalid review pointer");
  }
  return reviewLayout(tourPath, current.reviewId);
}

/** Requests from one port are serialized so two posts cannot pick the same free number. */
export function postRequestVia(port: MailboxPort, layout: ReviewLayout, body: RequestBody, at: string): Promise<Request> {
  const posting = (postQueues.get(port) ?? Promise.resolve()).catch(() => {}).then(() => reserveRequestVia(port, layout, body, at));
  postQueues.set(port, posting);
  return posting;
}

async function reserveRequestVia(port: MailboxPort, layout: ReviewLayout, body: RequestBody, at: string): Promise<Request> {
  const box = await readMailboxVia(port, layout);
  let seq = Math.max(nextSeq(box), nextSeqFromNames(await port.listNames(layout.inbox)));
  for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt++, seq++) {
    const request = buildRequest(box, body, at, seq);
    const path = requestFile(layout, request.id);
    if ((await port.readText(path)) !== undefined) continue;
    await port.writeText(path, encodeJson(request));
    return request;
  }
  throw new Error("could not reserve a request number");
}

export async function patchSessionVia(port: MailboxPort, layout: ReviewLayout, patch: Partial<SessionRecord>): Promise<SessionRecord | null> {
  let session: SessionRecord | null = null;
  for (let attempt = 0; attempt < 2 && !session; attempt++) {
    const text = await port.readText(layout.session);
    if (text === undefined) return null;
    try {
      session = parseSession(JSON.parse(text));
      if (!session) return null;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  if (!session) return null;
  const merged: SessionRecord = { ...session, ...patch };
  if (patch.finishedAt === undefined && session.finishedAt !== undefined) merged.finishedAt = session.finishedAt;
  if (patch.closedAt === undefined && session.closedAt !== undefined) merged.closedAt = session.closedAt;
  await port.writeText(layout.session, encodeJson(merged));
  return merged;
}
