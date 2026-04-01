# DCP Shadow System

## What is a shadow

A DCP body is a positional array — raw signal with no embedded meaning.

```
["2026-03-29","ERROR","gateway","timeout"]
```

A **shadow** is a metadata row layered on top of the body. It declares how to read the data, how to validate it, or who receives it. Shadows are independent of the body and of each other. Remove any shadow — the body continues to exist, unchanged and unaware.

This is the core property: **shadows are observations, not properties of the data.**

Removing a TypeScript interface causes a compilation error. Removing a Protobuf schema causes deserialization failure. Removing a DCP shadow causes nothing — the stream continues, just uninterpreted.

## The $ prefix

All shadow rows begin with `$`. This is the DCP protocol marker — it signals that the row is not data, but a declaration about data.

```
$S  →  DCP + semantic    (field names)
$V  →  DCP + validation  (positional constraints)
$P  →  DCP + permission  (access and visibility)
```

The `$` prefix unifies the shadow family. `S`, `V`, `P` are shadow types — each is an independent layer, attachable and removable without affecting the others.

**Workers receive only the body.** `$` rows are stripped before delivery to lightweight agents. High-capability AI and system components are the only consumers of shadow rows.

```
High-capability AI / system:
  ["$S","log:v1","ts","level","svc","msg"]
  ["$V","log:v1",iso8601,enum(ERROR|WARN|INFO),string,string]
  ["$P","log:v1",access:["ops"],fields:[0,1,2,3]]
  ["2026-03-29","ERROR","gateway","timeout"]

Worker AI:
  ["2026-03-29","ERROR","gateway","timeout"]
```

The body is identical. The shadow layer is the access boundary.

## $S — Semantic Shadow

`$S` declares what each position means. It is the original DCP use case — token compression by eliminating per-record key repetition.

```
["$S","log:v1","ts","level","svc","msg"]
["2026-03-29","ERROR","gateway","timeout"]
["2026-03-29","WARN","auth","retry 3"]
```

The schema ID (`log:v1`) is an attribute of the semantic shadow, not a separate declaration. Once a capable agent has seen a schema, `$S` + ID alone is sufficient — the agent retains the field mapping across multiple schemas simultaneously.

```
Abbreviated (after first contact):
  ["$S","log:v1"]
  ["2026-03-29","ERROR","gateway","timeout"]
```

### Density spectrum

How much semantic information accompanies data depends on the consumer:

| Level | Form | When |
|-------|------|------|
| L0 | field names only, no `$S` | lightweight models (≤4B), no protocol parsing |
| L1 | `$S` + schema ID | capable agents after first contact |
| L2 | `$S` + schema ID + field names | first contact or reminder |
| L3 | full schema definition | new consumer, education |

L0 exists because `$` parsing has been observed to confuse lightweight models. Workers operate at L0 by design — field names alone, when needed at all.

## $V — Validation Shadow

`$V` declares what "correct" means for each position. It is not a type system imposed on the data — it is a lens you choose to apply.

```
["$V","log:v1",iso8601,enum(ERROR|WARN|INFO),string,string:200]
```

Each position maps to a constraint. Constraints are independent — define one, some, or all:

```
field count only:    ["$V","log:v1",*,*,*,*]          → 4 fields expected
type mask:           ["$V","log:v1",iso8601,enum(...),string,string]
length constraint:   ["$V","log:v1",*,*,*,string:200]
range check:         ["$V","event:v1",*,int:0-30000]
regex pattern:       ["$V","log:v1",/ISO8601/,*,*,*]
```

### Null representation

DCP rows are positional arrays. Omitting a field shifts all subsequent positions — never acceptable. `null` fills the slot but carries JSON-era semantics and costs extra tokens unnecessarily.

**Convention: use `-` for absent values.**

```
["2026-03-29","ERROR","gateway", -]
```

`-` is a single token, unambiguous in log and CSV tradition, and readable by LLMs without inference. When a field may be absent, declare it in `$V`:

```
["$V","log:v1", iso8601, enum(ERROR|WARN|INFO), string, string:nullable:-]
```

Without a `$V` declaration, `-` is still valid as a positional placeholder — the consumer treats it as absent. With `$V`, the intent is explicit and machine-checkable.

Because DCP rows are fixed-length and line-independent:

- Field count check requires no parsing — delimiter counting
- Type masks compile to bit patterns — hardware-friendly comparison
- Each row validates independently — a corrupted row doesn't invalidate neighbors
- Validation cost is constant per row — 1M rows/sec is integer comparison, not tree walking

`$V` is **portable** (ship the definition to a new consumer), **composable** (stack constraints as needed), and **disposable** (remove it, the stream continues unvalidated).

When validation shadows handle the normal case at machine speed, AI handles exceptions:

```
Stream: 1M rows/sec
  → $V shadow: 999,990 pass → store silently
  → 10 fail → route to AI for interpretation
```

Math first. AI when math isn't enough.

## $P — Permission Shadow

`$P` declares who sees what — both field visibility and access to `$` rows themselves.

```
["$P","log:v1",access:["ops","sre"],fields:[0,1,2,3]]
```

Two concerns:

**Field-level projection** — same body, different visibility per consumer:

```
Brain AI:   sees all 8 fields
Worker AI:  sees fields [0,2] only
```

**Protocol access** — `$S` and `$V` rows are visible only to consumers with sufficient capability. `$P` declares the boundary. Workers receive a body stripped of all `$` rows — not because the system filtered them, but because `$P` declared it.

`$P` is declarative: conditions stated in the shadow, not coded in the system. Change the shadow, change the access. Remove the shadow, data flows unrestricted.

## Shadow principles

| Principle | Statement |
|-----------|-----------|
| Separation | Body carries no interpretation. Shadows carry no data. |
| Independence | Each shadow is attached and removed without affecting others. |
| Disposability | Removing a shadow causes nothing. The stream continues. |
| Composability | Attach one, some, or all. Stack as needed. |
| Access boundary | `$` rows are for high-capability AI and system only. Workers receive the body. |
| Observation | Validation is an observation, not a property of the data. |

## Shadow layering

Shadows are composable — multiple shadows of the same type can stack, and the order they are applied carries meaning.

### Stacking $V

Multiple `$V` rows on the same schema split validation concerns into independent layers:

```
["$V","log:v1", /ISO8601/, *, *, *]              ← syntax check
["$V","log:v1", *, enum(ERROR|WARN|INFO), *, *]  ← semantic check
["$V","log:v1", *, *, string:64, string:200]     ← length check
```

Each layer is independently attachable and removable. Production runs syntax only; debug mode stacks all three. The stream doesn't change — the observation depth does.

### Order dependency: $P then $V vs $V then $P

```
$P → $V:  fields [2,3] hidden before validation runs
          → type checks never fire on fields the consumer cannot see

$V → $P:  all fields validated, then [2,3] hidden for delivery
          → validation passes on full data, projection happens at the boundary
```

Same shadows, different order, different meaning. The pipeline topology is itself a declaration.

### Multi-layer $P

```
["$P","log:v1", role:ops,    fields:[0,1,2,3]]
["$P","log:v1", role:audit,  fields:[0,1]]
["$P","log:v1", role:worker, fields:[]]
```

Same body, three visibility contracts. The routing layer selects which `$P` to apply by role. No branching in the data — branching in the shadow.

### AI-verifiable patterns

Layer combinations produce conditions that are difficult for humans to track but tractable for AI:

- **Constraint conflict**: two `$V` rows declare incompatible constraints for the same position — which takes precedence?
- **Validation-visibility mismatch**: a `$V` check runs on a field that `$P` hides from the consumer — is this intentional gate or logic error?
- **Permission leakage**: role A sees `[0,1,2]`, role B sees `[0,1,3]` — is field `[3]` intentionally exposed to B, or an oversight?

These are structural properties of the shadow configuration. An AI reads the shadow stack and flags them. A human auditing the same configuration would likely miss them.

---

## $ST — Stats Shadow

`$ST` is a shadow for observation of other shadows. Where `$V` checks individual rows, `$ST` records the aggregate — pass rates, field distributions, running counts — as a first-class shadow layer.

```
$ST  →  DCP + statistics  (aggregated observation)
```

### Form

`$ST` is positional like all shadows. Fields are defined per schema:

```
["$ST","log:v1", pass_count, fail_count, sample_n, dominant_value]
["$ST","log:v1", 9990, 10, 1000, "ERROR"]
```

Row-level: a `$ST` row is emitted per batch or per window, not per data row. It is a summary over a range of body rows — ephemeral by nature.

Field-level: each position in `$ST` maps to a metric about the corresponding position in the body. Pass rate for field 0, enum distribution for field 1, length average for field 3.

### The in-memory anchor

The practical value of `$ST` is not persistence — it is form. Before `$ST` existed as a concept, in-memory accumulation was ad hoc: pick a dict, pick a counter, pick whatever. The form was invented at the point of need, without a basis in the rest of the system.

`$ST` resolves this. When in-memory aggregation is needed:

```
Use $ST form. Positional array. Schema-scoped.
Accumulate as rows. Aggregate per field. Discard when no longer needed.
```

The data is still in memory. But the format has a reason — it comes from the shadow system, not from the moment.

### In the pipeline

```
body rows → [$V shadow: validate] → [$ST shadow: count pass/fail, measure distribution]
                                         │
                                    in-memory accumulation
                                    discard after window
                                    or route to $P-controlled output
```

`$ST` sits after `$V` in the natural order: validate first, then observe what passed. Combined with `$P`, the stats output itself can be visibility-controlled — aggregate metrics visible to ops, hidden from workers.

---

## Numeric-to-semantic bridge — 16-bit flag system

Shadows operate in the semantic domain. But upstream systems — behavior monitors, sensors, classifiers — operate in the numeric domain. A bridge is needed.

The **16-bit flag system** is that bridge. Fixed-width, schema-grounded, no ambiguity:

```
bit0  = error_state
bit1  = frustration_high
bit2  = seeking_active
bit3  = flow_active
bit4  = confidence_low
bit5  = fatigue_high
...
```

Each bit position carries a meaning defined by the schema — not inferred by the consumer. The consumer reads the flag, not the value.

### Why this matters for DCP

LLMs cannot reliably generate numeric encodings from scratch. If you ask a model to output a 16-bit state representation, it will produce plausible-looking values with no semantic grounding.

The correct division of responsibility:

```
System (numeric domain):
  Receptor computes emotion vector → [0.7, 0.2, 0.1, 0.4, 0.0]
  Flag encoder maps to 16-bit     → 0x0024

DCP (transmission):
  ["$S","receptor:v1","state","flags","intensity"]
  ["stuck", 0x0024, 0.7]

LLM (semantic domain):
  receives DCP row → interprets "stuck", reads flag schema → acts
```

The LLM receives, not generates. The numeric-to-semantic conversion happens at the system boundary, not inside the model.

### Reuse principle

Any time a numeric computation needs to cross into a semantic layer, the 16-bit flag pattern applies:

- Receptor emotion vector → agent state flags
- Validation pass/fail rates → stream health flags  
- Permission role bitmask → $P access control

The flag schema is the anchor. Bit positions are fixed. The schema ships with the $S shadow — consumers know what each bit means without inference.

This is Active Bus reconceived: the system speaks to the LLM in structured flags, not the LLM generating native encodings spontaneously. The direction inverts — system as speaker, LLM as receiver.

---

## $O — Output Shadow

`$O` is the format adaptation layer. Where `$P` controls access (who may see data), `$O` controls form (who can consume it). These are separate concerns.

```
$O  →  DCP + output  (format conversion for capability-limited consumers)
```

The distinction:

```
$P: access control  — permission boundary (who is allowed)
$O: format conversion — capability boundary (who can parse)
```

An agent may have full access rights (`$P` grants it) but lack the ability to parse DCP protocol (`$O` serves it). These are orthogonal properties of the consumer.

### Form

`$O` derives from `$ST` observations and converts to bit flag + component vector:

```
["$O","receptor:v1", 0x0024, [0.7, 0.2, 0.0, 0.4]]
                      ^flags  ^component vector
```

- **bit flags**: schema-grounded discrete labels — what kind of state (presence/absence)
- **component vector**: intensity per dimension — how strong each component is

The two are complementary. Bit flags identify; the vector grades.

### Derivation pipeline

```
$ST (batch window observations)
  → Tag Shadow computation: component addition per semantic dimension
  → $O emission: bit flags + intensity vector

Consumer (phi-agent or DCP-limited agent):
  → reads bit flags → identifies active dimensions (role-filtered)
  → reads vector → reads intensity of relevant components
  → no DCP protocol parsing required
```

### Reversibility

`$O` inherits the reversibility property of the bit-flag layer:

```
DCP full:         reversible (positional array ↔ field names)
NL semantic:      irreversible (meaning degrades on compression)
$O (bit flag + schema-grounded vector): near-reversible
```

Conditions for near-reversibility:
- Bit positions defined by schema (fixed meaning)
- Vector components derived from numeric computation, not LLM inference
- Consumer references the same schema

When these hold, the compressed form restores deterministically. No interpretation ambiguity.

### Relationship to shadow family

```
$S  → declares meaning      (semantic layer)
$V  → declares correctness  (validation layer)
$P  → declares access       (permission layer)
$ST → declares observation  (statistics layer)
$O  → declares output form  (capability adaptation layer)
```

Each shadow carries a single responsibility. `$O` completes the family by addressing consumer capability rather than data meaning, correctness, permission, or observation.

### Multi-agent implication

In a multi-agent pipeline, agents have different DCP parsing capabilities. `$O` enables a single stream to serve all of them:

```
High-capability AI  → receives full DCP ($S/$V/$P shadows intact)
Phi-agent (role A)  → receives $O: bit flags, reads bits 0,1,4 only
Phi-agent (role B)  → receives $O: bit flags, reads bits 2,3 only
DCP-limited agent   → receives $O: vector form only
```

No format branching in the stream. `$O` is the projection layer that makes one stream universally consumable.

---

---

## Eval Shadow — considered and deferred

During design, a seventh shadow `$E` was considered: a lightweight stamp recording which shadows a data row had passed through.

```
["$E", 0x06, "receptor-a"]
  bit0: $V passed
  bit1: $R applied
  bit2: $O converted
  bit3: $P checked
```

The intent was to carry processing state alongside data — useful in multi-agent pipelines where a downstream agent needs to know what has already been applied.

**Why it was not added as a shadow:**

The six existing shadows all describe properties of the data itself — its structure, correctness, routing, access, statistics, output form. `$E` would describe what happened to the data during processing. This is a different category: not an observation of the data, but a record of system actions.

Adding `$E` as a shadow would mix two concerns that should remain separate:

```
Shadow layer:    data properties (what the data is)
Processing layer: execution history (what was done to it)
```

**Where it belongs:**

Processing state is an envelope concern, not a payload concern. When a pipeline needs to carry processing stamps alongside data, the correct form is a packet envelope:

```
{
  header: { processed_by: ["$V","$R"], receptor: "receptor-a", flags: 0x06 },
  body:   [["$S","log:v1",...], [...data...]]
}
```

The packet form is an optional extension — not required for most DCP use cases. When processing state must cross agent boundaries, the stream shifts to packet form. When it does not, the lightweight body-only form is preserved.

`$ST` covers the batch-level equivalent: aggregate statistics over a window of rows. `$E` at the row level and `$ST` at the batch level together cover the observation range — without requiring a seventh shadow.

---

## Current status

Shadow rows (`$S`, `$V`, `$P`, `$ST`, `$O`) are a conceptual framework. In current deployments, `$S` is implemented. `$V`, `$P`, `$ST`, and `$O` are not — the overhead is not yet justified at current scale.

The framework is documented here as a stable concept. Implementation is deferred until the operational need is clear.