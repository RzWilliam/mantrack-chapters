/**
 * Very small in-memory TTL cache.
 * - Not distributed (process-local) — good for Node server instances where memory persists.
 * - Simple Map-based storage with optional maxEntries eviction (FIFO)
 */
export type CacheEntry<T> = {
  value: T
  expiresAt: number
}

export class SimpleCache<T> {
  private map = new Map<string, CacheEntry<T>>()
  private queue: string[] = []

  constructor(private ttlMs = 60_000, private maxEntries = 500) {}

  get(key: string): T | null {
    const e = this.map.get(key)
    if (!e) return null
    if (Date.now() > e.expiresAt) {
      this.map.delete(key)
      return null
    }
    return e.value
  }

  set(key: string, value: T, ttlMs?: number) {
    const expiresAt = Date.now() + (ttlMs ?? this.ttlMs)
    if (!this.map.has(key)) {
      this.queue.push(key)
    }
    this.map.set(key, { value, expiresAt })

    // simple eviction when exceeding maxEntries
    while (this.queue.length > this.maxEntries) {
      const old = this.queue.shift()
      if (old) this.map.delete(old)
    }
  }

  delete(key: string) {
    this.map.delete(key)
    const i = this.queue.indexOf(key)
    if (i >= 0) this.queue.splice(i, 1)
  }

  clear() {
    this.map.clear()
    this.queue = []
  }
}

// Export a shared instance intended for header searches. TTL tuned short to keep results fresh.
export type HeaderSearchResult = Array<{
  mal_id: number;
  title: string;
  image_url?: string | null;
  type?: string | null;
  score?: number | null;
}>

export const headerCache = new SimpleCache<HeaderSearchResult>(30_000, 1000)

// Generic cache for search page results (page 1). Use unknown here and cast when reading/writing.
export const searchCache = new SimpleCache<unknown>(300_000, 500)
