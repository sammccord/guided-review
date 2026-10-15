import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { SessionRecord, Tour } from "../core/src/index";
import { mailboxPaths, readMailbox, writeJsonAtomic } from "../core/src/mailbox";
import { resolveDiffRefs } from "../core/src/git";

export async function pinTourRefs(repo: string, tour: Tour): Promise<Tour> {
  return { ...tour, ...await resolveDiffRefs(repo, tour.base, tour.head) };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

/** Includes repository, PR/layer, refs, stop identities and order, and the text being agreed to. */
export function tourFingerprint(repo: string, tour: Tour): string {
  return createHash("sha256").update(JSON.stringify([resolve(repo), canonical(tour)])).digest("hex");
}

export function assertSessionTour(session: SessionRecord, tour: Tour): void {
  if (session.tourFingerprint !== tourFingerprint(session.repo, tour)) {
    throw new Error("tour changed or has no saved identity; reopen the tour before answering or approving");
  }
}

/** Old generations (including legacy mailboxes) stay on disk but never enter a new review. */
export async function prepareSession(input: { repo: string; tourPath: string; tour: Tour; fresh?: boolean }) {
  const repo = resolve(input.repo);
  const tourPath = resolve(input.tourPath);
  const tour = await pinTourRefs(repo, input.tour);
  const previous = await readMailbox(mailboxPaths(tourPath));
  const fingerprint = tourFingerprint(repo, tour);
  const reviewId = !input.fresh && previous.session?.tourFingerprint === fingerprint && previous.session.reviewId
    ? previous.session.reviewId : randomUUID();
  const paths = mailboxPaths(tourPath, reviewId);
  const session: SessionRecord = {
    repo, tourPath, head: tour.head, reviewId, tourFingerprint: fingerprint,
    pid: process.pid, openedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(paths.session, session);
  // Publish only after the new session exists; old TUI writers retain their generation's paths.
  await writeJsonAtomic(join(mailboxPaths(tourPath, null).root, "current.json"), { reviewId });
  return { paths, session, box: await readMailbox(paths) };
}
