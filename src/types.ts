/** Type definition for a single schema field. */
export interface FieldTypeDef {
  type: string | string[];
  description?: string;
  enum?: unknown[];
  min?: number;
  max?: number;
}

/** DCP schema definition (the $dcp JSON document). */
export interface DcpSchemaDef {
  $dcp: "schema";
  id: string;
  description: string;
  fields: string[];
  fieldCount: number;
  types: Record<string, FieldTypeDef>;
}

/** Mapping: schema field name → dot.notation.path in source. */
export interface FieldMappingDef {
  schemaId: string;
  paths: Record<string, string>;
}

/** Options for schema generation. */
export interface GenerateOptions {
  domain: string;
  version?: number;
  description?: string;
  include?: string[];
  exclude?: string[];
  fieldNames?: Record<string, string>;
}

/** Inference report for a single field. */
export interface FieldReport {
  name: string;
  sourcePath: string;
  category: "identifier" | "classifier" | "numeric" | "text" | "other";
  inferredType: FieldTypeDef;
  presenceRate: number;
  uniqueCount: number;
  sampleCount: number;
  isGroupKeyCandidate: boolean;
}

/** Result of schema generation — inspectable before committing. */
export interface SchemaDraft {
  schema: DcpSchemaDef;
  mapping: FieldMappingDef;
  fieldReports: FieldReport[];
}

/** Encoded DCP output. */
export interface EncodedBatch {
  header: string;
  rows: string[];
  schemaId: string;
  mask: number;
  isCutdown: boolean;
}
