import * as vscode from "vscode";
import { formatLink } from "../../core/src/index";
import { location, markdown, plain } from "./format";
import type { TourSession } from "./session";

export interface PlanNode {
  key: string;
  label: string;
  parent?: PlanNode;
  children?: PlanNode[];
  index?: number;
  sessionId?: string;
  link?: number;
  text?: string;
  expanded?: boolean;
}

export class TourPlan implements vscode.TreeDataProvider<PlanNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<PlanNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private session?: TourSession;
  private roots: PlanNode[] = [];
  readonly stops = new Map<number, PlanNode>();

  setSession(session: TourSession | undefined): void {
    this.session = session;
    this.stops.clear();
    this.roots = [];
    if (session) {
      const { tour, stops, index } = session.loaded;
      const group = (key: string, label: string, texts: string[], expanded = false): PlanNode => ({
        key, label, expanded,
        children: texts.map((text, i) => ({ key: `${key}/${i}`, label: plain(text, session), text })),
      });
      this.roots.push(group("overview", tour.title, [tour.verdict.toUpperCase(), ...tour.summary.split("\n").filter(Boolean)], true));
      if (tour.stack) this.roots.push(group("stack", `Stack #${tour.stack.number}`, tour.stack.layers.map(layer => `${layer.number === tour.stack!.current ? "▶ " : ""}PR #${layer.number} · ${layer.state} · ${layer.title}`)));
      tour.tracks.forEach((track, ti) => {
        const node: PlanNode = { key: `track/${ti}`, label: `${ti + 1}. ${track.title}`, expanded: true, children: [] };
        node.children!.push(group(`${node.key}/summary`, "Track summary", track.summary.split("\n").filter(Boolean)));
        for (const entry of stops.filter(stop => stop.trackIndex === ti)) {
          const at = entry.number - 1;
          const stopNode: PlanNode = {
            key: `stop/${at}`, label: `${entry.number}. [${entry.stop.kind}] ${entry.stop.title}`, index: at,
            sessionId: session.id,
            children: [
              ...entry.stop.body.split("\n").filter(Boolean).map((text, i) => ({ key: `stop/${at}/body/${i}`, label: plain(text, session), text })),
              { key: `stop/${at}/ask`, label: `Ask: ${plain(entry.stop.ask, session)}`, text: entry.stop.ask },
              ...index.linksFrom(at).map(target => ({ key: `stop/${at}/to/${target.number}`, label: `→ ${formatLink(target)}`, link: target.number - 1 })),
              ...index.linksTo(at).map(target => ({ key: `stop/${at}/from/${target.number}`, label: `← ${formatLink(target)}`, link: target.number - 1 })),
            ],
          };
          this.stops.set(at, stopNode);
          node.children!.push(stopNode);
        }
        this.roots.push(node);
      });
      this.roots.push(group("checked", "Checked", tour.scope.checked), group("unchecked", "Unchecked", tour.scope.unchecked));
      if (tour.skipped.length) this.roots.push(group("skipped", "Skipped files", tour.skipped.map(file => `${file.path} — ${file.reason}`)));
      const parents = (nodes: PlanNode[], parent?: PlanNode) => {
        for (const node of nodes) { node.parent = parent; if (node.children) parents(node.children, node); }
      };
      parents(this.roots);
    }
    this.refresh();
  }

  refresh(): void { this.changed.fire(undefined); }
  getChildren(node?: PlanNode): PlanNode[] { return node?.children ?? (node ? [] : this.roots); }
  getParent(node: PlanNode): PlanNode | undefined { return node.parent; }

  getTreeItem(node: PlanNode): vscode.TreeItem {
    const session = this.session;
    const item = new vscode.TreeItem(node.label, node.children?.length ? (node.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None);
    item.id = node.key;
    if (session && node.index !== undefined) {
      item.description = location(session, node.index);
      const current = session.cursor.current === node.index;
      item.iconPath = new vscode.ThemeIcon(session.reviewed.has(node.index) ? "pass-filled" : current ? "arrow-right" : "circle-outline");
      item.contextValue = "tourStop";
      item.command = { command: "guidedReview.goto", title: "Open Stop", arguments: [session.id, node.index] };
      const stop = session.loaded.stops[node.index]!.stop;
      item.tooltip = markdown(`${stop.body}\n\nAsk: ${stop.ask}`, session);
      item.accessibilityInformation = { label: `${current ? "Current stop. " : ""}${session.reviewed.has(node.index) ? "Reviewed. " : ""}${node.label}` };
    } else if (session && node.link !== undefined) {
      item.command = { command: "guidedReview.follow", title: "Follow Stop Link", arguments: [session.id, node.link] };
    } else if (session && node.text) item.tooltip = markdown(node.text, session);
    return item;
  }

  dispose(): void { this.changed.dispose(); }
}
