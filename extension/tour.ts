import { execFile } from "node:child_process";
import type { AgentAnnotation, AgentFileContext } from "hunkdiff/extension";

export const TOUR_VERSION = 1;

export const STOP_KINDS = ["blocker", "risk", "question", "context"] as const;
export const VERDICTS = ["approve", "request-changes", "discuss"] as const;

export type StopKind = (typeof STOP_KINDS)[number];
export type Verdict = (typeof VERDICTS)[number];

/** One place the human must look. Array position within its track is the narrative order. */
export interface Stop {
  /** Path as git reports it: the new path, or the old path for a deleted file. */
  path: string;
  side: "new" | "old";
  line: number;
  endLine?: number;
  kind: StopKind;
  title: string;
  /** What changed here and why it matters. Plain text. */
  body: string;
  /** The decision only the human can make at this stop. */
  ask: string;
}

/** Stops that only make sense together: one causal chain, one subsystem, or one concern. */
export interface Track {
  title: string;
  /** How the stops in this track relate, and why the reviewer should read them together. Plain text. */
  summary: string;
  stops: Stop[];
}

/** A stop with its global 1-based number and its track, in tour order. */
export interface TourStop {
  number: number;
  stop: Stop;
  track: Track;
  trackIndex: number;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

/** The tour an agent writes and the extension presents. Single source of truth. */
export interface Tour {
  version: typeof TOUR_VERSION;
  title: string;
  url?: string;
  /** Resolved commit SHAs. The reviewed diff is `base...head`. */
  base: string;
  head: string;
  verdict: Verdict;
  /** Intent of the change and the bottom line. Plain text. */
  summary: string;
  scope: { checked: string[]; unchecked: string[] };
  /** Track order, then stop order within each track, is the tour order. */
  tracks: Track[];
  skipped: SkippedFile[];
}

export interface SidecarDocument {
  version: 1;
  summary?: string;
  files: AgentFileContext[];
}

/** Changed line ranges per file side, as git reports them for `base...head`. */
export interface HunkRange {
  side: "new" | "old";
  start: number;
  end: number;
}
export type DiffRanges = ReadonlyMap<string, readonly HunkRange[]>;

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

export type ParseResult = { ok: true; tour: Tour } | { ok: false; errors: string[] };

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return values.some((candidate) => candidate === value);
}

class Collector {
  readonly errors: string[] = [];

  string(obj: Json, key: string, at: string): string {
    const value = obj[key];
    if (isNonEmptyString(value)) return value;
    this.errors.push(`${at}${key} must be a non-empty string`);
    return "";
  }

  stringArray(obj: Json, key: string, at: string): string[] {
    const value = obj[key];
    if (!Array.isArray(value)) {
      this.errors.push(`${at}${key} must be an array of strings`);
      return [];
    }
    value.forEach((item, index) => {
      if (typeof item !== "string") this.errors.push(`${at}${key}[${index}] must be a string`);
    });
    return value.filter((item): item is string => typeof item === "string");
  }

  member<T extends string>(values: readonly T[], obj: Json, key: string, at: string): T {
    const value = obj[key];
    if (oneOf(values, value)) return value;
    this.errors.push(`${at}${key} must be one of ${values.join(", ")}`);
    return values[0]!;
  }
}

function parseStop(raw: unknown, at: string, c: Collector): Stop {
  if (!isObject(raw)) {
    c.errors.push(`${at} must be an object`);
    return { path: "", side: "new", line: 1, kind: "context", title: "", body: "", ask: "" };
  }
  const prefix = `${at}.`;
  const path = c.string(raw, "path", prefix);
  const side = c.member(["new", "old"] as const, raw, "side", prefix);
  let line = 1;
  if (isPositiveInteger(raw.line)) line = raw.line;
  else c.errors.push(`${prefix}line must be a positive integer`);
  let endLine: number | undefined;
  if (raw.endLine !== undefined) {
    if (!isPositiveInteger(raw.endLine)) {
      c.errors.push(`${prefix}endLine must be a positive integer`);
    } else if (isPositiveInteger(raw.line) && raw.endLine < raw.line) {
      c.errors.push(`${prefix}endLine must be >= line`);
    } else {
      endLine = raw.endLine;
    }
  }
  const kind = c.member(STOP_KINDS, raw, "kind", prefix);
  const title = c.string(raw, "title", prefix);
  const body = c.string(raw, "body", prefix);
  const ask = c.string(raw, "ask", prefix);
  return { path, side, line, ...(endLine === undefined ? {} : { endLine }), kind, title, body, ask };
}

function parseTrack(raw: unknown, at: string, c: Collector): Track {
  if (!isObject(raw)) {
    c.errors.push(`${at} must be an object`);
    return { title: "", summary: "", stops: [] };
  }
  const prefix = `${at}.`;
  const title = c.string(raw, "title", prefix);
  const summary = c.string(raw, "summary", prefix);
  let stops: Stop[] = [];
  if (!Array.isArray(raw.stops) || raw.stops.length === 0) {
    c.errors.push(`${prefix}stops must be a non-empty array`);
  } else {
    stops = raw.stops.map((stop, index) => parseStop(stop, `${prefix}stops[${index}]`, c));
  }
  return { title, summary, stops };
}

function parseSkipped(raw: unknown, at: string, c: Collector): SkippedFile {
  if (!isObject(raw)) {
    c.errors.push(`${at} must be an object`);
    return { path: "", reason: "" };
  }
  return { path: c.string(raw, "path", `${at}.`), reason: c.string(raw, "reason", `${at}.`) };
}

/** Validate untrusted JSON into a Tour. Collects every error instead of stopping at the first. */
export function parseTour(raw: unknown): ParseResult {
  if (!isObject(raw)) return { ok: false, errors: ["tour must be a JSON object"] };
  const c = new Collector();

  if (raw.version !== TOUR_VERSION) c.errors.push(`version must be ${TOUR_VERSION}`);
  const title = c.string(raw, "title", "");
  let url: string | undefined;
  if (raw.url !== undefined) {
    if (isNonEmptyString(raw.url)) url = raw.url;
    else c.errors.push("url must be a non-empty string when present");
  }
  const base = c.string(raw, "base", "");
  const head = c.string(raw, "head", "");
  const verdict = c.member(VERDICTS, raw, "verdict", "");
  const summary = c.string(raw, "summary", "");

  let scope = { checked: [] as string[], unchecked: [] as string[] };
  if (isObject(raw.scope)) {
    scope = {
      checked: c.stringArray(raw.scope, "checked", "scope."),
      unchecked: c.stringArray(raw.scope, "unchecked", "scope."),
    };
  } else {
    c.errors.push("scope must be an object with checked and unchecked string arrays");
  }

  if (raw.stops !== undefined) c.errors.push("stops is no longer supported; group stops under tracks[]");
  let tracks: Track[] = [];
  if (!Array.isArray(raw.tracks)) {
    c.errors.push("tracks must be an array (may be empty)");
  } else {
    tracks = raw.tracks.map((track, index) => parseTrack(track, `tracks[${index}]`, c));
  }

  let skipped: SkippedFile[] = [];
  if (!Array.isArray(raw.skipped)) {
    c.errors.push("skipped must be an array (may be empty)");
  } else {
    skipped = raw.skipped.map((item, index) => parseSkipped(item, `skipped[${index}]`, c));
  }

  if (c.errors.length > 0) return { ok: false, errors: c.errors };
  return {
    ok: true,
    tour: {
      version: TOUR_VERSION,
      title,
      ...(url === undefined ? {} : { url }),
      base,
      head,
      verdict,
      summary,
      scope,
      tracks,
      skipped,
    },
  };
}

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

const GIT_PREFIX_ARGS = [
  "-c",
  "core.quotePath=true",
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicPrefix=false",
  "-c",
  "diff.srcPrefix=a/",
  "-c",
  "diff.dstPrefix=b/",
];

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

/** Run git with hunk's own diff arguments and collect hunk ranges per path. */
export function readDiffRanges(cwd: string, base: string, head: string): Promise<DiffRanges> {
  const range = `${base}...${head}`;
  const args = ["-C", cwd, ...GIT_PREFIX_ARGS, "diff", "--no-ext-diff", "--find-renames", "--no-color", range];
  return new Promise((resolve, reject) => {
    execFile("git", args, { maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr).trim() || error.message;
        reject(new Error(`git diff ${range} failed in ${cwd}: ${detail}`));
        return;
      }
      resolve(parseDiffRanges(String(stdout)));
    });
  });
}

function stopAnnotation({ number, stop, track }: TourStop, total: number): AgentAnnotation {
  const range: [number, number] = [stop.line, stop.endLine ?? stop.line];
  return {
    id: `stop-${number}`,
    ...(stop.side === "new" ? { newRange: range } : { oldRange: range }),
    summary: `${number}/${total} [${stop.kind}] ${track.title} › ${stop.title}`,
    rationale: `${stop.body}\n\nAsk: ${stop.ask}`,
    tags: [stop.kind],
    source: "guided-review",
    author: "guided-review",
  };
}

/** Files ordered by first stop, one entry per file, so hunk's sidebar and `{`/`}` follow the tour. */
export function toSidecar(tour: Tour): SidecarDocument {
  const stops = tourStops(tour);
  const byPath = new Map<string, { annotations: AgentAnnotation[]; numbers: number[] }>();
  for (const entry of stops) {
    const file = byPath.get(entry.stop.path) ?? { annotations: [], numbers: [] };
    file.annotations.push(stopAnnotation(entry, stops.length));
    file.numbers.push(entry.number);
    byPath.set(entry.stop.path, file);
  }

  const files: AgentFileContext[] = [...byPath].map(([path, entry]) => ({
    path,
    summary: `Tour stop${entry.numbers.length === 1 ? "" : "s"} ${entry.numbers.join(", ")}`,
    annotations: entry.annotations,
  }));
  const listed = new Set(byPath.keys());
  for (const skipped of tour.skipped) {
    if (listed.has(skipped.path)) continue;
    listed.add(skipped.path);
    files.push({ path: skipped.path, summary: `Skipped: ${skipped.reason}`, annotations: [] });
  }

  let first = 1;
  const trackLines = tour.tracks.map((track, index) => {
    const last = first + track.stops.length - 1;
    const range = first === last ? `stop ${first}` : `stops ${first}-${last}`;
    first = last + 1;
    return `${index + 1}. ${track.title} (${range})`;
  });
  const tracks = trackLines.length > 0 ? `\n\nTracks:\n${trackLines.join("\n")}` : "";

  return {
    version: 1,
    summary: `${tour.verdict.toUpperCase()} · ${tour.title}\n\n${tour.summary}${tracks}`,
    files,
  };
}
