import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseSession, type Mailbox, type SessionRecord } from "./qa";
import { answerFile, currentPointerPath, requestFile, reviewLayout, type ReviewLayout } from "./layout";
import { encodeJson, readMailboxVia, type MailboxPort } from "./mailbox-port";

export type MailboxPaths = ReviewLayout;

export const fsPort: MailboxPort = {
  async readText(path) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  },
  async listNames(dir) {
    try {
      return await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  },
  writeText: writeTextAtomic,
};

/** Resolve the active review; an explicit id pins a writer, and null addresses the legacy root. */
export function mailboxPaths(tourPath: string, reviewId?: string | null): MailboxPaths {
  if (reviewId === undefined) {
    try {
      const current: unknown = JSON.parse(readFileSync(currentPointerPath(tourPath), "utf8"));
      if (!current || typeof current !== "object" || !("reviewId" in current) || typeof current.reviewId !== "string") {
        throw new Error("invalid review pointer");
      }
      reviewId = current.reviewId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return reviewLayout(tourPath, reviewId);
}

export function requestPath(paths: MailboxPaths, id: string): string {
  return requestFile(paths, id);
}

export function answerPath(paths: MailboxPaths, id: string): string {
  return answerFile(paths, id);
}

export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function readSessionSync(path: string): SessionRecord | null {
  try {
    return parseSession(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

export async function readMailbox(paths: MailboxPaths): Promise<Mailbox> {
  return readMailboxVia(fsPort, paths);
}

let tempCounter = 0;

function tempPath(path: string): string {
  return `${path}.${process.pid}.${tempCounter++}.tmp`;
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, encodeJson(value));
}

export async function writeTextAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = tempPath(path);
  await writeFile(temp, text);
  await rename(temp, path);
}

/** For a process about to exit, where a pending promise would be dropped. */
export function writeJsonAtomicSync(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = tempPath(path);
  writeFileSync(temp, encodeJson(value));
  renameSync(temp, path);
}
