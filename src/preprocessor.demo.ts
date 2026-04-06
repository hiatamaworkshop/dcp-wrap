/**
 * preprocessor.demo.ts — Preprocessor smoke test with mock_data_dirty.json
 *
 * Run:  node dist/preprocessor.demo.js
 *
 * What this does:
 *   1. Registers a "knowledge-entry:v1" schema matching mock_data_dirty.json fields
 *   2. Builds PostBox + RoutingLayer + PipelineControl stub
 *   3. Attaches a Preprocessor
 *   4. Processes every record in mock_data_dirty.json
 *   5. Prints pass / quarantine / drop decisions
 *   6. Simulates Brain AI approving every quarantine → re-inject
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { SchemaRegistry } from "./registry.js";
import { SchemaCache } from "./schema-cache.js";
import { PostBox } from "./postbox.js";
import { RoutingLayer } from "./router.js";
import { MessagePool } from "./monitor.js";
import { PipelineControl } from "./pipeline-control.js";
import { Preprocessor } from "./preprocessor.js";
import { JSONAdapter } from "./adapters/json-adapter.js";
import type { DcpSchemaDef } from "./types.js";
import type { QuarantinePayload } from "./postbox.js";

// ── 1. Schema for mock_data_dirty.json ────────────────────────────────────────

const KNOWLEDGE_SCHEMA: DcpSchemaDef = {
  $dcp: "schema",
  id: "knowledge-entry:v1",
  description: "Knowledge base entry — demo schema for Preprocessor smoke test",
  fields: ["summary", "tags", "content", "flags", "importance"],
  fieldCount: 5,
  types: {
    summary:    { type: ["string", "null"] },
    tags:       { type: "array" },           // array → joined string in DCP rows
    content:    { type: "string" },
    flags:      { type: "int",    min: 0 },
    importance: { type: "number", min: 0, max: 1 },
  },
};

// ── 2. Wire up components ─────────────────────────────────────────────────────

const registry = new SchemaRegistry();
registry.register(KNOWLEDGE_SCHEMA);

const postbox  = new PostBox();
const pool     = new MessagePool();
// RoutingLayer needs a pool + sink; use a no-op sink for this demo
const router   = new RoutingLayer(pool, { receive: () => {} });
const ctrl     = new PipelineControl("pipeline://demo-01", postbox, router);

const adapter = new JSONAdapter("$schema");
const cache   = new SchemaCache(registry);
const pre = new Preprocessor(adapter, cache, postbox, ctrl, {
  pipelineId: "pipeline://demo-01",
});

// ── 3. Counters & handlers ────────────────────────────────────────────────────

let passed      = 0;
let quarantined = 0;
let dropped     = 0;

pre.onPass((array, schemaId) => {
  passed++;
  // KNOWLEDGE_SCHEMA.fields = ["summary","tags","content","flags","importance"], index 0 = summary
  console.log(`[PASS]       schemaId=${schemaId}  summary="${array[0]}"`);
});

pre.onDrop((record, reason) => {
  dropped++;
  console.log(`[DROP]       reason="${reason}"  record=${JSON.stringify(record).slice(0, 80)}`);
});

// Brain AI stub: approve every quarantine, optionally fix obvious issues
postbox.subscribeInbound("quarantine", (msg) => {
  const q = msg.payload as QuarantinePayload;
  quarantined++;
  console.log(`[QUARANTINE] id=${q.quarantineId.slice(0, 8)}  reason=${q.reason}  detail="${q.detail}"`);

  // Simulate Brain AI decision — approve with a corrected record when fixable
  const record = q.record as Record<string, unknown>;
  let corrected: Record<string, unknown> | undefined;

  if (q.reason === "missing_field") {
    // Fill in any missing fields with safe defaults
    corrected = {
      ...record,
      $schema: "knowledge-entry:v1",
      flags:      typeof record.flags      === "number" ? record.flags      : 0,
      importance: typeof record.importance === "number" ? record.importance : 0.5,
    };
  } else if (q.reason === "type_mismatch") {
    // Attempt coercion field by field
    const fix: Record<string, unknown> = { ...record, $schema: "knowledge-entry:v1" };
    if (typeof fix.flags === "string")  fix.flags = 1;        // "HIGH" → 1
    if (typeof fix.flags === "boolean") fix.flags = fix.flags ? 1 : 0;
    if (typeof fix.flags === "number" && !Number.isInteger(fix.flags)) fix.flags = Math.round(fix.flags as number);
    if (typeof fix.content !== "string") fix.content = String(fix.content);
    if (typeof fix.importance === "string" && !isNaN(Number(fix.importance))) {
      fix.importance = Number(fix.importance);
    }
    corrected = fix;
  } else if (q.reason === "range_violation") {
    const fix: Record<string, unknown> = { ...record, $schema: "knowledge-entry:v1" };
    if (typeof fix.importance === "number") fix.importance = Math.min(1, Math.max(0, fix.importance as number));
    if (typeof fix.flags === "number" && (fix.flags as number) < 0) fix.flags = 0;
    corrected = fix;
  }
  // unknown_field: reject — cannot drop unknown fields safely without schema confirmation

  if (corrected) {
    console.log(`  → Brain AI approves with correction`);
    postbox.issueQuarantineApprove(msg.pipelineId, {
      quarantineId: q.quarantineId,
      correctedRecord: corrected,
    });
  } else {
    console.log(`  → Brain AI rejects`);
    postbox.issueQuarantineReject(msg.pipelineId, {
      quarantineId: q.quarantineId,
      reason: `cannot fix reason=${q.reason}`,
    });
  }
});

// ── 4. Load mock_data_dirty.json and process ──────────────────────────────────

const __dir   = dirname(fileURLToPath(import.meta.url));
const dataPath = join(__dir, "..", "tests", "mock_data_dirty.json");
const records  = JSON.parse(readFileSync(dataPath, "utf-8")) as unknown[];

console.log(`\n=== Preprocessor demo — ${records.length} records from mock_data_dirty.json ===\n`);

for (const record of records) {
  // Only inject $schema for plain objects that don't already have one.
  // Non-objects (null, string, array) are passed as-is so the DROP path is exercised.
  // Records that already carry $schema (empty string, alien id, no-schema) are also passed as-is.
  let toProcess: unknown;
  if (
    record !== null &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    !("$schema" in (record as object))
  ) {
    toProcess = { ...(record as Record<string, unknown>), $schema: "knowledge-entry:v1" };
  } else {
    toProcess = record;
  }
  pre.process(toProcess as Record<string, unknown>);
}

// ── 5. Summary ────────────────────────────────────────────────────────────────

console.log(`
=== Summary ===
  Total input  : ${records.length}
  PASS         : ${passed}
  QUARANTINE   : ${quarantined}
  DROP         : ${dropped}
`);