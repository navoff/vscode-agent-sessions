/** Turns successive clicks on the same key into a double-click signal. */
export class DoubleClickDetector {
  private lastKey: string | undefined;
  private lastAt = 0;

  constructor(private readonly windowMs = 500, private readonly now: () => number = Date.now) {}

  /** Returns true when this click completes a double click on `key`. */
  click(key: string): boolean {
    const t = this.now();
    const double = this.lastKey === key && t - this.lastAt <= this.windowMs;
    if (double) {
      this.lastKey = undefined;
      this.lastAt = 0;
      return true;
    }
    this.lastKey = key;
    this.lastAt = t;
    return false;
  }
}
