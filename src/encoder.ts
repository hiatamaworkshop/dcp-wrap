import { DcpSchema } from "./schema.js";
import { FieldMapping } from "./mapping.js";
import type { EncodedBatch } from "./types.js";

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

  const header = JSON.stringify(["$S", id, fields.length, ...fields]);
  const rows = records.map((record) => {
    const row = fields.map((f) => {
      const raw = record[f] ?? "-";
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

    // Build rows (nested arrays use $N references)
    const rows = resolvedBatch.map((resolved) => {
      const row = activeFields.map((f) => {
        const val = resolved[f] ?? "-";
        return this.encodeFieldValue(f, val);
      });
      return JSON.stringify(row);
    });

    return { header, rows, schemaId, mask, isCutdown };
  }

  /** Encode a single record, returning just the positional array. */
  encodeOne(record: Record<string, unknown>): unknown[] {
    const resolved = this.mapping.resolve(record);
    return this.schema.fields.map((f) => this.encodeFieldValue(f, resolved[f] ?? "-"));
  }

  /** Render encoded batch as a string (header + rows, newline-separated). */
  static toString(batch: EncodedBatch): string {
    if (!batch.header) return "";
    return [batch.header, ...batch.rows].join("\n");
  }

  /**
   * Encode a single field value.
   * If nestSchemas has a sub-schema for this field:
   *   Array-of-objects → ["$N", schemaId, ...rows]
   *   Empty array → ["$N", schemaId] (no rows)
   * Otherwise → pass through
   */
  private encodeFieldValue(fieldName: string, value: unknown): unknown {
    const nest = this.schema.def.nestSchemas?.[fieldName];
    if (!nest) return value;

    if (!Array.isArray(value)) return value;

    const subSchema = new DcpSchema(nest.schema);
    const sid = subSchema.id;

    if (value.length === 0) {
      return ["$N", sid];
    }

    // Check items are objects
    if (!value.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) {
      return value;
    }

    const subMapping = new FieldMapping(nest.mapping);
    const subEncoder = new DcpEncoder(subSchema, subMapping);
    const subBatch = subEncoder.encode(value as Record<string, unknown>[]);
    if (!subBatch.header) return ["$N", sid];

    const rowArrs = subBatch.rows.map((r: string) => JSON.parse(r));
    return ["$N", sid, ...rowArrs];
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
