import * as vscode from "vscode";
import { formatLink, segmentText } from "../../core/src/index";
import type { TourSession } from "./session";

/** Tour prose is untrusted. Only links we generate can execute a command. */
export function markdown(text: string, session: TourSession): vscode.MarkdownString {
  const result = new vscode.MarkdownString();
  result.isTrusted = { enabledCommands: ["guidedReview.follow"] };
  result.supportHtml = false;
  for (const segment of segmentText(text, session.loaded.index)) {
    if (segment.kind === "text") result.appendText(segment.text);
    else {
      const label = new vscode.MarkdownString().appendText(formatLink(segment.target)).value;
      const args = encodeURIComponent(JSON.stringify([session.id, segment.target.number - 1]));
      result.appendMarkdown(`[${label}](command:guidedReview.follow?${args})`);
    }
  }
  return result;
}

export function plain(text: string, session: TourSession): string {
  return segmentText(text, session.loaded.index).map(segment => segment.kind === "text" ? segment.text : formatLink(segment.target)).join("");
}

export function location(session: TourSession, index: number): string {
  const { stop } = session.loaded.stops[index]!;
  return `${stop.path}:${stop.line}${stop.endLine !== undefined ? `–${stop.endLine}` : ""} · ${stop.side}`;
}
