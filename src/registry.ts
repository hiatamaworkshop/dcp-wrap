/**
 * SchemaRegistry
 *
 * In-memory store for active schemas and their compiled shadows.
 * Loaded from disk on demand; immutable during a pipeline run.
 *
 * Lookup is O(1) via Map. Shadows are compiled once at load time.
 */

import { readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { DcpSchema } from "./schema.js";
import { vShadowFromSchema, VShadow } from "./validator.js";
import type { DcpSchemaDef } from "./types.js";

export interface RegistryEntry {
  schema: DcpSchema;
  vShadow: VShadow;
}

export class SchemaRegistry {
  private readonly entries: Map<string, RegistryEntry> = new Map();

  // ── Load ────────────────────────────────────────────────────

  /**
   * Load a single schema def directly (e.g. inferred at runtime).
   * Compiles $V shadow immediately.
   */
  register(def: DcpSchemaDef): void {
    if (this.entries.has(def.id)) return; // already loaded — immutable
    const schema = new DcpSchema(def);
    const vShadow = vShadowFromSchema(schema.def);
    this.entries.set(def.id, { schema, vShadow });
  }

  /**
   * Load a schema from a JSON file path.
   * Skips if schemaId already registered.
   */
  loadFile(path: string): void {
    const schema = DcpSchema.fromFile(path);
    if (this.entries.has(schema.id)) return;
    const vShadow = vShadowFromSchema(schema.def);
    this.entries.set(schema.id, { schema, vShadow });
  }

  /**
   * Load all *.json schema files from a directory.
   * Skips mapping files (*.mapping.json) and unknown formats.
   */
  loadDir(dirPath: string): void {
    if (!existsSync(dirPath)) return;
    const files = readdirSync(dirPath).filter(
      (f) => f.endsWith(".json") && !f.endsWith(".mapping.json"),
    );
    for (const file of files) {
      try {
        this.loadFile(join(dirPath, file));
      } catch {
        // Not a valid schema file — skip silently
      }
    }
  }

  // ── Lookup ──────────────────────────────────────────────────

  /** Get entry by schemaId. Returns undefined if not loaded. */
  get(schemaId: string): RegistryEntry | undefined {
    return this.entries.get(schemaId);
  }

  /** Returns true if schemaId is loaded. */
  has(schemaId: string): boolean {
    return this.entries.has(schemaId);
  }

  /** All loaded schema IDs. */
  ids(): string[] {
    return [...this.entries.keys()];
  }

  /** Number of loaded schemas. */
  get size(): number {
    return this.entries.size;
  }

  // ── Convenience ─────────────────────────────────────────────

  /**
   * Parse a $S header row and ensure its schema is registered.
   * If not found in registry, returns undefined — caller decides.
   *
   * $S format: ["$S", schemaId, fieldCount, ...fields]
   */
  resolveFromHeader(header: unknown[]): RegistryEntry | undefined {
    if (header[0] !== "$S" || typeof header[1] !== "string") return undefined;
    return this.entries.get(header[1]);
  }

  /**
   * Register a schema derived from a $S header row at runtime.
   * Used when a stream introduces a schema not pre-loaded from disk.
   * Fields get type "string" by default — no type inference possible from header alone.
   *
   * $S format: ["$S", schemaId, fieldCount, ...fields]
   */
  registerFromHeader(header: unknown[]): RegistryEntry | undefined {
    if (header[0] !== "$S" || typeof header[1] !== "string") return undefined;
    const schemaId = header[1] as string;
    if (this.entries.has(schemaId)) return this.entries.get(schemaId);

    const fieldCount = typeof header[2] === "number" ? header[2] : header.length - 3;
    const fields = header.slice(3, 3 + fieldCount) as string[];

    const def: DcpSchemaDef = {
      $dcp: "schema",
      id: schemaId,
      description: "",
      fields,
      fieldCount: fields.length,
      types: Object.fromEntries(fields.map((f) => [f, { type: "string" }])),
    };

    this.register(def);
    return this.entries.get(schemaId);
  }

  /** Debug summary. */
  summary(): string {
    if (this.entries.size === 0) return "SchemaRegistry: empty";
    const lines = [`SchemaRegistry: ${this.entries.size} schema(s)`];
    for (const [id, entry] of this.entries) {
      lines.push(`  ${id}  fields:[${entry.schema.fields.join(",")}]`);
    }
    return lines.join("\n");
  }
}

/** Derive a base schema ID from a file name (strips path + extension). */
export function schemaIdFromFile(filePath: string): string {
  return basename(filePath).replace(/\.json$/, "");
}