import type { AgentAnnotation, AgentFileContext } from "hunkdiff/extension";
import { tourStops, type Tour, type TourStop } from "../core/src/index";

export interface SidecarDocument {
  version: 1;
  summary?: string;
  files: AgentFileContext[];
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
