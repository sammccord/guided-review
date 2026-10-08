import type { Stop, Tour } from "./schema";
import { tourStops } from "./stops";

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

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** Undo git's core.quotePath C-style quoting, whose octal escapes are UTF-8 bytes. */
function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const bytes: number[] = [];
  const body = raw.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      bytes.push(...new TextEncoder().encode(ch));
      continue;
    }
    const next = body[i + 1] ?? "";
    if (/[0-7]/.test(next)) {
      bytes.push(Number.parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function stripPrefix(path: string, prefix: "a/" | "b/"): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function headerPath(line: string, marker: "--- " | "+++ "): string | null {
  const raw = unquoteGitPath(line.slice(marker.length).replace(/\t.*$/, ""));
  if (raw === "/dev/null") return null;
  return stripPrefix(raw, marker === "--- " ? "a/" : "b/");
}

/** Best-effort path for headers with no ---/+++ lines (binary, mode-only); ambiguous when paths contain " b/". */
function diffGitPaths(line: string): { oldPath: string; newPath: string } {
  const rest = line.slice("diff --git ".length);
  const quoted = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(rest);
  if (quoted) {
    return {
      oldPath: stripPrefix(unquoteGitPath(quoted[1]!), "a/"),
      newPath: stripPrefix(unquoteGitPath(quoted[2]!), "b/"),
    };
  }
  const split = rest.indexOf(" b/");
  if (split < 0) return { oldPath: stripPrefix(rest, "a/"), newPath: stripPrefix(rest, "a/") };
  return { oldPath: stripPrefix(rest.slice(0, split), "a/"), newPath: rest.slice(split + 3) };
}

interface FileBuilder {
  oldPath: string;
  newPath: string;
  deleted: boolean;
  ranges: HunkRange[];
}

/** Parse `git diff` output into hunk ranges keyed by the path git reports. */
export function parseDiffRanges(patch: string): DiffRanges {
  const result = new Map<string, HunkRange[]>();
  let file: FileBuilder | null = null;
  let oldLeft = 0;
  let newLeft = 0;

  const flush = () => {
    if (!file) return;
    const key = file.deleted ? file.oldPath : file.newPath;
    result.set(key, [...(result.get(key) ?? []), ...file.ranges]);
    file = null;
  };

  for (const line of patch.split("\n")) {
    if (file && (oldLeft > 0 || newLeft > 0)) {
      const marker = line[0];
      if (marker === " " || line === "") {
        oldLeft--;
        newLeft--;
      } else if (marker === "-") {
        oldLeft--;
      } else if (marker === "+") {
        newLeft--;
      }
      continue;
    }
    if (line.startsWith("diff --git ")) {
      flush();
      file = { ...diffGitPaths(line), deleted: false, ranges: [] };
      continue;
    }
    if (!file) continue;
    const current: FileBuilder = file;
    if (line.startsWith("rename from ")) current.oldPath = unquoteGitPath(line.slice(12));
    else if (line.startsWith("rename to ")) current.newPath = unquoteGitPath(line.slice(10));
    else if (line.startsWith("deleted file mode")) current.deleted = true;
    else if (line.startsWith("--- ")) {
      const path = headerPath(line, "--- ");
      if (path !== null) current.oldPath = path;
    } else if (line.startsWith("+++ ")) {
      const path = headerPath(line, "+++ ");
      if (path === null) current.deleted = true;
      else current.newPath = path;
    } else if (line.startsWith("@@ ")) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match) continue;
      const oldStart = Number(match[1]);
      const oldCount = match[2] === undefined ? 1 : Number(match[2]);
      const newStart = Number(match[3]);
      const newCount = match[4] === undefined ? 1 : Number(match[4]);
      if (oldCount > 0) current.ranges.push({ side: "old", start: oldStart, end: oldStart + oldCount - 1 });
      if (newCount > 0) current.ranges.push({ side: "new", start: newStart, end: newStart + newCount - 1 });
      oldLeft = oldCount;
      newLeft = newCount;
    }
  }
  flush();
  return result;
}
