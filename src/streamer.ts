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
 */

import { readFileSync } from "node:fs";
import { SchemaGenerator } from "./generator.js";
import { vShadowFromSchema } from "./validator.js";
import type { DcpSchemaDef } from "./types.js";

type ValidationMode = "filter" | "flag" | "isolate";

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

// ── CLI entry ──────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const filePath = args[0];

  if (!filePath) {
    process.stderr.write(
      "usage: streamer <json-file> [--delay <ms>] [--batch <n>] [--domain <name>] [--mode filter|flag|isolate]\n"
    );
    process.exit(1);
  }

  let delayMs = 0;
  let batchSize = 1;
  let domain = "data";
  let mode: ValidationMode = "filter";

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--delay"  && args[i + 1]) delayMs   = parseInt(args[++i], 10);
    if (args[i] === "--batch"  && args[i + 1]) batchSize = parseInt(args[++i], 10);
    if (args[i] === "--domain" && args[i + 1]) domain    = args[++i];
    if (args[i] === "--mode"   && args[i + 1]) mode      = args[++i] as ValidationMode;
  }

  const raw = readFileSync(filePath, "utf-8");
  const records: Record<string, unknown>[] = JSON.parse(raw);

  if (records.length === 0) {
    process.stderr.write("error: empty input\n");
    process.exit(1);
  }

  // Infer schema from all records
  const gen = new SchemaGenerator();
  const draft = gen.fromSamples(records, { domain, version: 1 });
  const { schema } = draft;

  // Derive $V shadow from schema (no hardcoding)
  const vShadow = vShadowFromSchema(schema);

  // Emit $V declaration to stderr
  process.stderr.write(JSON.stringify(vDeclRow(schema)) + "\n");

  // Emit $S header to stdout
  const sHeader = JSON.stringify(["$S", schema.id, schema.fieldCount, ...schema.fields]);
  process.stdout.write(sHeader + "\n");

  let passCount = 0;
  let failCount = 0;

  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);

    for (let j = 0; j < batch.length; j++) {
      const rec = batch[j];
      const row = encodeRow(rec, schema);
      const idx = i + j;

      const result = vShadow.validatePositional(schema.fields, row);

      if (result.pass) {
        passCount++;
        process.stderr.write(`PASS ${idx}\n`);
        if (mode === "filter" || mode === "flag") {
          process.stdout.write(JSON.stringify(row) + "\n");
        }
      } else {
        failCount++;
        for (const f of result.failures) {
          process.stderr.write(`FAIL ${idx} ${f.field}: ${f.reason}\n`);
        }
        if (mode === "flag" || mode === "isolate") {
          process.stdout.write(JSON.stringify(row) + "\n");
        }
      }
    }

    if (delayMs > 0 && i + batchSize < records.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  // $ST summary to stderr
  const total = passCount + failCount;
  const stRow = ["$ST", schema.id, passCount, failCount, total,
    `pass_rate=${(passCount / total).toFixed(3)}`];
  process.stderr.write(JSON.stringify(stRow) + "\n");
}

main().catch((e) => {
  process.stderr.write(`error: ${e.message}\n`);
  process.exit(1);
});