/**
 * connect.demo.ts — Two-pipeline connection via PipelineConnector.
 *
 * Run: node dist/connect.demo.js
 *
 * Architecture:
 *
 *   mock_data_dirty.json
 *     → PipelineA.Preprocessor  (schema: knowledge-entry:v1, flag mode)
 *     → PipelineA.Gate          (all rows forwarded regardless of validation result)
 *     → PipelineA.StCollector   → $ST-v / $ST-f
 *     └─ PipelineConnector      (schemaId routing → PipelineB)
 *          → PipelineB.Preprocessor  (same schema, independent re-validation)
 *          → PipelineB.Gate          (filter mode — only clean rows proceed)
 *          → PipelineB.StCollector   → $ST-v / $ST-f
 *
 * Key points:
 *   - Each pipeline has its own SchemaRegistry, Monitor, PostBox, PipelineControl.
 *   - PipelineA uses "flag" mode: all rows (pass or fail) are forwarded.
 *   - PipelineB uses "filter" mode: only validation-clean rows proceed.
 *   - Re-validation in PipelineB is intentional — each pipeline owns its rules.
 *   - Brain AI can call connector.setTable() at runtime to change routing.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { SchemaRegistry }                     from "./registry.js";
import { PostBox }                            from "./postbox.js";
import { RoutingLayer }                       from "./router.js";
import { SimpleMonitor, MessagePool }         from "./monitor.js";
import { PipelineControl }                    from "./pipeline-control.js";
import { StCollector }                        from "./st-collector.js";
import { Preprocessor }                       from "./preprocessor.js";
import { SchemaCache }                        from "./schema-cache.js";
import { JSONAdapter }                        from "./adapters/json-adapter.js";
import { Gate }                               from "./gate.js";
import { PipelineConnector }                  from "./pipeline-connector.js";
import type { DcpSchemaDef }                  from "./types.js";
import type { QuarantinePayload }             from "./postbox.js";
import type { StVRow, StFRow }                from "./st-collector.js";
import type { RawRecord }                     from "./preprocessor.js";
import type { ValidationMode }               from "./gate.js";

const __dir    = dirname(fileURLToPath(import.meta.url));
const dataPath = join(__dir, "..", "tests", "mock_data_dirty.json");

// ── Shared schema ─────────────────────────────────────────────────────────────

const SCHEMA: DcpSchemaDef = {
  $dcp: "schema",
  id: "knowledge-entry:v1",
  description: "Knowledge base entry",
  fields: ["summary", "tags", "content", "flags", "importance"],
  fieldCount: 5,
  types: {
    summary:    { type: ["string", "null"] },
    tags:       { type: "array" },
    content:    { type: "string" },
    flags:      { type: "int",    min: 0 },
    importance: { type: "number", min: 0, max: 1 },
  },
};

// ── Pipeline factory ──────────────────────────────────────────────────────────

interface Pipeline {
  id:        string;
  pre:       Preprocessor<Record<string, unknown>>;
  gate:      Gate;
  collector: StCollector;
  monitor:   SimpleMonitor;
  postbox:   PostBox;
  ctrl:      PipelineControl;
  stats:     { passed: number; quarantined: number; dropped: number };
}

function buildPipeline(id: string, gateMode: ValidationMode): Pipeline {
  const registry  = new SchemaRegistry();
  registry.register(SCHEMA);

  const monitor   = new SimpleMonitor();
  const postbox   = new PostBox();
  const router    = new RoutingLayer(new MessagePool(), { receive: () => {} });
  const ctrl      = new PipelineControl(id, postbox, router);
  const gate      = new Gate(registry, { defaultMode: gateMode, monitor });
  gate.onSchemaHeader(SCHEMA.id);
  const collector = new StCollector(monitor, { windowMs: 500 });
  const pre       = new Preprocessor(new JSONAdapter("$schema"), new SchemaCache(registry), postbox, ctrl, {
    pipelineId: id,
  });

  const stats = { passed: 0, quarantined: 0, dropped: 0 };

  return { id, pre, gate, collector, monitor, postbox, ctrl, stats };
}

// ── Build pipelines ───────────────────────────────────────────────────────────

const pA = buildPipeline("pipeline://A", "flag");
const pB = buildPipeline("pipeline://B", "filter");

// ── PipelineConnector: A → B ──────────────────────────────────────────────────

const connector = new PipelineConnector();
connector.register("knowledge-entry:v1", pB.pre);
connector.onDrop((_record, schemaId) => {
  console.log(`[CONNECTOR drop] no destination for schemaId=${schemaId}`);
});

// Wire connector to PipelineA's control so Brain AI routing_update also updates it.
// Resolver maps pipelineId strings to Preprocessor instances.
const pipelineMap = new Map([
  ["pipeline://B", pB.pre],
]);
pA.ctrl.setConnector(connector, (id) => pipelineMap.get(id));

// ── Wire Pipeline A ───────────────────────────────────────────────────────────

let rowIndexA = 0;

pA.pre.onPass((array, schemaId, raw) => {
  pA.stats.passed++;

  // array is already positional — normalize null values to "-"
  const row = array.map((v) => {
    if (v == null) return "-";
    if (Array.isArray(v)) return (v as unknown[]).join(",") || "-";
    return v;
  });
  pA.gate.process(schemaId, SCHEMA.fields, row, rowIndexA++);

  // Forward raw record to PipelineB via connector
  connector.forward(raw, schemaId);
});

pA.pre.onDrop((_record, _reason) => { pA.stats.dropped++; });

pA.postbox.subscribeInbound("quarantine", (msg) => {
  const q = msg.payload as QuarantinePayload;
  pA.stats.quarantined++;
  const record = q.record as Record<string, unknown>;

  if (q.reason === "missing_field") {
    pA.postbox.issueQuarantineApprove(msg.pipelineId, {
      quarantineId: q.quarantineId,
      correctedRecord: { ...record, $schema: SCHEMA.id, flags: 0, importance: 0.5 },
    });
  } else if (q.reason === "type_mismatch" || q.reason === "range_violation") {
    pA.postbox.issueQuarantineApprove(msg.pipelineId, { quarantineId: q.quarantineId });
  } else {
    pA.postbox.issueQuarantineReject(msg.pipelineId, {
      quarantineId: q.quarantineId,
      reason: `cannot fix: ${q.reason}`,
    });
  }
});

// ── Wire Pipeline B ───────────────────────────────────────────────────────────

let rowIndexB = 0;

pB.pre.onPass((array, schemaId) => {
  pB.stats.passed++;

  // array is already positional — normalize null values to "-"
  const row = array.map((v) => {
    if (v == null) return "-";
    if (Array.isArray(v)) return (v as unknown[]).join(",") || "-";
    return v;
  });
  pB.gate.process(schemaId, SCHEMA.fields, row, rowIndexB++);
});

pB.pre.onDrop((_record, _reason) => { pB.stats.dropped++; });

pB.postbox.subscribeInbound("quarantine", (msg) => {
  const q = msg.payload as QuarantinePayload;
  pB.stats.quarantined++;
  const record = q.record as Record<string, unknown>;

  // PipelineB is stricter: approve only missing_field, reject all others
  if (q.reason === "missing_field") {
    pB.postbox.issueQuarantineApprove(msg.pipelineId, {
      quarantineId: q.quarantineId,
      correctedRecord: { ...record, $schema: SCHEMA.id, flags: 0, importance: 0.5 },
    });
  } else {
    pB.postbox.issueQuarantineReject(msg.pipelineId, {
      quarantineId: q.quarantineId,
      reason: `pipeline-B strict: reject ${q.reason}`,
    });
  }
});

// ── $ST observers ─────────────────────────────────────────────────────────────

pA.monitor.subscribe("st_v", (msg) => {
  const [, schemaId, pass, fail, total, passRate] = msg.payload as StVRow;
  console.log(`[A $ST-v] schema=${schemaId}  pass=${pass}  fail=${fail}  total=${total}  pass_rate=${passRate}`);
});
pA.monitor.subscribe("st_f", (msg) => {
  const [, schemaId, rowsPerSec] = msg.payload as StFRow;
  console.log(`[A $ST-f] schema=${schemaId}  rowsPerSec=${rowsPerSec}`);
});

pB.monitor.subscribe("st_v", (msg) => {
  const [, schemaId, pass, fail, total, passRate] = msg.payload as StVRow;
  console.log(`[B $ST-v] schema=${schemaId}  pass=${pass}  fail=${fail}  total=${total}  pass_rate=${passRate}`);
});
pB.monitor.subscribe("st_f", (msg) => {
  const [, schemaId, rowsPerSec] = msg.payload as StFRow;
  console.log(`[B $ST-f] schema=${schemaId}  rowsPerSec=${rowsPerSec}`);
});

// ── Process records ───────────────────────────────────────────────────────────

const records = JSON.parse(readFileSync(dataPath, "utf-8")) as unknown[];
console.log(`\n=== Connect demo — ${records.length} records ===`);
console.log(`    PipelineA (flag mode) → PipelineConnector → PipelineB (filter mode)\n`);

pA.collector.start();
pB.collector.start();

for (const record of records) {
  let toProcess: unknown;
  if (
    record !== null &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    !("$schema" in (record as object))
  ) {
    toProcess = { ...(record as Record<string, unknown>), $schema: SCHEMA.id };
  } else {
    toProcess = record;
  }
  pA.pre.process(toProcess as Record<string, unknown>);
}

setTimeout(() => {
  pA.collector.stop();
  pB.collector.stop();

  console.log(`
=== Pipeline A (flag — passes all to connector) ===
  passed      : ${pA.stats.passed}
  quarantined : ${pA.stats.quarantined}
  dropped     : ${pA.stats.dropped}

=== Pipeline B (filter — re-validates independently) ===
  passed      : ${pB.stats.passed}
  quarantined : ${pB.stats.quarantined}
  dropped     : ${pB.stats.dropped}

=== Connector routing table ===
${[...connector.getTable().entries()].map(([k]) => `  "${k}" → pipeline://B`).join("\n")}
`);
}, 700);