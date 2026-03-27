import { DcpSchema } from "./schema.js";
import { FieldMapping } from "./mapping.js";
import type { DcpSchemaDef, EncodedBatch } from "./types.js";

/** Inline schema for dcpEncode — no files, no generator. */
export interface InlineSchema {
  id: string;
  fields: string[];
}

/**
 * One-step DCP encode. No schema file, no generator, no mapping.
 * For known structures where fields match source keys directly.
 *
 * Arrays are auto-joined with comma. Use transform for custom handling.
 *
 * @example
 * ```ts
 * const dcp = dcpEncode(results, {
 *   id: "engram-recall:v1",
 *   fields: ["id", "relevance", "summary", "tags", "hitCount", "weight", "status"],
 * });
 * // → header + rows as newline-separated string
 * ```
 */
export function dcpEncode(
  records: Record<string, unknown>[],
  schema: InlineSchema,
  options?: { transform?: Record<string, (v: unknown) => unknown> },
): string {
  if (records.length === 0) return "";

  const { id, fields } = schema;
  const transforms = options?.transform ?? {};

  const header = JSON.stringify(["$S", id, ...fields]);
  const rows = records.map((record) => {
    const row = fields.map((f) => {
      const raw = record[f] ?? null;
      if (transforms[f]) {
        return transforms[f](raw);
      }
      if (Array.isArray(raw)) {
        return raw.join(",") || "-";
      }
      return raw;
    });
    return JSON.stringify(row);
  });

  return [header, ...rows].join("\n");
}

export class DcpEncoder {
  private readonly schema: DcpSchema;
  private readonly mapping: FieldMapping;

  constructor(schema: DcpSchema, mapping: FieldMapping) {
    this.schema = schema;
    this.mapping = mapping;
  }

  /** Encode a batch of records into DCP format. */
  encode(records: Record<string, unknown>[]): EncodedBatch {
    if (records.length === 0) {
      return {
        header: "",
        rows: [],
        schemaId: this.schema.id,
        mask: 0,
        isCutdown: false,
      };
    }

    // Resolve all mappings
    const resolvedBatch = records.map((r) => this.mapping.resolve(r));

    // Detect field presence mask
    const mask = this.detectMask(resolvedBatch);
    if (mask === 0) {
      return {
        header: "",
        rows: [],
        schemaId: this.schema.id,
        mask: 0,
        isCutdown: false,
      };
    }

    const isCutdown = mask !== this.schema.fullMask;
    const activeFields = this.schema.fieldsFromMask(mask);
    const schemaId = this.schema.cutdownId(mask);

    // Build $S header
    const headerArr = this.schema.sHeader(mask);
    const header = JSON.stringify(headerArr);

    // Build rows
    const rows = resolvedBatch.map((resolved) => {
      const row = activeFields.map((f) => resolved[f] ?? null);
      return JSON.stringify(row);
    });

    return { header, rows, schemaId, mask, isCutdown };
  }

  /** Encode a single record, returning just the positional array. */
  encodeOne(record: Record<string, unknown>): unknown[] {
    const resolved = this.mapping.resolve(record);
    return this.schema.fields.map((f) => resolved[f] ?? null);
  }

  /** Render encoded batch as a string (header + rows, newline-separated). */
  static toString(batch: EncodedBatch): string {
    if (!batch.header) return "";
    return [batch.header, ...batch.rows].join("\n");
  }

  private detectMask(resolvedBatch: Record<string, unknown>[]): number {
    let mask = 0;
    const fc = this.schema.fieldCount;
    for (const resolved of resolvedBatch) {
      for (let i = 0; i < this.schema.fields.length; i++) {
        if (resolved[this.schema.fields[i]] != null) {
          mask |= 1 << (fc - 1 - i);
        }
      }
    }
    return mask;
  }
}
