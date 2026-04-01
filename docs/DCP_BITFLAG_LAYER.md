# DCP Bit-Flag Compression Layer

## Overview

DCP positional arrays carry semantic meaning in field positions. Bit flags carry semantic meaning in bit positions. These are the same principle at different scales — both are schema-grounded, position-anchored, and independent of the consumer's ability to infer meaning.

The bit-flag layer is not a replacement for DCP. It is DCP at maximum compression density.

```
DCP positional array  →  bit flag encoding  →  weight-bearing transmission  →  semantic restoration
```

## Compression as alternate representation

A DCP row with N semantic fields can be projected to a bit flag when:

- Field values are discrete or classifiable
- Consumer needs state, not content
- Transmission budget is constrained (lightweight agents, high-frequency streams)

```
DCP (full):
  ["$S","receptor:v1","state","flags","intensity"]
  ["stuck", 0x0024, 0.7]

Bit flag (compressed):
  0x0024  (bit positions schema-defined)
  + weight scalar 0.7

→ same semantic content, ~90% size reduction
```

The schema is the anchor in both cases. Remove the schema, neither form is interpretable.

## Gradient expression via weight

Binary bit flags express on/off. Adding a weight scalar introduces intensity:

| Form | Expression | Cost |
|------|-----------|------|
| bit flag only | binary (present/absent) | 2 bytes |
| bit flag + scalar | intensity (0.0–1.0) | 6 bytes |
| bit flag + $ST weight | time-averaged intensity | 6 bytes + history |

The same 16 bits express progressively richer state depending on what accompanies them.

```
frustration_high = bit1
  → bit1=1                     : frustration present
  → bit1=1, weight=0.3         : frustration mild
  → bit1=1, weight=0.9         : frustration severe
  → bit1=1, weight=$ST.ema_0.9 : frustration sustained (history-weighted)
```

Bit position is fixed. Weight is the gradient dimension.

## Semantic restoration

Restoration accuracy depends on schema quality:

```
schema precision × weight accuracy = restoration fidelity
```

A bit position with a well-defined schema entry restores cleanly. A vague schema entry produces arbitrary restoration regardless of weight precision.

This is the Active Bus lesson applied: the schema is the meaning-anchor. Without it, any numeric value is ungrounded.

```
Restoration pipeline:
  bit flag   → schema lookup → label (e.g. "frustration_high")
  weight     → intensity dimension
  $ST history → temporal context
  → semantic approximation in N-dimensional space
```

Full restoration to a 384-dimensional embedding is not the goal. **Meaning-sufficient approximation** for the consuming agent is. A lightweight agent needs fewer dimensions than a high-capability agent — the same bit flag + weight serves both at different restoration depths.

## $ST integration

`$ST` (stats shadow) accumulates observation data per window. This feeds naturally into weight calculation:

```
$ST records: pass_rate=0.97, anomaly_count=3, dominant="ERROR"
  ↓
weight derivation (outside DCP):
  stream_health_flag = f(pass_rate, anomaly_count)
  weight = EMA(stream_health over N windows)
  ↓
bit flag transmission:
  [stream_health_flags, weight]
  → receiver reconstructs stream quality state without raw $ST data
```

`$ST` provides the raw material. The compression layer distills it to bit flags for downstream consumers who don't need the full statistical record.

## Phi-agent compatibility

Lightweight agents (phi-class) cannot parse full DCP protocol. Bit flags are the natural delivery format:

```
High-capability AI:
  → receives DCP arrays, interprets $S/$V/$P shadows

Phi-agent (role-specialized):
  → receives bit flags + weight
  → role defines which bit positions it monitors
  → probabilistic detection in its designated dimension
  → hard filter for critical thresholds
```

Same stream, different consumption depth. No format branching required — the bit flag layer is a valid DCP-compatible projection.

## Role as perceptual filter

A phi-agent's role determines which bit dimensions it attends to:

```
role:security_monitor  → monitors bit0 (error_state), bit4 (confidence_low)
role:flow_tracker      → monitors bit2 (seeking_active), bit3 (flow_active)
role:fatigue_sensor    → monitors bit5 (fatigue_high)
```

The bit flag stream is identical for all agents. Role creates selective sensitivity — the lightweight agent's narrow interpretability becomes a feature, not a limitation.

## Relationship to DCP layers

| Layer | Carries | Compression |
|-------|---------|------------|
| DCP full | positional arrays + shadow rows | none |
| DCP L0 | field names + data | moderate |
| Bit flag | schema-grounded bit positions | maximum |
| Bit flag + weight | bit positions + intensity scalar | maximum + gradient |

The bit-flag layer fits naturally at L0 and below — it is the logical extension of the density spectrum toward minimum transmission cost.

## Design boundaries

The bit-flag layer does **not**:
- Learn weights internally (weight derivation is the calling system's responsibility)
- Infer schema meaning (schema is external, fixed, shipped with $S shadow)
- Replace DCP for content-bearing communication (use full DCP arrays for content)

It does:
- Compress DCP state to minimum bytes
- Carry gradient via weight scalar
- Enable meaningful consumption by agents that cannot parse full DCP
- Bridge numeric computation (Receptor math) to semantic labels (LLM-readable)

## $ST → low-dimensional instruction vector

`$ST` batch observations drive weight derivation for the bit-flag layer. The derivation pipeline produces a **low-dimensional instruction vector** — a schema-grounded, compact representation of batch character.

```
$ST window:
  pass_rate=0.97, fail_count=3, dominant="ERROR", sample_n=1000
  ↓ component addition per semantic dimension
  stream_health  = f(pass_rate, fail_count)     → 0.94
  anomaly_signal = f(fail_count, dominant)       → 0.12
  volume_signal  = f(sample_n, window_size)      → 0.71
  ↓
bit flags: stream_health_flags (schema-defined bit positions)
vector:    [0.94, 0.12, 0.71, ...]

→ ["$O","log:v1", 0x0081, [0.94, 0.12, 0.71]]
```

This is the "batch character label" — what kind of data this batch is, expressed in minimum bytes. A phi-agent reading this knows the batch's dominant properties without parsing a single body row.

### Derivation rules

Component addition is schema-specific. Each schema defines which `$ST` fields map to which vector dimensions:

```
schema: log:v1
  dimension 0 (stream_health):  $ST.pass_rate weighted 0.7, $ST.fail_count weighted -0.3
  dimension 1 (anomaly_signal): $ST.dominant == "ERROR" → 1.0, "WARN" → 0.5, else → 0.0
  dimension 2 (volume):         $ST.sample_n / window_expected
```

Rules are external to the bit-flag layer — defined in the schema registry, executed by the Tag Shadow computation step. The layer receives the result, not the rules.

---

## Traceability — agent inference audit

The bit-flag layer enables a traceability pattern for multi-agent pipelines. LLM inference is irreversible, but the inputs and outputs around it are recordable in schema-grounded form.

### Trace record

```
[agent_type, input_flags, input_vector, output_flags, timestamp]
```

| Field | Content | Source |
|-------|---------|--------|
| `agent_type` | role identifier (e.g. `phi:security`, `high-cap:v2`) | agent metadata |
| `input_flags` | `$O` bit flags received | $O shadow |
| `input_vector` | `$O` component vector received | $O shadow |
| `output_flags` | agent's output expressed as bit flags | $O encoding of output |
| `timestamp` | emission time | stream |

### Why this works

Same input format in, same output format out — both schema-grounded bit flags. The LLM inference in between is opaque, but the boundary is observable:

```
$O (input)  → [agent_type inference] → $O (output)
  ^recordable                              ^recordable
```

### Output probability estimation

`agent_type` determines the expected output distribution. Known agent types have known sensitivities:

```
phi-agent (role:security):  high sensitivity on bit0, bit4
  → given input_flags with bit0=1, expected output_flags concentrate on security-response bits

phi-agent (role:flow):      high sensitivity on bit2, bit3
  → same input_flags → different expected output distribution
```

Expected distribution × actual output → **deviation score**. Large deviation flags anomalous agent behavior without requiring access to the agent's internal state.

### Audit without reversibility

Full reversibility of LLM inference is not achievable. But:

```
Traceable:   what state the agent received, what it emitted, when, as what role
Not traceable: why — the internal inference path
```

This is the minimum viable audit trail for multi-agent pipelines. Post-hoc analysis of failures becomes possible: narrow the failure to an agent_type × input_flags combination, observe the deviation pattern, adjust routing or schema.

`$ST` aggregates trace records over windows — anomaly rates per agent_type become first-class observations, fed back into the pipeline as stream health signals.

---

## Current status

Conceptual framework. The 16-bit flag system (emotion state encoding) is implemented in the Receptor. Extension to a general DCP compression layer, weight-bearing transmission, $ST → instruction vector derivation, and traceability audit pattern are not yet implemented.

The schema anchor and bit-position semantics are established. Implementation requires: flag encoder per schema, weight derivation conventions, phi-agent consumption patterns, and trace record emission.