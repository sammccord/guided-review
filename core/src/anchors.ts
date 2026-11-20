import type { Stop, Tour } from "./schema";
import { tourStops } from "./stops";
import { parseUnifiedDiff } from "./diff";

/** Changed line ranges per file side, as git reports them for `base...head`. */
export interface HunkRange {
  side: "new" | "old";
  start: number;
  end: number;
}
export type DiffRanges = ReadonlyMap<string, readonly HunkRange[]>;

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function sharedSuffixSegments(a: string, b: string): number {
  const left = a.split("/").reverse();
  const right = b.split("/").reverse();
  let count = 0;
  while (count < left.length && count < right.length && left[count] === right[count]) count++;
  return count;
}

function closestPath(path: string, candidates: Iterable<string>): string | undefined {
  const name = basename(path);
  let best: string | undefined;
  let bestScore = -1;
  for (const candidate of candidates) {
    if (basename(candidate) !== name) continue;
    const score = sharedSuffixSegments(path, candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function anchorProblem(stop: Stop, ranges: DiffRanges): string | null {
  const fileRanges = ranges.get(stop.path);
  if (!fileRanges) {
    const suggestion = closestPath(stop.path, ranges.keys());
    return `path ${stop.path} is not in the diff${suggestion ? ` (did you mean ${suggestion}?)` : ""}`;
  }
  const start = stop.line;
  const end = stop.endLine ?? stop.line;
  const sideRanges = fileRanges.filter((range) => range.side === stop.side);
  if (sideRanges.some((range) => range.start <= start && end <= range.end)) return null;

  const where = start === end ? `line ${start}` : `lines ${start}-${end}`;
  if (sideRanges.length === 0) {
    return `${where} (${stop.side}): file has no hunks on the ${stop.side} side`;
  }
  const hunks = sideRanges.map((range) => `${range.start}-${range.end}`).join(", ");
  const owner = sideRanges.find((range) => range.start <= start && start <= range.end);
  if (owner) {
    return `${where} (${stop.side}) runs past hunk ${owner.start}-${owner.end}; an anchor must stay inside one hunk (hunks: ${hunks})`;
  }
  return `${where} (${stop.side}) is outside every hunk (hunks: ${hunks})`;
}

/** Every anchor must land inside a hunk of the reviewed diff. Returns one message per bad stop. */
export function checkAnchors(tour: Tour, ranges: DiffRanges): string[] {
  const messages: string[] = [];
  for (const { number, stop } of tourStops(tour)) {
    const problem = anchorProblem(stop, ranges);
    if (problem) messages.push(`stop ${number} "${stop.title}": ${problem}`);
  }
  return messages;
}

/** Parse `git diff` output into hunk ranges keyed by the path git reports. */
export function parseDiffRanges(patch: string): DiffRanges {
  const result = new Map<string, HunkRange[]>();
  for (const file of parseUnifiedDiff(patch)) {
    const ranges = result.get(file.path) ?? [];
    for (const hunk of file.hunks) {
      if (hunk.oldCount > 0) ranges.push({ side: "old", start: hunk.oldStart, end: hunk.oldStart + hunk.oldCount - 1 });
      if (hunk.newCount > 0) ranges.push({ side: "new", start: hunk.newStart, end: hunk.newStart + hunk.newCount - 1 });
    }
    result.set(file.path, ranges);
  }
  return result;
}
