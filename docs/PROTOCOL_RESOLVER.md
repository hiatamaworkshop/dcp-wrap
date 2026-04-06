# Protocol Resolver — 設計仕様

Preprocessor の JSON 前提問題を解決するための実装計画。
Minecraft Pipeline プロジェクトの前提基盤として先行実装する。

---

## 背景

現状の `Preprocessor` は `Record<string, unknown>` (= JSON パース後オブジェクト) を前提とする。
MQTT バイナリ・CBOR・独自フォーマットは `isPlainObject()` で即 Drop される。

目標: **あらゆるソースフォーマットから直接 positional array を生成し、JSON を中間フォーマットとして経由しない。**

---

## Phase 1: SourceAdapter + SchemaCache

### 1-1. SourceAdapter インターフェース

```typescript
// src/adapter.ts

/**
 * Protocol-specific adapter.
 * Converts raw bytes/objects from a source into a positional array
 * conformant with the target schema — without JSON as an intermediary.
 *
 * T = raw input type (Buffer for binary, Record for JSON, string for CSV...)
 */
export interface SourceAdapter<T = unknown> {
  /**
   * Extract schemaId from the raw input.
   * Returns null if the source cannot be identified (→ Drop).
   */
  schemaId(raw: T): string | null;

  /**
   * Convert raw input to positional array using the resolved schema.
   * Returns null if conversion fails (→ Drop).
   */
  decode(raw: T, schema: DcpSchema): unknown[] | null;

  /**
   * Inspect raw input for quarantine signals before decode.
   * Returns null if no quarantine signal detected.
   * Called only when decode() succeeds but field-level issues may exist.
   */
  quarantineHint?(raw: T): QuarantineReason | null;
}
```

### 1-2. 標準 Adapter 実装

#### JSONAdapter（既存 Preprocessor の置き換え）

```typescript
// src/adapters/json-adapter.ts

export class JSONAdapter implements SourceAdapter<Record<string, unknown>> {
  constructor(private readonly schemaField = "$schema") {}

  schemaId(raw: Record<string, unknown>): string | null {
    const id = raw[this.schemaField];
    return typeof id === "string" && id.trim() !== "" ? id : null;
  }

  decode(raw: Record<string, unknown>, schema: DcpSchema): unknown[] | null {
    // フィールド順に positional array を構築
    return schema.fields.map((f) => raw[f] ?? null);
  }
}
```

#### BinaryAdapter（MQTT / 独自バイナリ向け雛形）

```typescript
// src/adapters/binary-adapter.ts

export interface BinarySchemaMap {
  /** source identifier (topic / port / tag) → schemaId */
  resolve(source: string): string | null;
  /** schemaId → field byte offsets */
  offsets(schemaId: string): number[] | null;
}

export class BinaryAdapter implements SourceAdapter<{ bytes: Buffer; source: string }> {
  constructor(private readonly map: BinarySchemaMap) {}

  schemaId({ source }): string | null {
    return this.map.resolve(source);
  }

  decode({ bytes }, schema: DcpSchema): unknown[] | null {
    const offsets = this.map.offsets(schema.id);
    if (!offsets) return null;
    // offset定義に従って bytes をスライスして positional array を生成
    // 実装はプロトコル仕様に依存 — Minecraft Phase で具体化
    return offsets.map((off, i) => readField(bytes, off, schema.fieldTypes[i]));
  }
}
```

### 1-3. SchemaCache（インメモリ TTL）

```typescript
// src/schema-cache.ts

export interface SchemaCacheOptions {
  ttlMs: number;       // default: 300_000 (5分)
  maxEntries?: number; // default: 1000
}

export class SchemaCache {
  private readonly cache = new Map<string, { entry: RegistryEntry; expiresAt: number }>();

  constructor(
    private readonly registry: SchemaRegistry,
    private readonly opts: SchemaCacheOptions = { ttlMs: 300_000 },
  ) {}

  get(schemaId: string): RegistryEntry | null {
    const hit = this.cache.get(schemaId);
    if (hit && hit.expiresAt > Date.now()) return hit.entry;
    // miss or expired → registry fetch
    const entry = this.registry.get(schemaId);
    if (!entry) return null;
    this.cache.set(schemaId, { entry, expiresAt: Date.now() + this.opts.ttlMs });
    return entry;
  }

  evict(): void {
    const now = Date.now();
    for (const [id, v] of this.cache) {
      if (v.expiresAt <= now) this.cache.delete(id);
    }
  }
}
```

**設計原則:**
- スキーマ自体が消えるのではなく、キャッシュが消える。次アクセス時に registry から再フェッチ。
- 未登録 schemaId は `null` → Drop。事前登録前提。
- `evict()` は外部から定期呼び出し（setInterval）または IngestorX の tick で実行。

### 1-4. Preprocessor Core の再設計

現状の `Preprocessor` を **Adapter を受け取る汎用コア** に変える。

```typescript
// src/preprocessor.ts (変更後)

export class Preprocessor<T = unknown> {
  constructor(
    private readonly adapter: SourceAdapter<T>,
    private readonly cache: SchemaCache,
    private readonly postbox: PostBox,
    private readonly ctrl: PipelineControl,
    private readonly options: PreprocessorOptions,
  ) { ... }

  process(raw: T): void {
    // 1. schemaId 解決
    const schemaId = this.adapter.schemaId(raw);
    if (!schemaId) { this.drop(raw, "schemaId unresolvable"); return; }

    // 2. stop / throttle チェック (変更なし)
    ...

    // 3. スキーマキャッシュ参照
    const entry = this.cache.get(schemaId);
    if (!entry) { this.drop(raw, `unknown schemaId: ${schemaId}`); return; }

    // 4. decode → positional array
    const array = this.adapter.decode(raw, entry.schema);
    if (!array) { this.drop(raw, "decode failed"); return; }

    // 5. VShadow バリデーション (変更なし)
    const vResult = entry.vShadow.validateArray(array);
    ...

    // 6. Pass → onPass(array, schemaId)
    this.passHandler?.(array, schemaId);
  }
}
```

**後方互換:** `JSONAdapter` を渡せば既存の挙動と等価。既存テスト44件はそのまま通る。

---

## Phase 2: IngestorX

### 2-1. IngestorX インターフェース

```typescript
// src/ingestor.ts

export interface IngestorX<T = unknown> {
  /** 常時起動。ストリーム受付開始。 */
  start(): Promise<void>;

  /** グレースフルシャットダウン。進行中の処理を完了してから停止。 */
  stop(): Promise<void>;

  /** 受信イベント。Preprocessor.process() へ渡す。 */
  onReceive(handler: (raw: T) => void): void;
}
```

### 2-2. Ingestor 実装一覧

通信層は3段階で切り替える。インターフェースは共通なので Preprocessor 側は変更不要。

#### HTTPIngestor — 開発・デバッグ段階

```typescript
// src/ingestors/http-ingestor.ts

export class HTTPIngestor implements IngestorX<Record<string, unknown>> {
  constructor(private readonly port: number) {}

  async start(): Promise<void> {
    // POST /ingest → body parse → onReceive(body)
    // Minecraft Bukkit Plugin はここに POST する
    // デバッグ容易。ボトルネックになったら UDS に切り替える。
  }

  async stop(): Promise<void> { ... }

  onReceive(handler): void { this.handler = handler; }
}
```

#### UDSIngestor — 同一VM本番構成

```typescript
// src/ingestors/uds-ingestor.ts

export class UDSIngestor implements IngestorX<Buffer> {
  constructor(private readonly socketPath: string) {}
  // 例: /tmp/dcp-pipeline.sock

  async start(): Promise<void> {
    // net.createServer() → Unix Domain Socket listen
    // TCP/IPスタックを通らない。遅延ほぼゼロ。
    // 同一VM内に限定される。
  }

  async stop(): Promise<void> { ... }

  onReceive(handler): void { this.handler = handler; }
}
```

#### UDPIngestor — 複数サーバー集約・欠落許容データ

```typescript
// src/ingestors/udp-ingestor.ts

export class UDPIngestor implements IngestorX<Buffer> {
  constructor(private readonly port: number) {}

  async start(): Promise<void> {
    // dgram.createSocket('udp4') → bind
    // 欠落許容データ (player_move / $ST) に限定する。
    // combat / block_place など確定イベントには使わない。
  }

  async stop(): Promise<void> { ... }

  onReceive(handler): void { this.handler = handler; }
}
```

#### 用途別選択基準

| データ種別 | 欠落許容 | 推奨方式 |
|-----------|---------|---------|
| `player_move:v1` | ○ | UDP / UDS |
| `$ST` 統計 | ○ | UDP / UDS |
| `combat:v1` | ✗ | UDS のみ |
| `block_place:v1` | ✗ | UDS のみ |
| `chat:v1` | ✗ | UDS のみ |

**実装フェーズ:**
```
Phase A: HTTP  → 動作確認・デバッグ
Phase B: UDS   → 同一VM本番、遅延最小化
Phase C: UDP   → 複数Minecraftサーバー集約時、欠落許容データのみ
```

### 2-3. LoadBalancer（IngestorX × N）

```typescript
// src/ingestor-pool.ts

export class IngestorPool<T> {
  private readonly instances: IngestorX<T>[];
  private index = 0;

  constructor(
    factory: () => IngestorX<T>,
    private readonly size = 3,
  ) {
    this.instances = Array.from({ length: size }, factory);
  }

  async start(): Promise<void> {
    await Promise.all(this.instances.map((i) => i.start()));
  }

  async stop(): Promise<void> {
    await Promise.all(this.instances.map((i) => i.stop()));
  }

  /** Round-robin で次の IngestorX を返す。外部から process() を呼ぶ場合に使用。 */
  next(): IngestorX<T> {
    return this.instances[this.index++ % this.size];
  }
}
```

### 2-4. channel[schemaId]

IngestorX → Preprocessor の接続は **schemaId チャネル経由**。

```typescript
// src/ingestion-bus.ts

export class IngestionBus {
  private readonly channels = new Map<string, ((array: unknown[], schemaId: string) => void)[]>();

  /** IngestorX → Bus への投入口 */
  push(array: unknown[], schemaId: string): void {
    const handlers = this.channels.get(schemaId) ?? this.channels.get("*");
    handlers?.forEach((h) => h(array, schemaId));
  }

  /** Preprocessor Core → Bus への登録 */
  subscribe(schemaId: string, handler: (array: unknown[], schemaId: string) => void): void {
    const list = this.channels.get(schemaId) ?? [];
    list.push(handler);
    this.channels.set(schemaId, list);
  }
}
```

`"*"` はワイルドカード。特定スキーマを subscribe しない Preprocessor がすべてのイベントを受け取る場合に使う。

---

## 実装順序

```
# Phase 1: Protocol Adapter 基盤
Step 1: src/adapter.ts                 — SourceAdapter インターフェース定義
Step 2: src/schema-cache.ts            — SchemaCache (TTL付き)
Step 3: src/adapters/json-adapter.ts   — JSONAdapter 実装
Step 4: src/preprocessor.ts            — Adapter ベースに変更
        → 既存テスト44件パス確認 (必須チェックポイント)

# Phase 2A: HTTP Ingestor (開発・デバッグ)
Step 5: src/ingestor.ts                — IngestorX インターフェース定義
Step 6: src/ingestors/http-ingestor.ts — HTTPIngestor 実装
Step 7: src/ingestor-pool.ts           — LoadBalancer (round-robin)
Step 8: src/ingestion-bus.ts           — channel[schemaId] バス
Step 9: テスト追加                     — SchemaCache TTL / HTTP受信 / Pool分散

# Phase 2B: UDS Ingestor (同一VM本番) ← Minecraft Phase B で着手
Step 10: src/ingestors/uds-ingestor.ts — UDSIngestor 実装
Step 11: テスト追加                    — UDS 接続・切断・再接続

# Phase 2C: UDP Ingestor (複数サーバー集約) ← 複数MC Server構成時に着手
Step 12: src/ingestors/udp-ingestor.ts — UDPIngestor 実装
Step 13: テスト追加                    — UDP 受信・欠落シミュレーション
```

各 Step は独立してテスト可能。**Step 4 が必須チェックポイント** — 既存44テストが通ることを確認してから Phase 2 に進む。

---

## 影響範囲

| ファイル | 変更種別 | 内容 |
|---------|---------|------|
| `src/preprocessor.ts` | 変更 | Adapter ベースに再設計、後方互換維持 |
| `src/registry.ts` | 変更なし | SchemaCache が内部参照 |
| `src/validation.test.ts` | 軽微な変更 | JSONAdapter 経由に変更 |
| `src/pipeline-chain.test.ts` | 軽微な変更 | 同上 |
| `src/adapter.ts` | 新規 | |
| `src/schema-cache.ts` | 新規 | |
| `src/adapters/json-adapter.ts` | 新規 | |
| `src/ingestor.ts` | 新規 | |
| `src/ingestors/http-ingestor.ts` | 新規 | Phase A: 開発・デバッグ |
| `src/ingestors/uds-ingestor.ts` | 新規 | Phase B: 同一VM本番 |
| `src/ingestors/udp-ingestor.ts` | 新規 | Phase C: 複数サーバー集約 |
| `src/ingestor-pool.ts` | 新規 | |
| `src/ingestion-bus.ts` | 新規 | |

---

## Minecraft Phase への接続

Phase 1〜2 完了後、Minecraft プロジェクトで追加するのは以下だけ：

```typescript
// minecraft-dcp-server/src/adapters/bukkit-adapter.ts

export class BukkitAdapter implements SourceAdapter<Record<string, unknown>> {
  // Bukkit Plugin が POST する JSON body を受け取り
  // topic ("player_move", "combat" ...) → schemaId ("player_move:v1") に解決
  // decode() は JSONAdapter と同じ (フィールド順マッピング)
}
```

DCP Pipeline コアは変更不要。Adapter を追加するだけで Minecraft に対応できる。

---

## 現時点の方針

**設計仕様として記録。実装は Phase 1 → Phase 2 → Minecraft の順で着手。**

Phase 1 完了が既存44テストのパス維持の必須条件。後方互換を崩さずに進める。
