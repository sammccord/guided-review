export const TOUR_VERSION = 1;

export const STOP_KINDS = ["blocker", "risk", "question", "inspect", "context"] as const;
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
