import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseTour, stackPosition, validateTour, type ValidateResult } from "../core/src/index";
import { readDiffRanges } from "../core/src/git";
import { pinTourRefs } from "./session";

export async function loadAndCheck(file: string, cwd: string): Promise<ValidateResult> {
  const path = resolve(cwd, file);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    return { ok: false, errors: [`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const parsed = parseTour(raw);
  if (!parsed.ok) return parsed;
  try {
    return await validateTour(await pinTourRefs(cwd, parsed.tour), (base, head) => readDiffRanges(cwd, base, head));
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

export function checkSummary(result: Extract<ValidateResult, { ok: true }>): string {
  const { tour, stops } = result;
  const fileCount = new Set(stops.map(({ stop }) => stop.path)).size;
  let stackSuffix = "";
  if (tour.stack) {
    const { index, total } = stackPosition(tour.stack);
    stackSuffix = ` · stack #${tour.stack.number} layer ${index}/${total}`;
  }
  return `ok: ${stops.length} stops in ${tour.tracks.length} tracks across ${fileCount} files, verdict ${tour.verdict}${stackSuffix}`;
}
