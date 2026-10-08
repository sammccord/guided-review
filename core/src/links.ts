import type { TourStop } from "./schema";

export const STOP_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const REFERENCE_PATTERN = /\[\[([^[\]\n]+)\]\]/g;

export type TextSegment = { kind: "text"; text: string } | { kind: "link"; id: string; target: TourStop };

export interface StopIndex {
  byId: ReadonlyMap<string, TourStop>;
  /** Distinct stops referenced from the body and ask of the stop at this tour position, in order of first appearance. */
  linksFrom(stopIndex: number): TourStop[];
  /** Stops whose body or ask reference the stop at this tour position, in tour order. */
  linksTo(stopIndex: number): TourStop[];
}

/** Every `[[id]]` in the text, in order, repeats included. */
export function referencedIds(text: string): string[] {
  return [...text.matchAll(REFERENCE_PATTERN)].map((match) => match[1]!);
}

/** References that do not resolve stay as literal text. */
export function segmentText(text: string, index: StopIndex): TextSegment[] {
  const segments: TextSegment[] = [];
  let pending = "";
  let last = 0;
  for (const match of text.matchAll(REFERENCE_PATTERN)) {
    const id = match[1]!;
    const target = index.byId.get(id);
    const end = match.index + match[0].length;
    if (!target) {
      pending += text.slice(last, end);
      last = end;
      continue;
    }
    pending += text.slice(last, match.index);
    if (pending) segments.push({ kind: "text", text: pending });
    segments.push({ kind: "link", id, target });
    pending = "";
    last = end;
  }
  pending += text.slice(last);
  if (pending) segments.push({ kind: "text", text: pending });
  return segments;
}

export function indexStops(stops: readonly TourStop[]): StopIndex {
  const byId = new Map<string, TourStop>();
  for (const entry of stops) if (entry.stop.id !== undefined) byId.set(entry.stop.id, entry);

  const outgoing = stops.map((entry) => {
    const targets = new Set<TourStop>();
    for (const id of referencedIds(`${entry.stop.body}\n${entry.stop.ask}`)) {
      const target = byId.get(id);
      if (target && target !== entry) targets.add(target);
    }
    return [...targets];
  });
  const incoming = stops.map((target) => stops.filter((_, from) => outgoing[from]!.includes(target)));

  return {
    byId,
    linksFrom: (stopIndex) => [...(outgoing[stopIndex] ?? [])],
    linksTo: (stopIndex) => [...(incoming[stopIndex] ?? [])],
  };
}

export function formatLink(target: TourStop): string {
  return `#${target.number} ${target.stop.title}`;
}
