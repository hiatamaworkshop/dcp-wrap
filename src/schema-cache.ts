/**
 * SchemaCache — TTL付きインメモリキャッシュ
 *
 * SchemaRegistry への高頻度アクセスを軽減する。
 * キャッシュが失効しても registry から再フェッチするため、スキーマ自体は消えない。
 * 未登録 schemaId は null → Preprocessor が Drop として扱う。
 *
 * evict() を外部から定期呼び出しするか、IngestorX の tick で実行すること。
 */

import type { SchemaRegistry, RegistryEntry } from "./registry.js";

export interface SchemaCacheOptions {
  /** キャッシュ有効期間 (ms)。デフォルト: 300_000 (5分) */
  ttlMs?: number;
  /** 最大エントリ数。超過時は最古エントリを evict。デフォルト: 1000 */
  maxEntries?: number;
}

export class SchemaCache {
  private readonly cache = new Map<string, { entry: RegistryEntry; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(
    private readonly registry: SchemaRegistry,
    opts: SchemaCacheOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 300_000;
    this.maxEntries = opts.maxEntries ?? 1000;
  }

  /**
   * schemaId を解決して RegistryEntry を返す。
   * キャッシュヒット (TTL内) → キャッシュを返す。
   * ミスまたは失効 → registry から再フェッチしてキャッシュに格納。
   * registry にも存在しない場合は null。
   */
  get(schemaId: string): RegistryEntry | null {
    const now = Date.now();
    const hit = this.cache.get(schemaId);

    // キャッシュヒット: TTL内 かつ registry のエントリと同一インスタンス (VShadow 更新検知)
    if (hit && hit.expiresAt > now) {
      const current = this.registry.get(schemaId);
      if (current === hit.entry) return hit.entry;
      // registry 側が更新された (updateVShadow など) → キャッシュを差し替え
      this.cache.set(schemaId, { entry: current!, expiresAt: now + this.ttlMs });
      return current ?? null;
    }

    // miss or expired — registry から再フェッチ
    const entry = this.registry.get(schemaId);
    if (!entry) return null;

    // maxEntries 超過時は最古エントリを削除
    if (this.cache.size >= this.maxEntries) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }

    this.cache.set(schemaId, { entry, expiresAt: now + this.ttlMs });
    return entry;
  }

  /**
   * 失効エントリをすべて削除する。
   * setInterval や IngestorX の tick から定期呼び出しすること。
   */
  evict(): void {
    const now = Date.now();
    for (const [id, v] of this.cache) {
      if (v.expiresAt <= now) this.cache.delete(id);
    }
  }

  /** 現在のキャッシュエントリ数。 */
  get size(): number {
    return this.cache.size;
  }

  /** キャッシュを全クリアする (テスト用)。 */
  clear(): void {
    this.cache.clear();
  }
}
