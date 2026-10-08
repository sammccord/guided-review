import type { Stop, Tour, Track } from "../src/index";

export function stop(overrides: Partial<Stop> = {}): Stop {
  return {
    path: "src/a.ts",
    side: "new",
    line: 10,
    kind: "risk",
    title: "Retry loop",
    body: "- Retries forever.",
    ask: "Is unbounded retry acceptable?",
    ...overrides,
  };
}

export function track(stops: Stop[], overrides: Partial<Track> = {}): Track {
  return { title: "Retries", summary: "- How retry is wired.", stops, ...overrides };
}

/** Accepts a flat stop list as shorthand for a single-track tour. */
export function tour({ stops, ...overrides }: Partial<Tour> & { stops?: Stop[] } = {}): Tour {
  return {
    version: 1,
    title: "Add retries",
    base: "aaa",
    head: "bbb",
    verdict: "request-changes",
    summary: "- Adds retry logic.",
    scope: { checked: ["unit tests"], unchecked: ["load"] },
    tracks: [track(stops ?? [stop()])],
    skipped: [],
    ...overrides,
  };
}
