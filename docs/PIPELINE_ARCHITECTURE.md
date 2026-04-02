# DCP Pipeline Architecture

## Overview

A DCP pipeline moves data from source to consumer through a sequence of
composable components. Each component has a single responsibility. Components
communicate through a shared message bus rather than direct coupling.

```
[Source]
  JSON file / DCP stream / live feed
       ↓
[Encoder]          (optional — JSON sources only)
       ↓
[Streamer]
       ↓
[Gate]
       ↓
[downstream Streamer / Gate / consumer ...]

All components → [Monitor] → subscribers ($ST, $R, agents)
```

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

Moves rows from source to Gate. Tracks schema context and flow rate.

- Detects `$S` headers to track current schemaId
- Maintains a **time window** (rolling N-second count per schemaId)
- Emits `flow` messages to Monitor when rate crosses thresholds
- Has no knowledge of validation or routing logic

```
Streamer state:
  currentSchemaId: string
  window: Map<schemaId, RollingCounter>
```

Multiple Streamers can connect in sequence. Each operates on the same
registry and the same Monitor instance.

### Gate

Applies shadow evaluation to each row. Routes output based on results.

**Slot model:**

```
fixed slots [0..n]   hot schemas — array index lookup, no map overhead
dynamic slots        remaining active schemas — Map lookup
```

Streamer `flow` messages inform Gate when to promote a schema to a fixed slot.

**Validation modes (`$V`):**

```
filter    PASS → downstream   FAIL → dropped
flag      PASS → downstream   FAIL → downstream (Monitor notified)
isolate   PASS → dropped      FAIL → downstream
```

Mode is declared in the `$V` shadow attached to the schema.

**Gate processing per row:**

```
1. lookup schemaId → slot (O(1))
2. run compiled $V function array
3. emit vResult to Monitor
4. route by mode + $R conditions
```

Gate knows nothing about what is downstream. It routes to an interface,
not a concrete consumer.

### Monitor

The pipeline observer. Receives messages from all components via a simple
emit interface. Distributes to subscribers.

```ts
interface PipelineMessage {
  type: "flow" | "vResult" | "promote" | "schema_loaded"
  schemaId: string
  ts: number
  payload: unknown
}

interface Monitor {
  emit(msg: PipelineMessage): void
  subscribe(type: string, handler: (msg: PipelineMessage) => void): void
}
```

Components only know the `Monitor` interface. Subscribers are decoupled
from emitters.

**Built-in subscribers:**

| Subscriber | Message types consumed | Purpose |
|------------|----------------------|---------|
| $ST collector | `vResult`, `flow` | Aggregate pass/fail stats per window |
| $R router | `vResult`, `flow` | Adjust routing based on stream state |
| Slot manager | `flow`, `promote` | Promote/demote Gate fixed slots |
| Brain agent | any | Receive FAIL rows, $ST summaries for interpretation |

Subscribers are registered at startup. Adding a new agent means adding a
subscriber — no changes to Streamer or Gate.

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
  accumulates: { pass:158, fail:0, total:158, pass_rate:1.000 }
  emits $ST row at window boundary:
    ["$ST","knowledge:v1",158,0,158,"pass_rate=1.000"]
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

## Current implementation status

| Component | Status |
|-----------|--------|
| SchemaRegistry | not yet |
| Encoder | `encoder.ts` (batch, not streaming) |
| Streamer | `streamer.ts` (single schema, hardcoded) |
| Gate | not yet (inline in streamer) |
| Monitor | not yet |
| VShadow | `validator.ts` (functional, not schema-driven) |
| $V from schema | not yet — next step |
| $ST collector | partial (end-of-stream summary only) |
| $R router | not yet |

**Next step:** `vShadowFromSchema(schema: DcpSchemaDef): VShadow`
— derive $V constraints from schema type definitions automatically.
Schema-driven shadow generation closes the gap between registry and Gate.