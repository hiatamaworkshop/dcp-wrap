export { DcpSchema } from "./schema.js";
export { FieldMapping, resolvePath, flattenKeys } from "./mapping.js";
export { SchemaGenerator, formatReport } from "./generator.js";
export { DcpEncoder, dcpEncode } from "./encoder.js";
export { DcpDecoder } from "./decoder.js";
export type { InlineSchema } from "./encoder.js";
export type { DecodeResult, TemplateMap } from "./decoder.js";
export type {
  DcpSchemaDef,
  NestSchemaDef,
  FieldTypeDef,
  FieldMappingDef,
  GenerateOptions,
  EncodedBatch,
  SchemaDraft,
  FieldReport,
} from "./types.js";
