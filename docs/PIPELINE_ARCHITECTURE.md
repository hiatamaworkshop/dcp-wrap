# DCP Pipeline Architecture

## Overview

A DCP pipeline moves data from source to consumer through a sequence of
composable components. Each component has a single responsibility. Components
communicate through a shared message bus rather than direct coupling.

```
[Raw Source]
  JSON file / DCP stream / live feed
       ↓
[Preprocessor]     (pre-pipeline — normalization, field audit, type coercion)
       ↓
[Encoder]          (optional — JSON sources only)
       ↓
[Streamer]         transport layer — timestamp, flow emit
       ↓
[Gate]             $V validation — PASS/FAIL → MessagePool
       ↓
[MessagePool]      immediateQueue (FAIL) / batchQueue (PASS)
       ↓
[$R layer]         schemaId → pipelineId(s) routing
       ↓
[downstream pipeline / consumer]

All components → [Monitor] → [$ST collector]
                                    ↓
                               [PostBox]        ← single broker, all pipelines
                                ↑    ↓
                           pipeline  [Brain AI]  ← out-of-pipeline, async
                           (reads        (writes decisions back to PostBox)
                           control)
```

**Design principle: the pipeline accepts clean data only.**

The Preprocessor is not part of the pipeline. It is an upstream stage that
prepares data before it enters the pipeline boundary. The pipeline itself
assumes structurally valid, schema-conformant input.

Responsibilities belong strictly to each stage:

| Stage | Responsibility |
|-------|----------------|
| Preprocessor | Field audit, type coercion, nesting flatten, anomaly decision |
| Pipeline (Encoder→Gate) | Schema encoding, validation, routing, monitoring |

Anything that would require the pipeline to handle unknown fields, mixed types,
or missing values is a preprocessing concern. The pipeline should not
defensively handle what the preprocessor should have resolved.

This separation keeps the pipeline fast, stateless with respect to source
quirks, and independently testable against well-formed data.

---

## Preprocessor — upstream normalization stage

### Position

```
[Raw JSON source]
      ↓
[Preprocessor]     ← record-level, resident, transforms data
      ↓
[InitialGate]      ← batch-level, one-shot, Go/No-Go only
      ↓
[Encoder → Streamer → Gate → ...]
```

Preprocessor and InitialGate are distinct concepts with different
responsibilities, granularities, and lifetimes.

| | Preprocessor | InitialGate |
|---|---|---|
| Purpose | Normalize and decide per record | Gate the batch before streaming begins |
| Granularity | Record-level | Batch-level |
| Lifetime | Resident — runs continuously | One-shot — runs once at stream start |
| Transforms data | Yes | No |
| Output | Clean record, Drop, or Quarantine | Go or No-Go |

### Responsibilities

**1. Structural normalization**
- Flatten nested fields (`user.address.city` → flat field)
- Separate array-of-objects into sub-schemas (`items[].price` → own schema)
- Unify field names (`user_id` / `userId` / `id` → canonical name)

**2. Type normalization**
- String `"123"` → number `123` where schema expects numeric
- Unify null / `""` / absent → `-` (DCP absent marker)
- Normalize datetime formats

**3. Anomaly decision — the Preprocessor's sole judgment call**

```
明らかな破損（必須フィールド欠損、型が完全に違う）
  → Drop + log

スキーマ境界ケース（未知フィールド、微妙な型ずれ、range violation）
  → Quarantine

正常（スキーマに適合）
  → Encoder へ渡す
```

The Preprocessor does not fix ambiguous data. It passes clean records,
drops corrupt records, and quarantines uncertain ones. It does not guess.

### Schema reference

The Preprocessor pulls the schema from SchemaRegistry (same registry the
pipeline uses). This is intentional: the same schema drives both upstream
normalization and downstream validation.

**Schema tentativeness caveat:**

Schemas are not ground truth — they are observations crystallized at a
point in time. In the early phase especially, unknown fields and type
mismatches will arrive. The Preprocessor must not treat schema mismatch
as an error by default; it must treat it as a signal for schema evolution.

```
スキーマ信頼度が低い初期フェーズ:
  未知フィールドが多い → Quarantine に溜まる
  人間が目視・承認
  Generator.from_samples(quarantine_samples) → スキーマ v+1 候補
  承認 → SchemaRegistry 更新
  Preprocessor が v+1 で再処理
```

Quarantine is the feedback loop entry point into schema evolution.
Drop is for records that are unambiguously corrupt regardless of schema version.

### Quarantine format

```jsonl
{"ts":1234567890, "schemaId":"user:v1", "reason":"unknown_field",
 "detail":"field 'extra_note' not in schema (present in 3/50 records)",
 "record": { ...original JSON... }}
{"ts":1234567891, "schemaId":"user:v1", "reason":"range_violation",
 "detail":"field 'importance' value 1.5 exceeds max 1.0",
 "record": { ...original JSON... }}
```

Quarantine entries carry enough context for a human reviewer to decide:
- approve → feed to Generator as additional samples → schema update
- reject → Drop

### Hard drop vs quarantine — the decision boundary

Not every violation is worth Brain AI's attention. The Preprocessor applies
a two-tier triage:

**Hard drop (no PostBox involvement):**
- Record is not a plain object (`null`, bare string, array)
- `$schema` field missing, empty, or not a string
- `schemaId` is not registered and `autoRegister` is off

These cases are structurally corrupt at the ingress boundary. There is no
useful data for Brain AI to inspect. Drop and log.

**Quarantine (PostBox → Brain AI):**
- `unknown_field` — field present in record but absent from schema
- `missing_field` — required field absent from record
- `type_mismatch` — field present but wrong JS type (including float-for-int,
  boolean-for-int, nested object for string)
- `range_violation` — numeric value outside min/max bounds, or NaN/Infinity

These cases are schema boundary events. The record may be valid under a
newer schema version, or Brain AI may be able to correct and re-inject it.
A quarantined record is never silently lost.

**NaN and Infinity are range violations, not type mismatches.**
`typeof NaN === "number"` and `typeof Infinity === "number"` — both pass the
type check. The Preprocessor explicitly tests `!isFinite(value)` before
applying min/max bounds, so they are caught as `range_violation`.

**Multiple violations per record: first wins.**
The Preprocessor stops at the first detected violation and quarantines the
record with that reason. Brain AI receives one clean signal per record.
If Brain AI's correction introduces a second violation, the re-injected
record will be quarantined again with the new reason.

**`array` type fields:**
DCP schemas use `"type": "array"` for fields that carry arrays (e.g. tags).
The Preprocessor checks `Array.isArray(value)` for these — not `typeof value`
(which returns `"object"` for arrays). Without this, every array field would
trigger a spurious `type_mismatch`.

### Quarantine re-inject flow

```
Preprocessor.process(record)
    ↓ violation detected
PostBox.pushQuarantine(pipelineId, { quarantineId, schemaId, reason, detail, record })
    ↓ Brain AI (or stub) reads inbound "quarantine"
PostBox.issueQuarantineApprove(pipelineId, { quarantineId, correctedRecord })
    ↓ PipelineControl receives outbound "quarantine_approve"
    ↓ calls registered onQuarantineApprove handler
Preprocessor.reInject(quarantineId, correctedRecord)
    ↓ re-processes corrected record
passHandler(record, schemaId)   ← if correction passes all checks
```

`correctedRecord` is optional. If Brain AI omits it, the original record
is not re-injected (Preprocessor drops it silently rather than re-quarantining
in a loop). If Brain AI rejects instead, `onQuarantineReject` fires — the
default is silent drop; a handler can be registered for custom logging.

The Preprocessor wires `pipelineControl.onQuarantineApprove()` automatically
in its constructor. Callers do not need to connect these manually.

### InitialGate after Preprocessor

When a Preprocessor is in place, InitialGate acts as the final checkpoint
on Preprocessor output — confirming that what reaches the Encoder is
genuinely schema-conformant. Without a Preprocessor (direct JSON → pipeline),
InitialGate is the primary safety net.

InitialGate does not replace Preprocessor. It does not transform data.
It only asks: "is this batch safe to stream?"

---

## Schema Registry

The source of truth for schemas lives in `schemas/` on disk. At runtime,
only the schemas needed for active processing are loaded into memory.

```
schemas/          persistent storage, all schemas
     ↓ load on demand
SchemaRegistry    in-memory, active schemas only
                  Map<schemaId, { schema, shadows }>
```

Shadows are attached to the schema at load time and compiled once:

- `$V` constraints → compiled to function arrays (no per-row allocation)
- `$R` routes → compiled to condition tables
- future shadows → same pattern

The registry is **immutable during a pipeline run**. No lock contention,
no mid-stream schema changes. If a new schema arrives in the stream
(`$S` header with unknown ID), the registry loads it on first contact.

---

## Components

### Encoder

Converts JSON records to DCP positional rows.

- Reads schema from registry by ID
- Maps source fields to positional array
- Emits `$S` header once per schema, then body rows
- If source is already DCP: encoder is bypassed entirely

### Streamer

**Transport layer.** Streamer moves rows from source to Gate. It has no
knowledge of what the data means — no validation, no routing, no schema
inference.

**What Streamer does:**

- Reads lines from file or stdin, writes to stdout (pass-through)
- Detects `$S` headers to track current `schemaId`
- Attaches `cachedTs` timestamp to each row (updated by interval, not per-row syscall)
- Maintains a **time window** (rolling N-second count per schemaId)
- Emits `flow` messages to Monitor when window closes
- `--pre-check` / InitialGate: samples N rows before streaming begins, fails early if schema violations found

**What Streamer does not do:**

- Row-by-row validation → Gate's responsibility
- Schema inference / field normalization → Preprocessor's responsibility
- JSON reshaping / type coercion → Preprocessor's responsibility
- Routing decisions → `$R` / RoutingLayer

With Preprocessor in place, Streamer receives clean, schema-conformant data
and has no reason to inspect row content. It is a pure transport stage.

```
Streamer state:
  currentSchemaId: string
  window: Map<schemaId, { count: number, windowStart: number }>
  cachedTs: number   — refreshed every tsResolutionMs (default 100ms)
```

Multiple Streamers can connect in sequence. Each operates on the same
registry and the same Monitor instance.

### Gate

Applies shadow evaluation to each row. **Gate does not route.** It pushes
to the MessagePool and moves on. Routing is the $R layer's responsibility.

**Slot model:**

```
fixed slots [0..n]   hot schemas — array index lookup, no map overhead
dynamic slots        remaining active schemas — Map lookup
```

Streamer `flow` messages inform Gate when to promote a schema to a fixed slot.

**Validation modes (`$V`):**

```
filter    PASS → MessagePool (batch)    FAIL → MessagePool (immediate)
flag      PASS → MessagePool (batch)    FAIL → MessagePool (immediate)
isolate   PASS → dropped               FAIL → MessagePool (immediate)
```

Mode affects whether PASS rows enter the pool at all. Downstream routing
is determined entirely by the $R layer after pool delivery.

**Gate processing per row:**

```
1. lookup schemaId → slot (O(1))
2. run compiled $V function array
3. push vResult to MessagePool (priority: immediate on FAIL, batch on PASS)
   ← done. Gate does not decide where the row goes next.
```

**Gate push contract:**

Gate does not buffer. Gate does not manage timers. Gate does not route.
Gate only decides *priority* when handing off to the MessagePool:

```
PASS → pool.push(payload, priority: "batch")
FAIL → pool.push(payload, priority: "immediate")
```

The MessagePool owns all buffering and flush logic. Gate's responsibility
is: judge the row, indicate urgency, move on.

---

### MessagePool + Messenger

The MessagePool decouples Gate (and other emitters) from subscribers.
Gate fires and forgets. Delivery timing is the Pool's concern.

```
Gate ──push(priority)──→ [MessagePool]
Streamer ──────────────→ [MessagePool]
                               ↓
                         Messenger(s)
                         (windowed poll or immediate flush)
                               ↓
              ┌────────────────┼──────────────────┐
         $ST collector      $R layer          Brain AI
         (統計集計)         (routing)          (観測のみ)
```

**Pool internals:**

```
batchQueue:     VResultPayload[]   — flushed on window boundary (e.g. 100ms)
immediateQueue: VResultPayload[]   — flushed on next tick
```

On `priority: "immediate"`, the Pool flushes the immediate queue without
waiting for the window. Batch queue drains on schedule.

**Messenger filtering:**

Each Messenger declares the message types and priority levels it consumes.
Subscribers receive only what they need:

| Messenger / Subscriber | Consumes | Notes |
|------------------------|----------|-------|
| $ST collector | `vResult` (all), `flow` | emits `st_v` (validation stats) and `st_f` (flow stats) |
| $R layer | `vResult` (PASS) | schemaId → pipelineId lookup, downstream write |
| Brain AI | `st_v`, `st_f` | $ST summaries only, read-only observation |
| Slot manager | `flow`, `promote` | Gate fixed-slot management |

Adding a subscriber = adding a Messenger. Gate and Pool are unchanged.

### $R layer

The $R layer is the sole routing authority. It receives rows from the
MessagePool (via Messenger) and dispatches them to downstream destinations
based on a routing table keyed by `schemaId`.

**destId = pipeline instance ID** — not an agent ID, not a process ID.
The $R layer routes to processing units (pipelines), not to the AI inside them.
What runs inside a destination pipeline is that pipeline's internal concern.

```
MessagePool
  → $R layer
      routing table:
        "user:v1"   → "pipeline://ingest-01"
        "event:v1"  → ["pipeline://analytics-01", "pipeline://analytics-02"]   // fanout
        "error:v1"  → "pipeline://dead-letter"
        *           → "pipeline://default"
```

**Fanout**: a single `schemaId` can route to multiple pipeline destinations
simultaneously. The same row is delivered to each destination independently.

Multiple schemas coexist in the same pipeline. The $R layer handles each
`schemaId` independently — no coordination needed at the Gate level.

The routing table is **mutable at runtime**: Brain AI can update it
asynchronously via `PipelineControl.updateRouting()`. The change takes
effect on the next row delivered, with no pipeline interruption.

**Pipeline Registry**: Brain AI resolves pipeline IDs to physical connections
(socket / named pipe / queue endpoint) via a Pipeline Registry. The $R layer
holds pipeline IDs only; the registry owns the ID → connection mapping.

```
Brain AI
  └─ Pipeline Registry 参照 (pipelineId → physical connection)
       └─ routing decision → PipelineControl.updateRouting()
            └─ $R layer applies on next row
```

```ts
interface RoutingLayer {
  ingest(msg: PipelineMessage): void          // called by Messenger
  setTable(table: RoutingTable): void         // called by Brain AI (async)
}

// destId(s) are pipeline instance IDs, not agent IDs
type RoutingTable = Map<string, string | string[]>  // schemaId → pipelineId(s)
```

The $R layer is independent of MessagePool internals. It can be driven by
MessagePool, a direct call, or a future inter-process bus.

### Monitor

The Monitor interface is retained as the public API for emitters.
Internally, `Monitor.emit()` is a thin wrapper over `MessagePool.push()`.

```ts
interface PipelineMessage {
  type: "flow" | "vResult" | "promote" | "schema_loaded"
  schemaId: string
  ts: number
  priority?: "immediate" | "batch"   // new — set by Gate on FAIL
  payload: unknown
}

interface Monitor {
  emit(msg: PipelineMessage): void
  subscribe(type: string, handler: (msg: PipelineMessage) => void): void
}
```

Components only know the `Monitor` interface. The Pool/Messenger layer
is an implementation detail behind it.

---

## Data flow example

```
Source: mock_data.json (JSON)

Encoder
  reads schema "knowledge:v1" from registry
  emits:
    ["$S","knowledge:v1",5,"flags","importance","tags","summary","content"]
    [0,0.92,"cryptography,security,mathematics","RSA public-key cryptography","..."]
    [1,0.45,"physics,misinformation,biology","Schrödinger's Cat ...","..."]
    ...

Streamer
  tracks schemaId = "knowledge:v1"
  window: { "knowledge:v1": 158 rows / last 1s }
  emits to Monitor: { type:"flow", schemaId:"knowledge:v1", rowsPerSec:158 }

Gate (mode: flag)
  slot 0 → "knowledge:v1" (promoted by slot manager)
  row [1, 0.45, ...]:
    flags=1 → passes $V (int:min=0 — structurally valid)
    importance=0.45 → passes $V (number:0-1)
    emits to Monitor: { type:"vResult", pass:true, ... }
  all rows pass → downstream receives full stream

$ST collector (Monitor subscriber)
  accumulates vResult → { pass:158, fail:0, total:158, pass_rate:1.000 }
  accumulates flow   → { rowsPerSec:158 }
  emits at window boundary:
    ["$ST-v","knowledge:v1",158,0,158,1.000,1000]   // st_v: validation stats
    ["$ST-f","knowledge:v1",158,1000]                // st_f: flow stats
```

---

## Pipeline chaining

Streamers chain. Each segment can have its own Gate with different shadows:

```
Encoder → Streamer A → Gate A ($V: structural) → Streamer B → Gate B ($V: semantic, $R: routing) → consumers
                                                      ↑
                                               same Monitor instance
                                               same SchemaRegistry
```

Gate A handles structural validation (type, range, null).
Gate B handles semantic filtering (flags, domain-specific rules) and routing.

---

## パイプライン間接続 — PipelineConnector

`PipelineConnector` は同一プロセス内の2つのパイプラインを接続する。

### 設計意図

パイプラインは**独立した検証単位**として設計されている。あるパイプラインが別のパイプラインの内部状態（SchemaRegistry, Gate, PostBox）を直接参照してしまうと、スキーマ変更や Gate モード変更が意図せず他パイプラインに波及する。

`PipelineConnector` が解決するのは次の問題：

- **独立性を保ちながらデータを渡したい** — 各パイプラインは自分のスキーマルール・Gate モード・PostBox・Brain AI サブスクリプションを持つ。接続はデータの転送のみを意味し、状態の共有を意味しない。
- **検証は各パイプラインが責任を持つ** — PipelineA が approve した record であっても、PipelineB は自分のルールで再評価する。「A が OK と言ったから B もスキップする」という設計は採用しない。これにより PipelineB の品質基準が A に依存しない。
- **ルーティングは Brain AI が制御できる** — `setTable()` でランタイムに宛先を切り替えられる。A → B から A → C への切り替えはデータの流れを変えるが、各パイプラインの内部には一切手を触れない。

### なぜ RoutingLayer を使わないのか

`RoutingLayer` は `MessagePool` 上の `vResult` メッセージを購読し、PASS 行を `RoutedRow` として `RoutingSink` に配送する。しかし `vResult` メッセージの payload は `VResultPayload`（pass/fail 判定結果のみ）であり、**元の行データを含まない**。

```
Gate.process() → monitor.emit({ type: "vResult", payload: VResultPayload })
                                                            ↑
                                                   index, pass, failures のみ
                                                   フィールド名・値は含まない
```

`RoutingLayer` に行データを乗せるには `VResultPayload` の拡張が必要で、既存の `Gate` / `Monitor` / `Streamer` に影響が及ぶ。

`Preprocessor.onPass` は `(record: RawRecord, schemaId: string)` を受け取る境界であり、**行データが完全な形で存在する最初のコールバック**。ここで接続するのが最も自然で、既存コードへの影響もゼロ。

### 役割と位置

```
PipelineA.Preprocessor.onPass(record, schemaId)
    │
    ├─ [既存] PipelineA.Gate.process(...)   ← A 独自のバリデーション・$ST 計測
    │
    └─ connector.forward(record, schemaId)  ← 参照渡し・ゼロコピー
              │
              │  schemaId でルーティング解決
              ▼
    PipelineB.Preprocessor.process(record)  ← B が独立して再バリデーション
              │
              ├─ PipelineB.Gate.process(...)
              └─ PipelineB.StCollector → $ST-v / $ST-f（A とは独立した統計）
```

- **同期・ゼロコピー** — `forward()` は同期呼び出し。record は参照渡しで追加アロケーションなし。
- **同一プロセス限定** — クロスプロセス転送は `ProxyExporter` が担当（将来拡張）。

### ルーティングテーブル

```ts
connector.register("knowledge-entry:v1", pipelineB.pre);  // 特定 schemaId
connector.register("*", pipelineC.pre);                   // ワイルドカードフォールバック
```

解決順序: exact match → `"*"` → drop（`onDrop` コールバック呼び出し）。

`register()` は同じ schemaId で再呼び出しすると上書き。`unregister()` で個別削除可能。

### fanout（1:N 接続）

複数の Preprocessor に同一レコードを転送したい場合は、下流 Preprocessor を束ねた薄い wrapper を `register()` に渡すか、複数の `connector.forward()` を `onPass` 内で直列に並べる。1:N を `ConnectorTable` 側で持たせない理由は、fanout の制御（順序・エラー処理）がユースケースごとに異なるため。

```ts
// 例: A → B かつ A → C に同時転送
pre.onPass((record, schemaId) => {
  // ... gate 処理 ...
  connectorToB.forward(record, schemaId);
  connectorToC.forward(record, schemaId);
});
```

### Brain AI とのランタイム連携

Brain AI は `PostBox.issueRoutingUpdate(pipelineId, table)` を呼ぶ。`PipelineControl` がこれを受けて `applyRoutingUpdate()` を実行するが、現状の `applyRoutingUpdate()` は `RoutingLayer.setTable()` を呼ぶ実装になっている。

`PipelineConnector` と `PipelineControl` を連携させるには、呼び出し側で `applyRoutingUpdate` をオーバーライドまたは拡張し、`connector.setTable()` を呼ぶよう配線する。

```ts
// 配線例（connect.demo では省略、本番実装時に追加する）
ctrl.onRoutingUpdate((table) => {
  // table: Map<schemaId, pipelineId string> → pipelineId を Preprocessor に解決して渡す
  const resolved = new ConnectorTable();
  for (const [schemaId, pipelineId] of table) {
    const target = pipelineRegistry.get(pipelineId);  // pipelineId → Preprocessor
    if (target) resolved.set(schemaId, target);
  }
  connector.setTable(resolved);
});
```

`pipelineId → Preprocessor` の解���は呼び出し側の責任（`PipelineConnector` は Preprocessor インスタンスしか知らない）。

### 実装ファイル

| ファイル | 内容 |
|---------|------|
| `pipeline-connector.ts` | `PipelineConnector` — `ConnectorTable`, `register/unregister`, `forward`, `setTable`, `onDrop` |
| `connect.demo.ts` | 2パイプライン接続デモ。A(flag mode) → connector → B(filter mode)、各 $ST 独立観測 |

### demo 出力例

```
[A $ST-v] schema=knowledge-entry:v1  pass=11  fail=2  total=13  pass_rate=0.846
[B $ST-v] schema=knowledge-entry:v1  pass=11  fail=2  total=13  pass_rate=0.846

=== Pipeline A (flag — passes all to connector) ===
  passed      : 13  quarantined : 16  dropped : 5

=== Pipeline B (filter — re-validates independently) ===
  passed      : 13  quarantined : 2   dropped : 0
```

- **PipelineA**: quarantine を approve して pass に変換し、すべてのレコードを connector に流す（flag モード）
- **PipelineB**: type_mismatch / range_violation を reject（strict ポリシー）、missing_field のみ approve。PipelineA が修正済みのレコードは clean で到着するため quarantine=2 に留まる
- **$ST が一致する理由**: 同じレコードを同じスキーマで評価しているため pass_rate は一致する。将来異なるスキーマや Gate モードを使えば A と B の $ST は乖離し、ZISV の差分比較が有効になる

---

## Brain AI — pipeline control principle

**AI must never enter the data pipeline.**

Inference is slow and non-deterministic. The pipeline is fast and
deterministic. Mixing them would make inference a bottleneck and break
the pipeline's latency guarantees.

### Observation → inference → control chain

```
[Pipeline]
  Streamer → Gate → MessagePool
                         ↓
                    $ST collector
                    ["$ST-v", schemaId, pass, fail, total, pass_rate, windowMs]
                    ["$ST-f", schemaId, rowsPerSec, windowMs]
                         ↓
                   [Lightweight Analyzer]   ← fast, rule-based or small model
                    interprets $ST trends, detects anomalies
                         ↓
                   $I packet (inference result)
                    { schemaId, signal, severity, context: $ST row }
                         ↓
                   [$I pool]   ← async buffer, Brain AI reads at its own pace
                         ↓
                   [Brain AI]   ← slow, evaluates across schemas and time
                         ↓
                   decision (details TBD — see below)
                         ↓
                   [Control Channel]   ← only intervention point
                         ↓
                   PipelineControl interface
```

The Lightweight Analyzer acts as a buffer between the fast pipeline and
the slow Brain AI. $ST collection is never blocked by inference latency.

### Bot (Lightweight Analyzer) — design principles

The Bot is a **worker AI** that monitors pipeline statistics and outputs
inference signals (`$I`). It sits between the fast pipeline and Brain AI.

**Model tier**: phi3:mini or equivalent — smaller and faster than Haiku.
Brain AI is Haiku. The Bot is below Haiku. The split is intentional:
- Bot: high-frequency, low-cost, "what is this pattern?"
- Brain: low-frequency, high-cost, "what should we do about it?"

**FastGate + Weapon pattern** (from phi-agent / Sphere Project):

The key principle: *LLM は1箇所だけ* — LLM is called exactly once per
trigger. Everything before it is deterministic, 0ms computation.

```
$ST (every window)
    ↓
[Weapon group]   ← numeric filters on $ST metrics, 0ms
    ↓ score > threshold only
[L-LLM (phi3:mini)]   ← 1 call: "what does this pattern mean?"
    ↓
[$I packet]   → FIFO ring buffer → Brain AI reads at own pace
```

**Weapon** = a named, configurable $ST filter. Multiple weapons can be
defined. Any single weapon firing triggers the L-LLM call.

```
Weapon examples:
  pass_rate_drop   : pass_rate < 0.8  → weight 1.0
  zero_flow        : rowsPerSec == 0  → weight 1.0
  fail_spike       : fail > 10        → weight 0.8
  combined score   : Σ(metric × weight) > threshold
```

The weapon configuration is the Bot's "character" — a Bot sensitive to
pass_rate is different from one sensitive to flow. Configuration only;
no code change needed to define a new Bot personality.

**What the L-LLM is asked**: one question only.

```
"This $ST pattern was flagged. What does it signal?
 Answer with: signal (string), severity (low|medium|high)"
→ $I { schemaId, signal, severity, context: $ST row }
```

The Bot does not make control decisions. It perceives and labels.
Brain AI evaluates $I packets and decides whether to act.

**LLM uncertainty is localized**: if the Bot hallucinates a severity,
Brain AI still decides whether to act. Bot output does not trigger
pipeline changes directly. Worst case: a spurious $I in the buffer.

**$I ring buffer (FIFO)**: fixed capacity. Oldest entries dropped when
full. Brain AI reads at its own pace — $I production never blocks the
pipeline or the Bot.

### What Brain AI may and may not do

| Operation | Permitted | Reason |
|-----------|-----------|--------|
| Update routing table ($R) | ✓ | async, control channel only |
| Swap agent pool entry | ✓ | async, non-blocking |
| Update agent profile | ✓ | async, non-blocking |
| Stop / throttle pipeline | ✓ | sends control signal, does not block stream |
| Row-level routing decision | ✗ | inference latency would bottleneck the pipeline |
| Data transformation / $O shaping | ✗ | pipeline-internal, must be deterministic |
| Intervene in vResult | ✗ | Gate's responsibility, AI does not touch |

### $R and Brain AI are separate

```
$R (lightweight, deterministic):
  reads routing table → routes rows → fast, in-pipeline

Brain AI (slow, probabilistic):
  evaluates $I packets → writes decisions to PostBox → async, out-of-pipeline
```

$R is not the Brain's executor. It is the Brain's **configuration target**.

Brain AI does not call PipelineControl directly. It writes to the PostBox.
The pipeline reads from the PostBox and applies instructions locally.

### Message paths into Brain AI

Three distinct message types flow from pipelines into the Brain Inbox:

**$V path — validation failures**
```
Gate (FAIL) → MessagePool → Proxy/Exporter → Brain Inbox
  → [AutoProcess] if rule-defined (threshold, dead-letter routing)
  → [BrainDecision] if anomaly is outside rule coverage
```
Processing pipelines minimize inference. AutoProcess handles the common cases.
Brain AI intervenes only when rule-based handling is insufficient.

**$ST path — flow and quality statistics**
```
$ST-v / $ST-f → MessagePool → Proxy/Exporter → Brain Inbox
  + AgentProfile (Brain AI reads from its own in-memory registry)
  → routing update, throttle, or skip (default: static routing table unchanged)
```

**$I path — inference results from pipeline-internal AI**
```
Pipeline AI → $I { inferenceResult, context: $ST } → MessagePool → Proxy/Exporter → Brain Inbox
  + AgentProfile
  → Brain reads, updates routing or does nothing
```
$I is **input to Brain AI**, not Brain AI's output. A pipeline-internal agent
produces $I after completing its inference. Brain AI evaluates it and decides
whether to act. Default: pass through unchanged.

### Brain AI control targets (design — under discussion)

The Brain AI controls the system by writing to the PostBox, not by touching
data or calling pipeline internals directly.

**Routing table (`$R`)**
- schemaId → destination mapping
- Brain updates when it detects degradation, anomaly patterns, or load imbalance
- Change takes effect on the next row, no pipeline interruption

**Agent profiles**
- Brain holds AgentProfileMap in-memory: `botId → AgentProfile`
- Profile updates arrive via PostBox ($AP messages); Brain updates its map on receipt
- Brain can rewrite a Bot's Weapon thresholds via $AP — raising or lowering
  sensitivity without restarting the Bot
- See AgentProfile schema below

**Pipeline throttle / stop**
- Brain writes throttle/stop instruction to PostBox
- Pipeline reads and applies via PipelineControl interface

---

### AgentProfile schema

AgentProfile is the shared object between Bot and Brain.

- **Bot** reads its own profile at startup to load its Weapon set and behavior.
- **Brain** holds all profiles in AgentProfileMap and may rewrite them via $AP
  messages — adjusting a Bot's sensitivity or focus without code changes.

```ts
interface Weapon {
  name: string;                          // e.g. "pass_rate_drop"
  metric: "pass_rate" | "fail" | "rowsPerSec" | string;
  op: "<" | ">" | "<=" | ">=" | "==" | "!=";
  threshold: number;
  weight: number;                        // contribution to score trigger
}

type TriggerMode =
  | { mode: "any" }                      // any single Weapon fires → call L-LLM
  | { mode: "score"; scoreThreshold: number }  // Σ(weight) > threshold → call L-LLM
  | { mode: "all" }                      // all Weapons must fire (AND)

interface AgentProfile {
  id: string;                            // e.g. "bot-quality-watcher"
  botId: string;                         // pipelineId of the Bot instance
  model: string;                         // e.g. "phi3:mini" — L-LLM model hint
  weapons: Weapon[];                     // FastGate filter set
  trigger: TriggerMode;
  llmPromptHint?: string;               // context injected into L-LLM prompt
                                         // e.g. "focus on data quality degradation"
  schemaScope?: string[];               // schemaIds this Bot watches; [] = all
}
```

**Dual role of AgentProfile:**

```
Bot perspective:
  reads own profile at init
  weapons[] → FastGate filter logic
  trigger   → when to call L-LLM
  llmPromptHint → shapes L-LLM question

Brain perspective:
  AgentProfileMap: botId → AgentProfile
  reads to understand each Bot's character and focus
  writes $AP to update weapons[].threshold, trigger.scoreThreshold, schemaScope
  → Bot reloads on next $AP receive
```

**Brain stays neutral** because it reads AgentProfiles rather than encoding
judgment directly. Brain's "decisions" are profile reads + targeted updates.
The judgment criteria live in the profiles, not in Brain's logic.

**Example profiles:**

```jsonc
// Sensitive to data quality
{
  "id": "bot-quality-watcher",
  "botId": "pipeline://bot-01",
  "model": "phi3:mini",
  "weapons": [
    { "name": "pass_rate_drop", "metric": "pass_rate", "op": "<",  "threshold": 0.8, "weight": 1.0 },
    { "name": "fail_spike",     "metric": "fail",      "op": ">",  "threshold": 10,  "weight": 0.8 }
  ],
  "trigger": { "mode": "any" },
  "llmPromptHint": "focus on data quality degradation"
}

// Sensitive to flow interruption
{
  "id": "bot-flow-monitor",
  "botId": "pipeline://bot-02",
  "model": "phi3:mini",
  "weapons": [
    { "name": "zero_flow",    "metric": "rowsPerSec", "op": "==", "threshold": 0,   "weight": 1.0 },
    { "name": "flow_drop",    "metric": "rowsPerSec", "op": "<",  "threshold": 10,  "weight": 0.6 }
  ],
  "trigger": { "mode": "score", "scoreThreshold": 1.0 },
  "llmPromptHint": "focus on flow interruption and throughput loss"
}
```

Multiple Bot instances with different profiles can run against the same
pipeline simultaneously. Each fires independently; Brain reads all $I output.

### Brain AI quarantine path (実装済み)

Brain AI は PostBox inbound "quarantine" チャンネルを購読し `quarantineBuffer` に蓄積する。
`tick()` ごとにドレインして `BrainAdapter.evaluate()` に渡す。

```
Preprocessor.quarantine()
  → PostBox.pushQuarantine(pipelineId, { quarantineId, schemaId, reason, record })
  → Brain.quarantineBuffer に蓄積
  → tick() → BrainAdapter.evaluate({ packets, quarantines })
  → BrainDecision.quarantineApprove / quarantineReject
  → Brain.apply()
  → PostBox.issueQuarantineApprove/Reject
  → PipelineControl.onQuarantineApprove → Preprocessor.reInject(id, correctedRecord)
```

**correctedRecord なし approve**: `Preprocessor.reInject()` はサイレントドロップ（ループ防止）。
再 inject を意図する場合は必ず `correctedRecord` を含めること。

**validation_update**: `PostBox.issueValidationUpdate(pipelineId, schemaId, typeMap)` で
VShadow をランタイム差し替え可能。次の record 処理から新制約が適用される。

### PipelineControl interface (design)

```ts
interface PipelineControl {
  stop(schemaId?: string): void
  throttle(schemaId: string, rps: number): void
  updateRouting(table: RoutingTable): void
  swapAgent(agentId: string, profile: AgentProfile): void
}
```

The pipeline reads instructions from the PostBox and applies them through
this interface. Brain AI writes to the PostBox only — pipeline internals
are invisible to it.

---

## Multi-pipeline topology and PostBox

When multiple pipelines run in parallel (different processes or containers),
direct Brain AI ↔ Pipeline coupling does not scale. A PostBox mediates all
communication in both directions.

```
Pipeline A (process/container)        Pipeline B            Pipeline C
  MessagePool-A                          MessagePool-B         MessagePool-C
    ↓                                      ↓                     ↓
  [Proxy/Exporter]                       [Proxy/Exporter]      [Proxy/Exporter]
    ↓  $ST, $I, $V                         ↓                     ↓
    └──────────────────────────────────────┴─────────────────────┘
                                           ↓
                                      [PostBox]   ← single message broker
                                       $I pool       all pipelines write here
                                       $ST pool       Brain AI reads from here
                                       $AP pool
                                           ↓
                                      [Brain AI]   out-of-pipeline, reads at own pace
                                       in-memory:
                                         PipelineRegistry   pipelineId → connection
                                         AgentProfileMap    pipelineId → profile
                                           ↓
                                       writes decisions back to PostBox
                                           ↓
                                      [PostBox]   ← control direction (reverse)
                                           ↓
    ┌──────────────────────────────────────┬─────────────────────┐
    ↓                                      ↓                     ↓
  PipelineControl-A                  PipelineControl-B     PipelineControl-C
  (applies locally)
```

**Design principles:**

- **Brain AI never connects to a pipeline directly.** It reads and writes to
  the PostBox only. The PostBox address is the only thing Brain AI knows.
- **Each pipeline is autonomous.** If Brain AI is unavailable, pipelines
  continue running with their default routing table.
- **Proxy/Exporter is a Messenger.** It registers on the local MessagePool
  with a filter for exportable message types ($ST, $I, $V). The pipeline
  itself has no knowledge of the export destination.
- **PostBox hides physical topology.** Whether transport is a named pipe,
  socket, or queue is an implementation detail of the PostBox layer.
- **Control is asynchronous.** Brain AI writes a routing update; the target
  pipeline applies it on its next read cycle. There is no blocking RPC.

---

## PostBox Recorder — snapshot and replay

For testing, demos, and Brain AI development, the PostBox can be observed
by a Recorder that logs all inbound and outbound messages.

```
[PostBox]
  inbound  ($ST, $I, $V from pipelines)          ──→ [Recorder] → snapshot.jsonl
  outbound (routing update, throttle, stop from Brain AI) ──→ [Recorder]
```

**Snapshot format:**

```jsonl
{"dir":"in",  "ts":1234567890, "type":"st_v", "payload":["$ST-v","schema:v1",158,0,158,1.0,1000]}
{"dir":"in",  "ts":1234567891, "type":"st_f", "payload":["$ST-f","schema:v1",158,1000]}
{"dir":"out", "ts":1234567892, "type":"routing_update", "payload":{"schema:v1":"pipeline://b"}}
```

**Replay mode:**

The snapshot replaces Brain AI entirely. A replay process reads
`snapshot.jsonl` and feeds outbound messages back to PipelineControl
at the recorded timestamps. No API calls, no latency, fully deterministic.

**Use cases:**

- **Demo**: pre-record Brain AI decisions for multiple corruption scenarios,
  replay without live API dependency
- **Testing**: reproduce edge cases exactly — pass_rate degradation, fanout
  routing switches, throttle triggers
- **Brain AI development**: use recorded $ST/$I as training input, evaluate
  new decision logic against known scenarios

**Corruption scenario candidates for recording:**

```
- pass_rate gradual decline            → Brain reroutes to dead-letter pipeline
- field type mismatch spike            → Brain throttles schema stream
- rowsPerSec drops to zero             → Brain signals pipeline stop
- multiple schemas degrade simultaneously → Brain reorganizes fanout routing
```

The Recorder is implemented as a Messenger on the PostBox with a wildcard
filter (`types: ["*"]`). It adds no overhead to the pipeline itself.

---

## Current implementation status

| Component | Status |
|-----------|--------|
| SchemaRegistry | `registry.ts` — O(1) lookup, loadFile/loadDir, registerFromHeader |
| Encoder | `encoder.ts` — batch, flat schema は問題なし。ネスト大バッチは懸念あり（SCHEMA_GENERATION.md §8） |
| Streamer | `streamer.ts` — transport layer のみ。タイムスタンプ付与・flow emit・InitialGate。row-by-row validation は Gate へ委譲 |
| Gate | `gate.ts` — fixed/dynamic slot, auto-promote at 100 hits, filter/flag/isolate |
| Monitor | `monitor.ts` — NullMonitor / SimpleMonitor / PooledMonitor + MessagePool |
| MessagePool | `monitor.ts` — immediateQueue + batchQueue, windowMs flush, Messenger フィルタ配信 |
| VShadow / vShadowFromSchema | `validator.ts` — スキーマ駆動、int/float 分離、min/max/enum/nullable/pattern/maxLength。compile-once / validate-many。regex・Set は構築時に確定、validate() はヒープアロケーションなし |
| Generator | `generator.ts` — minPresence フィルタ、int/float 精度修正済み |
| InitialGate | `streamer.ts` — 実装済み。`--pre-check` / `--force` / `--pre-check-sample n`（SCHEMA_GENERATION.md §7） |
| Streamer time window + flow emit | `streamer.ts` — 実装済み。1秒ウィンドウで `flow` メッセージを Monitor へ emit |
| $ST collector | `st-collector.ts` — 実装済み。`vResult`+`flow` subscriber、`st_v`(validation統計) / `st_f`(flow統計) を分離emit。統計エンジンは載せ替え前提（下記参照） |
| $R router | `router.ts` — RoutingLayer, RoutingTable, fanout, `setTable()` for Brain AI updates |
| PostBox | `postbox.ts` — inbound ($ST/$V-fail) / outbound (routing_update/throttle/stop) channels |
| ProxyExporter | `proxy-exporter.ts` — MessagePool → PostBox bridge; pipeline has no PostBox knowledge |
| PipelineControl | `pipeline-control.ts` — PostBox outbound → RoutingLayer/throttle/stop apply locally |
| PostBox Recorder | `recorder.ts` — 実装済み。inbound/outbound 全メッセージを JSONL 記録。`replay()` で Brain AI をスナップショット差し替え可能 |
| Bot (Lightweight Analyzer) | `bot.ts` — 実装済み。FastGate+Weapon パターン、$ST フィルタ → RuleBasedLlm (phi3:mini スワップ可) → $I → IPool |
| Brain AI | `brain.ts` — 実装済み。IPool drain → BrainAdapter(evaluate) → PostBox outbound。RuleBasedBrain(default) / ClaudeBrain(Haiku) スワップ可。**quarantine パス実装済み**: PostBox inbound "quarantine" を `quarantineBuffer` に蓄積 → tick() でドレイン → `BrainDecision.quarantineApprove/Reject` → `apply()` が PostBox へ発行。`flush()` でテスト・デモ用即時評価可能 |
| Preprocessor | `preprocessor.ts` — 実装済み。Pass/Drop/Quarantine 判定、PostBox.pushQuarantine() 統合、Brain AI approve → re-inject 自動配線。**実装注意**: range_violation 判定は `reason.includes("< min") or includes("> max")` — validator が `"999 > max(150)"` 形式で出力するため `startsWith("range")` では検出不可。correctedRecord なし approve はサイレントドロップ（再 quarantine ループ防止） |
| PipelineConnector | `pipeline-connector.ts` — 実装済み。同一プロセス内パイプライン間接続。schemaId ルーティング、ワイルドカード、setTable() でランタイム変更可。`ctrl.setConnector(connector, resolverFn)` で Brain AI の routing_update を connector に自動配線可能 |

---

## $ST 統計エンジン（載せ替え前提設計）

現在の StCollector は**固定ウィンドウ + 単純カウント**のみ。

```
$ST-v: pass / fail カウント → pass_rate = pass / total
$ST-f: 最後の flow メッセージの rowsPerSec をそのまま使用
```

Bot の Weapon 評価（`pass_rate < 0.9` 等）にはこれで十分だが、
統計エンジンは将来の要件に応じて**差し替え可能な構造**にする。

### 差し替え候補

| 手法 | 効果 | 適用場面 |
|---|---|---|
| スライディングウィンドウ | 突発スパイクを平滑化、急落を即検出 | 高頻度ストリーム |
| EWMA（指数移動平均） | 古いデータを自然に減衰、トレンド追跡 | 緩やかなドリフト検出 |
| CUSUM / 変化点検出 | 「いつから悪化したか」を特定 | SLA 監視、異常検知 |
| 分位数（p95/p99） | pass_rate の分布・外れ値の重み | 多スキーマ横断比較 |

### ZISV との関係

シャドウパイプライン間の差分比較（TrialCollector）では、
ウィンドウサイズが異なると `pass_rate` の単純比較が成立しない。
**有意差判断には共通の統計手法が前提**になるため、
TrialCollector 実装時に統計エンジンを揃えるのが自然なタイミング。

### 差し替え方針

- StCollector のウィンドウ計算部分（`flush()` 内）を `StEngine` インターフェースとして抽出
- デフォルト実装 = 現在の固定ウィンドウ
- Brain AI 統合後、実データで必要性が見えた時点で差し替える

---

## Future: Zero-Inference Shadow Validation / ZISV (遠い将来案)

### 概念

複数の試験パイプライン（シャドウ）を本番と並走させ、**推論リソースを一切使わずに**
構造差分を統計だけで検証する。Brain が動くのは本番環境での意思決定時のみ。

> **設計原則: 推論は貴重な資源。シャドウは無推論で動く。**

### データフロー

```
本番パイプライン:
  source → Pre → Gate → $ST → Bot(L-LLM) → $I → Brain(Haiku)
                                  ↑ 推論あり              ↑ 推論あり（本番のみ）

シャドウパイプライン（推論なし）:
  source → Pre → Gate_A → $ST_A ─┐
              → Gate_B → $ST_B ─┤→ TrialCollector(diff) → Brain（有意差があれば1回だけ）
              → Gate_C → $ST_C ─┘
                  ↑ Bot なし・Brain なし・$ST 収集のみ
                                              ↓
                                  Brain → AgentProfile 更新 or $R 切り替え
```

### シャドウパイプラインの制約

- **Bot なし** — L-LLM 呼び出しゼロ
- **Brain なし** — Haiku 呼び出しゼロ
- `$ST`（pass_rate / fail / rowsPerSec）だけ収集
- 「どの構造が良いか」は**統計差分だけで判断**
- TrialCollector が差分を計算し、有意な場合のみ Brain に通知

### Brain が動く条件

- シャドウの $ST が本番と有意に異なる場合のみ（差分閾値はAgentProfileで設定）
- 判断は1回 = AgentProfile 更新 or $R 切り替え
- シャドウが本番を上回ると判断したら構造を採用、下回れば破棄

### TrialCollector の設計方針

- 各 TrialPipeline の `$ST-v` を PostBox inbound に push（既存の配線を流用）
- `expected: Set<pipelineId>` — 全員分が揃うまで待機（Promise.all 相当）
- タイムアウト付き — 失敗・遅延パイプラインがあっても揃った分で発火
- Brain は `Map<pipelineId, StVRow>` を受け取り横断比較 → bestCandidate 決定

### 実装前提条件

- `$R` ファンアウトモード（RoutingLayer への複数宛先配信）
- TrialCollector 本体（薄い集約レイヤー）
- Brain AI 基礎実装（単一パイプライン往復が先）

現状は単一パイプラインの Bot → $I → Brain の往復を固める段階。
TrialCollector は `$R` ファンアウトと同時に実装するのが自然。

---

## テスト検証状況 (44 tests / 0 fail)

| テストファイル | カバレッジ | 主要検証点 |
|---|---|---|
| `decoder.test.ts` | DcpDecoder (9) | decode / decodeRows / decodeRaw / validateRow roundtrip |
| `pipeline-connector.test.ts` | PipelineConnector (8) + PipelineControl (2) | fanout / wildcard / setTable / routing_update via PostBox |
| `validation.test.ts` | VShadow (9) + Preprocessor (4) + validation_update (3) | type/range/enum/pattern/maxLength / quarantine分類 / ランタイム制約更新 |
| `pipeline-chain.test.ts` | A→B→C chain (2) + Brain rerouteSchema (2) + quarantine→downstream (3) | パイプラインチェーン完全性・Brain 経由ルーティング切替・quarantine approve/reject 後の下流到達確認 |

### pipeline-chain.test.ts — 検証アーキテクチャ注意点

`wireForward()` ヘルパーが両方の責務を原子的に担う：

```ts
function wireForward(pl: PL, connector: PipelineConnector): void {
  pl.pre.onPass((r, schemaId) => {
    pl.arrived.push(r);          // テスト用到達確認
    connector.forward(r, schemaId); // 下流パイプラインへ転送
  });
}
```

`pre.onPass()` は後から呼ぶと上書きされる。`arrived.push` と `connector.forward` を別々の
`onPass()` で登録すると片方が失われる。必ず同一コールバック内に記述すること。

### 未実装 / 将来対応

| 項目 | 状態 | 備考 |
|---|---|---|
| Bot (phi3:mini 実運用) | 設計済み・stub 実装 | `RuleBasedLlm` でテスト可、実 LLM 接続は将来 |
| TrialCollector / ZISV | 未実装 | `$R` ファンアウト実装後に着手 |
| ProxyExporter (クロスプロセス) | 未実装 | 同一プロセス内 PipelineConnector は実装済み |

---

## 設計課題: Preprocessor の JSON 前提問題

### 現状の制約

現在の Preprocessor は JavaScript オブジェクト（= JSON パース後の状態）を前提として設計されている。

```
src/preprocessor.ts:36  RawRecord = Record<string, unknown>   // JS オブジェクト前提
src/preprocessor.ts:130 isPlainObject()                       // オブジェクト以外は即 Drop
src/preprocessor.ts:138 raw[this.schemaField]                 // キー "$schema" でスキーマID を読む
```

MQTT バイナリ / CBOR / 独自バイナリが来た場合、**L130 の isPlainObject() で即 Drop** される。
JSON を中間フォーマットにすると「一度キー付きオブジェクトを生成 → 位置配列に変換」という無駄が生じ、IoT 高頻度ストリームでは性能劣化の原因になる。

### IoT 入力の現実

```
IoTデバイス
  ├── MQTT broker    → binary payload (Protocol Buffer / MessagePack / 独自)
  ├── CoAP           → CBOR
  ├── HTTP/REST      → JSON
  └── raw TCP        → 独自バイナリ
```

これらを現状の `Preprocessor.process()` に直接 feed することはできない。

### 設計案の比較

**案A: Protocol Adapter 層を Preprocessor 手前に置く（Preprocessor 変更なし）**

```
MQTT binary → MQTTAdapter.decode() → RawRecord → Preprocessor.process()
CBOR        → CBORAdapter.decode() → RawRecord → Preprocessor.process()
JSON        → (そのまま)           → RawRecord → Preprocessor.process()
```

- Preprocessor のコアロジック（Quarantine / Throttle / Stop 制御）は触らない
- 実装コストが低い
- **問題: 依然として JSON オブジェクトを中間フォーマットとして経由する**

**案B: Adapter インターフェース化 + 直接 positional array 出力（理想形）**

```typescript
interface SourceAdapter<T> {
  schemaId(raw: T): string
  decode(raw: T, schema: Schema): unknown[]   // → 直接 positional array
  quarantineReason(raw: T): QuarantineReason | null
}
```

```
MQTT binary → MQTTAdapter → positional array → Gate($V)
CBOR        → CBORAdapter → positional array → Gate($V)
JSON        → JSONAdapter → positional array → Gate($V)
```

- JSON 経由なし
- DCP の本質（「最初から位置で意味を持たせる」）と一致
- **問題: Preprocessor が持つ Quarantine / Throttle / Stop 制御を Adapter と分離する必要がある**
  → フィールド監査・型チェックは Adapter 側、制御フローは共通コアに集約する再設計が必要

### 影響範囲

案B を採用する場合、以下が変更対象になる：

| ファイル | 変更内容 |
|---------|---------|
| `src/preprocessor.ts` | `RawRecord` → `SourceAdapter<T>` ベースに再設計 |
| `src/pipeline-chain.test.ts` | `wireForward()` の入力型変更 |
| `src/validation.test.ts` | Preprocessor 統合テストの入力形式変更 |

### 現時点の方針

**設計課題として記録。実装は着手しない。**

Preprocessor の JSON 前提は現状の用途（JSON/CSV ソース）では問題ない。
IoT / MQTT 対応が必要になった時点で案B の方向で再設計する。
その際は Preprocessor を「Protocol-agnostic な制御コア」と「Protocol Adapter」に分離するアーキテクチャを採用する。
| Pipeline Registry (pipelineId → Preprocessor 解決) | 未実装 | `ctrl.setConnector(connector, resolverFn)` の resolverFn は呼び出し側が担う |
| $ST 統計エンジン差し替え | 未実装 | 現在は固定ウィンドウ + 単純カウント |

---

## 理想アーキテクチャ: IoT ストリーム対応 Ingestor 設計

### 全体像

```
[MQTT Broker]
[CoAP Server]  → Protocol Adapter → [Load Balancer]
[HTTP/REST]                               ↓
[raw TCP]                    ┌─────────────────────────┐
                             │  IngestorX-1            │
                             │  IngestorX-2  ──────────┼→ channel[schemaId]
                             │  IngestorX-3            │
                             └─────────────────────────┘
                                          ↓
                             [Preprocessor Core]
                               ├── フィールド監査
                               ├── Quarantine / Throttle / Stop
                               └── onPass → Pipeline ($V / $R / $ST)
```

### Ingestor の責務

Ingestor がやることは3つだけ。判断はしない。

```
IngestorX.receive(rawBytes, source):
  1. source → schemaId  (スキーマキャッシュ参照)
  2. schemaId → Schema  (インメモリ TTL キャッシュ)
  3. rawBytes → positional array  (スキーマの field 定義に従って直接変換)
  4. channel[schemaId].push(array)
```

**形式はIngestor、品質はPreprocessor。** この境界を越えない。

### スキーマキャッシュ (インメモリ TTL)

```
SchemaCache
  ├── get(schemaId): Schema | null   ← miss → registry fetch → set with TTL
  ├── set(schemaId, schema, ttl)
  └── evict()                        ← TTL切れで自動削除（使われていないスキーマは消える）
```

スキーマ自体が消えるわけではなく、キャッシュが消える。次アクセス時に再フェッチ。
スキーマは**事前登録前提**。未登録 schemaId が来た場合は Drop（Ingestor レベル）。

### プロトコル差の吸収

プロトコル種別は Protocol Adapter が吸収する。IngestorX 本体は共通コードで動く。

```
MQTTAdapter  ─┐
CoAPAdapter  ─┼→ IngestorX（共通）→ channel[schemaId] → Preprocessor
HTTPAdapter  ─┘
```

Adapter の責務は「バイトを受け取り、IngestorX が扱える形で渡す」だけ。

### 並列化の考え方

Ingestor の並列化はプロトコル種別ではなく**スループット対応の水平スケール**。

```
[MQTT Broker] → [Load Balancer] → IngestorX-1 ─┐
                                → IngestorX-2 ─┼→ channel["sensor:v1"]
                                → IngestorX-3 ─┘
```

各 IngestorX は同一コード。スキーマキャッシュはインスタンスごとに独立（TTL で整合性確保）。

**常駐数は 3 が基本:**

| 台数 | 問題 |
|------|------|
| 1 | SPOF |
| 2 | 1台落ちると残り1台が全負荷 |
| 3 | 1台落ちても残り2台で 2/3 負荷。ローリング再起動も無停止 |

Kubernetes の `PodDisruptionBudget minAvailable: 2` と同じ発想。

### $R との関係

Ingestor は `$R`（ルーティング）を知らない。

```
Ingestor → channel["sensor:v1"] → Preprocessor → $R → pipeline-A or pipeline-B
```

Ingestor が行う「schemaId への振り分け」はデータ形式の分類であり、パイプラインへのルーティング判断ではない。`$R` は Preprocessor の下流にある。

### 現時点の方針

**設計記録。実装は IoT 対応フェーズで着手。**

現状の `Preprocessor.process(RawRecord)` は JSON/CSV ソース向けに動作している。
IoT ストリーム対応時は本セクションの設計を起点に Ingestor 層を追加する。