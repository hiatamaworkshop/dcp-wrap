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
- Each pipeline has a profile (capabilities, capacity, schema affinity)
- Brain holds AgentProfileMap in-memory: `pipelineId → profile`
- Profile updates arrive via PostBox ($AP messages); Brain updates its map on receipt
- How profiles map to routing decisions is TBD

**Pipeline throttle / stop**
- Brain writes throttle/stop instruction to PostBox
- Pipeline reads and applies via PipelineControl interface

```
[Under discussion]
- What exactly is an AgentProfile?
- How does agent pool membership relate to $R routing destinations?
- $I packet format — needs a schema ($I shadow?)
- $AP (AgentProfile update) message format
```

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
| VShadow / vShadowFromSchema | `validator.ts` — スキーマ駆動、int/float 分離、min/max/enum/nullable |
| Generator | `generator.ts` — minPresence フィルタ、int/float 精度修正済み |
| InitialGate | `streamer.ts` — 実装済み。`--pre-check` / `--force` / `--pre-check-sample n`（SCHEMA_GENERATION.md §7） |
| Streamer time window + flow emit | `streamer.ts` — 実装済み。1秒ウィンドウで `flow` メッセージを Monitor へ emit |
| $ST collector | `st-collector.ts` — 実装済み。`vResult`+`flow` subscriber、`st_v`(validation統計) / `st_f`(flow統計) を分離emit |
| $R router | `router.ts` — RoutingLayer, RoutingTable, fanout, `setTable()` for Brain AI updates |
| PostBox | `postbox.ts` — inbound ($ST/$V-fail) / outbound (routing_update/throttle/stop) channels |
| ProxyExporter | `proxy-exporter.ts` — MessagePool → PostBox bridge; pipeline has no PostBox knowledge |
| PipelineControl | `pipeline-control.ts` — PostBox outbound → RoutingLayer/throttle/stop apply locally |
| PostBox Recorder | 未実装 — Brain AI セッション録画・replay 用。Brain 統合後に実装 |
| Brain AI | 未実装 — $I/$ST 読み取り、PostBox outbound へ決定を書く。Haiku API 予定 |
| Preprocessor | 概念のみ（ネスト展開、型正規化、フィールド監査）— パイプライン外の上流ステージ |