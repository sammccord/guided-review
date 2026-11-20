import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { stageLayout, type StageMeta } from "../core/src/index";
import { readDiffText } from "../core/src/git";
import { writeJsonAtomic, writeTextAtomic } from "../core/src/mailbox";
import { loadAndCheck } from "./check";
import { prepareSession } from "./session";

const MAX_DIFF_BYTES = 8 * 1024 * 1024;

export async function stageReview(input: { worktree: string; tourPath: string; sharedRoot: string; sessionId?: string; fresh?: boolean }): Promise<{
  slug: string; dir: string; tour: string; reviewId: string; meta: StageMeta; warnings: string[];
}> {
  const worktree = resolve(input.worktree);
  const result = await loadAndCheck(input.tourPath, worktree);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  const { tour, warnings } = result;
  const diff = await readDiffText(worktree, tour.base, tour.head);
  const diffBytes = Buffer.byteLength(diff);
  if (diffBytes > MAX_DIFF_BYTES) {
    throw new Error(`diff is ${(diffBytes / 1024 / 1024).toFixed(1)} MiB; the Toshi panel reads at most 8 MiB. Review a smaller range or split the PR.`);
  }
  const name = basename(worktree).toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 100) || "review";
  const slug = `${name}-${createHash("sha1").update(worktree).digest("hex").slice(0, 8)}`;
  const layout = stageLayout(resolve(input.sharedRoot, "guided-review", slug));
  await writeJsonAtomic(layout.tour, tour);
  await writeTextAtomic(layout.diff, diff);
  const { session } = await prepareSession({ repo: worktree, tourPath: layout.tour, tour, fresh: input.fresh });
  const meta: StageMeta = {
    version: 1, slug, title: tour.title, reviewId: session.reviewId!, stagedAt: new Date().toISOString(),
    ...(tour.url === undefined ? {} : { url: tour.url }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
  };
  await writeJsonAtomic(layout.meta, meta);
  return { slug, dir: layout.dir, tour: layout.tour, reviewId: meta.reviewId, meta, warnings };
}
