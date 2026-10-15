import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parseTour, validateTour, type Tour, type TourStop, type StopIndex } from "../../core/src/index";
import { readDiffRanges } from "../../core/src/git";

export function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
  });
}

export interface FileChange {
  oldPath?: string;
  newPath?: string;
}

/** -z keeps spaces, tabs, newlines and non-ASCII names intact. */
export function parseChanges(output: string): Map<string, FileChange> {
  const changes = new Map<string, FileChange>();
  const parts = output.split("\0");
  for (let i = 0; i < parts.length && parts[i];) {
    const status = parts[i++]!;
    const first = parts[i++];
    if (!first) throw new Error("Incomplete git name-status output");
    if (status.startsWith("R") || status.startsWith("C")) {
      const second = parts[i++];
      if (!second) throw new Error("Incomplete git rename output");
      changes.set(second, { oldPath: first, newPath: second });
    } else {
      changes.set(first, { ...(status !== "A" ? { oldPath: first } : {}), ...(status !== "D" ? { newPath: first } : {}) });
    }
  }
  return changes;
}

export interface LoadedTour {
  file: string;
  root: string;
  tour: Tour;
  stops: TourStop[];
  index: StopIndex;
  warnings: string[];
  mergeBase: string;
  head: string;
  changes: Map<string, FileChange>;
}

export async function loadTour(file: string, directory: string): Promise<LoadedTour> {
  const raw: unknown = JSON.parse(await readFile(file, "utf8"));
  const parsed = parseTour(raw);
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  const root = (await git(directory, ["rev-parse", "--show-toplevel"])).trimEnd();
  // Resolve once: moving refs and a dirty checkout must never shift an anchor.
  const base = (await git(root, ["rev-parse", "--verify", "--end-of-options", `${parsed.tour.base}^{commit}`])).trim();
  const head = (await git(root, ["rev-parse", "--verify", "--end-of-options", `${parsed.tour.head}^{commit}`])).trim();
  const mergeBase = (await git(root, ["merge-base", base, head])).trim();
  const validated = await validateTour(raw, () => readDiffRanges(root, mergeBase, head));
  if (!validated.ok) throw new Error(validated.errors.join("\n"));
  const changes = parseChanges(await git(root, ["diff", "--no-ext-diff", "--find-renames", "--name-status", "-z", mergeBase, head, "--"]));
  return { ...validated, file, root, mergeBase, head, changes };
}

export function revisionFile(loaded: LoadedTour, stop: TourStop["stop"], side = stop.side): { ref: string; path: string } | undefined {
  const change = loaded.changes.get(stop.path);
  const path = side === "old" ? change?.oldPath : change?.newPath;
  return path === undefined ? undefined : { ref: side === "old" ? loaded.mergeBase : loaded.head, path };
}

export async function readRevision(root: string, ref: string, path: string): Promise<string> {
  return git(root, ["show", `${ref}:${path}`]);
}
