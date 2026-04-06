/**
 * SourceAdapter<T>
 *
 * Protocol-specific adapter interface.
 * Converts raw bytes/objects from a source into a positional array
 * conformant with the target schema — without JSON as a required intermediary.
 *
 * T = raw input type (Buffer for binary, Record for JSON, string for CSV...)
 */

import type { DcpSchema } from "./schema.js";
import type { QuarantineReason } from "./postbox.js";

export interface SourceAdapter<T = unknown> {
  /**
   * Extract schemaId from the raw input.
   * Returns null if the source cannot be identified (→ Drop).
   */
  schemaId(raw: T): string | null;

  /**
   * Convert raw input to a positional array conforming to the resolved schema.
   * Array order must match schema.fields order exactly.
   * Returns null if conversion fails (→ Drop).
   */
  decode(raw: T, schema: DcpSchema): unknown[] | null;

  /**
   * Inspect raw input for quarantine signals before decode.
   * Called after schemaId resolves successfully.
   * Returns a QuarantineReason if the adapter detects a structural issue,
   * or null if no quarantine signal is detected.
   *
   * Optional — adapters that cannot detect quarantine signals omit this.
   */
  quarantineHint?(raw: T): QuarantineReason | null;
}
