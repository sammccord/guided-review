import { homedir } from "node:os";
import { resolve } from "node:path";
import { checkSummary, loadAndCheck } from "./check";
import { runAnswer, runApprove, runWait } from "./commands";
import { noNotes, writeLine, type CliContext, type CliResult } from "./context";
import { stageReview } from "./stage";

export const GUIDED_REVIEW_USAGE = [
  "usage: guided-review check <tour.json>",
  "       guided-review stage <worktree> <tour.json> [--session <id>] [--shared <dir>] [--fresh]",
  "       guided-review wait <tour.json>... [--timeout <seconds>] [--away <minutes>]",
  "       guided-review answer <tour.json> <id> --text <answer>",
  "       guided-review approve <tour.json> [--body <text>]",
];

function parseStageArgs(args: string[], cwd: string): Parameters<typeof stageReview>[0] | null {
  const [worktree, tourPath, ...flags] = args;
  if (!worktree || !tourPath || worktree.startsWith("--") || tourPath.startsWith("--")) return null;
  let sessionId = process.env.MUX_PTY_ID;
  let sharedRoot = process.env.GUIDED_REVIEW_SHARED_DIR ?? resolve(homedir(), ".mux/shared");
  let fresh = false;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === "--fresh") {
      fresh = true;
      continue;
    }
    if (flag !== "--session" && flag !== "--shared") return null;
    const value = flags[++i];
    if (!value || value.startsWith("--")) return null;
    if (flag === "--session") sessionId = value;
    else sharedRoot = value;
  }
  return { worktree: resolve(cwd, worktree), tourPath: resolve(cwd, tourPath), sharedRoot: resolve(cwd, sharedRoot), sessionId, fresh };
}

export async function runMain(argv: string[], ctx: Omit<CliContext, "program" | "notes">): Promise<CliResult> {
  const [command, ...args] = argv;
  try {
    const host = { ...ctx, program: "guided-review", notes: noNotes };
    const handler = command === "wait" ? runWait : command === "answer" ? runAnswer : command === "approve" ? runApprove : undefined;
    if (handler) {
      const result = await handler(args, { ...host, stderr: { write: (text) => text.startsWith("usage: hunk tour") ? undefined : ctx.stderr.write(text) } });
      if (result.code === 2) await writeLine(ctx.stderr, GUIDED_REVIEW_USAGE.join("\n"));
      return result;
    }
    if (command === "check" && args.length === 1 && !args[0]!.startsWith("--")) {
      const result = await loadAndCheck(args[0]!, ctx.cwd);
      if (!result.ok) {
        await writeLine(ctx.stderr, result.errors.join("\n"));
        return { kind: "exit", code: 1 };
      }
      for (const warning of result.warnings) await writeLine(ctx.stderr, `warning: ${warning}`);
      await writeLine(ctx.stdout, checkSummary(result));
      return { kind: "exit", code: 0 };
    }
    if (command === "stage") {
      const input = parseStageArgs(args, ctx.cwd);
      if (input) {
        const staged = await stageReview(input);
        for (const warning of staged.warnings) await writeLine(ctx.stderr, `warning: ${warning}`);
        await writeLine(ctx.stdout, { slug: staged.slug, dir: staged.dir, tour: staged.tour, reviewId: staged.reviewId, sessionId: input.sessionId });
        return { kind: "exit", code: 0 };
      }
    }
    await writeLine(ctx.stderr, GUIDED_REVIEW_USAGE.join("\n"));
    return { kind: "exit", code: 2 };
  } catch (error) {
    await writeLine(ctx.stderr, error instanceof Error ? error.message : String(error));
    return { kind: "exit", code: 1 };
  }
}
