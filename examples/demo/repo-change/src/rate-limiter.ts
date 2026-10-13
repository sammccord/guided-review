export type Clock = () => number;

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: Clock = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefill = now();
  }

  tryAcquire(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  private refill(): void {
    const now = this.now();
    const added = Math.floor(((now - this.lastRefill) / 1000) * this.refillPerSecond);
    this.tokens = Math.min(this.capacity, this.tokens + added);
    this.lastRefill = now;
  }
}
