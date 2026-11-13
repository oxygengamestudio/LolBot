export class BoundedTtlCache<K, V> {
    private entries = new Map<K, { value: V; expires: number }>();
    constructor(private readonly capacity: number, private readonly ttlMs: number) {
        if (capacity < 1 || ttlMs <= 0) throw new Error('Invalid cache limits');
    }
    get(key: K): V | undefined {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        if (entry.expires <= Date.now()) { this.entries.delete(key); return undefined; }
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }
    set(key: K, value: V): void {
        this.prune();
        this.entries.delete(key);
        this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
        while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
    }
    prune(): void {
        for (const [key, entry] of this.entries) if (entry.expires <= Date.now()) this.entries.delete(key);
    }
    get size(): number { this.prune(); return this.entries.size; }
}
