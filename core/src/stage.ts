import { joinPosixPaths } from "./layout";
import { REVIEW_ID_PATTERN } from "./qa";

export interface StageMeta {
  version: 1;
  slug: string;
  title: string;
  url?: string;
  sessionId?: string;
  reviewId: string;
  stagedAt: string;
}

export function parseStageMeta(raw: unknown): StageMeta | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  if (!("version" in raw) || raw.version !== 1 || !("slug" in raw) || typeof raw.slug !== "string" ||
    !("title" in raw) || typeof raw.title !== "string" || !("reviewId" in raw) || typeof raw.reviewId !== "string" ||
    !REVIEW_ID_PATTERN.test(raw.reviewId) || !("stagedAt" in raw) || typeof raw.stagedAt !== "string") return null;
  const url = "url" in raw ? raw.url : undefined;
  const sessionId = "sessionId" in raw ? raw.sessionId : undefined;
  if ((url !== undefined && typeof url !== "string") || (sessionId !== undefined && typeof sessionId !== "string")) return null;
  return { version: 1, slug: raw.slug, title: raw.title, reviewId: raw.reviewId, stagedAt: raw.stagedAt,
    ...(url === undefined ? {} : { url }), ...(sessionId === undefined ? {} : { sessionId }) };
}

export function stageLayout(stageDir: string): { dir: string; tour: string; diff: string; meta: string } {
  const dir = joinPosixPaths(stageDir);
  return { dir, tour: joinPosixPaths(dir, "review.tour.json"), diff: joinPosixPaths(dir, "review.diff"), meta: joinPosixPaths(dir, "meta.json") };
}
