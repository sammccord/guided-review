import * as vscode from "vscode";
import { resolve } from "node:path";
import type { TourMove } from "../../core/src/index";
import { TourEditor, snapshotScheme, snapshotSelector } from "./editor";
import { TourPlan, type PlanNode } from "./plan";
import { loadTour } from "./repository";
import { TourSession } from "./session";

export function activate(context: vscode.ExtensionContext): void {
  const plan = new TourPlan();
  const tree = vscode.window.createTreeView("guidedReview.plan", { treeDataProvider: plan, showCollapseAll: true });
  const editor = new TourEditor();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  status.command = "guidedReview.next";
  let session: TourSession | undefined;
  // Navigation and open/close commands are serialized, including their async editor work.
  let pending: Promise<unknown> = Promise.resolve();
  const enqueue = (work: () => Promise<unknown> | unknown): Promise<unknown> => {
    pending = pending.then(work).catch(error => {
      void vscode.window.showErrorMessage(`Guided Review: ${error instanceof Error ? error.message : String(error)}`);
    });
    return pending;
  };
  const register = (id: string, action: (...args: any[]) => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(id, (...args: any[]) => enqueue(() => action(...args))));
  };

  const refresh = () => {
    plan.refresh();
    editor.refresh();
    if (!session) { status.hide(); tree.description = undefined; return; }
    const { stops } = session.loaded;
    const current = session.cursor.current;
    tree.description = `${session.reviewed.size}/${stops.length} reviewed`;
    status.text = `$(map) Tour ${current < 0 ? 0 : current + 1}/${stops.length} · ${session.reviewed.size} reviewed`;
    status.tooltip = "Guided Review: next stop (Ctrl+Alt+Right in tour snapshots). Tour code is a read-only Git snapshot.";
    status.show();
  };

  const navigate = async (action: TourMove) => {
    if (!session) return;
    const reason = session.move(action);
    if (reason) { void vscode.window.showInformationMessage(reason); return; }
    refresh();
    const node = plan.stops.get(session.cursor.current);
    if (node) await tree.reveal(node, { select: true, focus: false, expand: true });
    await editor.show(session.cursor.current);
  };

  const open = async (file?: vscode.Uri, directory?: string) => {
    if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before opening a tour.");
    const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === "file") ?? [];
    if (!folders.length) throw new Error("Open the reviewed Git repository as a folder in Cursor first.");
    let folder = folders[0]!;
    if (directory) {
      const match = folders.find(item => resolve(item.uri.fsPath) === resolve(directory));
      if (!match) throw new Error("The tour repository is not open in this window. Open its folder first.");
      folder = match;
    } else if (folders.length > 1) {
      const choice = await vscode.window.showWorkspaceFolderPick({ placeHolder: "Repository this tour reviews" });
      if (!choice || choice.uri.scheme !== "file") return;
      folder = choice;
    }
    if (!file) [file] = await vscode.window.showOpenDialog({ title: "Open guided-review tour", filters: { "Review tour": ["json"] }, canSelectMany: false }) ?? [];
    if (!file) return;
    if (file.scheme !== "file") throw new Error("Tour files must be local files.");
    // Keep the current tour intact if parsing, Git lookup or anchor validation fails.
    const loaded = await loadTour(file.fsPath, folder.uri.fsPath);
    const next = new TourSession(loaded);
    const saved = context.workspaceState.get<unknown>(next.progressKey, []);
    if (Array.isArray(saved)) for (const at of saved) if (typeof at === "number" && next.hasStop(at)) next.reviewed.add(at);
    session = next;
    plan.setSession(session);
    editor.setSession(session);
    await vscode.commands.executeCommand("setContext", "guidedReview.active", true);
    await vscode.commands.executeCommand("guidedReview.plan.focus");
    refresh();
    if (loaded.warnings.length) void vscode.window.showWarningMessage(`Tour opened with warnings: ${loaded.warnings.join("; ")}`);
    if (loaded.stops.length) await navigate({ kind: "next" });
  };

  register("guidedReview.open", (file?: vscode.Uri) => open(file instanceof vscode.Uri ? file : undefined));
  register("guidedReview.close", async () => {
    session = undefined;
    plan.setSession(undefined);
    editor.setSession(undefined);
    await vscode.commands.executeCommand("setContext", "guidedReview.active", false);
    refresh();
  });
  for (const kind of ["next", "prev", "nextTrack", "prevTrack", "restart", "back"] as const) register(`guidedReview.${kind}`, () => navigate({ kind }));
  for (const kind of ["goto", "follow"] as const) register(`guidedReview.${kind}`, (id: unknown, index: unknown) => {
    if (session && id === session.id && typeof index === "number" && session.hasStop(index)) return navigate({ kind, index });
  });
  register("guidedReview.toggleReviewed", async (idOrNode?: string | PlanNode, index?: number) => {
    if (!session) return;
    const at = idOrNode && typeof idOrNode === "object" ? (idOrNode.sessionId === session.id ? idOrNode.index : undefined) : typeof idOrNode === "string" ? (idOrNode === session.id ? index : undefined) : session.cursor.current;
    if (at === undefined || !session.hasStop(at)) return;
    session.toggleReviewed(at);
    await context.workspaceState.update(session.progressKey, [...session.reviewed]);
    refresh();
  });
  register("guidedReview.showDiff", () => session ? editor.show(session.cursor.current, true) : undefined);
  register("guidedReview.movePlan", async () => {
    await vscode.commands.executeCommand("guidedReview.plan.focus");
    // Stable extension APIs cannot choose a custom view's Secondary Side Bar location.
    // Use the native picker, which remembers the placement without moving other views.
    await vscode.commands.executeCommand("workbench.action.moveFocusedView", "guidedReview.plan");
  });
  context.subscriptions.push(
    plan, tree, editor, status,
    vscode.workspace.registerTextDocumentContentProvider(snapshotScheme, editor),
    vscode.languages.registerCodeLensProvider(snapshotSelector, editor),
    vscode.window.onDidChangeVisibleTextEditors(() => editor.decorate()),
    vscode.window.registerUriHandler({ handleUri: uri => enqueue(async () => {
      if (uri.path !== "/open") throw new Error("Unknown tour URL action");
      const query = new URLSearchParams(uri.query);
      const tour = query.get("tour");
      const repo = query.get("repo");
      if (!tour || !repo) throw new Error("Tour URL requires repo and tour paths");
      await open(vscode.Uri.file(tour), repo);
    }) as Thenable<void> }),
  );
  const configured = vscode.workspace.getConfiguration("guidedReview", null).get<string>("tourFile");
  if (configured) void enqueue(() => open(vscode.Uri.file(resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ".", configured))));
}
