import { writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { TextAttributes, type MouseEvent, type ScrollBoxRenderable } from "@opentui/core";
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
  commentStatus,
  decisions,
  formatLink,
  indexStops,
  initialCursor,
  move,
  segmentText,
  stackPosition,
  statusText,
  validateTour,
  type CommentStatus,
  type Decision,
  type StackLayer,
  type Stop,
  type StopIndex,
  type StopKind,
  type Tour,
  type TourCursor,
  type TourMove,
  type TourStack,
  type TourStop,
  type Track,
  type ValidateResult,
  type Verdict,
} from "../core/src/index";
import { readDiffRanges } from "../core/src/git";
import { decisionBadge, openSession, QA_USAGE, registerQa, requestComment, runAnswer, runWait, useMailbox, type TourAccess } from "./qa";
import { toSidecar } from "./sidecar";

const PANE_ID = "tour";

interface TourState {
  tour: Tour | null;
  stops: readonly TourStop[];
  links: StopIndex;
  cursor: TourCursor;
}

let state: TourState = { tour: null, stops: [], links: indexStops([]), cursor: initialCursor() };
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

async function loadAndCheck(file: string, cwd: string): Promise<ValidateResult> {
  const path = resolve(cwd, file);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    return { ok: false, errors: [`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`] };
  }
  return validateTour(raw, (base, head) => readDiffRanges(cwd, base, head));
}

async function writeSidecar(tour: Tour): Promise<string> {
  const path = join(tmpdir(), `hunk-guided-review-${tour.head.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40)}.json`);
  await writeFile(path, `${JSON.stringify(toSidecar(tour), null, 2)}\n`, { mode: 0o600 });
  return path;
}

async function runTourCli(args: readonly string[], ctx: ExtensionCliCommandContext): Promise<ExtensionCliCommandResult> {
  const [subcommand, file, ...extra] = args;
  if (subcommand === "wait") return runWait(args.slice(1), ctx);
  if (subcommand === "answer") return runAnswer(args.slice(1), ctx);
  if ((subcommand !== "check" && subcommand !== "open") || !file || extra.length > 0) {
    await writeLines(ctx.stderr, QA_USAGE);
    return { kind: "exit", code: 2 };
  }

  const result = await loadAndCheck(file, ctx.cwd);
  if (!result.ok) {
    await writeLines(ctx.stderr, result.errors);
    return { kind: "exit", code: 1 };
  }
  const { tour, stops, index, warnings } = result;
  await writeLines(ctx.stderr, warnings.map((message) => `warning: ${message}`));

  if (subcommand === "check") {
    const fileCount = new Set(stops.map(({ stop }) => stop.path)).size;
    let stackSuffix = "";
    if (tour.stack) {
      const { index, total } = stackPosition(tour.stack);
      stackSuffix = ` · stack #${tour.stack.number} layer ${index}/${total}`;
    }
    await writeLines(ctx.stdout, [
      `ok: ${stops.length} stops in ${tour.tracks.length} tracks across ${fileCount} files, verdict ${tour.verdict}${stackSuffix}`,
    ]);
    return { kind: "exit", code: 0 };
  }

  const sidecarPath = await writeSidecar(tour);
  setState({ tour, stops, links: index, cursor: initialCursor() });
  await openSession({ repo: ctx.cwd, tourPath: resolve(ctx.cwd, file), head: tour.head });
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

type DescribeStop = (entry: TourStop) => string;

const describeStop: DescribeStop = ({ number, stop, track, trackIndex }) =>
  `Stop ${number}/${state.stops.length} · Track ${trackIndex + 1}/${state.tour?.tracks.length ?? 0} ${track.title}: ${stop.title}`;

const describeBack: DescribeStop = ({ number, stop }) => `Back to stop ${number}/${state.stops.length}: ${stop.title}`;

function revealStop(
  navigation: ExtensionReviewNavigation,
  notify: (message: string, type?: ExtensionNotifyType) => void,
  fileId: string | undefined,
  cursor: TourCursor,
  missing: string,
  describe: DescribeStop = describeStop,
) {
  const entry = state.stops[cursor.current]!;
  setState({ ...state, cursor });
  if (fileId === undefined) {
    notify(`Stop ${entry.number}: ${entry.stop.path} ${missing}`, "warning");
    return;
  }
  navigation.revealLine(fileId, entry.stop.side, entry.stop.line);
  notify(describe(entry));
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

function apply(ctx: ExtensionCommandContext, tourMove: TourMove, describe: DescribeStop = describeStop) {
  const { tour, stops, cursor } = state;
  if (!tour) {
    ctx.notify("No tour loaded. Start one with `hunk tour open <tour.json>`.", "warning");
    return;
  }
  const result = move(stops, tour.tracks.length, cursor, tourMove);
  if (!result.ok) {
    ctx.notify(result.reason);
    return;
  }
  ctx.panes.open(PANE_ID);
  const { fileId, missing } = locateForCommand(ctx, stops[result.cursor.current]!.stop);
  revealStop(ctx.navigation, ctx.notify, fileId, result.cursor, missing, describe);
}

async function followLink(ctx: ExtensionCommandContext) {
  const { tour, links, cursor } = state;
  if (!tour) {
    ctx.notify("No tour loaded. Start one with `hunk tour open <tour.json>`.", "warning");
    return;
  }
  if (cursor.current < 0) {
    ctx.notify("No current stop. Press > to start the tour.");
    return;
  }
  const choices = [
    ...links.linksFrom(cursor.current).map((target) => ({ label: `→ ${formatLink(target)}`, target })),
    ...links.linksTo(cursor.current).map((target) => ({ label: `← ${formatLink(target)}`, target })),
  ];
  if (choices.length === 0) {
    ctx.notify("This stop has no links");
    return;
  }
  let target = choices[0]!.target;
  if (choices.length > 1) {
    const picked = await ctx.dialogs.select({ title: "Follow a link", options: choices.map(({ label }) => label) });
    const choice = choices.find(({ label }) => label === picked);
    if (!choice) return;
    target = choice.target;
  }
  apply(ctx, { kind: "follow", index: target.number - 1 });
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

function decisionColor(decision: Decision, theme: ExtensionPaneTheme): string {
  switch (decision) {
    case "agree":
      return theme.badgeAdded;
    case "disagree":
      return theme.badgeRemoved;
    case "unsure":
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

/** `- ` lines become rows with a hanging indent so wrapped bullets stay readable in a narrow pane. */
function BulletedText({ text, ...props }: Parameters<typeof LinkedText>[0]) {
  return (
    <box style={{ flexDirection: "column", backgroundColor: props.bg }}>
      {text.split("\n").filter((line) => line.trim() !== "").map((line, index) => {
        const bullet = line.trimStart().startsWith("- ");
        return bullet ? (
          <box key={index} style={{ flexDirection: "row", backgroundColor: props.bg }}>
            <text content="• " fg={props.fg} bg={props.bg} />
            <box style={{ flexGrow: 1, flexShrink: 1, backgroundColor: props.bg }}>
              <LinkedText {...props} text={line.trimStart().slice(2)} />
            </box>
          </box>
        ) : (
          <LinkedText key={index} {...props} text={line} />
        );
      })}
    </box>
  );
}

function LinkedText({
  text,
  links,
  fg,
  bg,
  theme,
  prefix = "",
  attributes = TextAttributes.NONE,
}: {
  text: string;
  links: StopIndex;
  fg: string;
  bg?: string;
  theme: ExtensionPaneTheme;
  prefix?: string;
  attributes?: number;
}) {
  return (
    <text fg={fg} bg={bg} wrapMode="word" attributes={attributes}>
      {prefix ? <span fg={fg}>{prefix}</span> : null}
      {segmentText(text, links).map((segment, index) =>
        segment.kind === "text" ? (
          <span key={index} fg={fg}>
            {segment.text}
          </span>
        ) : (
          <span key={index} fg={theme.accent} attributes={attributes | TextAttributes.UNDERLINE}>
            {formatLink(segment.target)}
          </span>
        ),
      )}
    </text>
  );
}

function LinkRows({
  label,
  arrow,
  targets,
  bg,
  theme,
  onFollow,
}: {
  label: string;
  arrow: string;
  targets: readonly TourStop[];
  bg: string;
  theme: ExtensionPaneTheme;
  onFollow: (target: TourStop) => void;
}) {
  if (targets.length === 0) return null;
  const follow = (target: TourStop) => (event: MouseEvent) => {
    event.stopPropagation();
    onFollow(target);
  };
  return (
    <box style={{ flexDirection: "column", marginTop: 1, backgroundColor: bg }}>
      <text content={label} fg={theme.muted} bg={bg} attributes={TextAttributes.BOLD} />
      {targets.map((target) => (
        <box key={target.number} style={{ backgroundColor: bg }} onMouseDown={follow(target)}>
          <text bg={bg} wrapMode="word">
            <span fg={theme.accent}>{`${arrow} `}</span>
            <span fg={theme.accent} attributes={TextAttributes.UNDERLINE}>
              {formatLink(target)}
            </span>
            <span fg={theme.muted}>{`  ${target.stop.path}:${target.stop.line}`}</span>
          </text>
        </box>
      ))}
    </box>
  );
}

function StopRow({
  stop,
  index,
  current,
  related,
  decision,
  comment,
  links,
  theme,
  onSelect,
  onFollow,
  onComment,
}: {
  stop: Stop;
  /** Global position in the tour, 0-based. */
  index: number;
  current: boolean;
  /** Links to or from the current stop. */
  related: boolean;
  decision: Decision | undefined;
  comment: CommentStatus;
  links: StopIndex;
  theme: ExtensionPaneTheme;
  onSelect: () => void;
  onFollow: (target: TourStop) => void;
  onComment: () => void;
}) {
  const bg = current ? theme.selectedHunk : theme.panel;
  return (
    <box id={`tour-stop-${index}`} style={{ flexDirection: "column", backgroundColor: bg }} onMouseDown={onSelect}>
      <box style={{ paddingLeft: 1, paddingRight: 1, backgroundColor: bg }}>
        <text fg={theme.text} bg={bg} wrapMode="word" attributes={current ? TextAttributes.BOLD : TextAttributes.NONE}>
          <span fg={theme.text}>{`${current ? "▸" : " "}${index + 1}. `}</span>
          {related ? <span fg={theme.accent}>{"↔ "}</span> : null}
          <span fg={kindColor(stop.kind, theme)}>{`[${stop.kind}] `}</span>
          {decision ? <span fg={decisionColor(decision, theme)}>{`${decisionBadge(decision)} `}</span> : null}
          <span fg={theme.text}>{stop.title}</span>
        </text>
      </box>
      <box style={{ paddingLeft: 5, paddingRight: 1, backgroundColor: bg }}>
        <text content={stopLocation(stop)} fg={theme.muted} bg={bg} wrapMode="char" />
      </box>
      {current ? (
        <box style={{ flexDirection: "column", paddingLeft: 5, paddingRight: 1, paddingBottom: 1, backgroundColor: bg }}>
          <BulletedText text={stop.body} links={links} fg={theme.text} bg={bg} theme={theme} />
          <box style={{ marginTop: 1, backgroundColor: bg }}>
            <LinkedText
              text={stop.ask}
              links={links}
              prefix="Ask: "
              fg={theme.noteBorder}
              bg={bg}
              theme={theme}
              attributes={TextAttributes.BOLD}
            />
          </box>
          <LinkRows label="Links" arrow="→" targets={links.linksFrom(index)} bg={bg} theme={theme} onFollow={onFollow} />
          <LinkRows label="Linked from" arrow="←" targets={links.linksTo(index)} bg={bg} theme={theme} onFollow={onFollow} />
          <box
            style={{ marginTop: 1, backgroundColor: bg }}
            onMouseDown={(event: MouseEvent) => {
              event.stopPropagation();
              if (comment === "none") onComment();
            }}
          >
            <text
              content={comment === "none" ? "[ Post to PR ]" : comment === "pending" ? "Posting to PR…" : "✓ Posted to PR"}
              fg={comment === "none" ? theme.accent : theme.muted}
              bg={bg}
            />
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
  links,
  theme,
}: {
  track: Track;
  trackIndex: number;
  current: boolean;
  links: StopIndex;
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
        <BulletedText text={track.summary} links={links} fg={theme.muted} theme={theme} />
      </box>
    </box>
  );
}

function StackLayerRow({ layer, current, theme }: { layer: StackLayer; current: boolean; theme: ExtensionPaneTheme }) {
  const status = current ? "reviewing" : layer.state;
  const fg = current || layer.state === "open" ? theme.text : theme.muted;
  return (
    <box style={{ flexDirection: "row", paddingLeft: 2, paddingRight: 1 }}>
      <text content={`${current ? "▸" : " "} `} fg={current ? theme.accent : fg} attributes={current ? TextAttributes.BOLD : TextAttributes.NONE} />
      <box style={{ flexGrow: 1, flexShrink: 1 }}>
        <text fg={fg} wrapMode="word" attributes={current ? TextAttributes.BOLD : TextAttributes.NONE}>
          <span fg={fg}>{`#${layer.number} ${layer.title}`}</span>
          <span fg={current ? theme.accent : theme.muted}>{`  ${status}`}</span>
        </text>
      </box>
    </box>
  );
}

function StackBlock({ stack, theme }: { stack: TourStack; theme: ExtensionPaneTheme }) {
  const { index, total } = stackPosition(stack);
  return (
    <box style={{ flexDirection: "column", marginTop: 1 }}>
      <box style={{ paddingLeft: 1, paddingRight: 1 }}>
        <text wrapMode="word">
          <span fg={theme.accent} attributes={TextAttributes.BOLD}>{`Stack #${stack.number}`}</span>
          <span fg={theme.muted}>{` · layer ${index}/${total}`}</span>
        </text>
      </box>
      {stack.layers.map((layer) => (
        <StackLayerRow key={layer.number} layer={layer} current={layer.number === stack.current} theme={theme} />
      ))}
    </box>
  );
}

function TourPane({ files, theme, actions }: ExtensionPaneProps): ReactNode {
  const { tour, stops, links, cursor } = useTourState();
  const mailbox = useMailbox();
  const decided = decisions(mailbox);
  const { current } = cursor;
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);

  useEffect(() => {
    if (current >= 0) scrollRef.current?.scrollChildIntoView(`tour-stop-${current}`);
  }, [current]);

  if (!tour) return <text content=" No tour loaded" fg={theme.muted} />;

  const go = (tourMove: TourMove) => {
    const result = move(stops, tour.tracks.length, cursor, tourMove);
    if (!result.ok) {
      actions.notify(result.reason);
      return;
    }
    const file = findFile(files, stops[result.cursor.current]!.stop);
    revealStop(actions, actions.notify, file?.id, result.cursor, "is hidden by the file filter or not in this review");
  };
  const follow = (target: TourStop) => go({ kind: "follow", index: target.number - 1 });
  const currentTrack = current >= 0 ? stops[current]!.trackIndex : -1;
  const related = new Set(current >= 0 ? [...links.linksFrom(current), ...links.linksTo(current)] : []);

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
        <box style={{ paddingLeft: 1, paddingRight: 1 }}>
          <text content={statusText(mailbox, stops.length, Date.now())} fg={theme.muted} wrapMode="word" />
        </box>
        {tour.stack ? <StackBlock stack={tour.stack} theme={theme} /> : null}
        <box style={{ marginTop: 1, paddingLeft: 1, paddingRight: 1 }}>
          <BulletedText text={tour.summary} links={links} fg={theme.text} theme={theme} />
        </box>

        <Heading label={`Stops (${stops.length})`} theme={theme} />
        {current < 0 && stops.length > 0 ? (
          <box style={{ paddingLeft: 2 }}>
            <text content="Press > to start the tour" fg={theme.muted} attributes={TextAttributes.ITALIC} />
          </box>
        ) : null}
        {tour.tracks.map((track, trackIndex) => (
          <box key={trackIndex} style={{ flexDirection: "column", backgroundColor: theme.panel }}>
            <TrackHeading
              track={track}
              trackIndex={trackIndex}
              current={trackIndex === currentTrack}
              links={links}
              theme={theme}
            />
            {stops.map((entry, index) =>
              entry.trackIndex === trackIndex ? (
                <StopRow
                  key={index}
                  stop={entry.stop}
                  index={index}
                  current={index === current}
                  related={related.has(entry)}
                  decision={decided.get(entry.number)}
                  comment={commentStatus(mailbox, entry.number)}
                  links={links}
                  theme={theme}
                  onSelect={() => go({ kind: "goto", index })}
                  onFollow={follow}
                  onComment={() => {
                    void requestComment(entry);
                    actions.notify("Sent to the agent to post");
                  }}
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
            <Bullets items={tour.skipped.map((file) => `${file.path}: ${file.reason}`)} theme={theme} empty="" />
          </>
        ) : null}
      </box>
    </scrollbox>
  );
}

export default function registerGuidedReview(hunk: HunkExtensionAPI) {
  hunk.registerCliCommand(
    { name: "tour", summary: "Check, open, or answer a guided review tour", usage: "check|open|wait|answer <tour.json> ..." },
    runTourCli,
  );

  hunk.registerPane({
    id: PANE_ID,
    title: "Tour",
    placement: "right",
    width: { preferred: 48, min: 32, max: 64, fraction: 0.3 },
    defaultOpen: true,
    available: () => state.tour !== null,
    component: TourPane,
  });

  // Below 160 columns Hunk hides every side pane, even logically open ones, until `panes.open` reveals the area.
  hunk.on("changeset_loaded", (_payload, ctx) => {
    if (state.tour) ctx.panes.open(PANE_ID);
  });

  hunk.registerCommand({ id: "next", title: "Next tour stop", key: ">" }, (ctx) => apply(ctx, { kind: "next" }));
  hunk.registerCommand({ id: "prev", title: "Previous tour stop", key: "<" }, (ctx) => apply(ctx, { kind: "prev" }));
  hunk.registerCommand({ id: "nextTrack", title: "Next tour track", key: ")" }, (ctx) => apply(ctx, { kind: "nextTrack" }));
  hunk.registerCommand({ id: "prevTrack", title: "Previous tour track", key: "(" }, (ctx) => apply(ctx, { kind: "prevTrack" }));
  hunk.registerCommand({ id: "start", title: "Restart tour" }, (ctx) => apply(ctx, { kind: "restart" }));
  hunk.registerCommand({ id: "links", title: "Follow a link from this stop", key: "L" }, followLink);
  hunk.registerCommand({ id: "back", title: "Back to previous stop", key: "B" }, (ctx) =>
    apply(ctx, { kind: "back" }, describeBack),
  );

  const access: TourAccess = {
    currentStop: () => (state.cursor.current >= 0 ? state.stops[state.cursor.current]! : null),
    stopCount: () => state.stops.length,
  };
  registerQa(hunk, access);
}
