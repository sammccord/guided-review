import { describe, expect, test } from "bun:test";
import { stackPosition, type StackLayer, type TourStack } from "../src/index";

const layers: StackLayer[] = [
  { number: 1, title: "base", state: "merged" },
  { number: 2, title: "middle", state: "open" },
  { number: 3, title: "top", state: "open" },
];

function stack(current: number, overrides: Partial<TourStack> = {}): TourStack {
  return { number: 9, current, layers, ...overrides };
}

describe("stackPosition", () => {
  test("middle layer has neighbours on both sides", () => {
    expect(stackPosition(stack(2))).toEqual({ index: 2, total: 3, below: layers[0], above: layers[2] });
  });

  test("bottom layer has nothing below", () => {
    expect(stackPosition(stack(1))).toEqual({ index: 1, total: 3, above: layers[1] });
  });

  test("top layer has nothing above", () => {
    expect(stackPosition(stack(3))).toEqual({ index: 3, total: 3, below: layers[1] });
  });

  test("single-layer stack has no neighbours", () => {
    expect(stackPosition(stack(2, { layers: [layers[1]!] }))).toEqual({ index: 1, total: 1 });
  });
});
