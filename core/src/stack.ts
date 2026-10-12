import type { StackLayer, TourStack } from "./schema";

export interface StackPosition {
  /** 1-based position of `current`, counted from the trunk. */
  index: number;
  total: number;
  /** The layer this one builds on, closer to trunk. */
  below?: StackLayer;
  /** The layer that builds on this one. */
  above?: StackLayer;
}

/** Assumes a parsed stack, where `current` names exactly one layer. */
export function stackPosition(stack: TourStack): StackPosition {
  const at = stack.layers.findIndex((layer) => layer.number === stack.current);
  const below = stack.layers[at - 1];
  const above = stack.layers[at + 1];
  return {
    index: at + 1,
    total: stack.layers.length,
    ...(below ? { below } : {}),
    ...(above ? { above } : {}),
  };
}
