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

export { SchemaRegistry } from "./registry.js";
export { VShadow, vShadowFromSchema } from "./validator.js";
export type { RegistryEntry } from "./registry.js";
export type { VConstraint, VFieldResult, VRowResult } from "./validator.js";

export { Gate } from "./gate.js";
export { SimpleMonitor, NullMonitor } from "./monitor.js";
export type { GateOptions, GateResult, ValidationMode } from "./gate.js";
export type { Monitor, PipelineMessage, MessageType, FlowPayload, VResultPayload } from "./monitor.js";
