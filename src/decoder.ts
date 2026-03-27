import { DcpSchema } from "./schema.js";

/** Result of decoding a single DCP row. */
export interface DecodeResult {
  keyValues: Record<string, unknown>;
  text: string;
}

/** Template map: key (e.g. enum value or "default") → template string with {{field}} placeholders. */
export type TemplateMap = Record<string, string>;

export class DcpDecoder {
  private readonly schema: DcpSchema;
  private readonly templates: TemplateMap;
  private readonly templateField: string | null;

  /**
   * @param schema - DcpSchema instance
   * @param templates - Optional templates keyed by enum value or "default".
   *                    Use {{fieldName}} for interpolation.
   * @param templateField - Field name whose value selects the template (typically an enum field).
   *                        If omitted, auto-detects first enum field.
   */
  constructor(
    schema: DcpSchema,
    templates?: TemplateMap,
    templateField?: string,
  ) {
    this.schema = schema;
    this.templates = templates ?? {};
    this.templateField = templateField ?? this.detectEnumField();
  }

  /** Decode a positional array into key-values and human-readable text. */
  decode(row: unknown[], mask?: number): DecodeResult {
    const fields = mask != null
      ? this.schema.fieldsFromMask(mask)
      : this.schema.fields;

    const keyValues: Record<string, unknown> = {};
    for (let i = 0; i < fields.length; i++) {
      keyValues[fields[i]] = i < row.length ? row[i] : null;
    }

    const text = this.renderTemplate(keyValues);
    return { keyValues, text };
  }

  /** Decode multiple rows. */
  decodeRows(rows: unknown[][], mask?: number): DecodeResult[] {
    return rows.map((row) => this.decode(row, mask));
  }

  /**
   * Parse a raw DCP string (header + rows) and decode all rows.
   * Handles $S header line, returns decoded results.
   */
  decodeRaw(raw: string): { header: unknown[]; results: DecodeResult[] } {
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (lines.length === 0) return { header: [], results: [] };

    let headerLine: unknown[] = [];
    let dataLines = lines;

    // Check if first line is a $S header
    const first = JSON.parse(lines[0]);
    if (Array.isArray(first) && first[0] === "$S") {
      headerLine = first;
      dataLines = lines.slice(1);
    }

    const results = dataLines.map((line) => {
      const row = JSON.parse(line);
      return this.decode(row);
    });

    return { header: headerLine, results };
  }

  private renderTemplate(kv: Record<string, unknown>): string {
    // Try value-specific template
    if (this.templateField && this.templates) {
      const val = kv[this.templateField];
      if (typeof val === "string" && this.templates[val]) {
        return interpolate(this.templates[val], kv);
      }
    }

    // Try default template
    if (this.templates?.["default"]) {
      return interpolate(this.templates["default"], kv);
    }

    // Fallback: field: value pairs
    return this.schema.fields
      .map((f) => {
        const v = kv[f];
        return v !== null && v !== undefined ? `${f}: ${v}` : null;
      })
      .filter(Boolean)
      .join(" | ");
  }

  private detectEnumField(): string | null {
    for (const f of this.schema.fields) {
      const ft = this.schema.types[f];
      if (ft?.enum && ft.enum.length > 0) return f;
    }
    return null;
  }
}

/** Replace {{field}} placeholders. Nulls become empty string. */
function interpolate(
  template: string,
  kv: Record<string, unknown>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = kv[key];
    return val !== null && val !== undefined ? String(val) : "";
  });
}