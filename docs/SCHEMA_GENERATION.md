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

### 注意: 自動生成スキーマは必ず人間/AIがレビューすること

自動生成はあくまでドラフト。以下の問題が混入しやすい:

```
- サンプル数が少ない場合: minPresence が機能しない（1件 = 100% presence）
  → スキーマの信頼度はサンプル数に依存する。目安: 最低 50〜100 件以上
  → 少数サンプルで確定させない。継続観測で schema を更新する設計が理想

- スキーマ外フィールドの混入: extra_note のようなレアフィールドが少数サンプルでは
  足切りされずスキーマに混入する。これは Encoder の手前で除外すべき問題
  → Encoder はスキーマ定義フィールドのみを処理し、スキーマ外フィールドを無視する
  → Validator (Gate) はスキーマ外フィールドを検知しない。Encoder が防衛ライン

- 型推定の精度: 混合型（int + string 混在など）はバリデーション制約が失われる
  → 型が混在するフィールドは意図的か確認する

- enum 検出の誤検知: サンプルが偏っていると本来 enum でないフィールドを
  enum と誤判定する
```

**自動生成後のチェックリスト:**
- [ ] フィールド数・名称が想定通りか
- [ ] 型推定が正しいか（特に int/number/string の区別）
- [ ] enum フィールドが妥当か（値の種類が実際に限定されているか）
- [ ] minPresence で足切りされるべきフィールドが残っていないか
- [ ] スキーマ外フィールドをストリーマ手前の Encoder で除外しているか

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

## 2. Output Controller — LLM 出力の配置器

### 位置付け

OutputController は SemanticEncoder の薄いラッパーである。

```
SemanticEncoder:   dict → positional array（データ変換の本体）
OutputController:  LLM key-value 出力 → SemanticEncoder へ渡す
                   + LLM 出力特有のバリデーション（余分なキーの除去、欠損フィールドの `-` 補完）
```

変換の性質は同じ。出力元が「システムデータ」か「LLM 出力」かの違いだけ。

### なぜ分けるか

```
否定したもの（NL→DCP 常駐 encoder）:
  LLM → "auth の jwt を変更した" → encoder が意味推論 → DCP
  問題: encoder が意味を解釈する。推論エラーの温床。

正しい分離:
  LLM → {action:"replace", domain:"auth", ...} → controller → SemanticEncoder → DCP
  LLM が意味を決定。controller は整形だけ。SemanticEncoder が配置。
```

controller は意味を推論しない。MCP tool use の JSON Schema 引数強制と同じ発想。

### 設計

```
入力: LLM の出力（key-value object, tool use 引数）
      + スキーマ ID

処理:
  1. 余分なキーを除去（安全）
  2. 欠損フィールドを `-` で補完
  3. SemanticEncoder に渡す → positional array

出力: DCP positional array（SemanticEncoder と同一形式）
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

### Shadow Level と責務分離

```
密度の判断: Gateway（AgentProfile の errorRate を観測）
$S 行の生成: ShadowEmitter（shadow_level を受けて $S/$V/$P 行を生成）
body 変換:  SemanticEncoder（dict → positional array のみ、shadow に関与しない）
```

SemanticEncoder は body row の変換だけを担う。shadow_level は Gateway が決定し、ShadowEmitter が実行する。Encoder に shadow の責務を混ぜない。

**現状の実装について:** `$S` 生成は現在 SemanticEncoder 内に同居している。`$V`/`$P`/`$ST`/`$O` が未実装のため ShadowEmitter を切り出す動機が薄い。複数シャドウの協調が必要になった時点で分離する。

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

### ShadowEmitter shadow_level

shadow_level は ShadowEmitter が処理する。SemanticEncoder は body row のみを出力し、shadow 行を知らない。

```
# SemanticEncoder: body row のみ
encoder.encode(chunk)
  # → ["docs/auth.md",12,"JWT Config",0.92,3]

# ShadowEmitter: shadow 行を生成（Gateway が level を渡す）
emitter.emit(schema_id="rag-chunk-meta:v1", level=0)
  # L0: フィールド名のみ（shadow 行なし、field names をヘッダとして別途渡す）
  # [source, page, section, score, chunk_index]

emitter.emit(schema_id="rag-chunk-meta:v1", level=1)
  # L1: $S + schema ID
  # ["$S","rag-chunk-meta:v1","source","page","section","score","chunk_index"]

emitter.emit(schema_id="rag-chunk-meta:v1", level=2)
  # L2: $S + ID + hash + field count
  # ["$S","rag-chunk-meta:v1#hash",5,"source","page","section","score","chunk_index"]

emitter.emit(schema_id="rag-chunk-meta:v1", level=3)
  # L3: full schema definition（初回/教育用）
  # { id, fields, types, examples... }

# Gateway が両者を組み合わせて出力
gateway.deliver(chunks, agent_id="agent-a")
  # → shadow 行 (ShadowEmitter) + body 行 (SemanticEncoder) を結合して送信
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
        ├──→ SemanticEncoder（データ → positional array）
        │      body row のみ。shadow に関与しない。
        │
        ├──→ ShadowEmitter（shadow_level → $S/$V/$P 行を生成）
        │      shadow_level は Gateway が決定して渡す。
        │
        ├──→ OutputController（LLM 出力 → SemanticEncoder へ）
        │      整形・補完のみ。変換本体は SemanticEncoder。
        │
        ├──→ Validator（LLM 出力のチェック）
        │      結果を AgentProfile にフィードバック
        │
        └──→ AgentProfile（観測データ蓄積）
               → 次回の shadow_level を決定

  Gateway.deliver():
    AgentProfile 参照 → shadow_level 決定
    ShadowEmitter で shadow 行生成
    SemanticEncoder で body 行生成
    結合して送信
```

スキーマが SSOT。SemanticEncoder は body 変換のみ、ShadowEmitter は shadow 生成のみ — 責務が分離されている。Gateway がこれらを束ねて、エージェントごとに最適な密度で運用する。

---

## 実装優先度

```
1. SchemaGenerator.from_samples()  — 型推定、フィールド順序、自動マッピング
2. OutputController.place()        — key-value → positional array 配置
3. Encoder shadow_level 対応       — L0〜L3 の密度切り替え
4. 自動バインド (FieldMapping)     — 同名フィールドのマッピング不要化
5. MCP 統合例                      — engram_push での利用パターン
```

---

## 6. Schema `origin` フィールド — データストリームの出自

### 動機

スキーマ ID (`knowledge:v1`) はバージョン管理と参照を担う。しかしスキーマが**どのデータストリームのためのものか**という情報は ID に含まれない。API レスポンス、センサーストリーム、エージェント間プロトコルなど、対象がスキーマ外から見えない問題がある。

### 非対称問題との関連

API call では入力と出力の構造が一致しない。同一スキーマで `decoder <<schema>> encoder` とすることができない。`origin.direction` フィールドがこれを明示する:

```
入力スキーマ:  direction: "input"  → encode のみ（LLM → wire）
出力スキーマ:  direction: "output" → decode のみ（wire → DCP）
内部スキーマ:  direction: "bidirectional" または省略
```

### フィールド定義

```json
{
  "$dcp": "schema",
  "id": "tavily-response:v1",
  "origin": {
    "source": "tavily/search",
    "direction": "output"
  },
  "fields": ["title", "url", "score", "content"],
  "fieldCount": 4,
  "types": { ... }
}
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `source` | string | 任意 | データストリームの識別子。`api/method`、`sensor/gyro`、`agent/receptor` など自由形式 |
| `direction` | string | 任意 | `"input"` / `"output"` / `"bidirectional"`。省略時は `"bidirectional"` 扱い |

### 設計原則

- `origin` フィールド全体がオプショナル。内部スキーマ（`knowledge:v1` など）は省略で自然
- `source` は API に限らない。あらゆるデータストリームを対象とするためにユニバーサルな自由文字列
- スキーマ ID は変えない。`origin` は補足メタデータであり識別子ではない
- `direction` が実装上最も重要な追加価値 — スキーマレベルで入出力の使用可否を表現できる

---

## 7. Streamer Initial Gate — ストリーム開始前の入口検査

### 動機

基礎スキーマには対応する $V Shadow が存在する。$V Shadow を通過しないデータは排他フィルタされる — これが DCP パイプラインの原理。

しかし現状の構成では:

```
raw JSON → [Encoder] → DCP stream → [Gate] → downstream
```

Encoder はスキーマ定義フィールドのみを処理するが、**スキーマ生成フェーズで混入した
スキーマ外フィールドや型違いは Gate まで到達してしまう**。Gate は downstream での
継続バリデーターであり、「このデータはそもそもこのスキーマで流せるか」の入口判断を
担う設計になっていない。

### 設計

Streamer が InitialGate を内蔵する。ストリーム開始前に $V Shadow を raw データに適用し、
問題を列挙してユーザーに確認を求める。OKが出てからストリームを開始する。

```
raw JSON
   │
   ▼
[InitialGate]  ← スキーマの $V Shadow を適用
   │
   ├── スキーマ外フィールドの検知（スキーマに定義されていないキー）
   ├── 必須フィールドの欠落検知
   ├── 型違いの検知（flags: "HIGH" など）
   ├── 範囲外の検知（importance: 1.5 など）
   │
   ├── 問題あり → 警告を列挙して stderr へ出力
   │              ユーザー確認（--force で skip 可能）
   │              確認 OK → ストリーム開始
   │
   └── 問題なし → そのままストリーム開始
         │
         ▼
      [Encoder] → DCP stream → [Gate] → downstream
```

### InitialGate と Gate の役割分担

```
InitialGate（Streamer 内蔵）:
  - raw JSON レベルで動作（encode 前）
  - スキーマ外フィールドの存在を検知できる（raw key を見る）
  - ストリーム開始の可否を判断
  - 一度だけ実行（バッチ全件をスキャン、または先頭 n 件をサンプル）
  - 結果を stderr に警告として出力

Gate（downstream）:
  - DCP row レベルで動作（encode 後）
  - 継続的にリアルタイムバリデーション
  - monitor へ vResult を emit
  - filter / flag / isolate モードで動作
```

概念の一貫性: **スキーマの $V Shadow はデータの入口から出口まで貫通している**。
InitialGate が入口、Gate が継続監視。同一の $V Shadow を共有する。

### スキーマ外フィールドの扱い

InitialGate が検知するもの:

```
1. unknown fields  — スキーマに定義されていないキーがデータに存在する
   例: extra_note がスキーマに無いのにデータに含まれている
   → 警告: "unknown field 'extra_note' in 2/15 records (13.3%) — not in schema"

2. missing fields  — スキーマに定義されているキーがデータに存在しない
   例: importance が一部レコードで欠落
   → 警告: "field 'importance' absent in 1/15 records (6.7%)"

3. type mismatch   — 型が合わない
   例: flags が文字列
   → 警告: "field 'flags' type mismatch in 1/15 records: expected int, got string"

4. range violation — 範囲外
   例: importance: 1.5
   → 警告: "field 'importance' out of range in 2/15 records"
```

### CLI オプション

```
--pre-check          InitialGate を実行してレポートのみ出力（ストリームしない）
--force              警告があってもストリーム開始（確認プロンプトを skip）
--pre-check-sample n 先頭 n 件だけを InitialGate でスキャン（大量データ対応）
```

### 実装状態

`streamer.ts` に実装済み。

- `runInitialGate()` — unknown_field / missing_field / type_mismatch / range_violation を検知
- `--pre-check` — レポートのみ出力してストリームしない
- `--force` — 警告があってもプロンプトなしでストリーム開始
- `--pre-check-sample n` — 先頭 n 件のみスキャン（大量データ対応）
- 問題なし → そのままストリーム開始
- 問題あり + `--force` なし → stderr に警告列挙 → ユーザー確認プロンプト [y/N]

---

## 8. Encoder バッチ処理の懸念

`DcpEncoder.encode()` はバッチ単位で受け取る設計だが、以下の懸念がある:

```
1. ネスト encode でのオブジェクト再生成（encoder.ts: encodeFieldValue）
   - ネストフィールドを持つレコードごとに new DcpSchema / new FieldMapping /
     new DcpEncoder を生成している
   - バッチ内の全レコードで毎回 new → 大バッチ × ネスト多数で顕在化
   - 改善: サブエンコーダをバッチ単位でキャッシュする

2. resolvedBatch の二重走査
   - resolve（mapping.resolve）と row 構築で2パス走査
   - 大バッチでは配列を2回走査する

3. ネスト encode での JSON 往復（encoder.ts:152）
   - サブエンコーダが返す rows は文字列化済み
   - それを JSON.parse() で再度オブジェクトに戻している
   - 文字列 → オブジェクト → 文字列の無駄な往復

flat なスキーマ（mock_data のような nestSchemas なし）では影響なし。
ネストが深い場合や大バッチで速度問題が出たときに対処する。
```