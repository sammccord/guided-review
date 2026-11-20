import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  answerFile, buildRequest, currentPointerPath, emptyMailbox, encodeJson, patchSessionVia,
  postRequestVia, readMailboxVia, requestFile, resolveLayoutVia, reviewLayout,
  type MailboxPort, type RequestBody, type SessionRecord,
} from "../src/index";
import { fsPort, mailboxPaths, writeJsonAtomic } from "../src/mailbox";

const tourPath = "guided-review/x/review.tour.json";
const layout = reviewLayout(tourPath, null);
const reviewId = "12345678-1234-1234-1234-123456789abc";
const body: RequestBody = { kind: "ask", stop: null, anchor: { path: "a.ts", side: "new", line: 1 }, text: "Why?" };
const session: SessionRecord = { repo: "/repo", tourPath, head: "abc", openedAt: "t0", reviewId };

function createMemoryPort(): MailboxPort {
  const files = new Map<string, string>();
  return {
    async readText(path) { return files.get(path); },
    async listNames(dir) {
      return [...files.keys()].filter(path => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes("/"))
        .map(path => path.slice(dir.length + 1));
    },
    async writeText(path, text) { files.set(path, text); },
  };
}

const scenarios: { name: string; run(port: MailboxPort): Promise<void> }[] = [
  {
    name: "missing files and directories read as empty",
    async run(port) {
      expect(await port.readText(layout.session)).toBeUndefined();
      expect(await port.listNames(layout.inbox)).toEqual([]);
      expect(await readMailboxVia(port, layout)).toEqual(emptyMailbox());
      expect(await resolveLayoutVia(port, tourPath)).toEqual(layout);
      await port.writeText(`${layout.inbox}/ignored.txt`, "");
      expect(await readMailboxVia(port, layout)).toEqual(emptyMailbox());
    },
  },
  {
    name: "reads sorted requests, answers, session and heartbeat; skips partial and invalid records",
    async run(port) {
      const first = buildRequest(emptyMailbox(), body, "t1");
      const second = { ...first, id: "q-2" as const, seq: 2 };
      const answer = { id: first.id, commentId: "note-1", text: "Yes", at: "t3" };
      await port.writeText(layout.session, encodeJson(session));
      await port.writeText(requestFile(layout, second.id), encodeJson(second));
      await port.writeText(requestFile(layout, first.id), encodeJson(first));
      await port.writeText(requestFile(layout, "q-3"), encodeJson(first).slice(0, 30));
      await port.writeText(requestFile(layout, "q-4"), encodeJson({ kind: "bad" }));
      await port.writeText(`${layout.inbox}/q-5.json.123.tmp`, encodeJson(first));
      await port.writeText(`${layout.inbox}/notes.json`, encodeJson(first));
      await port.writeText(answerFile(layout, first.id), encodeJson(answer));
      await port.writeText(answerFile(layout, "q-2"), "{");
      await port.writeText(layout.agent, encodeJson({ pid: 99, until: "t9" }));
      expect(await readMailboxVia(port, layout)).toEqual({
        session, requests: [first, second], answers: new Map([[first.id, answer]]), heartbeat: { pid: 99, until: "t9" },
      });
    },
  },
  {
    name: "resolves valid pointers and rejects invalid pointers",
    async run(port) {
      const pointer = currentPointerPath(tourPath);
      await port.writeText(pointer, encodeJson({ reviewId }));
      expect(await resolveLayoutVia(port, tourPath)).toEqual(reviewLayout(tourPath, reviewId));
      for (const value of [{}, { reviewId: 7 }, null]) {
        await port.writeText(pointer, encodeJson(value));
        await expect(resolveLayoutVia(port, tourPath)).rejects.toThrow("invalid review pointer");
      }
      await port.writeText(pointer, encodeJson({ reviewId: "../../escape" }));
      await expect(resolveLayoutVia(port, tourPath)).rejects.toThrow("invalid review id");
      await port.writeText(pointer, "{");
      await expect(resolveLayoutVia(port, tourPath)).rejects.toThrow();
    },
  },
  {
    name: "posts identical pretty JSON and reads it back with advancing sequences",
    async run(port) {
      await port.writeText(layout.session, encodeJson(session));
      const first = await postRequestVia(port, layout, body, "t1");
      expect(first).toEqual({ id: `q-${reviewId}-1`, seq: 1, at: "t1", ...body });
      expect(await port.readText(requestFile(layout, first.id))).toBe(`${JSON.stringify(first, null, 2)}\n`);
      const second = await postRequestVia(port, layout, body, "t2");
      expect(second.id).toBe(`q-${reviewId}-2`);
      expect((await readMailboxVia(port, layout)).requests).toEqual([first, second]);
    },
  },
  {
    name: "patches a session without losing fields and returns null for missing or invalid sessions",
    async run(port) {
      expect(await patchSessionVia(port, layout, { finishedAt: "t2" })).toBeNull();
      expect(await port.readText(layout.session)).toBeUndefined();
      await port.writeText(layout.session, "{");
      expect(await patchSessionVia(port, layout, { finishedAt: "t2" })).toBeNull();
      await port.writeText(layout.session, encodeJson(session));
      expect(await patchSessionVia(port, layout, { activeAt: "t1", finishedAt: "t2" })).toEqual({ ...session, activeAt: "t1", finishedAt: "t2" });
      expect((await readMailboxVia(port, layout)).session).toEqual({ ...session, activeAt: "t1", finishedAt: "t2" });
    },
  },
];

for (const adapter of ["memory", "fs"] as const) {
  describe(`${adapter} mailbox port`, () => {
    for (const scenario of scenarios) {
      test(scenario.name, async () => {
        if (adapter === "memory") return scenario.run(createMemoryPort());
        const dir = await mkdtemp(join(tmpdir(), "guided-review-port-"));
        const port: MailboxPort = {
          readText: path => fsPort.readText(join(dir, path)),
          listNames: path => fsPort.listNames(join(dir, path)),
          writeText: (path, text) => fsPort.writeText(join(dir, path), text),
        };
        try {
          await scenario.run(port);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
    }
  });
}

test("a concurrent reader skips a half-written non-atomic request and later reads the whole record", async () => {
  const memory = createMemoryPort();
  const halfWritten = Promise.withResolvers<void>();
  const resumeWrite = Promise.withResolvers<void>();
  const port: MailboxPort = {
    ...memory,
    async writeText(path, text) {
      await memory.writeText(path, text.slice(0, Math.floor(text.length / 2)));
      halfWritten.resolve();
      await new Promise(resolve => setTimeout(resolve, 0));
      await resumeWrite.promise;
      await memory.writeText(path, text);
    },
  };
  const writing = postRequestVia(port, layout, body, "t1");
  await halfWritten.promise;
  try {
    expect((await readMailboxVia(port, layout)).requests).toEqual([]);
  } finally {
    resumeWrite.resolve();
  }
  const request = await writing;
  expect((await readMailboxVia(port, layout)).requests).toEqual([request]);
});

test("fsPort request bytes match the existing atomic writer and pointer errors match the sync resolver", async () => {
  const dir = await mkdtemp(join(tmpdir(), "guided-review-port-bytes-"));
  try {
    const tour = join(dir, "review.tour.json");
    const paths = reviewLayout(tour, null);
    const request = await postRequestVia(fsPort, paths, body, "t1");
    const expected = join(dir, "expected.json");
    await writeJsonAtomic(expected, request);
    expect(await fsPort.readText(requestFile(paths, request.id))).toBe(await fsPort.readText(expected));
    for (const text of ["{", "{}", encodeJson({ reviewId: "invalid" }), encodeJson({ reviewId })]) {
      await fsPort.writeText(currentPointerPath(tour), text);
      try {
        const resolved = mailboxPaths(tour);
        expect(await resolveLayoutVia(fsPort, tour)).toEqual(resolved);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        await expect(resolveLayoutVia(fsPort, tour)).rejects.toThrow(error.message);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
