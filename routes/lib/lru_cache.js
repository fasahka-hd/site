class TTLCache {
  constructor({maxSize: maxSize = 5e3, ttlMs: ttlMs = 6 * 60 * 60 * 1e3} = {}) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.map = new Map;
  }
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return void 0;
    if (Date.now() - entry.ts > this.ttlMs) {
      this.map.delete(key);
      return void 0;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key); else if (this.map.size >= this.maxSize) {
      const first = this.map.keys().next().value;
      this.map.delete(first);
    }
    this.map.set(key, {
      value: value,
      ts: Date.now()
    });
  }
  has(key) {
    return this.get(key) !== void 0;
  }
  delete(key) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}

const avatarCache = new TTLCache({
  maxSize: 3e3,
  ttlMs: 6 * 60 * 60 * 1e3
});

const workshopCache = new TTLCache({
  maxSize: 500,
  ttlMs: 24 * 60 * 60 * 1e3
});

export { TTLCache, avatarCache, workshopCache };
