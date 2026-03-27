import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DcpSchemaDef, FieldTypeDef } from "./types.js";

export class DcpSchema {
  readonly id: string;
  readonly description: string;
  readonly fields: string[];
  readonly fieldCount: number;
  readonly types: Record<string, FieldTypeDef>;

  constructor(def: DcpSchemaDef) {
    this.id = def.id;
    this.description = def.description;
    this.fields = [...def.fields];
    this.fieldCount = def.fieldCount;
    this.types = { ...def.types };
  }

  /** Bitmask with all field bits set. */
  get fullMask(): number {
    return (1 << this.fieldCount) - 1;
  }

  /** Return the bit value for a field (MSB = first field). */
  fieldBit(fieldName: string): number {
    const idx = this.fields.indexOf(fieldName);
    if (idx === -1) throw new Error(`field not found: ${fieldName}`);
    return 1 << (this.fieldCount - 1 - idx);
  }

  /** Return field names corresponding to set bits in mask. */
  fieldsFromMask(mask: number): string[] {
    return this.fields.filter(
      (_, i) => mask & (1 << (this.fieldCount - 1 - i)),
    );
  }

  /** Generate cutdown schema ID: base_id#hex_mask. */
  cutdownId(mask: number): string {
    if (mask === this.fullMask) return this.id;
    return `${this.id}#${mask.toString(16)}`;
  }

  /** Generate $S header array. */
  sHeader(mask?: number): unknown[] {
    const m = mask ?? this.fullMask;
    const active = this.fieldsFromMask(m);
    const sid = this.cutdownId(m);
    return ["$S", sid, ...active];
  }

  /** Validate a positional array against this schema. Returns error messages. */
  validateRow(row: unknown[], mask?: number): string[] {
    const active = mask != null ? this.fieldsFromMask(mask) : this.fields;
    const errors: string[] = [];

    if (row.length !== active.length) {
      errors.push(`expected ${active.length} fields, got ${row.length}`);
      return errors;
    }

    for (let i = 0; i < active.length; i++) {
      const fname = active[i];
      const ft = this.types[fname];
      if (!ft) continue;

      const value = row[i];
      const err = validateField(ft, value);
      if (err) errors.push(`field ${fname} (pos ${i}): ${err}`);
    }

    return errors;
  }

  /** Export as JSON-serializable definition. */
  toDef(): DcpSchemaDef {
    return {
      $dcp: "schema",
      id: this.id,
      description: this.description,
      fields: [...this.fields],
      fieldCount: this.fieldCount,
      types: { ...this.types },
    };
  }

  /** Save schema definition to a JSON file. */
  save(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(this.toDef(), null, 2) + "\n", "utf-8");
  }

  /** Load schema from a JSON file. */
  static fromFile(path: string): DcpSchema {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    return DcpSchema.fromDef(data);
  }

  /** Load schema from a parsed JSON object. */
  static fromDef(data: Record<string, unknown>): DcpSchema {
    if (data.$dcp !== "schema") {
      throw new Error("not a DCP schema: missing or invalid $dcp marker");
    }
    return new DcpSchema(data as unknown as DcpSchemaDef);
  }
}

function validateField(ft: FieldTypeDef, value: unknown): string | null {
  const types = Array.isArray(ft.type) ? ft.type : [ft.type];

  if (value === null || value === undefined) {
    return types.includes("null") ? null : "null not allowed";
  }

  let typeOk = false;
  for (const t of types) {
    if (t === "string" && typeof value === "string") typeOk = true;
    else if (t === "number" && typeof value === "number") typeOk = true;
    else if (t === "boolean" && typeof value === "boolean") typeOk = true;
  }
  if (!typeOk) return `expected ${ft.type}, got ${typeof value}`;

  if (ft.enum != null && !ft.enum.includes(value)) {
    return `value ${JSON.stringify(value)} not in enum`;
  }
  if (ft.min != null && typeof value === "number" && value < ft.min) {
    return `value ${value} < min ${ft.min}`;
  }
  if (ft.max != null && typeof value === "number" && value > ft.max) {
    return `value ${value} > max ${ft.max}`;
  }
  return null;
}
