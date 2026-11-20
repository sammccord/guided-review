import { REVIEW_ID_PATTERN } from "./qa";

export interface ReviewLayout {
  root: string;
  session: string;
  inbox: string;
  answered: string;
  agent: string;
  approved: string;
}

function joinPosixPaths(...parts: string[]): string {
  const path = parts.join("/");
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === ".." && segments.length > 0 && segments.at(-1) !== "..") segments.pop();
    else if (segment !== ".." || !path.startsWith("/")) segments.push(segment);
  }
  return (path.startsWith("/") ? "/" : "") + segments.join("/") || ".";
}

export function reviewLayout(tourPath: string, reviewId?: string | null): ReviewLayout {
  let root = tourPath.replace(/\.json$/, "") + ".qa";
  if (reviewId != null) {
    if (!REVIEW_ID_PATTERN.test(reviewId)) throw new Error("invalid review id");
    root = joinPosixPaths(root, "reviews", reviewId);
  }
  return {
    root,
    session: joinPosixPaths(root, "session.json"),
    inbox: joinPosixPaths(root, "inbox"),
    answered: joinPosixPaths(root, "answered"),
    agent: joinPosixPaths(root, "agent.json"),
    approved: joinPosixPaths(root, "approved.json"),
  };
}

export function currentPointerPath(tourPath: string): string {
  return joinPosixPaths(reviewLayout(tourPath).root, "current.json");
}

export function requestFile(layout: ReviewLayout, id: string): string {
  return joinPosixPaths(layout.inbox, `${id}.json`);
}

export function answerFile(layout: ReviewLayout, id: string): string {
  return joinPosixPaths(layout.answered, `${id}.json`);
}
