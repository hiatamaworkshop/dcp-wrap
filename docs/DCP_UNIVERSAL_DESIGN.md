# DCP Universal Module — 設計ノート

## 動機

dcp-rag の core は RAG に依存していない。`DcpSchema`, `FieldMapping`, `DcpEncoder` は任意の dict → positional array 変換を行う汎用エンジン。RAG はスキーマとプリセットの組み合わせに過ぎない。

## パッケージ構造案

```
dcp/                          ← pip install dcp
  core/
    schema.py                 ← DcpSchema, SchemaRegistry, FieldType (現状のまま)
    mapping.py                ← FieldMapping, resolve_path (現状のまま)
    encoder.py                ← DcpEncoder, EncodedBatch (現状のまま)
  schemas/
    rag-chunk-meta.v1.json    ← RAG用 (dcp[rag] extras)
    rag-query-hint.v1.json
    rag-rerank-signal.v1.json
    rag-result-summary.v1.json
    log-entry.v1.json         ← ログ分析用 (dcp[log] extras — 将来)
    api-response.v1.json      ← API応答用 (dcp[api] extras — 将来)
  presets/
    rag/                      ← RAGプリセット (pinecone, qdrant, ...)
    log/                      ← ログプリセット (structured-log, cloudwatch, ...)
    api/                      ← APIプリセット (rest-json, graphql, ...)
  adapters/
    rag/                      ← RAGフレームワーク (llamaindex, langchain, haystack, azure)
    log/                      ← ログフレームワーク (将来)

dcp-rag/                      ← pip install dcp-rag (薄いラッパー、移行期間用)
  → depends on dcp[rag]
  → re-exports DcpEncoder, from_preset("pinecone") etc.
```

## 移行パス

```
Phase 1 (現在):  dcp-rag 0.1.x — 単独パッケージとして公開
Phase 2:         dcp 0.1.0 — core を dcp に抽出、dcp-rag は dcp[rag] に依存
Phase 3:         dcp-rag 1.0 → deprecated, "pip install dcp[rag]" に誘導
```

## core の汎用性の証明

encoder.py の主要メソッド:

```python
def encode(self, chunks: list[dict], texts: list[str] | None = None) -> EncodedBatch:
```

- `chunks` = 任意の dict のリスト（Vector DB result に限らない）
- `texts` = テキスト部分（ログのメッセージ本文、API response body、etc.）
- `DcpSchema` = フィールド定義（RAG固有の知識なし）
- `FieldMapping` = dot-notation パス解決（任意の nested dict 構造対応）

**RAG 固有のコードは core に存在しない。**

## 汎用ユースケース

### 1. ログ分析 → LLM

```json
{
  "$dcp": "schema",
  "id": "log-entry:v1",
  "fields": ["level", "service", "timestamp", "error_code"],
  "fieldCount": 4,
  "types": {
    "level": {"type": "string", "enum": ["debug", "info", "warn", "error", "fatal"]},
    "service": {"type": "string"},
    "timestamp": {"type": "number", "description": "Unix epoch seconds"},
    "error_code": {"type": ["string", "null"]}
  }
}
```

```python
encoder = DcpEncoder(
    schema="log-entry:v1",
    mapping={
        "level": "level",
        "service": "service_name",
        "timestamp": "ts",
        "error_code": "error.code",
    },
    group_key="service",
    text_key="message",
)

# NL: "Error in auth-service at 2024-03-24 14:30: connection timeout (E_TIMEOUT)"
# DCP: ["error", "auth-service", 1711284600, "E_TIMEOUT"]
#       connection timeout
```

### 2. DB結果 → LLM

```json
{
  "$dcp": "schema",
  "id": "db-row:v1",
  "fields": ["table", "column", "value_type", "row_count"],
  "fieldCount": 4
}
```

### 3. API レスポンス → LLM

```json
{
  "$dcp": "schema",
  "id": "api-response:v1",
  "fields": ["status", "latency_ms", "endpoint", "method"],
  "fieldCount": 4
}
```

### 4. 設定注入 → LLM

```json
{
  "$dcp": "schema",
  "id": "config-param:v1",
  "fields": ["key", "value", "source", "override"],
  "fieldCount": 4
}
```

## 設計原則 (dcp-rag から継承)

1. **データ変換しない** — 値は as-is。構造だけ変える
2. **カットダウン** — 存在するフィールドだけ。null-fill しない
3. **$G グルーピング** — 繰り返しキーの圧縮
4. **スキーマ教育** — $S ヘッダーで LLM にフィールド意味を伝達
5. **LLM境界のみ** — 上流のプログラム処理は元データで行う

## core に必要な変更

**なし。** 現状の core は汎用的。変更が必要なのは:

- パッケージ名: `dcp_rag` → `dcp`
- `from_preset()` のプリセットロード先: ドメイン別に分離
- schemas ディレクトリ: ドメイン別のサブディレクトリ or タグベースのフィルタリング

## `from_preset()` の拡張案

```python
# 現状 (RAG のみ)
encoder = DcpEncoder.from_preset("pinecone")

# 拡張 (ドメイン prefix)
encoder = DcpEncoder.from_preset("rag:pinecone")
encoder = DcpEncoder.from_preset("log:cloudwatch")
encoder = DcpEncoder.from_preset("api:rest-json")

# あるいは引数
encoder = DcpEncoder.from_preset("pinecone", domain="rag")
```

prefix 方式が良い。理由:
- 1引数で完結
- 名前空間の衝突を防ぐ
- `rag:` prefix がなければ RAG がデフォルト (後方互換)

## SchemaRegistry の拡張案

```python
# 現状: ディレクトリ全部ロード
registry = SchemaRegistry("schemas/")

# 拡張: ドメインフィルタ
registry = SchemaRegistry("schemas/", domain="rag")  # rag-* のみロード
registry = SchemaRegistry("schemas/", domain="log")   # log-* のみロード
registry = load_default_registry(domain="rag")         # 便利関数
```

あるいはスキーマ ID の prefix 規約で十分:
- `rag-chunk-meta:v1` → RAG ドメイン
- `log-entry:v1` → ログドメイン
- `api-response:v1` → API ドメイン

Registry はフラットで全部持ち、`get()` で ID 指定するだけ。ドメインフィルタは不要。

## まとめ

dcp-rag の core は既に dcp 汎用モジュールそのもの。必要なのは:

1. パッケージ名変更 (`dcp`)
2. プリセットの名前空間分離 (`rag:pinecone` 形式)
3. 新ドメインのスキーマ定義 (JSON ファイル追加のみ)
4. 新ドメインのプリセット定義 (Python dict 追加のみ)

core のロジック変更はゼロ。

---

## Interactive Schema — 実装済み設計 (2026-03-25)

> engram gateway に Stage 0/1 を実装済み。以下は初期構想から実装を経て確定した設計。

### 背景: エージェントは DCP を知っていても従わない

実証済み: CLAUDE.md に DCP 仕様が記載され、engram が native 推奨警告を返しても、エージェントは自然言語で push した。LLM は仕様を「知っている」ことと「従う」ことの間にギャップがある。recency bias により、コンテキストウィンドウの拡大ではこの問題は解決しない。

### 密度スペクトラム（3段階）

schema は文脈に応じて自身の表現密度を変える:

| 密度 | いつ | 形式 | コスト |
|------|------|------|--------|
| **Abbreviated** | consumer が schema を知っている | `$S:knowledge:v1#fcbc [expand:GET /schemas/knowledge:v1]` | ~5 tokens |
| **Expanded** | consumer にリマインダーが必要 | `$S:knowledge:v1#fcbc [action(add\|replace\|flag\|remove) target domain weight:0-1] [expand:...]` | ~30 tokens |
| **Full** | consumer が初見 | フィールド定義全体 + 型 + enum + 例 | ~80+ tokens |

### スキーマヒントの実動作（engram 実装済み）

engram gateway の `determineSchemaHint()` が push レスポンスに含めるヒントを決定:

- **DCP-native かつ schema-valid** → abbreviated のみ（最小コスト）
- **自然言語の push** → expanded ヒント（パッシブ教育）
- **schema 違反** → データは **受理** + 警告 + expanded ヒント

**パッシブ教育原則: reject しない、warn のみ。** gate.ts で schema violation は `warnings.push()` に変更済み（`errors.push()` ではない）。コスト勾配が自然なインセンティブ — DCP 準拠データは処理コストが低い。非準拠でも動く、ただしコストが高い。

### スキーマレジストリ（engram 実装済み）

`gateway/schemas/*.json` を SSOT として一元管理。API で動的参照可能:

```
GET /schemas          → スキーマ一覧
GET /schemas/:id      → フル定義
```

tool description にスキーマをインライン埋め込み + push レスポンスにヒント + API で能動的参照 = 3層の教育動線。

### スキーマプリメソッド（設計のみ・4つに凍結）

| メソッド | 意味 |
|----------|------|
| `$S?` | schema query — "このスキーマは何？" |
| `$S!` | schema declaration — "このスキーマで送る" |
| `$SV` | schema validation — "準拠しているか？" |
| `$S+` | schema expansion — "フル定義をくれ" |

将来のマルチエージェントハンドシェイク用インフラ。現時点でエージェントが能動的にトリガすることはない。

### エージェントプロファイル適応（設計のみ）

エージェントごとの DCP 準拠率を観測し、ヒント密度を自動調整する:

```
agent_profile {
  agentId:       string
  errorRate:     float          // 直近 N 回の非準拠率
  hintStage:     0 | 1 | 2 | 3 // 適用中のヒント密度
  anchorDensity: number         // リマインダー頻度 (0 = なし)
}

初見         → 保守的 (expanded + 高密度アンカー)
高精度       → abbreviated + アンカーなし
中精度       → expanded + 適度なアンカー
低精度       → full + 高密度アンカー
改善傾向     → 段階的に密度を下げる
悪化傾向     → 即座に密度を上げる
```

TCP 輻輳制御と同構造: slow start → congestion avoidance。ペナルティではなくコスト最適化 — 低精度エージェントは罰を受けるのではなく、必要な情報量を提供されているだけ。

### OUT 側フォーマッタとの協調

Interactive Schema は **入口の改善** — エージェントが DCP に近づく確率を上げる。
OUT 側フォーマッタは **出口の保証** — エージェントが何を出しても DCP になる。

```
Interactive Schema (入口)          OUT Formatter (出口)
  abbreviated で周辺視野を提供       bitmask で入力を判定
  $S+ で展開を提供                   cutdown で positional array に成型
  教育コストグラデーション            streaming 適性（1 件ずつ処理）
       ↓                                ↓
  エージェントの改善を促す            改善しなくても動く
```

**両方あって完全** — 入口だけでは準拠を保証できない。出口だけでは改善が起きない。

### bitmask cutdown のストリーミング適性

| 入力タイプ | bitmask 判定 | フォーマッタの処理 |
|---|---|---|
| 完全 DCP | full_mask 一致 | 素通し |
| 部分 DCP | 部分 bit | cutdown 成型 |
| structured NL | キー名マッピング | positional 化 |
| 生 NL | mask=0 | summary + tags から最低限 array |

バッチ全体の OR で bitmask を判定すると、1 件の良いデータが全体の null 埋めを誘発する。**ストリーミング（1 件ずつ判定）ではこの問題は起きない。** マルチエージェントの push は本質的にストリーミング。

### DB データ管理との構造的一致

| DCP | DB equivalent |
|---|---|
| bitmask | カラムナー DB の null bitmap |
| cutdown | スキーマプロジェクション (`SELECT col1, col3`) |
| `$G` | `GROUP BY` |
| ストリーミング単位処理 | row-level evaluation |
| abbreviated schema | インデックスページ（B-Tree の内部ノード） |
| interactive methods | ストアドプロシージャ参照 |

偶然の一致ではなく、データを効率的に扱う問題の解は収束する。

### 設計原則

| # | 原則 |
|---|---|
| 1 | **schema が全ての起点** — データ定義も操作方法も schema から生える |
| 2 | **abbreviated が日常、展開は例外** — 常時コストは最小、必要時だけ拡大 |
| 3 | **準拠は経済的インセンティブ** — 従えばコスト減、従わなければコスト増。reject しない |
| 4 | **入口は改善、出口は保証** — Interactive Schema + OUT フォーマッタの二重構造 |
| 5 | **観測 → 適応** — エージェント能力はシステムが観測し、密度を自動調整する |

---

## Shadow の使い方と作法 (2026-03-31)

### シャドウのライフタイム原則

シャドウは **スキーマID × 接続ID** にバインドされる。それ以上でも以下でもない。

```
shadow → bound to → schemaId (e.g. "hotmemo:v1") + connectionId
```

- **接続IDをライフタイムにする** — MCPコネクション確立でシャドウが生まれ、切断で廃棄される。セッションをまたいだ持ち越しは原則しない
- **スキーマIDが変わればシャドウは死ぬ** — `hotmemo:v1` のシャドウは `hotmemo:v2` には使えない。IDが変わった時点でエラーとする
- **バージョン管理はしない** — シャドウに独立したバージョン管理を持ち込まない。スキーマIDの更新がバージョン管理を兼ねる

### 使い捨ての論理

シャドウは本質的に使い捨て。この性質を利用する:

```
コネクション確立
  → スキーマ解決 (schemaId 確定)
  → シャドウをスキーマIDにアタッチ
  → バリデーション/ルーティング動作
  → コネクション切断 → シャドウ全廃棄
```

再利用したい場合は必ず明示的なガードを通す:

```typescript
// 再利用前に必ずスキーマID一致チェック
if (shadow.schemaId !== currentSchema.id) {
  throw new Error(`shadow bound to ${shadow.schemaId}, current schema is ${currentSchema.id}`);
}
```

### フォールバック設計

バリデーションシャドウが未知フィールド・定義外の表現に出会った時の原則:

- **未知フィールド → pass-through** — 捨てずに通過させる。シャドウが知らないフィールドはシャドウの管轄外
- **定義外の表現 → pass-through** — silent drop ではなく `unknown` として扱う
- **バリデーション失敗 = ストリームの終わりではない** — 1行が失敗しても後続行は処理を続ける

```
バリデーションシャドウの判定:
  known field, valid value   → pass
  known field, invalid value → fail (log + route to AI)
  unknown field              → pass-through (shadow の管轄外)
  定義外の表現               → pass-through (unknown として保持)
```

### スキーマ定義内でのシャドウ宣言

`DcpSchemaDef` の `shadows?` フィールドにアタッチできる:

```json
{
  "$dcp": "schema",
  "id": "hotmemo:v1",
  "fields": ["summary", "tags", "domain", "weight"],
  "shadows": {
    "validation": {
      "schemaId": "hotmemo:v1",
      "fields": {
        "weight": { "minLength": 0 },
        "tags": { "pattern": "^[a-z0-9,]+$" }
      }
    },
    "routing": {
      "schemaId": "hotmemo:v1",
      "minLevel": 1,
      "access": ["ops"]
    }
  }
}
```

シャドウはスキーマ定義内に宣言できるが、着脱可能。`shadows` を丸ごと除いてもボディは影響を受けない。

### まとめ

| 原則 | 内容 |
|---|---|
| バインドキー | `schemaId` — IDが変わればシャドウは無効 |
| ライフタイム | MCPコネクション単位 — 切断で廃棄 |
| バージョン管理 | しない — スキーマIDの更新で吸収 |
| 未知フィールド | pass-through — シャドウの管轄外として通過 |
| 再利用時 | schemaId一致チェックを必ず通す |
| 設計思想 | 使い捨てが正しい。セッション内で完結する |
