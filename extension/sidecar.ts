import type { AgentAnnotation, AgentFileContext } from "hunkdiff/extension";
import { indexStops, segmentText, tourStops, type StopIndex, type Tour, type TourStop } from "../core/src/index";

export interface SidecarDocument {
  version: 1;
  summary?: string;
  files: AgentFileContext[];
}

/** Hunk notes are plain text, so a link carries enough to find its target without the pane. */
function plain(text: string, index: StopIndex): string {
  return segmentText(text, index)
    .map((segment) => {
      if (segment.kind === "text") return segment.text;
      const { number, stop } = segment.target;
      return `#${number} "${stop.title}" (${stop.path}:${stop.line})`;
    })
    .join("");
}

function stopAnnotation({ number, stop, track }: TourStop, total: number, index: StopIndex): AgentAnnotation {
  const range: [number, number] = [stop.line, stop.endLine ?? stop.line];
  return {
    id: `stop-${number}`,
    ...(stop.side === "new" ? { newRange: range } : { oldRange: range }),
    summary: `${number}/${total} [${stop.kind}] ${track.title} › ${stop.title}`,
    rationale: plain(`${stop.body}\n\nAsk: ${stop.ask}`, index),
    tags: [stop.kind],
    source: "guided-review",
    author: "guided-review",
  };
}

/** Files ordered by first stop, one entry per file, so hunk's sidebar and `{`/`}` follow the tour. */
export function toSidecar(tour: Tour): SidecarDocument {
  const stops = tourStops(tour);
  const index = indexStops(stops);
  const byPath = new Map<string, { annotations: AgentAnnotation[]; numbers: number[] }>();
  for (const entry of stops) {
    const file = byPath.get(entry.stop.path) ?? { annotations: [], numbers: [] };
    file.annotations.push(stopAnnotation(entry, stops.length, index));
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
  const trackLines = tour.tracks.map((track, trackIndex) => {
    const last = first + track.stops.length - 1;
    const range = first === last ? `stop ${first}` : `stops ${first}-${last}`;
    first = last + 1;
    const line = `${trackIndex + 1}. ${track.title} (${range})`;
    const linked = plain(track.summary, index);
    // A summary joins the list only when it links stops: those links are the cross-track map note readers lack.
    return linked === track.summary ? line : `${line}\n   ${linked}`;
  });
  const tracks = trackLines.length > 0 ? `\n\nTracks:\n${trackLines.join("\n")}` : "";

  return {
    version: 1,
    summary: `${tour.verdict.toUpperCase()} · ${tour.title}\n\n${tour.summary}${tracks}`,
    files,
  };
}
