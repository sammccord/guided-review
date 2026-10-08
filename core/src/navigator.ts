import type { TourStop } from "./schema";

export interface TourCursor {
  /** Index into the tour's stops; -1 until the tour starts. */
  readonly current: number;
  /** Stops left by following links, most recent last; `back` returns to them. */
  readonly history: readonly number[];
}

export type TourMove =
  | { kind: "next" }
  | { kind: "prev" }
  | { kind: "nextTrack" }
  | { kind: "prevTrack" }
  | { kind: "goto"; index: number }
  | { kind: "restart" }
  | { kind: "follow"; index: number }
  | { kind: "back" };

export type MoveResult = { ok: true; cursor: TourCursor } | { ok: false; reason: string };

export function initialCursor(): TourCursor {
  return { current: -1, history: [] };
}

function goto(stops: readonly TourStop[], index: number, history: readonly number[]): MoveResult {
  if (index >= stops.length) return { ok: false, reason: `End of tour (${stops.length} stops)` };
  if (index < 0) return { ok: false, reason: "Already at the first stop" };
  return { ok: true, cursor: { current: index, history } };
}

function firstStopOfTrack(stops: readonly TourStop[], trackIndex: number): number {
  return stops.findIndex((entry) => entry.trackIndex === trackIndex);
}

function nextTrack(stops: readonly TourStop[], trackCount: number, { current, history }: TourCursor): MoveResult {
  const target = current < 0 ? 0 : stops[current]!.trackIndex + 1;
  const index = firstStopOfTrack(stops, target);
  if (index < 0) return { ok: false, reason: `Already in the last track (${trackCount} tracks)` };
  return goto(stops, index, history);
}

/** Like a media player: first rewind to the start of the current track, then step to the previous one. */
function prevTrack(stops: readonly TourStop[], { current, history }: TourCursor): MoveResult {
  if (current < 0) return { ok: false, reason: "Already at the first stop" };
  const trackIndex = stops[current]!.trackIndex;
  const trackStart = firstStopOfTrack(stops, trackIndex);
  if (current > trackStart) return goto(stops, trackStart, history);
  if (trackIndex === 0) return { ok: false, reason: "Already in the first track" };
  return goto(stops, firstStopOfTrack(stops, trackIndex - 1), history);
}

function follow(stops: readonly TourStop[], { current, history }: TourCursor, index: number): MoveResult {
  return goto(stops, index, current < 0 ? history : [...history, current]);
}

function back(stops: readonly TourStop[], { history }: TourCursor): MoveResult {
  const previous = history.at(-1);
  if (previous === undefined) return { ok: false, reason: "No earlier stop to go back to" };
  return goto(stops, previous, history.slice(0, -1));
}

export function move(stops: readonly TourStop[], trackCount: number, cursor: TourCursor, move: TourMove): MoveResult {
  switch (move.kind) {
    case "next":
      return goto(stops, cursor.current + 1, cursor.history);
    case "prev":
      return goto(stops, cursor.current - 1, cursor.history);
    case "nextTrack":
      return nextTrack(stops, trackCount, cursor);
    case "prevTrack":
      return prevTrack(stops, cursor);
    case "goto":
      return goto(stops, move.index, cursor.history);
    case "restart":
      return goto(stops, 0, []);
    case "follow":
      return follow(stops, cursor, move.index);
    case "back":
      return back(stops, cursor);
  }
}
