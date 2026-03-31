# DCP Shadow Index — Multiple Faces of the Same Data

## Core insight

DCP separates data from interpretation. The body (positional array) carries no type, no field name, no schema — it's just ordered values. All meaning lives in the shadow: the `$S` header, schema definitions, and any metadata layered on top.

This separation was a side effect of token compression. But it turns out to be a fundamental design property with applications far beyond LLM cost reduction.

## The body is naked

```
["2026-03-29T10:00","ERROR","gateway","connection refused"]
```

This row knows nothing about itself. It has no type annotations, no field names, no validation rules. It's a tuple of values in fixed positions.

This is the key: **the body is not typed data. It's raw signal. Shadows give it meaning.**

## Multiple shadows, one body

The same body can wear different shadows depending on who reads it and why:

### Validation shadow — stream verification

```
schema:    ["$S","log:v1",4,"ts","level","svc","msg"]
type mask: [string/iso8601, enum(ERROR|WARN|INFO), string, string]
→ bit pattern: 0b_01_10_01_01
```

Fixed field count → delimiter counting. Type mask → bitwise AND per field. One row, one pass, constant time. At 1M rows/sec, you're doing integer comparison, not parsing.

No JSON tree walking. No recursive descent. No state machine for matching braces. The fixed-length positional structure makes stream validation a hardware-friendly operation.

Crucially, the validation shadow itself is user-defined. Nothing dictates what "validation" means:

```
# strict type check
type mask: [iso8601, enum(ERROR|WARN|INFO), string, string]

# length constraint
length mask: [<=24, <=7, <=64, <=500]

# regex pattern
pattern mask: [\d{4}-\d{2}-.+, ^(ERROR|WARN|INFO)$, ^[a-z-]+$, .*]

# numeric range
range mask: [-, -, -, len>=1]

# composite — mix freely
custom mask: [iso8601+len<=24, enum+len<=7, regex+len<=64, len>=1+len<=500]
```

The body doesn't change. The validation shadow is whatever you need it to be — type check, length count, regex, range, or any combination. You define the mask, you define what "valid" means. This is not a type system imposed on data; it's a lens you choose to look through.

### Semantic shadow — LLM interpretation

```
schema: ["$S","log:v1",4,"ts","level","svc","msg"]
```

The `$S` header is the semantic shadow. It tells the LLM: "position 0 is timestamp, position 1 is severity level, ..." — the same information that JSON keys provide, declared once instead of per-record. This is the original DCP use case: token compression.

### Routing shadow — multi-agent placement

```
schema ID: "log:v1"
→ agents holding "log:v1" can read this data
→ agents without it see raw arrays — meaningless
```

Schema compatibility becomes the routing key. No explicit task assignment needed — agents self-select by what they can interpret. The schema ID is a pheromone trail: only those who recognize it follow.

### Statistical shadow — anomaly detection

```
field 1 (level): distribution {ERROR: 2%, WARN: 8%, INFO: 90%}
field 3 (msg):   baseline vocabulary, entropy threshold
→ deviation from baseline triggers alert
```

Overlay statistical profiles on the same positional data. No modification to the body. The shadow carries what "normal" looks like; deviation is anomaly.

## Why this matters

Traditional typed data (JSON Schema, Protocol Buffers, TypeScript interfaces) embeds the interpretation in the data. Remove the type and the data breaks — or at least becomes ambiguous.

DCP inverts this. The body is interpretation-free. Shadows are **additive and disposable**:

- Need validation? Attach a type-mask shadow.
- Need LLM interpretation? Attach a `$S` header.
- Need routing? Use the schema ID.
- Need anomaly detection? Overlay a statistical profile.
- Don't need one anymore? Drop it. The body doesn't notice.

**Data that doesn't carry its own interpretation can be reinterpreted freely.** This is the opposite of self-describing formats (JSON, XML) where the schema is baked in. DCP's "weakness" (no inline metadata) is actually its architectural strength.

## Relation to stream processing

The fixed-length, line-independent structure makes DCP rows ideal for:

- **Pipeline parallelism**: each row is self-contained, no cross-row dependencies
- **Partial failure isolation**: a corrupted row doesn't invalidate neighbors
- **Zero-copy validation**: field count check requires no allocation
- **SIMD-friendly**: uniform record structure enables vectorized processing

These are the same properties that make columnar formats (Parquet, Arrow) fast for analytics. DCP achieves them in a text-based, human-readable format — at the cost of columnar query efficiency, but with the benefit of universality (any tool that reads text can read DCP).

## The compression origin

None of this was designed. The goal was: "send less tokens to the LLM." Stripping keys, using positional encoding, declaring schema once — all token optimization decisions. The result happened to produce a minimal data representation that is simultaneously:

- Compressible (original goal)
- Validatable (fixed-length + type masks)
- Routable (schema ID as capability key)
- Layerable (shadows as independent interpretation planes)

The simplest representation turned out to be the most versatile. Not because simplicity was the goal, but because **removing everything unnecessary leaves only the essential structure — and essential structure is universally useful.**

## Validation shadow is user-defined

The validation shadow is not a fixed set of rules. It's whatever the user decides to check.

```
Shadow A: field count only
  → 4 fields expected, row has 4 → pass

Shadow B: type mask
  → field 0: string, field 1: enum(ERROR|WARN|INFO), field 2: string, field 3: string
  → bitwise AND per field → pass/fail

Shadow C: length constraint
  → field 3 (msg): max 200 chars
  → strlen check → pass/fail

Shadow D: range check
  → field 4 (latency_ms): 0 ≤ n ≤ 30000
  → integer comparison → pass/fail

Shadow E: regex pattern
  → field 0 (ts): matches ISO8601 pattern
  → pattern match → pass/fail
```

These are not layers of the same validation. They are **independent shadows** — attach one, some, or all. The body doesn't know or care which shadows are watching it.

This means validation is:
- **Portable**: shadow definitions travel separately from data. Ship a shadow to a new consumer and they can validate the same stream differently.
- **Composable**: Shadow A + Shadow C = field count check + length constraint. No schema language needed. Just stack what you need.
- **Disposable**: Remove Shadow B from the pipeline. Nothing breaks. The stream continues. Other shadows keep working.

The key difference from traditional type systems:

```
TypeScript:  interface LogRow { ts: string; level: "ERROR"|"WARN"|"INFO"; ... }
             → compiled into the program. Removal = compilation error.

Protobuf:    message LogRow { string ts = 1; ... }
             → schema and data are coupled. Version mismatch = deserialization failure.

DCP shadow:  attach type-mask shadow → validates. detach → stream continues unvalidated.
             → no coupling between data existence and validation existence.
```

**Validation is an observation, not a property of the data.** The body exists whether or not anyone is checking it. This is fundamentally different from typed data where the type is constitutive — remove the type and the data loses meaning.

## Extract first, interpret later

Traditional data pipelines (ETL) require schema before data flows. You define the shape, then extract, then transform, then load. Schema is a precondition.

DCP inverts this. Data flows first. Interpretation follows when needed — or never.

```
Source (JSON API, database, logs, CSV, anything)
  │
  ├─ Extract fields into positional arrays
  │   ["2026-03-29","ERROR","gateway","timeout"]
  │   ["2026-03-29","WARN","auth","retry 3"]
  │
  │  At this point: transferable, storable, streamable.
  │  No schema attached. No meaning declared. Just tuples.
  │
  ├─ Later: attach $S → LLM can interpret
  ├─ Later: attach type mask → validation begins
  ├─ Later: attach statistical profile → anomaly detection begins
  ├─ Later: attach routing shadow → agents self-select
  │
  └─ Each shadow arrives when needed, not before
```

The key property: **data existence and data interpretation are asynchronous.** The positional array is valid — structurally complete, transferable, storable — before anyone declares what it means.

This changes how you think about data pipelines:

```
ETL:  schema → extract → transform → load
      (schema is a precondition — nothing moves without it)

DCP:  extract → flow → attach shadows as needed
      (schema is a postcondition — data moves freely, meaning catches up)
```

Partial extraction is natural. Take 4 fields from a 40-field JSON object. The resulting array doesn't know it came from a larger structure — and doesn't need to. Attach a shadow that describes those 4 fields. If you later need 2 more fields, create a new 6-field array with a new shadow. The old 4-field arrays and their shadows remain valid.

This also means DCP rows from different sources can coexist in the same stream as long as they share a shadow. A log row from PostgreSQL and a log row from nginx, both extracted to `[timestamp, level, source, message]`, are indistinguishable under the same `$S` header. The origin doesn't matter. The positional structure does.

## AI as exception handler, not stream processor

When validation shadows handle the normal case (pass/fail at machine speed), AI's role shifts:

```
Stream: 1M rows/sec
  → validation shadow: 999,990 pass → discard or store silently
  → 10 fail → route to AI for interpretation
  → AI processes 10 rows, not 1,000,000
```

MCP's limitation is that every tool call requires AI mediation. DCP validation shadows bypass this entirely for the normal case. AI becomes the exception handler — invoked only when the mathematical checks surface something the shadow can't resolve.

This is not "AI with guardrails." This is "math first, AI when math isn't enough."

## See also

- [claw-type-output-control.md](claw-type-output-control.md) — DCP decode as shadow reversal (AI outputs DCP → decode → human reads)
- [DCP Specification](https://dcp-docs.pages.dev/dcp/specification) — protocol design
- engram shadow-index-config.ts — shadow index implementation in engram receptor