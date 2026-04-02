import type {
  DcpSchemaDef,
  NestSchemaDef,
  FieldTypeDef,
  FieldReport,
  SchemaDraft,
  GenerateOptions,
  FieldMappingDef,
} from "./types.js";
import { flattenKeys } from "./mapping.js";

// ── Field ordering heuristics ──────────────────────────────

const CATEGORY_ORDER: Record<string, number> = {
  identifier: 0,
  classifier: 1,
  numeric: 2,
  text: 3,
  other: 4,
};

const IDENTIFIER_HINTS = new Set([
  "id", "source", "name", "path", "endpoint", "url", "uri", "key",
  "file", "file_path", "doc", "document", "chunk_id", "node_id",
]);

const CLASSIFIER_HINTS = new Set([
  "status", "level", "type", "action", "method", "kind", "category",
  "state", "trigger", "mode", "role", "domain",
]);

const NUMERIC_HINTS = new Set([
  "score", "count", "weight", "latency", "page", "rank", "index",
  "chunk_index", "position", "size", "duration", "confidence",
  "distance", "similarity", "uptime", "hit_count",
]);

type Category = "identifier" | "classifier" | "numeric" | "text" | "other";

function classifyField(name: string, values: unknown[]): Category {
  const lower = name.toLowerCase();
  if (IDENTIFIER_HINTS.has(lower)) return "identifier";
  if (CLASSIFIER_HINTS.has(lower)) return "classifier";
  if (NUMERIC_HINTS.has(lower)) return "numeric";

  const nonNull = values.filter((v) => v != null);
  if (nonNull.length > 0 && nonNull.every((v) => typeof v === "number")) {
    return "numeric";
  }
  if (
    nonNull.length > 0 &&
    nonNull.every((v) => typeof v === "string" && (v as string).length > 50)
  ) {
    return "text";
  }
  if (nonNull.length > 0 && nonNull.every((v) => typeof v === "string")) {
    const uniqueRatio = new Set(nonNull).size / nonNull.length;
    if (uniqueRatio < 0.3) return "classifier";
  }
  return "other";
}

/** Check if a value is a homogeneous array of objects (candidate for nested DCP). */
function isArrayOfObjects(values: unknown[]): boolean {
  const nonNull = values.filter((v) => v != null);
  if (nonNull.length === 0) return false;
  return nonNull.every(
    (v) => Array.isArray(v) && v.length > 0 && v.every((item) => typeof item === "object" && item !== null && !Array.isArray(item)),
  );
}

function inferType(values: unknown[]): FieldTypeDef {
  const nonNull = values.filter((v) => v != null);
  const hasNull = nonNull.length < values.length;

  if (nonNull.length === 0) {
    return { type: "null" };
  }

  const typeSet = new Set<string>();
  for (const v of nonNull) {
    if (typeof v === "boolean") typeSet.add("boolean");
    else if (typeof v === "number") {
      // Separate int from float at detection time
      typeSet.add(Number.isInteger(v) ? "int" : "number");
    }
    else typeSet.add("string"); // fallback
  }

  // Mixed int+float → promote all to number
  if (typeSet.has("int") && typeSet.has("number")) {
    typeSet.delete("int");
  }

  const types = [...typeSet].sort();
  if (hasNull) types.push("null");

  const result: FieldTypeDef = {
    type: types.length === 1 ? types[0] : types,
  };

  // Enum detection (string fields only)
  if (typeSet.has("string") && typeSet.size === 1) {
    const unique = [...new Set(nonNull as string[])].sort();
    if (unique.length >= 2 && unique.length <= 10 && unique.length <= nonNull.length * 0.6) {
      result.enum = unique;
    }
  }

  // Numeric range detection — float only (int = flags/counts, no range assumption)
  if (typeSet.has("number") && typeSet.size === 1) {
    const nums = nonNull as number[];
    const lo = Math.min(...nums);
    const hi = Math.max(...nums);
    if (lo >= 0 && hi <= 1) {
      result.min = 0;
      result.max = 1;
    } else if (lo >= 0) {
      result.min = 0;
    }
  }

  // int: only attach min:0 if all values are non-negative (no upper bound assumed)
  if (typeSet.has("int") && typeSet.size === 1) {
    const nums = nonNull as number[];
    if (Math.min(...nums) >= 0) {
      result.min = 0;
    }
  }

  return result;
}

// ── Analyzed field tuple ───────────────────────────────────

interface AnalyzedField {
  schemaName: string;
  sourcePath: string;
  category: Category;
  typeInfo: FieldTypeDef;
  values: unknown[];
}

// ── SchemaGenerator ────────────────────────────────────────

export class SchemaGenerator {
  /**
   * Generate a schema draft from JSON samples.
   * Infers field types, enums, ordering, and mapping.
   */
  fromSamples(
    samples: Record<string, unknown>[],
    options: GenerateOptions,
  ): SchemaDraft {
    if (samples.length === 0) {
      throw new Error("need at least 1 sample");
    }

    const { domain, version = 1, description = "" } = options;
    const excludeSet = new Set(options.exclude ?? []);
    const includeSet = options.include ? new Set(options.include) : null;
    const fieldNames = options.fieldNames ?? {};
    const maxDepth = options.maxDepth ?? 3;
    const maxFields = options.maxFields ?? Infinity;
    const minPresence = options.minPresence ?? 0.1;

    // Step 0.5: Detect array-of-objects fields (before flattening)
    const arrayObjectFields = new Map<string, Record<string, unknown>[][]>();
    for (const sample of samples) {
      for (const [key, value] of Object.entries(sample)) {
        if (
          Array.isArray(value) &&
          value.length > 0 &&
          value.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))
        ) {
          if (!arrayObjectFields.has(key)) arrayObjectFields.set(key, []);
          arrayObjectFields.get(key)!.push(value as Record<string, unknown>[]);
        }
      }
    }

    // Step 1: Flatten and collect per-path values
    const pathValues = new Map<string, unknown[]>();

    for (const sample of samples) {
      const flat = flattenKeys(sample, "", maxDepth);
      const seenPaths = new Set<string>();

      for (const [path, value] of Object.entries(flat)) {
        if (excludeSet.has(path)) continue;
        if (includeSet && !includeSet.has(path)) continue;
        if (!pathValues.has(path)) pathValues.set(path, []);
        pathValues.get(path)!.push(value);
        seenPaths.add(path);
      }

      // Mark missing paths as null
      for (const path of pathValues.keys()) {
        if (!seenPaths.has(path)) {
          pathValues.get(path)!.push(null);
        }
      }
    }

    if (pathValues.size === 0) {
      throw new Error("no fields found in samples after filtering");
    }

    // Step 2: Analyze each field
    let analyzed: AnalyzedField[] = [];

    for (const [sourcePath, values] of pathValues) {
      const schemaName = fieldNames[sourcePath] ?? sourcePath.split(".").pop()!;
      const category = classifyField(schemaName, values);
      const typeInfo = inferType(values);
      analyzed.push({ schemaName, sourcePath, category, typeInfo, values });
    }

    // Step 2.5: Drop low-presence fields (appear in < minPresence of samples)
    analyzed = analyzed.filter((f) => {
      const presence = f.values.filter((v) => v != null).length / f.values.length;
      return presence >= minPresence;
    });

    if (analyzed.length === 0) {
      throw new Error("no fields survive presence filter");
    }

    // Step 3: Sort by DCP convention
    analyzed.sort((a, b) => {
      const catA = CATEGORY_ORDER[a.category] ?? 99;
      const catB = CATEGORY_ORDER[b.category] ?? 99;
      if (catA !== catB) return catA - catB;

      const presA = a.values.filter((v) => v != null).length / a.values.length;
      const presB = b.values.filter((v) => v != null).length / b.values.length;
      if (presA !== presB) return presB - presA; // descending

      return a.schemaName.localeCompare(b.schemaName);
    });

    // Step 3.5: Cap at maxFields (keep highest-priority fields)
    if (analyzed.length > maxFields) {
      analyzed = analyzed.slice(0, maxFields);
    }

    // Step 4: Deduplicate field names
    // Use the full source path (dot-separated) as prefix for disambiguation
    // e.g. user.url → user_url, milestone.url → milestone_url
    const seenNames = new Set<string>();
    for (const field of analyzed) {
      if (seenNames.has(field.schemaName)) {
        // Use parent path segments as prefix to disambiguate
        const parts = field.sourcePath.split(".");
        if (parts.length > 1) {
          field.schemaName = `${parts[parts.length - 2]}_${parts[parts.length - 1]}`;
        }
        // If still colliding, append incrementing suffix
        let candidate = field.schemaName;
        let i = 2;
        while (seenNames.has(candidate)) {
          candidate = `${field.schemaName}_${i}`;
          i++;
        }
        field.schemaName = candidate;
      }
      seenNames.add(field.schemaName);
    }

    // Step 5: Build schema and mapping
    const schemaId = `${domain}:v${version}`;
    const fields = analyzed.map((f) => f.schemaName);
    const types: Record<string, FieldTypeDef> = {};
    const paths: Record<string, string> = {};
    const fieldReports: FieldReport[] = [];

    const nestSchemas: Record<string, NestSchemaDef> = {};

    for (const f of analyzed) {
      types[f.schemaName] = f.typeInfo;
      paths[f.schemaName] = f.sourcePath;

      // Generate sub-schema for array-of-objects fields → nestSchemas
      const aoSamples = arrayObjectFields.get(f.sourcePath);
      if (aoSamples && aoSamples.length > 0) {
        const allItems = aoSamples.flat();
        if (allItems.length > 0) {
          const subGen = new SchemaGenerator();
          const subDraft = subGen.fromSamples(allItems, {
            domain: `${domain}.${f.schemaName}`,
            version,
            maxDepth: 0, // sub-schemas: top-level only, nested objects stay as JSON
            maxFields,
            minPresence,
          });
          types[f.schemaName] = { ...f.typeInfo, type: "array" };
          nestSchemas[f.schemaName] = {
            schema: subDraft.schema,
            mapping: subDraft.mapping,
          };
        }
      }

      const nonNull = f.values.filter((v) => v != null);
      const uniqueCount = new Set(nonNull.map(String)).size;
      const presenceRate = nonNull.length / f.values.length;
      const repetitionRate =
        nonNull.length > 0 ? 1 - uniqueCount / nonNull.length : 0;

      fieldReports.push({
        name: f.schemaName,
        sourcePath: f.sourcePath,
        category: f.category,
        inferredType: f.typeInfo,
        presenceRate,
        uniqueCount,
        sampleCount: f.values.length,
        isGroupKeyCandidate:
          repetitionRate > 0.3 &&
          (f.category === "identifier" || f.category === "classifier"),
      });
    }

    const schema: DcpSchemaDef = {
      $dcp: "schema",
      id: schemaId,
      description,
      fields,
      fieldCount: fields.length,
      types,
      ...(Object.keys(nestSchemas).length > 0 ? { nestSchemas } : {}),
    };

    const mapping: FieldMappingDef = { schemaId, paths };

    return { schema, mapping, fieldReports };
  }
}

/** Format a SchemaDraft as a human-readable report string. */
export function formatReport(draft: SchemaDraft): string {
  const lines = [
    `Schema: ${draft.schema.id}`,
    `Fields: ${draft.schema.fields.length}`,
    "",
  ];

  for (const fr of draft.fieldReports) {
    const t = Array.isArray(fr.inferredType.type)
      ? fr.inferredType.type.join("|")
      : fr.inferredType.type;
    const flags: string[] = [];
    if (fr.isGroupKeyCandidate) flags.push("group_key candidate");
    if (fr.inferredType.enum) flags.push(`enum(${fr.inferredType.enum.length})`);
    if (fr.presenceRate < 1.0)
      flags.push(`nullable(${Math.round(fr.presenceRate * 100)}%)`);
    const flagStr = flags.length > 0 ? `  [${flags.join(", ")}]` : "";
    lines.push(
      `  ${fr.name}: ${t} (source: ${fr.sourcePath}, unique: ${fr.uniqueCount}/${fr.sampleCount})${flagStr}`,
    );
  }

  return lines.join("\n");
}
