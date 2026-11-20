import type { Mailbox, Request, StopRef } from "./qa";
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

export function buildRequest(box: Mailbox, body: RequestBody, at: string): Request {
  const seq = nextSeq(box);
  return { id: box.session?.reviewId ? `q-${box.session.reviewId}-${seq}` : `q-${seq}`, seq, at, ...body };
}
