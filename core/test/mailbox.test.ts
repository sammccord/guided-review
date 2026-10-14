import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerPath, mailboxPaths, nextSeq, readMailbox, requestPath, writeJsonAtomic, writeJsonAtomicSync } from "../src/mailbox";
import { emptyMailbox, type Request, type SessionRecord } from "../src/index";

describe("mailbox", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "guided-review-qa-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const anchor = { path: "src/a.ts", side: "new" as const, line: 3 };
  const ask = (seq: number): Request => ({ id: `q-${seq}`, seq, at: `t${seq}`, stop: null, kind: "ask", anchor, text: `ask ${seq}` });

  test("paths sit beside the tour file", () => {
    const paths = mailboxPaths("/repo/.git/guided-review/pr-7.tour.json");
    expect(paths.root).toBe("/repo/.git/guided-review/pr-7.tour.qa");
    expect(paths.session).toBe("/repo/.git/guided-review/pr-7.tour.qa/session.json");
    expect(requestPath(paths, "q-3")).toBe("/repo/.git/guided-review/pr-7.tour.qa/inbox/q-3.json");
    expect(answerPath(paths, "q-3")).toBe("/repo/.git/guided-review/pr-7.tour.qa/answered/q-3.json");
  });

  test("a missing mailbox reads as empty and seq starts at 1", async () => {
    const box = await readMailbox(mailboxPaths(join(dir, "none.tour.json")));
    expect(box).toEqual(emptyMailbox());
    expect(nextSeq(box)).toBe(1);
  });

  test("round-trips session, requests, answers, and heartbeat; skips unparsable files", async () => {
    const paths = mailboxPaths(join(dir, "pr-1.tour.json"));
    const session: SessionRecord = { repo: "/repo", tourPath: "/x.tour.json", head: "bbb", pid: process.pid, openedAt: "t0" };
    await writeJsonAtomic(paths.session, session);
    await writeJsonAtomic(requestPath(paths, "q-2"), ask(2));
    await writeJsonAtomic(requestPath(paths, "q-1"), ask(1));
    await writeJsonAtomic(answerPath(paths, "q-1"), { id: "q-1", commentId: "mcp:1", text: "- yes", at: "t9" });
    await writeJsonAtomic(paths.agent, { pid: 99, until: "t5" });
    writeFileSync(requestPath(paths, "q-3"), "{ not json");
    writeFileSync(join(paths.inbox, "q-4.json.123.0.tmp"), JSON.stringify(ask(4)));
    writeFileSync(join(paths.inbox, "notes.txt"), "ignored");
    mkdirSync(join(paths.answered, "q-5.json"));

    const box = await readMailbox(paths);
    expect(box.session).toEqual(session);
    expect(box.requests.map((r) => r.id)).toEqual(["q-1", "q-2"]);
    expect([...box.answers.keys()]).toEqual(["q-1"]);
    expect(box.heartbeat).toEqual({ pid: 99, until: "t5" });
    expect(nextSeq(box)).toBe(3);
    expect(readdirSync(paths.root).sort()).toEqual(["agent.json", "answered", "inbox", "session.json"]);
  });

  test("writeJsonAtomic leaves no temp file behind and overwrites in place", async () => {
    const path = join(dir, "atomic", "deep", "value.json");
    await writeJsonAtomic(path, { n: 1 });
    await writeJsonAtomic(path, { n: 2 });
    expect(readdirSync(join(dir, "atomic", "deep"))).toEqual(["value.json"]);
    expect(await Bun.file(path).json()).toEqual({ n: 2 });
    writeJsonAtomicSync(path, { n: 3 });
    expect(readdirSync(join(dir, "atomic", "deep"))).toEqual(["value.json"]);
    expect(await Bun.file(path).json()).toEqual({ n: 3 });
  });
});
