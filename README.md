# dcp-wrap

Convert JSON to [DCP](https://dcp-docs.pages.dev) positional-array format — fewer tokens, same accuracy.

## What it does

DCP strips repeated keys from structured data. Instead of sending `{"endpoint":"/v1/users","method":"GET","status":200}` per record, DCP declares the schema once and writes values by position:

```
["$S","api-response:v1","endpoint","method","status","latency_ms"]
["/v1/users","GET",200,42]
["/v1/orders","POST",201,187]
```

40–60% token reduction when feeding data to LLMs. Zero accuracy cost. See [benchmark](https://dcp-docs.pages.dev/dcp/specification#benchmark-dcp-vs-json-vs-natural-language).

## Install

```bash
npm install dcp-wrap
```

Or use directly:

```bash
npx dcp-wrap
```

## CLI

### Infer schema from JSON

```bash
cat api-response.json | npx dcp-wrap init api-response
```

Output:
```
Schema: api-response:v1
Fields: 4

  endpoint: string (source: endpoint, unique: 4/4)
  method: string (source: method, unique: 2/4)  [enum(2)]
  status: number (source: status, unique: 2/4)
  latency_ms: number (source: latency_ms, unique: 4/4)

Saved: dcp-schemas/api-response.v1.json
Saved: dcp-schemas/api-response.v1.mapping.json
```

The generator infers field types, detects enums, numeric ranges, and orders fields by DCP convention (identifiers → classifiers → numerics → text).

### Encode JSON to DCP

```bash
cat data.json | npx dcp-wrap encode --schema dcp-schemas/api-response.v1.json
```

Output:
```
["$S","api-response:v1","endpoint","method","status","latency_ms"]
["/v1/users","GET",200,42]
["/v1/orders","POST",201,187]
["/v1/auth","POST",200,95]
```

### Inspect a schema

```bash
npx dcp-wrap inspect dcp-schemas/api-response.v1.json
```

## Programmatic API

### Quick — one function, no files

For known structures where you define the schema inline:

```typescript
import { dcpEncode } from "dcp-wrap";

const dcp = dcpEncode(results, {
  id: "engram-recall:v1",
  fields: ["id", "relevance", "summary", "tags", "hitCount", "weight", "status"],
});
// ["$S","engram-recall:v1","id","relevance","summary","tags","hitCount","weight","status"]
// ["abc123",0.95,"port conflict fix","docker,gotcha",12,3.2,"fixed"]
```

Array fields are auto-joined with comma. Use `transform` for custom handling:

```typescript
const dcp = dcpEncode(records, schema, {
  transform: { relevance: (v) => +(v as number).toFixed(3) },
});
```

### Full — schema generation + encoding

For unknown JSON where you want schema inference:

```typescript
import { SchemaGenerator, DcpEncoder, DcpSchema, FieldMapping } from "dcp-wrap";

const gen = new SchemaGenerator();
const draft = gen.fromSamples(jsonRecords, { domain: "github-pr" });

const schema = new DcpSchema(draft.schema);
const mapping = new FieldMapping(draft.mapping);
const encoder = new DcpEncoder(schema, mapping);

const batch = encoder.encode(jsonRecords);
console.log(DcpEncoder.toString(batch));
```

## Nested JSON

Nested objects are automatically flattened via dot-notation:

```json
{"id": "pr-1", "metadata": {"author": "alice", "state": "open"}}
```

The generator maps `metadata.author` → `author`, `metadata.state` → `state`. The mapping file records the full paths for encoding.

## Working with messy data

Real-world APIs return deeply nested objects, inconsistent fields, and dozens of keys you don't need. The generator applies three guards by default:

| Guard | Default | What it does |
|-------|---------|-------------|
| `maxDepth` | 3 | Stops flattening at 3 levels. `a.b.c` is resolved; `a.b.c.d.e` is kept as an opaque value. |
| `maxFields` | 20 | Keeps the top 20 fields by DCP priority (identifiers → classifiers → numerics → text). The rest are dropped. |
| `minPresence` | 0.1 | Fields appearing in less than 10% of samples are excluded. |

Override when needed:

```typescript
const draft = gen.fromSamples(samples, {
  domain: "some-api",
  maxDepth: 2,       // very flat — only top-level and one level of nesting
  maxFields: 10,     // aggressive trim
  minPresence: 0.5,  // field must appear in at least half the samples
});
```

**Always review the generated schema before using it in production.** The generator infers — it does not know your intent. Check:

- Are the right fields included? Use `include` / `exclude` to override.
- Are field names sensible? Nested paths become leaf names (`metadata.author` → `author`). Use `fieldNames` to rename.
- Are array fields handled correctly? Arrays are auto-joined with comma in `dcpEncode()`. Use `transform` for custom serialization.
- Is the schema ID correct? The generator derives `{domain}:v{version}` from your input. This ID is how consumers identify the schema.

## Design

- **Zero runtime dependencies**
- Schema generation follows DCP field ordering convention
- Supports JSON arrays and newline-delimited JSON (NDJSON) as input
- Handles nested objects, enum detection, nullable fields, numeric ranges
- Schema + mapping files are plain JSON — review, version, and edit them

dcp-wrap handles JSON → DCP conversion. For shadow index optimization, agent profiling, and the full protocol design, see [dcp-docs.pages.dev](https://dcp-docs.pages.dev).

## PicoClaw Integration

dcp-wrap ships with an out-of-process hook for [PicoClaw](https://github.com/sipeed/picoclaw) that DCP-encodes tool results before they reach the LLM. No core modification needed — just configure a process hook.

See [docs/picoclaw-integration.md](docs/picoclaw-integration.md) for setup guide, Docker instructions, and gotchas.

## License

Apache-2.0
