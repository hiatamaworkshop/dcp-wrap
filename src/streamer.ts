/**
 * DCP Streamer
 *
 * Reads a JSON array file and emits DCP rows to stdout line by line.
 * Applies a $V shadow inline — pass/fail printed to stderr.
 *
 * Usage:
 *   node dist/streamer.js <json-file> [--delay <ms>] [--batch <n>]
 *
 * Output (stdout):
 *   $S header once, then body rows
 *   Rows are newline-separated JSON arrays
 *
 * Validation results (stderr):
 *   PASS <index>
 *   FAIL <index> <field>: <reason>
 */

import { readFileSync } from "node:fs";
import { VShadow, type VConstraint } from "./validator.js";

// ── Schema definition for mock_data.json ──────────────────────

const SCHEMA_ID = "knowledge:v1";
const FIELDS = ["flags", "importance", "tags", "summary", "content"] as const;

type KnowledgeRecord = {
  summary: string;
  tags: string[];
  content: string;
  flags: number;
  importance: number;
};

// $S header row
const S_HEADER = JSON.stringify(["$S", SCHEMA_ID, FIELDS.length, ...FIELDS]);

// $V shadow constraints
const V_CONSTRAINTS: Record<string, VConstraint> = {
  flags:      { type: "int", min: 0 },
  importance: { type: "number", min: 0, max: 1 },
  tags:       { type: "string" },         // post-join: comma-separated string
  summary:    { type: "string", maxLength: 200 },
  content:    { type: "string", maxLength: 500 },
};

const vShadow = new VShadow(SCHEMA_ID, V_CONSTRAINTS);

// ── Encode one record as positional row ────────────────────────

function encodeRow(rec: KnowledgeRecord): unknown[] {
  return [
    rec.flags,
    rec.importance,
    Array.isArray(rec.tags) ? rec.tags.join(",") : "-",
    rec.summary ?? "-",
    rec.content ?? "-",
  ];
}

// ── CLI entry ──────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const filePath = args[0];

  if (!filePath) {
    process.stderr.write("usage: streamer <json-file> [--delay <ms>] [--batch <n>]\n");
    process.exit(1);
  }

  let delayMs = 0;
  let batchSize = 1;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--delay" && args[i + 1]) delayMs = parseInt(args[++i], 10);
    if (args[i] === "--batch" && args[i + 1]) batchSize = parseInt(args[++i], 10);
  }

  const raw = readFileSync(filePath, "utf-8");
  const records: KnowledgeRecord[] = JSON.parse(raw);

  // Emit $V declaration to stderr for observers
  const vDecl = [
    "$V", SCHEMA_ID,
    "int:min=0",
    "number:0-1",
    "string",
    "string:max=200",
    "string:max=500",
  ];
  process.stderr.write(JSON.stringify(vDecl) + "\n");

  // Emit $S header
  process.stdout.write(S_HEADER + "\n");

  let passCount = 0;
  let failCount = 0;

  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);

    for (let j = 0; j < batch.length; j++) {
      const rec = batch[j];
      const row = encodeRow(rec);
      const idx = i + j;

      // Build named object for $V validation
      const named: Record<string, unknown> = {};
      for (let k = 0; k < FIELDS.length; k++) {
        named[FIELDS[k]] = row[k];
      }

      const result = vShadow.validate(named);

      if (result.pass) {
        passCount++;
        process.stderr.write(`PASS ${idx}\n`);
      } else {
        failCount++;
        for (const f of result.failures) {
          process.stderr.write(`FAIL ${idx} ${f.field}: ${f.reason}\n`);
        }
      }

      // Emit body row to stdout
      process.stdout.write(JSON.stringify(row) + "\n");
    }

    if (delayMs > 0 && i + batchSize < records.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  // $ST summary to stderr
  const total = passCount + failCount;
  const stRow = ["$ST", SCHEMA_ID, passCount, failCount, total, `pass_rate=${(passCount / total).toFixed(3)}`];
  process.stderr.write(JSON.stringify(stRow) + "\n");
}

main().catch((e) => {
  process.stderr.write(`error: ${e.message}\n`);
  process.exit(1);
});