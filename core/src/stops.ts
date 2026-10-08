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

function nonBulletLine(text: string): boolean {
  return text.split("\n").some((line) => line.trim() !== "" && !line.trimStart().startsWith("- "));
}

/** Advisory messages for prose written as paragraphs instead of `- ` bullet lines; never blocks opening. */
export function checkBullets(tour: Tour): string[] {
  const hint = 'write it as "- " bullet lines';
  const warnings = nonBulletLine(tour.summary) ? [`summary: ${hint}`] : [];
  tour.tracks.forEach((track, index) => {
    if (nonBulletLine(track.summary)) warnings.push(`track ${index + 1} "${track.title}" summary: ${hint}`);
  });
  for (const { number, stop } of tourStops(tour)) {
    if (nonBulletLine(stop.body)) warnings.push(`stop ${number} "${stop.title}" body: ${hint}`);
  }
  return warnings;
}
