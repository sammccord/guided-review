import type { TourStop } from "./schema";

export interface TourCursor {
  /** Index into the tour's stops; -1 until the tour starts. */
  readonly current: number;
}

export type TourMove =
  | { kind: "next" }
  | { kind: "prev" }
  | { kind: "nextTrack" }
  | { kind: "prevTrack" }
  | { kind: "goto"; index: number }
  | { kind: "restart" };

export type MoveResult = { ok: true; cursor: TourCursor } | { ok: false; reason: string };

export function initialCursor(): TourCursor {
  return { current: -1 };
}

function goto(stops: readonly TourStop[], index: number): MoveResult {
  if (index >= stops.length) return { ok: false, reason: `End of tour (${stops.length} stops)` };
  if (index < 0) return { ok: false, reason: "Already at the first stop" };
  return { ok: true, cursor: { current: index } };
}

function firstStopOfTrack(stops: readonly TourStop[], trackIndex: number): number {
  return stops.findIndex((entry) => entry.trackIndex === trackIndex);
}

function nextTrack(stops: readonly TourStop[], trackCount: number, { current }: TourCursor): MoveResult {
  const target = current < 0 ? 0 : stops[current]!.trackIndex + 1;
  const index = firstStopOfTrack(stops, target);
  if (index < 0) return { ok: false, reason: `Already in the last track (${trackCount} tracks)` };
  return goto(stops, index);
}

/** Like a media player: first rewind to the start of the current track, then step to the previous one. */
function prevTrack(stops: readonly TourStop[], { current }: TourCursor): MoveResult {
  if (current < 0) return { ok: false, reason: "Already at the first stop" };
  const trackIndex = stops[current]!.trackIndex;
  const trackStart = firstStopOfTrack(stops, trackIndex);
  if (current > trackStart) return goto(stops, trackStart);
  if (trackIndex === 0) return { ok: false, reason: "Already in the first track" };
  return goto(stops, firstStopOfTrack(stops, trackIndex - 1));
}

export function move(stops: readonly TourStop[], trackCount: number, cursor: TourCursor, move: TourMove): MoveResult {
  switch (move.kind) {
    case "next":
      return goto(stops, cursor.current + 1);
    case "prev":
      return goto(stops, cursor.current - 1);
    case "nextTrack":
      return nextTrack(stops, trackCount, cursor);
    case "prevTrack":
      return prevTrack(stops, cursor);
    case "goto":
      return goto(stops, move.index);
    case "restart":
      return goto(stops, 0);
  }
}
