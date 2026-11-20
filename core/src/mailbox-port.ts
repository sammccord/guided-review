import { currentPointerPath, joinPosixPaths, requestFile, reviewLayout, type ReviewLayout } from "./layout";
import { parseAnswer, parseHeartbeat, parseRequest, parseSession, REQUEST_ID_PATTERN, type Mailbox, type Request, type SessionRecord } from "./qa";
import { buildRequest, type RequestBody } from "./requests";

export interface MailboxPort {
  readText(path: string): Promise<string | undefined>;
  listNames(dir: string): Promise<string[]>;
  writeText(path: string, text: string): Promise<void>;
}

export function encodeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readJsonVia(port: MailboxPort, path: string): Promise<unknown> {
  try {
    const text = await port.readText(path);
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function readJsonDirVia(port: MailboxPort, dir: string): Promise<unknown[]> {
  let names: string[];
  try {
    names = await port.listNames(dir);
  } catch {
    return [];
  }
  const files = names.filter((name) => name.endsWith(".json") && REQUEST_ID_PATTERN.test(name.slice(0, -5))).map((name) => readJsonVia(port, joinPosixPaths(dir, name)));
  return Promise.all(files);
}

function parseAll<T>(values: unknown[], parse: (raw: unknown) => T | null): T[] {
  return values.map(parse).filter((value): value is T => value !== null);
}

export async function readMailboxVia(port: MailboxPort, layout: ReviewLayout): Promise<Mailbox> {
  const [session, inbox, answered, agent] = await Promise.all([
    readJsonVia(port, layout.session),
    readJsonDirVia(port, layout.inbox),
    readJsonDirVia(port, layout.answered),
    readJsonVia(port, layout.agent),
  ]);
  const requests = parseAll(inbox, parseRequest).sort((a, b) => a.seq - b.seq);
  const answers = new Map(parseAll(answered, parseAnswer).map((answer) => [answer.id, answer]));
  return { session: parseSession(session), requests, answers, heartbeat: parseHeartbeat(agent) };
}

export async function resolveLayoutVia(port: MailboxPort, tourPath: string): Promise<ReviewLayout> {
  const text = await port.readText(currentPointerPath(tourPath));
  if (text === undefined) return reviewLayout(tourPath, null);
  const current: unknown = JSON.parse(text);
  if (!current || typeof current !== "object" || !("reviewId" in current) || typeof current.reviewId !== "string") {
    throw new Error("invalid review pointer");
  }
  return reviewLayout(tourPath, current.reviewId);
}

export async function postRequestVia(port: MailboxPort, layout: ReviewLayout, body: RequestBody, at: string): Promise<Request> {
  const request = buildRequest(await readMailboxVia(port, layout), body, at);
  await port.writeText(requestFile(layout, request.id), encodeJson(request));
  return request;
}

export async function patchSessionVia(port: MailboxPort, layout: ReviewLayout, patch: Partial<SessionRecord>): Promise<SessionRecord | null> {
  const session = parseSession(await readJsonVia(port, layout.session));
  if (!session) return null;
  const merged = { ...session, ...patch };
  await port.writeText(layout.session, encodeJson(merged));
  return merged;
}
