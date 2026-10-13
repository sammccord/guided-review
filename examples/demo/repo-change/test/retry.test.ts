import { describe, expect, it } from "bun:test";
import { retry } from "../src/retry";

const fast = { maxAttempts: 4, baseDelayMs: 0, maxDelayMs: 0, jitter: false, shouldRetry: () => true };

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

  it("gives up after the last attempt", async () => {
    let calls = 0;
    const failing = retry(async () => {
      calls++;
      throw new Error("down");
    }, fast);
    await expect(failing).rejects.toThrow("down");
    expect(calls).toBe(5);
  });

  it("stops on a non-retryable error", async () => {
    let calls = 0;
    const failing = retry(
      async () => {
        calls++;
        throw new Error("bad request");
      },
      { ...fast, shouldRetry: () => false },
    );
    await expect(failing).rejects.toThrow("bad request");
    expect(calls).toBe(1);
  });
});
