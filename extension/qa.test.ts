import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tour } from "../core/src/index";
import { actionLabel } from "./qa";

const anchor = { path: "src/a.ts", side: "new" as const, line: 10 };
const stop = { number: 2, title: "Loop bound", ask: "Block?", anchor };
const HEAD = "b".repeat(40);
const tourData: Tour = {
  version: 1, title: "Review", url: "https://github.example.com/o/r/pull/42", base: "a".repeat(40), head: HEAD, verdict: "approve",
  summary: "- Safe change.", scope: { checked: [], unchecked: [] }, skipped: [],
  tracks: [{ title: "Bounds", summary: "- Check bounds.", stops: [1, 2].map(() => ({ ...anchor, kind: "inspect", title: stop.title, ask: stop.ask, body: "- Bound." })) }],
};

test("action labels show resolved keys, drop unbound keys, and fall back on older hosts", () => {
  expect(actionLabel("Ask agent", "ask")).toBe("[ Ask agent · Q ]");
  expect(actionLabel("Comment on PR", "comment", {})).toBe("[ Comment on PR · C ]");
  expect(actionLabel("Finish review", "finish", { getKeys: () => ["X", "ctrl+x"] })).toBe("[ Finish review · X/ctrl+x ]");
  expect(actionLabel("Ask agent", "ask", { getKeys: () => [] })).toBe("[ Ask agent ]");
});

test("TUI reconciles placeholders across overlap, replies, answers, failures, and finish", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guided-review-placeholders-"));
  const qa = new URL("./qa.ts", import.meta.url).href;
  const mailbox = new URL("../core/src/mailbox.ts", import.meta.url).href;
  try {
    writeFileSync(join(dir, "mode"), "missing");
    writeFileSync(join(dir, "hunk"), `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const dir = ${JSON.stringify(dir)};
appendFileSync(dir + "/calls", JSON.stringify(args) + "\\n");
const mode = readFileSync(dir + "/mode", "utf8");
if (mode === "fail") process.exit(1);
if (args[1] === "list") console.log(JSON.stringify({ sessions: mode === "missing" ? [] : [{ sessionId: "mine", pid: process.ppid }] }));
else {
  await Bun.sleep(80);
  console.log(JSON.stringify({ result: { commentId: "placeholder:" + args[args.indexOf("--reply-to") + 1] } }));
}
`, { mode: 0o755 });
    const script = `
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { openSession, registerQa } from ${JSON.stringify(qa)};
import { mailboxPaths, readMailbox, answerPath, writeJsonAtomic } from ${JSON.stringify(mailbox)};
const dir = ${JSON.stringify(dir)};
const tour = dir + "/tour.json";
const paths = mailboxPaths(tour);
const events = new Map();
const commands = new Map();
let poll;
globalThis.setInterval = (callback) => { poll = callback; return 1; };
const notifications = [];
const ctx = { notify: (text) => notifications.push(text), dialogs: { confirm: async () => { throw new Error("Finish must not ask for confirmation"); } } };
const access = { currentStop: () => null };
registerQa({ on: (name, handler) => events.set(name, handler), registerCommand: (command, handler) => commands.set(command.id, handler) }, access);
await openSession({ repo: dir, tourPath: tour, tour: ${JSON.stringify(tourData)} });
await events.get("changeset_loaded")({}, ctx);
const activePaths = mailboxPaths(tour);
const calls = () => { try { return readFileSync(dir + "/calls", "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse); } catch { return []; } };
const until = async (predicate) => { for (let i = 0; i < 200; i++) { if (await predicate()) return; await Bun.sleep(10); } throw new Error("Timed out"); };
await until(() => calls().length > 0);
await Bun.sleep(100);
writeFileSync(dir + "/mode", "fail");
const note = { id: "user:1", body: "Why?", filePath: "src/a.ts", side: "new", line: 10, draft: false };
await events.get("note_created")({ note }, ctx);
await Bun.sleep(100);
assert.equal(calls().filter((args) => args[2] === "add").length, 0);
writeFileSync(dir + "/mode", "ok");
poll();
await until(() => calls().some((args) => args[2] === "add"));
poll(); poll();
await Bun.sleep(250);
assert.equal(calls().filter((args) => args[2] === "add").length, 1);
assert.ok(calls().find((args) => args[2] === "add").includes("⋯ Waiting for the agent"));
await events.get("note_created")({ note: { ...note, id: "user:2", parentId: "placeholder:user:1", body: "More?" } }, ctx);
assert.equal((await readMailbox(activePaths)).requests[1].kind, "followup");
await until(() => calls().filter((args) => args[2] === "add").length === 2);
const firstRequest = (await readMailbox(activePaths)).requests[0];
await writeJsonAtomic(answerPath(activePaths, firstRequest.id), { id: firstRequest.id, commentId: "answer:1", text: "Because", at: "t1" });
poll();
await Bun.sleep(250);
assert.equal(calls().some((args) => args[2] === "rm" && args[4] === "placeholder:user:1"), false);
writeFileSync(dir + "/mode", "fail");
await commands.get("finish")(ctx);
assert.ok((await readMailbox(activePaths)).session.finishedAt);
assert.ok(calls().some((args) => JSON.stringify(args) === JSON.stringify(["session", "comment", "rm", "mine", "placeholder:user:2", "--json"])));
const count = calls().length;
writeFileSync(dir + "/mode", "ok");
poll();
await Bun.sleep(150);
assert.equal(calls().length, count);
assert.deepEqual(notifications, ["Question sent to the agent", "Question sent to the agent", "Answered: Why?", "Review finished. The agent will draft the review from your notes."]);
console.log("reconciled");
`;
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout.trim()).toBe("reconciled");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
