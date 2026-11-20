import { REQUEST_ID_PATTERN, type Mailbox, type Request, type StopRef } from "./qa";
import type { TourStop } from "./schema";

export type RequestBody = Request extends infer R ? (R extends Request ? Omit<R, "id" | "seq" | "at"> : never) : never;

export function stopRef(entry: TourStop): StopRef {
  const { number, stop } = entry;
  return {
    number,
    ...(stop.id === undefined ? {} : { id: stop.id }),
    title: stop.title,
    ask: stop.ask,
    anchor: { path: stop.path, side: stop.side, line: stop.line },
  };
}

export function nextSeq(box: Mailbox): number {
  return box.requests.reduce((max, request) => Math.max(max, request.seq), 0) + 1;
}

/** Counts every request file name, including ones that do not parse yet, so a half-written request keeps its number. */
export function nextSeqFromNames(names: string[]): number {
  return names.reduce((max, name) => {
    const id = name.endsWith(".json") ? name.slice(0, -5) : "";
    return REQUEST_ID_PATTERN.test(id) ? Math.max(max, Number(id.slice(id.lastIndexOf("-") + 1))) : max;
  }, 0) + 1;
}

export function buildRequest(box: Mailbox, body: RequestBody, at: string, seq = nextSeq(box)): Request {
  return { id: box.session?.reviewId ? `q-${box.session.reviewId}-${seq}` : `q-${seq}`, seq, at, ...body };
}
