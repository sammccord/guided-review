import { afterAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Request, Tour } from "../core/src/index";
import { answerPath, mailboxPaths, readJson, requestPath, writeJsonAtomic } from "../core/src/mailbox";
import { checkSummary, loadAndCheck } from "./check";
import { runMain } from "./main";

const dir = mkdtempSync(join(tmpdir(), "guided-review-main-"));
const root = resolve(import.meta.dir, "..");
const tourPath = join(dir, "tour.json");
const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args]);
git("init", "-q");
git("config", "user.name", "Test");
git("config", "user.email", "test@example.com");
writeFileSync(join(dir, "a.txt"), "before\n");
git("add", ".");
git("-c", "commit.gpgsign=false", "commit", "-qm", "base");
writeFileSync(join(dir, "a.txt"), "after\n");
git("add", ".");
git("-c", "commit.gpgsign=false", "commit", "-qm", "head");
const tour: Tour = { version: 1, title: "Review", base: "HEAD~1", head: "HEAD", verdict: "approve", summary: "- Change.", scope: { checked: [], unchecked: [] }, skipped: [],
  tracks: [{ title: "Change", summary: "- Check.", stops: [{ path: "a.txt", side: "new", line: 1, kind: "inspect", title: "Value", body: "- Changed.", ask: "Correct?" }] }] };
writeFileSync(tourPath, JSON.stringify(tour));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function run(args: string[]) {
  let stdout = "";
  let stderr = "";
  const result = await runMain(args, { cwd: dir, signal: new AbortController().signal,
    stdout: { write: (text) => { stdout += text; } }, stderr: { write: (text) => { stderr += text; } } });
  return { result, stdout, stderr };
}

test("standalone stage, wait, answer, finish loop uses the shared mailbox", async () => {
  const staged = await run(["stage", ".", "tour.json", "--shared", join(dir, "shared"), "--session", "pty"]);
  expect(staged.result.code).toBe(0);
  const bundle = JSON.parse(staged.stdout);
  expect(bundle.sessionId).toBe("pty");
  const paths = mailboxPaths(bundle.tour);
  const anchor = { path: "a.txt", side: "new" as const, line: 1 };
  const request: Request = { id: `q-${bundle.reviewId}-1`, seq: 1, at: new Date().toISOString(), kind: "ask", stop: null, anchor, text: "Why?" };
  await writeJsonAtomic(requestPath(paths, request.id), request);
  const waiting = await run(["wait", bundle.tour, "--timeout", "1"]);
  expect(JSON.parse(waiting.stdout)).toMatchObject({ kind: "pending" });
  expect(waiting.stdout).toContain("guided-review answer");
  const answered = await run(["answer", bundle.tour, request.id, "--text", "x"]);
  expect(answered.result.code).toBe(0);
  expect(JSON.parse(answered.stdout).commentId).toBeNull();
  expect(await readJson(answerPath(paths, request.id))).toMatchObject({ text: "x", commentId: null });
  const session = await readJson(paths.session);
  await writeJsonAtomic(paths.session, { ...Object(session), finishedAt: new Date().toISOString() });
  const finished = JSON.parse((await run(["wait", bundle.tour, "--timeout", "1"])).stdout);
  expect(finished.kind).toBe("finished");
  expect(finished.transcript).toHaveLength(1);
  expect(finished.transcript[0]).toMatchObject({ status: "answered", answer: { text: "x" } });
});

test("check shares the Hunk summary and rejects bad command arguments", async () => {
  const checked = await loadAndCheck(tourPath, dir);
  if (!checked.ok) throw new Error(checked.errors.join("\n"));
  expect((await run(["check", "tour.json"])).stdout).toBe(checkSummary(checked) + "\n");
  for (const args of [[], ["open"], ["check"], ["stage", ".", "tour.json", "--shared"], ["answer"], ["wait"], ["approve"]]) {
    const result = await run(args);
    expect(result.result.code).toBe(2);
    expect(result.stderr).toContain("usage: guided-review");
    expect(result.stderr).not.toContain("usage: hunk");
  }
});

const hasNode = spawnSync("node", ["--version"]).status === 0;
test.skipIf(!hasNode)("built CLI checks a real repo under Node (requires node on PATH)", () => {
  execFileSync("bun", ["run", "build:cli"], { cwd: root });
  const output = execFileSync("node", [join(root, "dist/guided-review.mjs"), "check", tourPath], { cwd: dir, encoding: "utf8" });
  expect(output).toBe("ok: 1 stops in 1 tracks across 1 files, verdict approve\n");
}, 15000);
