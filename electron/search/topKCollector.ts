export type TopKCompare<T> = (a: T, b: T) => number;

export type TopKCollectorOptions<T> = {
  limit: number;
  getKey: (item: T) => string;
  compare: TopKCompare<T>;
};

export class TopKCollector<T> {
  private readonly limit: number;
  private readonly getKey: (item: T) => string;
  private readonly compare: TopKCompare<T>;
  private readonly items: T[] = [];
  private readonly byKey = new Map<string, T>();

  constructor(options: TopKCollectorOptions<T>) {
    this.limit = Math.max(0, Math.floor(Number(options.limit) || 0));
    this.getKey = options.getKey;
    this.compare = options.compare;
  }

  add(item: T) {
    if (this.limit <= 0) return false;
    const key = this.getNormalizedKey(item);
    if (!key) return false;

    const existing = this.byKey.get(key);
    if (existing) {
      if (this.compare(item, existing) >= 0) return false;
      this.removeExisting(key);
    } else if (this.items.length >= this.limit) {
      const worst = this.items[this.items.length - 1];
      if (worst && this.compare(item, worst) >= 0) return false;
    }

    this.insertSorted(item, key);
    if (this.items.length > this.limit) this.trimOverflow();
    return true;
  }

  toArray() {
    return this.items.slice();
  }

  get size() {
    return this.items.length;
  }

  private getNormalizedKey(item: T) {
    const raw = this.getKey(item);
    return typeof raw === "string" ? raw.trim().toLowerCase() : "";
  }

  private removeExisting(key: string) {
    const existing = this.byKey.get(key);
    if (!existing) return;
    this.byKey.delete(key);
    const idx = this.items.findIndex((item) => this.getNormalizedKey(item) === key);
    if (idx >= 0) this.items.splice(idx, 1);
  }

  private insertSorted(item: T, key: string) {
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const current = this.items[mid];
      if (!current) break;
      if (this.compare(item, current) < 0) hi = mid;
      else lo = mid + 1;
    }
    this.items.splice(lo, 0, item);
    this.byKey.set(key, item);
  }

  private trimOverflow() {
    while (this.items.length > this.limit) {
      const removed = this.items.pop();
      if (!removed) continue;
      const removedKey = this.getNormalizedKey(removed);
      if (!removedKey) continue;
      const latest = this.byKey.get(removedKey);
      if (latest === removed) this.byKey.delete(removedKey);
    }
  }
}

