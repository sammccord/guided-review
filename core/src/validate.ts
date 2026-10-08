import { checkAnchors, type DiffRanges } from "./anchors";
import { parseTour, type Tour, type TourStop } from "./schema";
import { checkStopSize, tourStops } from "./stops";

export type ValidateResult =
  | { ok: true; tour: Tour; stops: TourStop[]; warnings: string[] }
  | { ok: false; errors: string[] };

/** Anchor problems are errors; oversized stops are warnings that never block. */
export function validateTour(raw: unknown, ranges: DiffRanges): ValidateResult {
  const parsed = parseTour(raw);
  if (!parsed.ok) return parsed;
  const { tour } = parsed;
  const problems = checkAnchors(tour, ranges);
  if (problems.length > 0) return { ok: false, errors: problems };
  return { ok: true, tour, stops: tourStops(tour), warnings: checkStopSize(tour) };
}
