import { describe, expect, it } from "bun:test";
import { retry } from "../src/retry";

const fast = { retries: 3, baseDelayMs: 0, maxDelayMs: 0 };

describe("retry", () => {
  it("returns the first success", async () => {
    let calls = 0;
    const result = await retry(async () => {
      calls++;
      if (calls < 2) throw new Error("flaky");
      return "ok";
    }, fast);
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("gives up after the last retry", async () => {
    let calls = 0;
    const failing = retry(async () => {
      calls++;
      throw new Error("down");
    }, fast);
    await expect(failing).rejects.toThrow("down");
    expect(calls).toBe(4);
  });
});
