import { DcpSchema } from "./schema.js";
import { FieldMapping } from "./mapping.js";
import type { EncodedBatch } from "./types.js";

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
