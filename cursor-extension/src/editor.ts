import * as vscode from "vscode";
import { formatLink } from "../../core/src/index";
import { markdown } from "./format";
import { readRevision, revisionFile } from "./repository";
import type { TourSession } from "./session";

const SCHEME = "guided-review";
interface Snapshot { root: string; ref: string; path: string }

export class TourEditor implements vscode.TextDocumentContentProvider, vscode.CodeLensProvider, vscode.Disposable {
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensesChanged.event;
  private readonly snapshots = new Map<string, Snapshot | undefined>();
  private readonly threads: vscode.CommentThread[] = [];
  private readonly controller = vscode.comments.createCommentController("guided-review", "Guided Review");
  private readonly highlight = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorInfo.foreground"),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  private session?: TourSession;

  constructor() { this.controller.options = { prompt: "Tour stops are read-only; progress is saved locally." }; }

  uri(session: TourSession, index: number, side = session.loaded.stops[index]!.stop.side): vscode.Uri {
    const stop = session.loaded.stops[index]!.stop;
    const file = revisionFile(session.loaded, stop, side);
    const uri = vscode.Uri.from({ scheme: SCHEME, authority: session.id, path: `/${side}/${file?.path ?? stop.path}` });
    this.snapshots.set(uri.toString(), file ? { root: session.loaded.root, ...file } : undefined);
    return uri;
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    if (!this.snapshots.has(uri.toString())) throw new Error("This tour snapshot is no longer available; reopen the tour.");
    const file = this.snapshots.get(uri.toString());
    return file ? readRevision(file.root, file.ref, file.path) : "";
  }

  setSession(session: TourSession | undefined): void {
    for (const thread of this.threads) thread.dispose();
    this.threads.length = 0;
    this.snapshots.clear();
    this.session = session;
    if (session) session.loaded.stops.forEach((entry, i) => {
      const range = new vscode.Range(entry.stop.line - 1, 0, (entry.stop.endLine ?? entry.stop.line) - 1, 0);
      const body = markdown(entry.stop.body, session);
      body.appendMarkdown("\n\n**Ask:** ").appendMarkdown(markdown(entry.stop.ask, session).value);
      const incoming = session.loaded.index.linksTo(i);
      if (incoming.length) {
        body.appendMarkdown("\n\n**Linked from:** ");
        for (const target of incoming) {
          // Reuse the safe reference renderer, rather than trusting tour-provided Markdown.
          if (target.stop.id) body.appendMarkdown(markdown(`[[${target.stop.id}]]`, session).value).appendText("  ");
          else body.appendText(formatLink(target));
        }
      }
      const thread = this.controller.createCommentThread(this.uri(session, i), range, [{ body, mode: vscode.CommentMode.Preview, author: { name: "Guided Review" } }]);
      thread.canReply = false;
      thread.label = `${entry.number}/${session.loaded.stops.length} · ${entry.stop.kind} · ${entry.stop.title}`;
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      this.threads.push(thread);
    });
    this.refresh();
  }

  refresh(): void {
    this.threads.forEach((thread, i) => {
      thread.collapsibleState = i === this.session?.cursor.current ? vscode.CommentThreadCollapsibleState.Expanded : vscode.CommentThreadCollapsibleState.Collapsed;
      thread.state = this.session?.reviewed.has(i) ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
    });
    this.lensesChanged.fire();
    this.decorate();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const session = this.session;
    if (!session) return [];
    return session.loaded.stops.flatMap((entry, i) => {
      if (this.uri(session, i).toString() !== document.uri.toString()) return [];
      const range = new vscode.Range(entry.stop.line - 1, 0, entry.stop.line - 1, 0);
      return [
        new vscode.CodeLens(range, { title: `Tour ${entry.number}/${session.loaded.stops.length} · ${entry.stop.kind}: ${entry.stop.title}`, command: "guidedReview.goto", arguments: [session.id, i] }),
        new vscode.CodeLens(range, { title: session.reviewed.has(i) ? "✓ Reviewed" : "Mark reviewed", command: "guidedReview.toggleReviewed", arguments: [session.id, i] }),
      ];
    });
  }

  async show(index: number, diff = false): Promise<void> {
    const session = this.session;
    if (!session || !session.hasStop(index)) return;
    const entry = session.loaded.stops[index]!;
    const selection = new vscode.Range(entry.stop.line - 1, 0, (entry.stop.endLine ?? entry.stop.line) - 1, 0);
    if (diff) {
      await vscode.commands.executeCommand("vscode.diff", this.uri(session, index, "old"), this.uri(session, index, "new"), `${entry.stop.path} · Guided Review`, { preview: true, ...(entry.stop.side === "new" ? { selection } : {}) });
      const anchored = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === this.uri(session, index).toString());
      if (anchored) {
        anchored.selection = new vscode.Selection(selection.start, selection.end);
        anchored.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    } else {
      await vscode.window.showTextDocument(this.uri(session, index), { preview: true, selection, viewColumn: vscode.ViewColumn.One });
    }
    this.decorate();
  }

  decorate(): void {
    const session = this.session;
    const index = session?.cursor.current ?? -1;
    for (const editor of vscode.window.visibleTextEditors) {
      const stop = session?.loaded.stops[index]?.stop;
      const matches = session && stop && editor.document.uri.toString() === this.uri(session, index).toString();
      editor.setDecorations(this.highlight, matches ? [new vscode.Range(stop.line - 1, 0, (stop.endLine ?? stop.line) - 1, 0)] : []);
    }
  }

  dispose(): void {
    this.setSession(undefined);
    this.controller.dispose();
    this.highlight.dispose();
    this.lensesChanged.dispose();
  }
}

export const snapshotSelector: vscode.DocumentSelector = { scheme: SCHEME };
export const snapshotScheme = SCHEME;
