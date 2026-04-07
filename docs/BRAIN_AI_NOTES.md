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

## 7. 効果確認済みの変更 (2026-04-07)

| 問題 | 対策 | 結果 |
|------|------|------|
| botId を pipelineId に誤用 | `observer=` / `target_pipeline=` 分離 | `pipeline://dcp-minecraft` を正しく使用 |
| throttle しか選ばない | `severity_guidelines` を systemContext に追加 | `high severity` で `rerouteSchema → pvp-pipeline` を選択 |
| JSON parse 失敗 | Markdown fence strip | 安定して parse 成功 |
| ドメイン知識のハードコード | `brain-prompt.json` に外出し | `ClaudeBrain` がドメイン非依存に |
