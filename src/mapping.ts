import type { FieldMappingDef } from "./types.js";

/** Flatten nested object into dot-notation keys with leaf values. */
export function flattenKeys(
  obj: Record<string, unknown>,
  prefix = "",
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(result, flattenKeys(v as Record<string, unknown>, fullKey));
    } else {
      result[fullKey] = v;
    }
  }
  return result;
}

/** Resolve a dot-notation path against an object. Returns undefined if missing. */
export function resolvePath(obj: unknown, path: string): unknown {
  let current = obj;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current ?? undefined;
}

export class FieldMapping {
  readonly schemaId: string;
  readonly paths: Record<string, string>;

  constructor(def: FieldMappingDef) {
    this.schemaId = def.schemaId;
    this.paths = { ...def.paths };
  }

  /** Resolve all mapped fields from a source object. */
  resolve(source: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [field, path] of Object.entries(this.paths)) {
      result[field] = resolvePath(source, path);
    }
    return result;
  }

  /** Resolve fields in schema order, returning a positional array. */
  resolveToRow(source: Record<string, unknown>, fields: string[]): unknown[] {
    const resolved = this.resolve(source);
    return fields.map((f) => resolved[f] ?? null);
  }

  /** Return a new FieldMapping with some paths overridden. */
  withOverrides(overrides: Record<string, string>): FieldMapping {
    return new FieldMapping({
      schemaId: this.schemaId,
      paths: { ...this.paths, ...overrides },
    });
  }

  /** Auto-bind schema fields to source paths by name matching. */
  static autoBind(
    schemaId: string,
    fields: string[],
    sample: Record<string, unknown>,
    overrides?: Record<string, string>,
  ): FieldMapping {
    const ov = overrides ?? {};
    const flat = flattenKeys(sample);
    const paths: Record<string, string> = {};

    for (const fieldName of fields) {
      if (fieldName in ov) {
        paths[fieldName] = ov[fieldName];
        continue;
      }
      // Top-level exact match
      if (
        fieldName in sample &&
        (typeof sample[fieldName] !== "object" || sample[fieldName] === null)
      ) {
        paths[fieldName] = fieldName;
        continue;
      }
      // Nested leaf match
      const candidates = Object.keys(flat).filter(
        (p) => p.split(".").pop() === fieldName,
      );
      if (candidates.length === 1) {
        paths[fieldName] = candidates[0];
      } else if (candidates.length > 1) {
        paths[fieldName] = candidates.reduce((a, b) =>
          a.length <= b.length ? a : b,
        );
      }
    }

    return new FieldMapping({ schemaId, paths });
  }

  toDef(): FieldMappingDef {
    return { schemaId: this.schemaId, paths: { ...this.paths } };
  }
}
