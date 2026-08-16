/**
 * Generic TTL-based in-memory cache with per-key invalidation.
 * Replaces hand-rolled cache objects across the codebase.
 */

export class ResourceCache<T> {
  private store = new Map<string, { value: T; cachedAt: number }>();

  constructor(private ttlMs: number) {}

  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.store.set(key, { value, cachedAt: Date.now() });
  }

  /** Returns age in ms, or null if not cached / expired. */
  getAge(key: string): number | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    const age = Date.now() - entry.cachedAt;
    if (age > this.ttlMs) { this.store.delete(key); return null; }
    return age;
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  invalidateAll(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}
