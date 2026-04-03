/**
 * DCP Streamer
 *
 * Reads a JSON array file, infers schema from samples, and emits DCP rows
 * to stdout line by line. Applies a $V shadow derived from the schema.
 *
 * Usage:
 *   node dist/streamer.js <json-file> [--delay <ms>] [--batch <n>] [--domain <name>] [--mode filter|flag|isolate]
 *
 * Output (stdout):
 *   $S header once, then body rows (filtered by mode)
 *
 * Validation results (stderr):
 *   $V declaration row
 *   PASS <index> | FAIL <index> <field>: <reason>
 *   $ST summary row
 *
 * Modes:
 *   filter   PASS rows → stdout, FAIL rows dropped         (default)
 *   flag     all rows → stdout, FAIL noted in stderr
 *   isolate  FAIL rows → stdout, PASS rows dropped
 *
 * InitialGate options:
 *   --pre-check          run InitialGate only, report anomalies, do not stream
 *   --force              skip confirmation prompt, stream despite warnings
 *   --pre-check-sample n scan only first n records in InitialGate
 */

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { SchemaGenerator } from "./generator.js";
import { PooledMonitor } from "./monitor.js";
import { StCollector } from "./st-collector.js";
import type { StRow } from "./st-collector.js";
import { SchemaRegistry } from "./registry.js";
import { Gate } from "./gate.js";
import type { ValidationMode } from "./gate.js";
import type { DcpSchemaDef } from "./types.js";

// ── Generic row encoder ────────────────────────────────────────

function encodeRow(record: Record<string, unknown>, schema: DcpSchemaDef): unknown[] {
  return schema.fields.map((field) => {
    const val = record[field];
    if (val == null) return "-";
    if (Array.isArray(val)) return val.join(",") || "-";
    return val;
  });
}

// ── $V declaration row for stderr ─────────────────────────────

function vDeclRow(schema: DcpSchemaDef): unknown[] {
  const decl: unknown[] = ["$V", schema.id];
  for (const field of schema.fields) {
    const t = schema.types[field];
    if (!t) { decl.push("*"); continue; }
    const base = Array.isArray(t.type) ? t.type.filter((x) => x !== "null").join("|") : t.type;
    let spec = base;
    if (t.min !== undefined && t.max !== undefined) spec += `:${t.min}-${t.max}`;
    else if (t.min !== undefined) spec += `:min=${t.min}`;
    if (t.enum) spec += `:enum(${(t.enum as unknown[]).join(",")})`;
    decl.push(spec);
  }
  return decl;
}

// ── InitialGate ────────────────────────────────────────────────

interface InitialGateWarning {
  kind: "unknown_field" | "missing_field" | "type_mismatch" | "range_violation";
  message: string;
}

function runInitialGate(
  records: Record<string, unknown>[],
  schema: DcpSchemaDef,
  sampleSize: number | null,
): InitialGateWarning[] {
  const sample = sampleSize !== null ? records.slice(0, sampleSize) : records;
  const n = sample.length;
  const warnings: InitialGateWarning[] = [];

  // Count unknown fields across all sample records
  const unknownCounts: Map<string, number> = new Map();
  for (const rec of sample) {
    for (const key of Object.keys(rec)) {
      if (!schema.fields.includes(key)) {
        unknownCounts.set(key, (unknownCounts.get(key) ?? 0) + 1);
      }
    }
  }
  for (const [field, count] of unknownCounts) {
    const pct = ((count / n) * 100).toFixed(1);
    warnings.push({
      kind: "unknown_field",
      message: `unknown field '${field}' in ${count}/${n} records (${pct}%) — not in schema`,
    });
  }

  // Count missing required fields
  const missingCounts: Map<string, number> = new Map();
  for (const rec of sample) {
    for (const field of schema.fields) {
      if (!(field in rec)) {
        missingCounts.set(field, (missingCounts.get(field) ?? 0) + 1);
      }
    }
  }
  for (const [field, count] of missingCounts) {
    const pct = ((count / n) * 100).toFixed(1);
    warnings.push({
      kind: "missing_field",
      message: `field '${field}' absent in ${count}/${n} records (${pct}%)`,
    });
  }

  // Per-field type mismatch and range violation
  const typeMismatch: Map<string, number> = new Map();
  const rangeMismatch: Map<string, number> = new Map();

  for (const rec of sample) {
    for (const field of schema.fields) {
      const val = rec[field];
      if (val == null || val === "-") continue;

      const typeDef = schema.types[field];
      if (!typeDef) continue;

      const expectedTypes = Array.isArray(typeDef.type)
        ? typeDef.type.filter((t) => t !== "null")
        : [typeDef.type];

      // Type check
      let typeOk = false;
      for (const et of expectedTypes) {
        if (et === "int") {
          if (typeof val === "number" && Number.isInteger(val)) { typeOk = true; break; }
        } else if (et === "float" || et === "number") {
          if (typeof val === "number") { typeOk = true; break; }
        } else if (et === "string") {
          if (typeof val === "string") { typeOk = true; break; }
        } else if (et === "boolean") {
          if (typeof val === "boolean") { typeOk = true; break; }
        }
      }
      if (!typeOk) {
        typeMismatch.set(field, (typeMismatch.get(field) ?? 0) + 1);
        continue; // skip range check if type is wrong
      }

      // Range check
      if (typeof val === "number") {
        const min = typeDef.min;
        const max = typeDef.max;
        if ((min !== undefined && val < min) || (max !== undefined && val > max)) {
          rangeMismatch.set(field, (rangeMismatch.get(field) ?? 0) + 1);
        }
      }
    }
  }

  for (const [field, count] of typeMismatch) {
    const typeDef = schema.types[field];
    const expected = typeDef
      ? (Array.isArray(typeDef.type) ? typeDef.type.filter((t) => t !== "null").join("|") : typeDef.type)
      : "unknown";
    const pct = ((count / n) * 100).toFixed(1);
    warnings.push({
      kind: "type_mismatch",
      message: `field '${field}' type mismatch in ${count}/${n} records (${pct}%): expected ${expected}`,
    });
  }

  for (const [field, count] of rangeMismatch) {
    const typeDef = schema.types[field];
    const rangeStr = typeDef
      ? (typeDef.min !== undefined && typeDef.max !== undefined
          ? `${typeDef.min}-${typeDef.max}`
          : typeDef.min !== undefined ? `min=${typeDef.min}` : `max=${typeDef.max}`)
      : "?";
    const pct = ((count / n) * 100).toFixed(1);
    warnings.push({
      kind: "range_violation",
      message: `field '${field}' out of range [${rangeStr}] in ${count}/${n} records (${pct}%)`,
    });
  }

  return warnings;
}

// ── CLI entry ──────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const filePath = args[0];

  if (!filePath) {
    process.stderr.write(
      "usage: streamer <json-file> [--delay <ms>] [--batch <n>] [--domain <name>] [--mode filter|flag|isolate] [--schema-from <json-file>] [--pre-check] [--force] [--pre-check-sample <n>] [--ts-resolution <ms>]\n"
    );
    process.exit(1);
  }

  let delayMs = 0;
  let batchSize = 1;
  let domain = "data";
  let mode: ValidationMode = "filter";
  let schemaFrom: string | null = null;
  let preCheckOnly = false;
  let force = false;
  let preCheckSample: number | null = null;
  let tsResolutionMs = 100;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--delay"             && args[i + 1]) delayMs        = parseInt(args[++i], 10);
    if (args[i] === "--batch"             && args[i + 1]) batchSize      = parseInt(args[++i], 10);
    if (args[i] === "--domain"            && args[i + 1]) domain         = args[++i];
    if (args[i] === "--mode"              && args[i + 1]) mode           = args[++i] as ValidationMode;
    if (args[i] === "--schema-from"       && args[i + 1]) schemaFrom     = args[++i];
    if (args[i] === "--pre-check")                        preCheckOnly   = true;
    if (args[i] === "--force")                            force          = true;
    if (args[i] === "--pre-check-sample"  && args[i + 1]) preCheckSample = parseInt(args[++i], 10);
    if (args[i] === "--ts-resolution"     && args[i + 1]) tsResolutionMs = parseInt(args[++i], 10);
  }

  const raw = readFileSync(filePath, "utf-8");
  const records: Record<string, unknown>[] = JSON.parse(raw);

  if (records.length === 0) {
    process.stderr.write("error: empty input\n");
    process.exit(1);
  }

  // Infer schema — from --schema-from file if specified, otherwise from input records
  const gen = new SchemaGenerator();
  const schemaSamples = schemaFrom
    ? (JSON.parse(readFileSync(schemaFrom, "utf-8")) as Record<string, unknown>[])
    : records;
  const draft = gen.fromSamples(schemaSamples, { domain, version: 1 });
  const { schema } = draft;

  // Register schema and set up Gate
  const registry = new SchemaRegistry();
  registry.register(schema);

  // ── InitialGate ──────────────────────────────────────────────
  const warnings = runInitialGate(records, schema, preCheckSample);

  if (warnings.length > 0) {
    process.stderr.write(`[InitialGate] ${warnings.length} warning(s) found:\n`);
    for (const w of warnings) {
      process.stderr.write(`  [${w.kind}] ${w.message}\n`);
    }

    if (preCheckOnly) {
      process.stderr.write("[InitialGate] --pre-check: report only, not streaming.\n");
      process.exit(0);
    }

    if (!force) {
      // Prompt user for confirmation
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      const answer = await new Promise<string>((resolve) => {
        rl.question("[InitialGate] Proceed with streaming? [y/N] ", resolve);
      });
      rl.close();

      if (answer.trim().toLowerCase() !== "y") {
        process.stderr.write("[InitialGate] Aborted.\n");
        process.exit(1);
      }
    } else {
      process.stderr.write("[InitialGate] --force: proceeding despite warnings.\n");
    }
  } else {
    if (preCheckOnly) {
      process.stderr.write("[InitialGate] No issues found.\n");
      process.exit(0);
    }
  }

  // Emit $V declaration to stderr
  process.stderr.write(JSON.stringify(vDeclRow(schema)) + "\n");

  // Emit $S header to stdout
  const sHeader = JSON.stringify(["$S", schema.id, schema.fieldCount, ...schema.fields]);
  process.stdout.write(sHeader + "\n");

  // ── Timestamp cache — updated every tsResolutionMs ──────────
  let cachedTs = Date.now();
  let tsSeq = 0;
  const tsInterval = setInterval(() => {
    const next = Date.now();
    if (next !== cachedTs) { cachedTs = next; tsSeq = 0; }
  }, tsResolutionMs);

  // ── Monitor + StCollector ────────────────────────────────────
  const monitor = new PooledMonitor(100);
  const st = new StCollector(monitor, { windowMs: 1000 });

  // Log $ST windows to stderr as they arrive — payload is StRow (DCP positional array)
  monitor.subscribe("st", (msg) => {
    process.stderr.write(JSON.stringify(msg.payload as StRow) + "\n");
  });

  monitor.start();
  st.start();

  // ── Gate — validation + Monitor emit ────────────────────────
  const gate = new Gate(registry, { monitor, defaultMode: mode });

  // ── flow emit — track rows per window ───────────────────────
  let windowRowCount = 0;
  let windowStart = Date.now();
  const flowInterval = setInterval(() => {
    const now = Date.now();
    const elapsed = now - windowStart;
    if (elapsed > 0) {
      monitor.emit({
        type: "flow",
        schemaId: schema.id,
        ts: now,
        priority: "batch",
        payload: { rowsPerSec: Math.round((windowRowCount / elapsed) * 1000), windowMs: elapsed },
      });
    }
    windowRowCount = 0;
    windowStart = now;
  }, 1000);

  let passCount = 0;
  let failCount = 0;

  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);

    for (let j = 0; j < batch.length; j++) {
      const rec = batch[j];
      const row = encodeRow(rec, schema);
      const idx = i + j;

      const result = gate.process(schema.id, schema.fields, row, idx, undefined, cachedTs);
      windowRowCount++;
      tsSeq++;

      if (result.pass) {
        passCount++;
        process.stderr.write(`PASS ${idx}\n`);
      } else {
        failCount++;
        for (const f of result.failures) {
          process.stderr.write(`FAIL ${idx} ${f.field}: ${f.reason}\n`);
        }
      }

      if (result.emit) {
        process.stdout.write(JSON.stringify(row) + "\n");
      }
    }

    if (delayMs > 0 && i + batchSize < records.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  // Shutdown — flush remaining stats
  clearInterval(tsInterval);
  clearInterval(flowInterval);
  st.stop();
  monitor.stop();
}

main().catch((e) => {
  process.stderr.write(`error: ${e.message}\n`);
  process.exit(1);
});