import { expect, mock, test } from "bun:test";
import type * as VSCode from "vscode";
import { TourSession } from "../src/session";
import { loadedTour } from "./fixtures";

// Test the adapter's native API calls without requiring Electron in the unit suite.
class EventEmitter {
  event = () => ({ dispose() {} });
  fire() {}
  dispose() {}
}
class MarkdownString {
  value = "";
  appendText(text: string) { this.value += text.replace(/[\\`*_{}\[\]()<>#!]/g, "\\$&"); return this; }
  appendMarkdown(text: string) { this.value += text; return this; }
}
class Uri {
  constructor(readonly scheme: string, readonly authority: string, readonly path: string) {}
  static from(parts: { scheme: string; authority: string; path: string }) { return new Uri(parts.scheme, parts.authority, parts.path); }
  toString() { return `${this.scheme}://${this.authority}${this.path}`; }
}
class Range { constructor(public startLine: number, public startColumn: number, public endLine: number, public endColumn: number) {} }
class TreeItem { constructor(public label: string, public collapsibleState: number) {} }
class CodeLens { constructor(public range: Range, public command: { title: string; command: string; arguments: unknown[] }) {} }
const threads: any[] = [];
const commands: unknown[][] = [];
const opened: unknown[][] = [];
mock.module("vscode", () => ({
  EventEmitter, MarkdownString, Uri, Range, TreeItem, CodeLens,
  ThemeIcon: class { constructor(public id: string) {} },
  ThemeColor: class { constructor(public id: string) {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
  CommentThreadState: { Unresolved: 0, Resolved: 1 },
  CommentMode: { Preview: 0 }, OverviewRulerLane: { Right: 4 }, ViewColumn: { One: 1 },
  window: { visibleTextEditors: [], createTextEditorDecorationType: () => ({ dispose() {} }), showTextDocument: async (...args: unknown[]) => { opened.push(args); } },
  commands: { executeCommand: async (...args: unknown[]) => { commands.push(args); } },
  comments: { createCommentController: () => ({
    options: {}, dispose() {},
    createCommentThread(uri: Uri, range: Range, comments: unknown[]) {
      const thread = { uri, range, comments, disposed: false, dispose() { this.disposed = true; } };
      threads.push(thread); return thread;
    },
  }) },
}));
const { TourEditor } = await import("../src/editor");
const { TourPlan } = await import("../src/plan");
const { markdown } = await import("../src/format");

test("plan is a native tree with track parents, linked stops, current state and reviewed state", () => {
  const session = new TourSession(loadedTour());
  const plan = new TourPlan();
  plan.setSession(session);
  expect(plan.stops.size).toBe(3);
  const node = plan.stops.get(0)!;
  expect(plan.getParent(node)!.label).toBe("1. Retries");
  expect(plan.getTreeItem(node).command!.arguments).toEqual([session.id, 0]);
  expect(node.children!.find(child => child.link === 2)!.label).toContain("Third");
  session.move({ kind: "next" });
  session.toggleReviewed(0);
  expect((plan.getTreeItem(node).iconPath as VSCode.ThemeIcon).id).toBe("pass-filled");
  plan.setSession(undefined);
  expect(plan.getChildren()).toEqual([]);
  expect(plan.stops.size).toBe(0);
  plan.dispose();
});

test("inline native threads cover exact ranges, expand the active stop and clean up", async () => {
  threads.length = 0;
  const session = new TourSession(loadedTour());
  const editor = new TourEditor();
  editor.setSession(session);
  expect(threads.length).toBe(3);
  expect(threads[0].range.startLine).toBe(9);
  expect(threads[0].comments[0].body.value).toContain("**Ask:**");
  expect(threads[0].canReply).toBe(false);
  session.move({ kind: "next" });
  editor.refresh();
  expect(threads[0].collapsibleState).toBe(1);
  expect(threads[1].collapsibleState).toBe(0);
  const uri = editor.uri(session, 0);
  const lenses = editor.provideCodeLenses({ uri } as VSCode.TextDocument);
  expect(lenses.length).toBe(4); // Two stops in this revision/file, two lenses each.
  expect(lenses[0]!.command!.arguments).toEqual([session.id, 0]);
  await editor.show(2);
  expect((opened.at(-1)![0] as Uri).path).toBe("/old/src/b.ts");
  await editor.show(2, true);
  expect(commands.at(-1)![0]).toBe("vscode.diff");
  expect(await editor.provideTextDocumentContent(editor.uri(session, 2, "new"))).toBe("");
  editor.setSession(undefined);
  expect(threads.every(thread => thread.disposed)).toBe(true);
  expect(editor.provideCodeLenses({ uri } as VSCode.TextDocument)).toEqual([]);
  await expect(editor.provideTextDocumentContent(uri)).rejects.toThrow("no longer available");
  editor.dispose();
});

test("tour prose cannot inject arbitrary Markdown commands or HTML", () => {
  const session = new TourSession(loadedTour());
  const body = markdown('[run](command:evil) <img src=x> [[third]]', session);
  expect(body.isTrusted).toEqual({ enabledCommands: ["guidedReview.follow"] });
  expect(body.supportHtml).toBe(false);
  expect(body.value).toContain("\\[run\\]\\(command:evil\\)");
  expect(body.value).toContain("\\<img src=x\\>");
  expect(body.value).toContain("command:guidedReview.follow?");
  expect(body.value).toContain(encodeURIComponent(JSON.stringify([session.id, 2])));
});
