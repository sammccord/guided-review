import { writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import type {
  ExtensionCliCommandContext,
  ExtensionCliCommandResult,
  ExtensionCliWriter,
  ExtensionCommandContext,
  ExtensionDiffFile,
  ExtensionNotifyType,
  ExtensionPaneProps,
  ExtensionPaneTheme,
  ExtensionReviewNavigation,
  HunkExtensionAPI,
} from "hunkdiff/extension";
import {
  checkAnchors,
  checkStopSize,
  parseTour,
  readDiffRanges,
  toSidecar,
  tourStops,
  type Stop,
  type StopKind,
  type Tour,
  type TourStop,
  type Track,
  type Verdict,
} from "./tour";

const PANE_ID = "tour";
const USAGE = "usage: hunk tour check|open <tour.json>";

interface TourState {
  tour: Tour | null;
  stops: readonly TourStop[];
  /** Index into `stops`; -1 until the tour starts. */
  current: number;
}

let state: TourState = { tour: null, stops: [], current: -1 };
const listeners = new Set<() => void>();

function setState(next: TourState) {
  state = next;
  for (const listener of listeners) listener();
}

function useTourState(): TourState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

async function writeLines(writer: ExtensionCliWriter, lines: readonly string[]) {
  if (lines.length > 0) await writer.write(`${lines.join("\n")}\n`);
}

type LoadResult = { ok: true; tour: Tour } | { ok: false; errors: string[] };

async function loadAndCheck(file: string, cwd: string): Promise<LoadResult> {
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
    const ranges = await readDiffRanges(cwd, parsed.tour.base, parsed.tour.head);
    const problems = checkAnchors(parsed.tour, ranges);
    return problems.length > 0 ? { ok: false, errors: problems } : parsed;
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

async function writeSidecar(tour: Tour): Promise<string> {
  const path = join(tmpdir(), `hunk-guided-review-${tour.head.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40)}.json`);
  await writeFile(path, `${JSON.stringify(toSidecar(tour), null, 2)}\n`, { mode: 0o600 });
  return path;
}

async function runTourCli(args: readonly string[], ctx: ExtensionCliCommandContext): Promise<ExtensionCliCommandResult> {
  const [subcommand, file, ...extra] = args;
  if ((subcommand !== "check" && subcommand !== "open") || !file || extra.length > 0) {
    await writeLines(ctx.stderr, [USAGE]);
    return { kind: "exit", code: 2 };
  }

  const result = await loadAndCheck(file, ctx.cwd);
  if (!result.ok) {
    await writeLines(ctx.stderr, result.errors);
    return { kind: "exit", code: 1 };
  }
  const { tour } = result;
  const stops = tourStops(tour);
  await writeLines(ctx.stderr, checkStopSize(tour).map((message) => `warning: ${message}`));

  if (subcommand === "check") {
    const fileCount = new Set(stops.map(({ stop }) => stop.path)).size;
    await writeLines(ctx.stdout, [
      `ok: ${stops.length} stops in ${tour.tracks.length} tracks across ${fileCount} files, verdict ${tour.verdict}`,
    ]);
    return { kind: "exit", code: 0 };
  }

  const sidecarPath = await writeSidecar(tour);
  setState({ tour, stops, current: -1 });
  return { kind: "delegate", argv: ["diff", `${tour.base}...${tour.head}`, "--agent-context", sidecarPath, "--agent-notes"] };
}

interface NavigableFile {
  id: string;
  path: string;
  previousPath?: string;
}

function findFile(files: readonly NavigableFile[], stop: Stop): NavigableFile | undefined {
  return files.find((file) => file.path === stop.path || file.previousPath === stop.path);
}

function stopLocation(stop: Stop): string {
  const lines = stop.endLine && stop.endLine !== stop.line ? `${stop.line}-${stop.endLine}` : `${stop.line}`;
  return `${stop.path}:${lines}${stop.side === "old" ? " (old)" : ""}`;
}

function revealStop(
  navigation: ExtensionReviewNavigation,
  notify: (message: string, type?: ExtensionNotifyType) => void,
  fileId: string | undefined,
  index: number,
  missing: string,
) {
  const { tour, stops } = state;
  const { number, stop, track, trackIndex } = stops[index]!;
  setState({ tour, stops, current: index });
  if (fileId === undefined) {
    notify(`Stop ${number}: ${stop.path} ${missing}`, "warning");
    return;
  }
  navigation.revealLine(fileId, stop.side, stop.line);
  const trackCount = tour?.tracks.length ?? 0;
  notify(`Stop ${number}/${stops.length} · Track ${trackIndex + 1}/${trackCount} ${track.title}: ${stop.title}`);
}

/** Hosts before API 26 lack `selection.files`; their snapshot lists filtered files too, and revealLine warns for those. */
function locateForCommand(ctx: ExtensionCommandContext, stop: Stop): { fileId?: string; missing: string } {
  const visible = (ctx.selection as { files?: readonly ExtensionDiffFile[] }).files;
  const reviewed = (ctx.review.snapshot()?.files ?? []).map((file) => ({ ...file, id: file.runtimeId }));
  const inReview = findFile(reviewed, stop);
  if (visible) {
    const shown = findFile(visible, stop);
    if (shown) return { fileId: shown.id, missing: "" };
    return { missing: inReview ? "is hidden by the current file filter" : "is not in this review" };
  }
  return inReview ? { fileId: inReview.id, missing: "" } : { missing: "is not in this review" };
}

function requireTour(ctx: ExtensionCommandContext): boolean {
  if (state.tour) return true;
  ctx.notify("No tour loaded. Start one with `hunk tour open <tour.json>`.", "warning");
  return false;
}

function goTo(ctx: ExtensionCommandContext, index: number) {
  if (!requireTour(ctx)) return;
  const { stops } = state;
  if (index >= stops.length) {
    ctx.notify(`End of tour (${stops.length} stops)`);
    return;
  }
  if (index < 0) {
    ctx.notify("Already at the first stop");
    return;
  }
  if (!ctx.panes.isOpen(PANE_ID)) ctx.panes.open(PANE_ID);
  const { fileId, missing } = locateForCommand(ctx, stops[index]!.stop);
  revealStop(ctx.navigation, ctx.notify, fileId, index, missing);
}

function firstStopOfTrack(trackIndex: number): number {
  return state.stops.findIndex((entry) => entry.trackIndex === trackIndex);
}

function goToNextTrack(ctx: ExtensionCommandContext) {
  if (!requireTour(ctx)) return;
  const { stops, current } = state;
  const target = current < 0 ? 0 : stops[current]!.trackIndex + 1;
  const index = firstStopOfTrack(target);
  if (index < 0) {
    ctx.notify(`Already in the last track (${state.tour!.tracks.length} tracks)`);
    return;
  }
  goTo(ctx, index);
}

function goToPreviousTrack(ctx: ExtensionCommandContext) {
  if (!requireTour(ctx)) return;
  const { stops, current } = state;
  if (current < 0) {
    ctx.notify("Already at the first stop");
    return;
  }
  const trackIndex = stops[current]!.trackIndex;
  const trackStart = firstStopOfTrack(trackIndex);
  if (current > trackStart) {
    goTo(ctx, trackStart);
    return;
  }
  if (trackIndex === 0) {
    ctx.notify("Already in the first track");
    return;
  }
  goTo(ctx, firstStopOfTrack(trackIndex - 1));
}

function kindColor(kind: StopKind, theme: ExtensionPaneTheme): string {
  switch (kind) {
    case "blocker":
      return theme.badgeRemoved;
    case "risk":
      return theme.fileModified;
    case "question":
      return theme.accent;
    case "inspect":
      return theme.badgeNeutral;
    case "context":
      return theme.muted;
  }
}

function verdictColor(verdict: Verdict, theme: ExtensionPaneTheme): string {
  switch (verdict) {
    case "approve":
      return theme.badgeAdded;
    case "request-changes":
      return theme.badgeRemoved;
    case "discuss":
      return theme.accent;
  }
}

function Heading({ label, theme }: { label: string; theme: ExtensionPaneTheme }) {
  return (
    <box style={{ marginTop: 1, paddingLeft: 1 }}>
      <text content={label} fg={theme.accent} attributes={TextAttributes.BOLD} />
    </box>
  );
}

function Bullets({ items, theme, empty }: { items: readonly string[]; theme: ExtensionPaneTheme; empty: string }) {
  if (items.length === 0) {
    return (
      <box style={{ paddingLeft: 2 }}>
        <text content={empty} fg={theme.muted} />
      </box>
    );
  }
  return (
    <>
      {items.map((item, index) => (
        <box key={index} style={{ paddingLeft: 2, paddingRight: 1 }}>
          <text content={`• ${item}`} fg={theme.text} wrapMode="word" />
        </box>
      ))}
    </>
  );
}

function StopRow({
  stop,
  index,
  current,
  theme,
  onSelect,
}: {
  stop: Stop;
  /** Global position in the tour, 0-based. */
  index: number;
  current: boolean;
  theme: ExtensionPaneTheme;
  onSelect: () => void;
}) {
  const bg = current ? theme.selectedHunk : theme.panel;
  return (
    <box id={`tour-stop-${index}`} style={{ flexDirection: "column", backgroundColor: bg }} onMouseDown={onSelect}>
      <box style={{ paddingLeft: 1, paddingRight: 1, backgroundColor: bg }}>
        <text fg={theme.text} bg={bg} wrapMode="word" attributes={current ? TextAttributes.BOLD : TextAttributes.NONE}>
          <span fg={theme.text}>{`${current ? "▸" : " "}${index + 1}. `}</span>
          <span fg={kindColor(stop.kind, theme)}>{`[${stop.kind}] `}</span>
          <span fg={theme.text}>{stop.title}</span>
        </text>
      </box>
      <box style={{ paddingLeft: 5, paddingRight: 1, backgroundColor: bg }}>
        <text content={stopLocation(stop)} fg={theme.muted} bg={bg} wrapMode="char" />
      </box>
      {current ? (
        <box style={{ flexDirection: "column", paddingLeft: 5, paddingRight: 1, paddingBottom: 1, backgroundColor: bg }}>
          <text content={stop.body} fg={theme.text} bg={bg} wrapMode="word" />
          <box style={{ marginTop: 1, backgroundColor: bg }}>
            <text content={`Ask: ${stop.ask}`} fg={theme.noteBorder} bg={bg} wrapMode="word" attributes={TextAttributes.BOLD} />
          </box>
        </box>
      ) : null}
    </box>
  );
}

function TrackHeading({
  track,
  trackIndex,
  current,
  theme,
}: {
  track: Track;
  trackIndex: number;
  current: boolean;
  theme: ExtensionPaneTheme;
}) {
  return (
    <box style={{ flexDirection: "column", marginTop: 1 }}>
      <box style={{ paddingLeft: 1, paddingRight: 1 }}>
        <text wrapMode="word">
          <span fg={theme.accent} attributes={TextAttributes.BOLD}>{`${current ? "▸" : " "}Track ${trackIndex + 1}: ${track.title}`}</span>
          <span fg={theme.muted}>{` (${track.stops.length} stop${track.stops.length === 1 ? "" : "s"})`}</span>
        </text>
      </box>
      <box style={{ paddingLeft: 2, paddingRight: 1 }}>
        <text content={track.summary} fg={theme.muted} wrapMode="word" />
      </box>
    </box>
  );
}

function TourPane({ files, theme, actions }: ExtensionPaneProps): ReactNode {
  const { tour, stops, current } = useTourState();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);

  useEffect(() => {
    if (current >= 0) scrollRef.current?.scrollChildIntoView(`tour-stop-${current}`);
  }, [current]);

  if (!tour) return <text content=" No tour loaded" fg={theme.muted} />;

  const select = (index: number) => {
    const file = findFile(files, stops[index]!.stop);
    revealStop(actions, actions.notify, file?.id, index, "is hidden by the file filter or not in this review");
  };
  const currentTrack = current >= 0 ? stops[current]!.trackIndex : -1;

  return (
    <scrollbox
      ref={scrollRef}
      width="100%"
      height="100%"
      focused={false}
      scrollY={true}
      rootOptions={{ backgroundColor: theme.panel }}
      wrapperOptions={{ backgroundColor: theme.panel }}
      viewportOptions={{ backgroundColor: theme.panel }}
      contentOptions={{ backgroundColor: theme.panel }}
      verticalScrollbarOptions={{ visible: false }}
      horizontalScrollbarOptions={{ visible: false }}
    >
      <box style={{ width: "100%", flexDirection: "column", backgroundColor: theme.panel }}>
        <box style={{ paddingLeft: 1, paddingRight: 1 }}>
          <text content={tour.title} fg={theme.text} wrapMode="word" attributes={TextAttributes.BOLD} />
        </box>
        <box style={{ paddingLeft: 1 }}>
          <text content={tour.verdict.toUpperCase()} fg={verdictColor(tour.verdict, theme)} attributes={TextAttributes.BOLD} />
        </box>
        <box style={{ marginTop: 1, paddingLeft: 1, paddingRight: 1 }}>
          <text content={tour.summary} fg={theme.text} wrapMode="word" />
        </box>

        <Heading label={`Stops (${stops.length})`} theme={theme} />
        {current < 0 && stops.length > 0 ? (
          <box style={{ paddingLeft: 2 }}>
            <text content="Press > to start the tour" fg={theme.muted} attributes={TextAttributes.ITALIC} />
          </box>
        ) : null}
        {tour.tracks.map((track, trackIndex) => (
          <box key={trackIndex} style={{ flexDirection: "column", backgroundColor: theme.panel }}>
            <TrackHeading track={track} trackIndex={trackIndex} current={trackIndex === currentTrack} theme={theme} />
            {stops.map((entry, index) =>
              entry.trackIndex === trackIndex ? (
                <StopRow
                  key={index}
                  stop={entry.stop}
                  index={index}
                  current={index === current}
                  theme={theme}
                  onSelect={() => select(index)}
                />
              ) : null,
            )}
          </box>
        ))}

        <Heading label="Checked" theme={theme} />
        <Bullets items={tour.scope.checked} theme={theme} empty="(nothing listed)" />
        <Heading label="Not checked" theme={theme} />
        <Bullets items={tour.scope.unchecked} theme={theme} empty="(nothing listed)" />
        {tour.skipped.length > 0 ? (
          <>
            <Heading label="Skipped files" theme={theme} />
            <Bullets items={tour.skipped.map((file) => `${file.path} — ${file.reason}`)} theme={theme} empty="" />
          </>
        ) : null}
      </box>
    </scrollbox>
  );
}

export default function registerGuidedReview(hunk: HunkExtensionAPI) {
  hunk.registerCliCommand({ name: "tour", summary: "Check or open a guided review tour", usage: "check|open <tour.json>" }, runTourCli);

  hunk.registerPane({
    id: PANE_ID,
    title: "Tour",
    placement: "right",
    width: { preferred: 48, min: 32 },
    defaultOpen: true,
    available: () => state.tour !== null,
    component: TourPane,
  });

  hunk.registerCommand({ id: "next", title: "Next tour stop", key: ">" }, (ctx) => goTo(ctx, state.current + 1));
  hunk.registerCommand({ id: "prev", title: "Previous tour stop", key: "<" }, (ctx) => goTo(ctx, state.current - 1));
  hunk.registerCommand({ id: "nextTrack", title: "Next tour track", key: ")" }, goToNextTrack);
  hunk.registerCommand({ id: "prevTrack", title: "Previous tour track", key: "(" }, goToPreviousTrack);
  hunk.registerCommand({ id: "start", title: "Restart tour" }, (ctx) => goTo(ctx, 0));
}
