# Brain AI — LLM Adapter 実装・運用ノート

実際の LLM (Haiku 等) を BrainAdapter として使う際の知見。
`ClaudeBrain` の実装・テスト (2026-04-07) で得た観察をまとめる。

---

## 1. LLM は DCP ネイティブではない

LLM は `$I` / `$S` / `$O` の記法を知らない。
プロンプトに DCP 記号をそのまま渡しても正しく解釈されない。

**対策:** `ClaudeBrain.evaluate()` 内でパケットを自然言語サマリーに変換してから渡す。
DCP の構造知識は LLM ではなくコードが持つ。

---

## 2. botId と pipelineId の混同

`$I` パケットには `botId` フィールドがある。
LLM はこれをそのまま制御アクションの `pipelineId` ターゲットとして使ってしまう。

**観察例:**
```
// 誤: botId をターゲットにしてしまう
{ "throttle": { "pipelineId": "pipeline://bot-minecraft-watcher", ... } }
```

**対策:** パケットサマリーのフォーマットで役割を明示する。
```
- observer=bot-minecraft-watcher | schema=combat:v1 | severity=high | target_pipeline=pipeline://dcp-minecraft
```
- `observer` = 検出した Bot (アクション対象ではない)
- `target_pipeline` = 制御アクションを適用すべきパイプライン

プロンプト冒頭にも明示する:
```
IMPORTANT: 'observer' is the Bot ID that detected the anomaly — it is NOT a pipeline target.
Always use 'target_pipeline' as the pipelineId in your actions.
```

---

## 3. ドメイン知識は設定ファイルに外出しする

LLM が正しく判断するために必要なドメイン知識 (pipelineId 一覧、schemaId の意味、
severity → action のガイドライン) をプロンプトにハードコードしてはならない。

**対策:** `brain-prompt.json` (またはそれに相当する設定ファイル) に記述し、
`ClaudeBrain` は `systemContext` オプションとして受け取るだけにする。

```json
{
  "pipelines": { "pipeline://dcp-minecraft": "Main pipeline", ... },
  "schemas":   { "combat:v1": "Player attack event. High severity = cheat suspect.", ... },
  "severity_guidelines": {
    "high":   "prefer rerouteSchema to audit/pvp pipeline",
    "medium": "prefer throttle"
  }
}
```

これにより `ClaudeBrain` はドメイン非依存のまま保たれる。MappingLayer と同じ疎結合原則。

---

## 4. LLM はデフォルトで保守的なアクションを選ぶ

ガイドラインなしでは `high severity` でも `throttle` を選びがち。
`rerouteSchema` のような「強い」アクションは指示しないと選ばれない。

**観察:**
- `systemContext` なし → `high severity` でも `throttle` を返し続けた
- `severity_guidelines` に `high → rerouteSchema` を明示 → 正しく `rerouteSchema → pvp-pipeline` を選択

**教訓:** ガイドラインは「推奨」ではなく意図的に強めに書く。
例: `"high: prefer rerouteSchema"` より `"high: MUST use rerouteSchema"` の方が効果的。

---

## 5. Markdown フェンス問題

"JSON only" と指示しても LLM が ` ```json\n{...}\n``` ` で返すことがある。

**対策:** レスポンスを必ず strip してから JSON.parse する。
```typescript
const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
```

---

## 6. max_tokens に注意

`rationale` フィールドが長くなると JSON が途中で切れる。
`max_tokens: 256` は最小限。アクションが複数ある場合は 512 以上を推奨。

---

## 8. 聖典 / シャドウ RuleBase + Brain 協調アーキテクチャ (設計案)

### 設計の核心

```
聖典 GameRuleBrain  — 変更不可の基準値 (初期シード)
シャドウ RuleBase   — Brain の判断を吸収して weight が動的に変化
Brain (LLM)         — 未知パターンの判断主体 + シャドウへのスナップショッター
```

Brain はシャドウを「育てる」存在。未知に当たったときだけ起動し、判断をシャドウに蒸留していく。
シャドウが成熟するほど Brain の呼び出し頻度が自然に減少 → コスト・レイテンシが削減される。

### ライフサイクル

```
Phase 1: 聖典固定 + シャドウ展開 + Brain 協調
  聖典  → 基準値、変更不可
  シャドウ → Brain の判断傾向を weight として吸収
  Brain → 判断主体、$ST-brain に記録

Phase 2: シャドウが成熟
  $ST-brain の乖離率が十分低下
  シャドウ単独でパフォーマンスが出ている

Phase 3: バージョニング
  シャドウ v1 → スナップショット保存
  シャドウ v2 → 新シャドウとして継続
  → 聖典の更新は不要、スナップショットの永続化だけでよい
```

聖典は「コールドスタート問題を解く初期値」。昇格判定も不要。ロールバックも自然にできる。

### $ST-brain メトリクス設計

三者 (聖典 / シャドウ / Brain) の差分を定期集計する新チャンネル:

```
[$ST-brain] schema=combat:v1  aligned=12  diverged=3  diverge_rate=0.200
[$ST-brain] llm_action=rerouteSchema  rule_action=throttle  count=3
```

| フィールド | 意味 |
|-----------|------|
| `aligned` | 聖典と Brain が一致した tick 数 |
| `diverged` | 聖典と Brain が乖離した tick 数 |
| `diverge_rate` | `diverged / (aligned + diverged)` |
| `llm_action` | Brain が選んだアクション種別 |
| `rule_action` | 聖典が選んだアクション種別 |

n tick ごとに $ST-brain サマリーを Brain のプロンプトに注入 → セルフキャリブレーション。

### 「正解」問題

現時点では正解ラベルは決定不可能。ただし:
- 乖離の記録と可視化は今すぐできる
- 将来: rerouteSchema 後に fail_rate が下がった → そのアクションが有効だった、という遅延フィードバックで正解に近づける
- 乖離率を下げること自体を目標にしない (Brain の「正しい反論」も記録する)

### 実装スコープ (段階的)

1. `$ST-brain` チャンネルの追加 — 聖典/LLM 差分の記録のみ ✓ (2026-04-07)
2. シャドウ RuleBase の weight 構造設計 (`shadow-rulebase:v1` バージョニング) ✓ (2026-04-07)
3. weight フィードバックループ + スナップショット永続化 (未実装)

### ShadowRuleBrain 実装詳細 (2026-04-07)

**ファイル**: `dcp-minecraft/server/src/shadow-rule-brain.ts`

#### Weight モデル

各 `ActionKind` (rerouteSchema / throttle / stop / ...) ごとに weight: 0.0 → 1.0 を保持。

| イベント | 変化量 |
|---------|--------|
| Brain と聖典が一致 (aligned) | `+0.05 × aligned count` |
| Brain と聖典が乖離 (diverged) | `-0.08 × diverged count` |
| アクションなし tick (idle) | `-0.01` (全アクション) |

初期値は 0.5 (中立)。`AUTONOMOUS_THRESHOLD = 0.70` を超えると自律判断可能フラグが立つ。

#### フィードバックループ

```
BrainCollector (10s flush) → StBrainRow
  → monitor.subscribe("st_brain") → ShadowRuleBrain.absorb(canonAction, llmAction, aligned, diverged)
  → weight 更新
  → [$SHADOW] ログ出力
```

#### ログ例

```
[$ST-brain] SUMMARY schema=combat:v1  aligned=8  diverged=3  diverge_rate=0.273  top_llm=throttle  top_canon=rerouteSchema
[$SHADOW] ver=shadow-rulebase:v1  ticks=42  rerouteSchema=0.63  throttle=0.37
```

#### スナップショット

```typescript
const snap = shadowBrain.snapshot();
// { version: "shadow-rulebase:v1", ts: ..., weights: {...}, tickCount: 42 }

shadowBrain.loadSnapshot(snap);
// バージョンは自動で v2 に昇格
```

#### 次フェーズ: スナップショット永続化

`snapshot()` の結果を `config/shadow-snapshot.json` に定期保存し、
起動時に `loadSnapshot()` で復元することで学習を引き継ぐ。

---

## 7. 効果確認済みの変更 (2026-04-07)

| 問題 | 対策 | 結果 |
|------|------|------|
| botId を pipelineId に誤用 | `observer=` / `target_pipeline=` 分離 | `pipeline://dcp-minecraft` を正しく使用 |
| throttle しか選ばない | `severity_guidelines` を systemContext に追加 | `high severity` で `rerouteSchema → pvp-pipeline` を選択 |
| JSON parse 失敗 | Markdown fence strip | 安定して parse 成功 |
| ドメイン知識のハードコード | `brain-prompt.json` に外出し | `ClaudeBrain` がドメイン非依存に |
