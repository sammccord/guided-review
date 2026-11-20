import { execFile } from "node:child_process";
import type { PostPlan } from "../core/src/index";

/** `--repo` is ambiguous when two Hunk sessions share the worktree, so answers address the mailbox owner's session by pid. */
export function sessionIdForPid(list: unknown, pid: number): string | null {
  if (typeof list !== "object" || list === null) return null;
  const sessions = (list as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) return null;
  for (const entry of sessions) {
    const { sessionId, pid: entryPid } = (entry ?? {}) as { sessionId?: unknown; pid?: unknown };
    if (entryPid === pid && typeof sessionId === "string") return sessionId;
  }
  return null;
}

export function sessionAddArgs(plan: PostPlan, sessionId: string): string[] {
  const target =
    plan.kind === "reply"
      ? ["--reply-to", plan.noteId]
      : ["--file", plan.anchor.path, plan.anchor.side === "new" ? "--new-line" : "--old-line", String(plan.anchor.line)];
  const rationale = plan.rationale === "" ? [] : ["--rationale", plan.rationale];
  return ["session", "comment", "add", sessionId, ...target, "--summary", plan.summary, ...rationale, "--author", "guided-review", "--json"];
}

export function runHunk(args: readonly string[]): Promise<string> {
  return new Promise((done, fail) => {
    execFile("hunk", args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) fail(new Error(String(stderr).trim() || error.message));
      else done(String(stdout));
    });
  });
}

export function commentIdOf(output: string): string | null {
  try {
    const parsed: unknown = JSON.parse(output);
    if (typeof parsed !== "object" || parsed === null) return null;
    const result = (parsed as { result?: unknown }).result;
    if (typeof result !== "object" || result === null) return null;
    const id = (result as { commentId?: unknown }).commentId;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}
