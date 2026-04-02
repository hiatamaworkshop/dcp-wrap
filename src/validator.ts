/**
 * $V — Validation Shadow runner.
 *
 * Applies per-field constraints to a DCP body row.
 * Shadows are independent observations — validation failure does not
 * modify the body; it produces a result the caller acts on.
 */

import type { DcpSchemaDef, FieldTypeDef } from "./types.js";

export interface VConstraint {
  /** Expected type: "string" | "number" | "boolean" | "int" */
  type?: string;
  /** Allowed values (enum check) */
  enum?: unknown[];
  /** Inclusive min for numbers */
  min?: number;
  /** Inclusive max for numbers */
  max?: number;
  /** Regex pattern (string fields) */
  pattern?: string;
  /** Max string length */
  maxLength?: number;
  /** Allow "-" as absent marker */
  nullable?: boolean;
}

export interface VFieldResult {
  field: string;
  value: unknown;
  pass: boolean;
  reason?: string;
}

export interface VRowResult {
  pass: boolean;
  failures: VFieldResult[];
}

/**
 * Derive a $V shadow from a DcpSchemaDef.
 *
 * Maps FieldTypeDef entries to VConstraint automatically.
 * Regex patterns are compiled once here — not per row.
 *
 * Nullable fields (type includes "null") get nullable:true.
 * Array fields (tags etc.) are validated as string post-join.
 */
export function vShadowFromSchema(schema: DcpSchemaDef): VShadow {
  const constraints: Record<string, VConstraint> = {};

  for (const field of schema.fields) {
    const typeDef: FieldTypeDef | undefined = schema.types[field];
    if (!typeDef) continue;

    const c: VConstraint = {};
    const types = Array.isArray(typeDef.type) ? typeDef.type : [typeDef.type];
    const nonNull = types.filter((t) => t !== "null");
    const isNullable = types.includes("null");

    if (isNullable) c.nullable = true;

    if (nonNull.length === 1) {
      const t = nonNull[0];
      if (t === "int") {
        c.type = "int";
      } else if (t === "number") {
        c.type = "number";
      } else if (t === "boolean") {
        c.type = "boolean";
      } else if (t === "string") {
        c.type = "string";
      } else if (t === "array") {
        // encoded as joined string in DCP rows
        c.type = "string";
      }
      // "null" only → no type constraint
    }
    // mixed non-null types → no type constraint (too permissive to enforce)

    if (typeDef.enum !== undefined) {
      c.enum = typeDef.enum;
    }

    if (typeDef.min !== undefined) c.min = typeDef.min;
    if (typeDef.max !== undefined) c.max = typeDef.max;

    constraints[field] = c;
  }

  return new VShadow(schema.id, constraints);
}

/**
 * Validation shadow bound to a schema.
 * constraints keys must match the schema field names in order.
 */
export class VShadow {
  readonly schemaId: string;
  private readonly constraints: Record<string, VConstraint>;
  private readonly compiledPatterns: Map<string, RegExp>;

  constructor(schemaId: string, constraints: Record<string, VConstraint>) {
    this.schemaId = schemaId;
    this.constraints = constraints;
    // Compile all regex patterns once at construction time
    this.compiledPatterns = new Map();
    for (const [field, c] of Object.entries(constraints)) {
      if (c.pattern) {
        this.compiledPatterns.set(field, new RegExp(c.pattern));
      }
    }
  }

  /** Validate a decoded row object (field name → value). */
  validate(row: Record<string, unknown>): VRowResult {
    const failures: VFieldResult[] = [];

    for (const [field, constraint] of Object.entries(this.constraints)) {
      const value = row[field];
      const compiled = this.compiledPatterns.get(field);
      const result = checkField(field, value, constraint, compiled);
      if (!result.pass) {
        failures.push(result);
      }
    }

    return { pass: failures.length === 0, failures };
  }

  /** Validate a positional row array against ordered field names. */
  validatePositional(fields: string[], row: unknown[]): VRowResult {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < fields.length; i++) {
      obj[fields[i]] = row[i];
    }
    return this.validate(obj);
  }
}

function checkField(
  field: string,
  value: unknown,
  c: VConstraint,
  compiledPattern?: RegExp,
): VFieldResult {
  const absent = value === "-" || value == null;

  if (absent) {
    if (c.nullable) return { field, value, pass: true };
    return { field, value, pass: false, reason: "absent" };
  }

  if (c.type) {
    if (c.type === "int") {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return { field, value, pass: false, reason: `expected int, got ${typeof value}` };
      }
    } else if (typeof value !== c.type) {
      return { field, value, pass: false, reason: `expected ${c.type}, got ${typeof value}` };
    }
  }

  if (c.enum !== undefined && !c.enum.includes(value)) {
    return { field, value, pass: false, reason: `not in enum [${c.enum.join(",")}]` };
  }

  if (typeof value === "number") {
    if (c.min !== undefined && value < c.min) {
      return { field, value, pass: false, reason: `${value} < min(${c.min})` };
    }
    if (c.max !== undefined && value > c.max) {
      return { field, value, pass: false, reason: `${value} > max(${c.max})` };
    }
  }

  if (typeof value === "string") {
    if (c.maxLength !== undefined && value.length > c.maxLength) {
      return { field, value, pass: false, reason: `length ${value.length} > maxLength(${c.maxLength})` };
    }
    if (compiledPattern !== undefined && !compiledPattern.test(value)) {
      return { field, value, pass: false, reason: `pattern mismatch: ${c.pattern}` };
    }
  }

  return { field, value, pass: true };
}