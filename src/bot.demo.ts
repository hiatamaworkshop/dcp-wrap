/**
 * bot.demo.ts — Pipeline + Bot full-stack demo
 *
 * Run: node dist/bot.demo.js
 *
 * Flow:
 *   mock_data_dirty.json
 *     → Preprocessor → Gate → StCollector → $ST-v / $ST-f
 *     → Bot (FastGate + RuleBasedLlm) → $I packet → IPool
 *     → Brain AI placeholder reads IPool at stop()
 *
 * Observe:
 *   - [PASS] / [DROP] / [QUARANTINE] per record
 *   - [GATE FAIL] per field
 *   - [$ST-v] pass_rate, fail, total
 *   - [$ST-f] rowsPerSec
 *   - [$I] Bot inference output — signal, severity, firedWeapons
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { SchemaRegistry } from "./registry.js";
import { PostBox } from "./postbox.js";
import { RoutingLayer } from "./router.js";
import { SimpleMonitor, MessagePool } from "./monitor.js";
import { PipelineControl } from "./pipeline-control.js";
import { StCollector } from "./st-collector.js";
import { Preprocessor } from "./preprocessor.js";
import { Gate } from "./gate.js";
import { IPool } from "./i-pool.js";
import { Bot } from "./bot.js";
import type { DcpSchemaDef, AgentProfile } from "./types.js";
import type { QuarantinePayload } from "./postbox.js";
import type { StVRow, StFRow } from "./st-collector.js";

const __dir    = dirname(fileURLToPath(import.meta.url));
const dataPath = join(__dir, "..", "tests", "mock_data_dirty.json");

// ── 1. Schema ─────────────────────────────────────────────────────────────────

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

// ── 2. Bot AgentProfile ───────────────────────────────────────────────────────

const PROFILE: AgentProfile = {
  id:     "profile-quality-watcher:v1",
  botId:  "bot-quality-watcher",
  model:  "rule-based",          // swap to "phi3:mini" when adapter ready
  weapons: [
    { name: "low_pass_rate", metric: "pass_rate", op: "<",  threshold: 0.9, weight: 1.0 },
    { name: "high_fail",     metric: "fail",      op: ">",  threshold: 2,   weight: 0.5 },
    { name: "slow_flow",     metric: "rowsPerSec",op: "<",  threshold: 5,   weight: 0.3 },
  ],
  trigger: { mode: "any" },
  schemaScope: ["knowledge-entry:v1"],
};

// ── 3. Wire components ────────────────────────────────────────────────────────

const registry = new SchemaRegistry();
registry.register(SCHEMA);

const monitor = new SimpleMonitor();
const postbox = new PostBox();
const router  = new RoutingLayer(new MessagePool(), { receive: () => {} });
const ctrl    = new PipelineControl("pipeline://demo-01", postbox, router);

const gate      = new Gate(registry, { defaultMode: "flag", monitor });
gate.onSchemaHeader(SCHEMA.id);

const collector = new StCollector(monitor, { windowMs: 500 });
const ipool     = new IPool({ capacity: 64 });
const bot       = new Bot(monitor, postbox, ipool, PROFILE);

const pre = new Preprocessor(registry, postbox, ctrl, {
  pipelineId: "pipeline://demo-01",
  schemaField: "$schema",
});

// ── 4. $ST observer (log only) ────────────────────────────────────────────────

monitor.subscribe("st_v", (msg) => {
  const [, schemaId, pass, fail, total, passRate] = msg.payload as StVRow;
  console.log(`\n[$ST-v] schema=${schemaId}  pass=${pass}  fail=${fail}  total=${total}  pass_rate=${passRate}`);
});

monitor.subscribe("st_f", (msg) => {
  const [, schemaId, rowsPerSec] = msg.payload as StFRow;
  console.log(`[$ST-f] schema=${schemaId}  rowsPerSec=${rowsPerSec}`);
});

// ── 5. Preprocessor → Gate bridge ────────────────────────────────────────────

let passed = 0, quarantined = 0, dropped = 0;
let rowIndex = 0;

pre.onPass((record, schemaId) => {
  passed++;
  console.log(`[PASS]       schemaId=${schemaId}  summary="${String(record.summary).slice(0, 40)}"`);

  const entry = registry.get(schemaId);
  if (!entry) return;

  const row = entry.schema.fields.map((f) => {
    const v = record[f];
    if (v == null) return "-";
    if (Array.isArray(v)) return v.join(",") || "-";
    return v;
  });

  const result = gate.process(schemaId, entry.schema.fields, row, rowIndex++);
  if (!result.pass) {
    for (const f of result.failures) {
      console.log(`  [GATE FAIL]  field=${f.field}  reason="${f.reason}"`);
    }
  }
});

pre.onDrop((record, reason) => {
  dropped++;
  console.log(`[DROP]       reason="${reason}"  record=${JSON.stringify(record).slice(0, 60)}`);
});

// ── 6. Quarantine handler (Brain AI stub) ─────────────────────────────────────

postbox.subscribeInbound("quarantine", (msg) => {
  const q = msg.payload as QuarantinePayload;
  quarantined++;
  console.log(`[QUARANTINE] id=${q.quarantineId.slice(0, 8)}  reason=${q.reason}  detail="${q.detail}"`);

  const record = q.record as Record<string, unknown>;

  if (q.reason === "missing_field") {
    const corrected = {
      ...record, $schema: "knowledge-entry:v1",
      flags:      typeof record.flags      === "number" ? record.flags      : 0,
      importance: typeof record.importance === "number" ? record.importance : 0.5,
    };
    console.log(`  → approve (fill defaults)`);
    postbox.issueQuarantineApprove(msg.pipelineId, { quarantineId: q.quarantineId, correctedRecord: corrected });
  } else if (q.reason === "type_mismatch") {
    const fix: Record<string, unknown> = { ...record, $schema: "knowledge-entry:v1" };
    if (typeof fix.flags === "string")  fix.flags = 1;
    if (typeof fix.flags === "boolean") fix.flags = fix.flags ? 1 : 0;
    if (typeof fix.flags === "number" && !Number.isInteger(fix.flags)) fix.flags = Math.round(fix.flags as number);
    if (typeof fix.content !== "string") fix.content = String(fix.content);
    if (typeof fix.importance === "string" && !isNaN(Number(fix.importance))) fix.importance = Number(fix.importance);
    console.log(`  → approve (coerce types)`);
    postbox.issueQuarantineApprove(msg.pipelineId, { quarantineId: q.quarantineId, correctedRecord: fix });
  } else if (q.reason === "range_violation") {
    const fix: Record<string, unknown> = { ...record, $schema: "knowledge-entry:v1" };
    if (typeof fix.importance === "number") fix.importance = Math.min(1, Math.max(0, fix.importance as number));
    if (typeof fix.flags === "number" && (fix.flags as number) < 0) fix.flags = 0;
    console.log(`  → approve (clamp range)`);
    postbox.issueQuarantineApprove(msg.pipelineId, { quarantineId: q.quarantineId, correctedRecord: fix });
  } else {
    console.log(`  → reject`);
    postbox.issueQuarantineReject(msg.pipelineId, { quarantineId: q.quarantineId, reason: `cannot fix: ${q.reason}` });
  }
});

// ── 7. Process records ────────────────────────────────────────────────────────

const records = JSON.parse(readFileSync(dataPath, "utf-8")) as unknown[];
console.log(`\n=== Bot demo — ${records.length} records ===\n`);

collector.start();
bot.start();

for (const record of records) {
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
  pre.process(toProcess);
}

// ── 8. Stop — flush $ST, drain IPool ─────────────────────────────────────────

setTimeout(() => {
  collector.stop();   // final flush → $ST-v / $ST-f → Bot evaluates
  bot.stop();

  // Brain AI placeholder: drain IPool
  const packets = ipool.drain();
  if (packets.length === 0) {
    console.log(`\n[$I] no inference packets (all weapons silent)`);
  } else {
    console.log(`\n=== $I packets (${packets.length}) ===`);
    for (const p of packets) {
      console.log(`[$I] bot=${p.botId}  schema=${p.schemaId}  severity=${p.severity}`);
      console.log(`     signal="${p.signal}"`);
    }
  }

  console.log(`
=== Summary ===
  Total input  : ${records.length}
  PASS (pre)   : ${passed}
  QUARANTINE   : ${quarantined}
  DROP         : ${dropped}
  $I packets   : ${packets.length}
`);
}, 700);