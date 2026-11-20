import { describe, expect, test } from "bun:test";
import { githubApproveArgs, githubCommentArgs, parsePullRequestUrl } from "./github";

const anchor = { path: "src/a.ts", side: "new" as const, line: 10 };

describe("parsePullRequestUrl", () => {
  test("parses GitHub and enterprise PR URLs, including trailing paths and queries", () => {
    expect(parsePullRequestUrl("https://github.com/owner/repo/pull/42")).toEqual({ host: "github.com", owner: "owner", repo: "repo", number: 42 });
    expect(parsePullRequestUrl("https://github.example.com/team/project/pull/123/files?diff=split")).toEqual({
      host: "github.example.com", owner: "team", repo: "project", number: 123,
    });
    expect(parsePullRequestUrl("https://github.com/owner/repo/pull/42?diff=split")?.number).toBe(42);
  });

  test("rejects URLs that do not name a pull request", () => {
    for (const url of ["", "not a URL", "https://github.com/owner/repo", "https://github.com/owner/repo/issues/42", "https://github.com/o/r/pull/nope"]) {
      expect(parsePullRequestUrl(url)).toBeNull();
    }
  });
});

describe("githubCommentArgs", () => {
  const target = { host: "github.example.com", owner: "owner", repo: "repo", number: 42 };

  test("posts at the head SHA and new-side line with the body as one argument", () => {
    expect(githubCommentArgs(target, "abc123", anchor, "Fix 'the bound'.\nKeep evidence.")).toEqual([
      "api", "--hostname", "github.example.com", "--method", "POST", "repos/owner/repo/pulls/42/comments",
      "-f", "body=Fix 'the bound'.\nKeep evidence.", "-f", "commit_id=abc123", "-f", "path=src/a.ts",
      "-F", "line=10", "-f", "side=RIGHT",
    ]);
  });

  test("uses LEFT for an old-side anchor", () => {
    expect(githubCommentArgs(target, "abc123", { path: "deleted.ts", side: "old", line: 7 }, "Restore this.")).toEqual([
      "api", "--hostname", "github.example.com", "--method", "POST", "repos/owner/repo/pulls/42/comments",
      "-f", "body=Restore this.", "-f", "commit_id=abc123", "-f", "path=deleted.ts",
      "-F", "line=7", "-f", "side=LEFT",
    ]);
  });
});

test("githubApproveArgs pins approval to the reviewed commit and preserves the optional body", () => {
  const target = { host: "github.example.com", owner: "o", repo: "r", number: 42 };
  const args = ["api", "--hostname", target.host, "--method", "POST", "repos/o/r/pulls/42/reviews", "-f", "event=APPROVE", "-f", "commit_id=bbb"];
  expect(githubApproveArgs(target, "bbb")).toEqual(args);
  expect(githubApproveArgs(target, "bbb", "Checked 'bounds'.\nTests pass.")).toEqual([...args, "-f", "body=Checked 'bounds'.\nTests pass."]);
});

