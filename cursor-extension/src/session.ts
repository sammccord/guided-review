import { createHash, randomUUID } from "node:crypto";
import { initialCursor, move, type TourCursor, type TourMove } from "../../core/src/index";
import type { LoadedTour } from "./repository";

export class TourSession {
  readonly id = randomUUID();
  readonly reviewed = new Set<number>();
  cursor: TourCursor = initialCursor();

  constructor(readonly loaded: LoadedTour, reviewed: readonly number[] = []) {
    for (const index of reviewed) if (this.hasStop(index)) this.reviewed.add(index);
  }

  get progressKey(): string {
    const hash = createHash("sha256").update(JSON.stringify([this.loaded.root, this.loaded.file, this.loaded.mergeBase, this.loaded.head, this.loaded.tour])).digest("hex");
    return `guidedReview.progress.${hash}`;
  }

  hasStop(index: number): boolean {
    return Number.isInteger(index) && index >= 0 && index < this.loaded.stops.length;
  }

  move(action: TourMove): string | undefined {
    if ((action.kind === "goto" || action.kind === "follow") && !this.hasStop(action.index)) return "Unknown tour stop";
    const result = move(this.loaded.stops, this.loaded.tour.tracks.length, this.cursor, action);
    if (!result.ok) return result.reason;
    this.cursor = result.cursor;
    return undefined;
  }

  toggleReviewed(index: number): void {
    if (!this.hasStop(index)) return;
    if (this.reviewed.has(index)) this.reviewed.delete(index);
    else this.reviewed.add(index);
  }
}
