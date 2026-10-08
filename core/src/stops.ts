import type { Tour, TourStop } from "./schema";

/** Stops longer than this many lines are flagged by `tour check` as too broad. */
export const MAX_STOP_LINES = 20;

export function tourStops(tour: Tour): TourStop[] {
  const stops: TourStop[] = [];
  tour.tracks.forEach((track, trackIndex) => {
    for (const stop of track.stops) stops.push({ number: stops.length + 1, stop, track, trackIndex });
  });
  return stops;
}

/** Advisory messages for stops that should be split; never blocks opening. */
export function checkStopSize(tour: Tour): string[] {
  return tourStops(tour).flatMap(({ number, stop }) => {
    const span = (stop.endLine ?? stop.line) - stop.line + 1;
    if (span <= MAX_STOP_LINES) return [];
    return [`stop ${number} "${stop.title}": spans ${span} lines; split it into smaller stops (max ${MAX_STOP_LINES})`];
  });
}
