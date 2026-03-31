# DCP Schema Generation & Output Controller

設計メモ。実装しながら固める。確定後に dcp-docs へ移植。

## 前提

```
既存データ → DCP Schema 生成 → DCP Encoder → DCP Data

スキーマ生成 = エンコーダ生成。スキーマが決まればエンコーダは自動的に決まる。
```

## 1. Schema Generator — 既存データからスキーマを生成する

### 問題

DCP スキーマには作法がある（フィールド順序、型定義、enum 検出、命名規則 `:v1` など）。現状はスキーマもマッピングも手書きで、作法の遵守は書く人間/AI に依存する:

```python
# 人間が JSON を書く — 作法を知っている前提
schema = DcpSchema.from_file("schemas/my-domain.v1.json")
# 人間がマッピングを書く
mapping = FieldMapping(schema_id="my-domain:v1", paths={"field": "data.field", ...})
```

作法をコードに埋め込んだジェネレータがあれば、誰が使っても DCP 準拠のスキーマが出る。

### 解決

データサンプルからスキーマを推論する:

```
入力: データサンプル（JSON object, DB result, dict, ...）
      + オプション: ドメイン名、フィールド選択、型ヒント

出力: DcpSchema + FieldMapping（ドラフト）
```

### 推論すべきもの

```
1. フィールド抽出
   - トップレベルキー、ネストされたキー（dot-notation で展開）
   - 複数サンプルでの出現率 → 常在フィールド vs 稀なフィールド

2. 型推定
   - 値の観察: string / number / boolean / null / array
   - enum 検出: 値の種類が少なければ enum 候補
   - range 検出: 数値フィールドの min/max

3. フィールド順序（作法）
   - 高頻度フィールドを先頭に（cutdown 時に生き残りやすい）
   - 識別子系 → 分類系 → 数値系 → テキスト系
   - group_key 候補の検出（重複率が高いフィールド）

4. マッピング自動生成
   - スキーマフィールド名とソースのキー名が同一 → 自動バインド
   - ネストされている場合は dot-notation パスを生成
   - 一致しないフィールドだけ人間/AI が補完
```

### API 案

```python
from dcp_rag.core.generator import SchemaGenerator

# データサンプルから推論
gen = SchemaGenerator()
draft = gen.from_samples(
    samples=[chunk1, chunk2, chunk3, ...],
    domain="my-domain",     # → スキーマ ID: "my-domain:v1"
    include=["field1", "field2"],  # 含めるフィールド（省略時: 全フィールド）
    exclude=["internal_id"],       # 除外するフィールド
)

# ドラフト確認
print(draft.schema)    # DcpSchema
print(draft.mapping)   # FieldMapping
print(draft.report)    # 推論レポート（型推定根拠、enum 候補など）

# 確定 → ファイル保存
draft.save("schemas/my-domain.v1.json")

# そのままエンコーダ生成
encoder = draft.to_encoder()
result = encoder.encode(data)
```

---

## 2. Output Controller — LLM に DCP を出力させる

### 問題

LLM は DCP を正確に出力できない（軽量モデルテスト: 正しいフィールド順序 = 0%）。
大型モデルでも不安定。しかし LLM が DCP データを出力すべき場面がある。

### 人間との類推

```
人間:  自由タイピング → フォーム/GUI が構造を強制 → 構造化データ
LLM:   自由テキスト生成 → 出力コントローラが配置 → DCP データ
```

### 「encoder ではなく validator」との関係

```
否定したもの（NL→DCP 常駐 encoder）:
  LLM → "auth の jwt を変更した" → encoder が意味推論 → DCP
  問題: encoder が意味を解釈する。推論エラーの温床。

提案するもの（意味決定と構造化の分離）:
  LLM → {action:"replace", domain:"auth", ...} → controller が配置 → DCP
  LLM が意味を決定。controller は並べるだけ。推論なし。
```

controller は意味を推論しない。LLM が key-value で意味を出し、controller がスキーマに従って positional array に配置する。MCP tool use の JSON Schema 引数強制と同じ発想。

### 設計

```
入力: LLM の出力（key-value object, tool use 引数, 構造化テキスト）
      + スキーマ ID

処理:
  1. スキーマをロード → フィールド順序を取得
  2. 入力の key をスキーマフィールドにマッチ
  3. 順序通りに配置 → positional array
  4. バリデーション（型チェック、enum チェック）

出力: DCP positional array
```

### API 案

```python
from dcp_rag.core.controller import OutputController

ctrl = OutputController(schema="knowledge:v1")

# key-value dict → DCP array
row = ctrl.place({"action": "replace", "domain": "auth", "detail": "jwt migration", "confidence": 0.9})
# → ["replace", "auth", "jwt migration", 0.9]

# 不足フィールドは None
row = ctrl.place({"action": "flag", "domain": "payment"})
# → ["flag", "payment", None, None]  or cutdown

# 余分なキーは無視（安全）
row = ctrl.place({"action": "add", "domain": "auth", "detail": "...", "confidence": 0.8, "extra": "ignored"})
# → ["add", "auth", "...", 0.8]

# バリデーション
result = ctrl.place({"action": "invalid_value", ...})
# → ValidationError: action must be one of [add, replace, flag, remove]
```

### MCP tool use との統合

```
engram_push の native フィールド:
  現状: LLM が直接 positional array を書く → エラーが多い
  改善: LLM が key-value で出す → OutputController が配置 → native に格納

tool schema:
  native: { action: "replace", domain: "auth", ... }  // LLM はこちらを書く
  → controller → ["replace", "auth", ...]              // システムが変換
```

---

## 3. 統合 — Generator + Controller

```
Phase 1: スキーマ生成
  既存データサンプル → SchemaGenerator → DcpSchema + FieldMapping

Phase 2: データ変換（システム側）
  既存データ → DcpEncoder (スキーマ駆動) → DCP Data

Phase 3: LLM 出力（AI 側）
  LLM key-value 出力 → OutputController → DCP Data

全て同一のスキーマから駆動される。スキーマが SSOT。
```

---

## 4. Gateway — スキーマの運用者

### スキーマは辞書、ゲートウェイは司書

スキーマ単体は静的な定義。ゲートウェイがスキーマを運用する:

```
スキーマ = データの定義（静的）
  - フィールド定義、型定義、バリデーションルール
  - JSON ファイルに閉じている

ゲートウェイ = スキーマの運用者（動的）
  - 誰に、どの密度で、いつ渡すか（shadow level 判断）
  - エージェントの準拠率を観測して密度を調整
  - スキーマの展開要求（$S? → full 返却）に応答
  - バリデーション結果をエージェントプロファイルに反映
```

### Gateway の構成

```
Gateway
  ├── SchemaRegistry（全スキーマ定義を保持）
  │     ├── hotmemo:v1
  │     ├── knowledge:v1
  │     └── rag-chunk-meta:v1
  │
  ├── AgentProfile（エージェントごとの観測データ）
  │     ├── errorRate, hintStage
  │     └── → shadow_level を決定
  │
  ├── Encoder（スキーマ駆動、レジストリから取得）
  │     └── → shadow_level を受けて変換するだけ。判断しない。
  │
  └── Validator（LLM 出力の準拠チェック）
        └── → スキーマをレジストリから参照
```

### Shadow Level と Encoder の責務分離

```
密度の判断: Gateway（AgentProfile の errorRate を観測）
密度の実行: Encoder（shadow_level を引数で受け取る）
```

Encoder は「言われた通りに変換する」。shadow level の決定権は外にある。

### $S ヘッダ各要素の必要性

```
$S ヘッダ: ["$S","rag-chunk-meta:v1#hash",5,"source","page","section","score","chunk_index"]

  "$S"                 → システムのパーサ用。LLM には不要。
  "rag-chunk-meta:v1"  → 複数スキーマを同時に扱う時の識別子。
  "#hash"              → セッション内でスキーマ定義を再取得せずに参照する。
  "5"                  → フィールド数。パーサ用。LLM はデータを見ればわかる。
  field names          → LLM がデータを解釈するのに必要。唯一の本質。
```

### Shadow Level 定義 — 能力 × 処理複雑度の2軸

field names が全ての基本線。プロトコル情報は複雑な処理に耐える AI のためのオプション。

```
                    単一スキーマ処理          複数スキーマ同時処理
                    ──────────────        ──────────────────
高性能 AI           field names             $S + ID + hash + fields
                                            (abbreviated で十分)

中性能              field names             field names + schema ID

軽量 LLM            field names のみ         複数スキーマを同時に
                                            扱わせるべきでない
```

### Encoder shadow_level

```
encoder.encode(chunks, shadow_level=0)
  # L0: fields only — フィールド名 + データ行のみ
  # [source, page, section, score, chunk_index]
  # ["docs/auth.md",12,"JWT Config",0.92,3]

encoder.encode(chunks, shadow_level=1)
  # L1: with schema ID — 複数スキーマ識別用
  # ["$S","rag-chunk-meta:v1","source","page","section","score","chunk_index"]
  # ["docs/auth.md",12,"JWT Config",0.92,3]

encoder.encode(chunks, shadow_level=2)
  # L2: full protocol — $S + ID + hash + field count + fields
  # ["$S","rag-chunk-meta:v1#hash",5,"source","page","section","score","chunk_index"]
  # ["docs/auth.md",12,"JWT Config",0.92,3]

encoder.encode(chunks, shadow_level=3)
  # L3: full schema definition（初回/教育用）
  # { id, fields, types, examples... }
  # ["docs/auth.md",12,"JWT Config",0.92,3]

encoder.encode(chunks, shadow_level=4)
  # L4: NL fallback（最終手段）
  # Source: docs/auth.md, Page: 12, Section: JWT Config, Score: 0.92, Chunk: 3
```

### 動線

```
データ入力時:
  データ → Gateway → AgentProfile 参照 → shadow_level 決定
                   → SchemaRegistry からスキーマ取得
                   → Encoder に shadow_level 付きで渡す
                   → DCP 出力 → エージェントへ

エージェント応答時:
  応答 → Gateway → Validator でスキーマ準拠チェック
                 → 結果を AgentProfile に反映
                 → 次回の shadow_level に影響（フィードバックループ）
```

---

## 5. 全体像 — スキーマから全てが駆動される

```
SchemaGenerator
  既存データサンプル → DcpSchema + FieldMapping 生成
        │
        ▼
  SchemaRegistry（Gateway が保持）
        │
        ├──→ Encoder（データ → DCP 変換）
        │      shadow_level は Gateway が決定
        │
        ├──→ OutputController（LLM 出力 → DCP 配置）
        │      LLM が意味を決定、controller が並べるだけ
        │
        ├──→ Validator（LLM 出力のチェック）
        │      結果を AgentProfile にフィードバック
        │
        └──→ AgentProfile（観測データ蓄積）
               → 次回の shadow_level を決定
```

スキーマが SSOT。Generator で作り、Registry で保持し、Encoder / Controller / Validator が参照する。Gateway がこれらを束ねて、エージェントごとに最適な密度で運用する。

---

## 実装優先度

```
1. SchemaGenerator.from_samples()  — 型推定、フィールド順序、自動マッピング
2. OutputController.place()        — key-value → positional array 配置
3. Encoder shadow_level 対応       — L0〜L3 の密度切り替え
4. 自動バインド (FieldMapping)     — 同名フィールドのマッピング不要化
5. MCP 統合例                      — engram_push での利用パターン
```