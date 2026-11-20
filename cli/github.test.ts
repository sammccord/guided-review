import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPrHostIsRemote, githubApproveArgs, githubCommentArgs, parsePullRequestUrl } from "./github";

const at = "@";
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


describe("assertPrHostIsRemote", () => {
  const root = mkdtempSync(join(tmpdir(), "guided-review-remotes-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const target = { host: "GitHub.Example.com", owner: "o", repo: "r", number: 42 };

  function repoWithRemotes(name: string, remotes: Record<string, string[]>): string {
    const repo = join(root, name);
    execFileSync("git", ["init", "-q", repo]);
    for (const [remote, [first, ...rest]] of Object.entries(remotes)) {
      execFileSync("git", ["-C", repo, "remote", "add", remote, first!]);
      for (const url of rest) execFileSync("git", ["-C", repo, "remote", "set-url", "--add", remote, url]);
    }
    return repo;
  }

  test.each([
    ["https", "https://github.example.com/o/r.git"],
    ["https-credentials", `https://user:token${at}github.example.com:8443/o/r.git`],
    ["ssh", `ssh://git${at}github.example.com:22/o/r.git`],
    ["scp", `git${at}github.example.com:o/r.git`],
    ["scp-no-user", "github.example.com:o/r.git"],
  ])("accepts a %s remote on the PR host, ignoring case", async (name, url) => {
    const repo = repoWithRemotes(name, { origin: ["https://elsewhere.example/o/r.git"], upstream: ["https://mirror.example/o/r.git", url] });
    await expect(assertPrHostIsRemote(repo, target)).resolves.toBeUndefined();
  });

  test.each([
    ["mismatch", { origin: ["https://github.com/o/r.git", `git${at}github.com:o/r.git`] }],
    ["suffix", { origin: ["https://github.example.com.attacker.dev/o/r.git"] }],
    ["none", {}],
  ] as const)("refuses a PR host that is not a remote (%s)", async (name, remotes) => {
    const repo = repoWithRemotes(`refuse-${name}`, remotes as Record<string, string[]>);
    await expect(assertPrHostIsRemote(repo, target)).rejects.toThrow("PR host GitHub.Example.com is not a remote of this repository; refusing to send credentials there");
  });
});
