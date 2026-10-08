import { checkAnchors, type DiffRanges } from "./anchors";
import { indexStops, type StopIndex } from "./links";
import { parseTour, type Tour, type TourStop } from "./schema";
import { checkStopSize, tourStops } from "./stops";

export type ValidateResult =
  | { ok: true; tour: Tour; stops: TourStop[]; index: StopIndex; warnings: string[] }
  | { ok: false; errors: string[] };

/** Ranges load only for a tour that parses. Anchor problems are errors; oversized stops are warnings that never block. */
export async function validateTour(
  raw: unknown,
  loadRanges: (base: string, head: string) => Promise<DiffRanges>,
): Promise<ValidateResult> {
  const parsed = parseTour(raw);
  if (!parsed.ok) return parsed;
  const { tour } = parsed;
  let ranges: DiffRanges;
  try {
    ranges = await loadRanges(tour.base, tour.head);
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
  const problems = checkAnchors(tour, ranges);
  if (problems.length > 0) return { ok: false, errors: problems };
  const stops = tourStops(tour);
  return { ok: true, tour, stops, index: indexStops(stops), warnings: checkStopSize(tour) };
}
