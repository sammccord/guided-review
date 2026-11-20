import { execFile } from "node:child_process";
import type { Anchor } from "../core/src/index";

export interface PullRequestTarget {
  host: string;
  owner: string;
  repo: string;
  number: number;
}

export function parsePullRequestUrl(url: string): PullRequestTarget | null {
  const match = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (!match) return null;
  return { host: match[1]!, owner: match[2]!, repo: match[3]!, number: Number(match[4]) };
}

export function githubCommentArgs(target: PullRequestTarget, commitId: string, anchor: Anchor, body: string): string[] {
  return [
    "api", "--hostname", target.host, "--method", "POST", `repos/${target.owner}/${target.repo}/pulls/${target.number}/comments`,
    "-f", `body=${body}`, "-f", `commit_id=${commitId}`, "-f", `path=${anchor.path}`,
    "-F", `line=${anchor.line}`, "-f", `side=${anchor.side === "new" ? "RIGHT" : "LEFT"}`,
  ];
}

export function githubApproveArgs(target: PullRequestTarget, commitId: string, body?: string): string[] {
  return [
    "api", "--hostname", target.host, "--method", "POST", `repos/${target.owner}/${target.repo}/pulls/${target.number}/reviews`,
    "-f", "event=APPROVE", "-f", `commit_id=${commitId}`, ...(body === undefined ? [] : ["-f", `body=${body}`]),
  ];
}

export function runGh(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((done, fail) => {
    execFile("gh", args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) fail(new Error(String(stderr).trim() || error.message));
      else done(String(stdout));
    });
  });
}

export function reviewUrl(raw: unknown): string {
  if (typeof raw !== "object" || raw === null || !("html_url" in raw) || typeof raw.html_url !== "string") {
    throw new Error("gh returned no review html_url");
  }
  return raw.html_url;
}
