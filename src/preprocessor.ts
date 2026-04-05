/**
 * Preprocessor — JSON record → pipeline gate.
 *
 * Sits upstream of the Encoder. Receives raw JSON objects from the source,
 * checks each against the registered schema, and decides:
 *
 *   Pass      → forward to onPass callback (Encoder entry point)
 *   Drop      → silently discard (structurally corrupt; not recoverable)
 *   Quarantine → push to PostBox; Brain AI inspects and either approves
 *                (re-inject into onPass) or rejects (drop + log)
 *
 * The Preprocessor does NOT own the encoding pipeline — it only guards the
 * entry point. It is schema-aware but treats schemas as tentative:
 * unknown fields are a schema evolution signal, not a hard error.
 *
 * Quarantine reasons:
 *   unknown_field   — field present in record but absent from schema
 *   missing_field   — required field missing from record
 *   type_mismatch   — field present but wrong JS type
 *   range_violation — numeric field outside min/max bounds
 *
 * Hard drop reasons (not quarantined):
 *   - record is null / not a plain object
 *   - schemaId field missing or not a string
 *   - schema unknown to registry AND auto-register is disabled
 */

import { randomUUID } from "node:crypto";
import type { SchemaRegistry } from "./registry.js";
import type { PostBox, QuarantineReason } from "./postbox.js";
import type { PipelineControl } from "./pipeline-control.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Raw JSON object arriving at the pipeline ingress. */
export type RawRecord = Record<string, unknown>;

/**
 * Called when a record passes preprocessing and is ready for encoding.
 * Typically wires to Encoder.encode() or a batch accumulator.
 */
export type PassHandler = (record: RawRecord, schemaId: string) => void;

/**
 * Called when a record is dropped (corrupt; not quarantinable).
 * Optional — default is silent drop.
 */
export type DropHandler = (record: unknown, reason: string) => void;

export interface PreprocessorOptions {
  /** Pipeline instance ID. Used as PostBox pipelineId in quarantine messages. */
  pipelineId: string;

  /**
   * If true, records with unknown schemaIds are auto-registered from the record
   * structure via registry.registerFromHeader(). This is permissive mode.
   * Default: false — unknown schema → Drop.
   */
  autoRegister?: boolean;

  /**
   * Fields that identify the schema of an incoming JSON record.
   * Preprocessor reads record[schemaField] to resolve the schema.
   * Default: "$schema"
   */
  schemaField?: string;
}

// ── Preprocessor ─────────────────────────────────────────────────────────────

/**
 * Preprocessor — guards the pipeline entry point.
 *
 * Usage:
 *   const pre = new Preprocessor(registry, postbox, pipelineControl, {
 *     pipelineId: "pipeline://ingest-01",
 *   });
 *   pre.onPass((record, schemaId) => encoder.encode(record, schemaId));
 *   pre.process(rawJsonObject);
 */
export class Preprocessor {
  private passHandler: PassHandler | null = null;
  private dropHandler: DropHandler | null = null;

  private readonly schemaField: string;
  private readonly autoRegister: boolean;
  private readonly ctrl: PipelineControl;

  // Throttle tracking: schemaId (or undefined for pipeline-wide) → { windowStart, count }
  private readonly throttleCounters = new Map<string | undefined, { windowStart: number; count: number }>();

  constructor(
    private readonly registry: SchemaRegistry,
    private readonly postbox: PostBox,
    pipelineControl: PipelineControl,
    private readonly options: PreprocessorOptions,
  ) {
    this.schemaField = options.schemaField ?? "$schema";
    this.autoRegister = options.autoRegister ?? false;
    this.ctrl = pipelineControl;

    // Wire Brain AI approve → re-inject into onPass
    pipelineControl.onQuarantineApprove((quarantineId, record) => {
      this.reInject(quarantineId, record);
    });
  }

  /** Register the downstream pass handler (typically Encoder.encode). */
  onPass(handler: PassHandler): void {
    this.passHandler = handler;
  }

  /** Register an optional drop handler for logging. */
  onDrop(handler: DropHandler): void {
    this.dropHandler = handler;
  }

  /**
   * Process a single raw JSON record.
   * Resolves schema, checks fields, and routes to Pass / Drop / Quarantine.
   */
  process(record: unknown): void {
    // ── Pipeline-wide stop check ──────────────────────────────────────────────
    if (this.ctrl.isStopped()) {
      this.drop(record, "pipeline stopped");
      return;
    }

    // ── Hard drop: not a plain object ─────────────────────────────────────────
    if (!isPlainObject(record)) {
      this.drop(record, "not a plain object");
      return;
    }

    const raw = record as RawRecord;

    // ── Hard drop: no schemaId ────────────────────────────────────────────────
    const schemaId = raw[this.schemaField];
    if (typeof schemaId !== "string" || schemaId.trim() === "") {
      this.drop(raw, `missing or invalid schemaId field: ${this.schemaField}`);
      return;
    }

    // ── Schema-level stop check ───────────────────────────────────────────────
    if (this.ctrl.isStopped(schemaId)) {
      this.drop(raw, `schema stopped: ${schemaId}`);
      return;
    }

    // ── Throttle check ────────────────────────────────────────────────────────
    // getRpsLimit() returns schema-specific cap, falling back to pipeline-wide cap.
    const rpsLimit = this.ctrl.getRpsLimit(schemaId);
    if (rpsLimit !== undefined && this.isThrottled(schemaId, rpsLimit)) {
      this.drop(raw, `throttled: ${schemaId} exceeds ${rpsLimit} rps`);
      return;
    }

    // ── Schema lookup ─────────────────────────────────────────────────────────
    let entry = this.registry.get(schemaId);

    if (!entry) {
      if (this.autoRegister) {
        // Build a synthetic $S header from the record's own keys and auto-register
        const keys = Object.keys(raw).filter((k) => k !== this.schemaField);
        const header: unknown[] = ["$S", schemaId, keys.length, ...keys];
        entry = this.registry.registerFromHeader(header);
      }
      if (!entry) {
        this.drop(raw, `unknown schemaId: ${schemaId}`);
        return;
      }
    }

    const { schema, vShadow } = entry;

    // ── Field-level inspection ────────────────────────────────────────────────
    const recordKeys = new Set(Object.keys(raw).filter((k) => k !== this.schemaField));
    const schemaFields = new Set(schema.fields);

    // Unknown fields — schema evolution signal
    const unknownFields = [...recordKeys].filter((k) => !schemaFields.has(k));
    if (unknownFields.length > 0) {
      this.quarantine(raw, schemaId, "unknown_field",
        `unknown fields: ${unknownFields.join(", ")}`);
      return;
    }

    // Missing required fields — any field in schema not present in record
    const missingFields = schema.fields.filter((f) => !recordKeys.has(f));
    if (missingFields.length > 0) {
      this.quarantine(raw, schemaId, "missing_field",
        `missing fields: ${missingFields.join(", ")}`);
      return;
    }

    // Type / range checks via compiled VShadow
    const vResult = vShadow.validate(raw);
    if (!vResult.pass) {
      const first = vResult.failures[0];
      const qReason: QuarantineReason =
        first.reason?.startsWith("range") ? "range_violation" : "type_mismatch";
      this.quarantine(raw, schemaId, qReason, first.reason ?? `validation failed: ${first.field}`);
      return;
    }

    // ── Pass ──────────────────────────────────────────────────────────────────
    this.passHandler?.(raw, schemaId);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private quarantine(
    record: RawRecord,
    schemaId: string,
    reason: QuarantineReason,
    detail: string,
  ): void {
    const quarantineId = randomUUID();
    this.postbox.pushQuarantine(this.options.pipelineId, {
      quarantineId,
      schemaId,
      reason,
      detail,
      record,
    });
  }

  private reInject(quarantineId: string, record: unknown): void {
    // Brain AI approved — re-process with the (possibly corrected) record.
    // If record is null Brain AI sent no correction; re-inject would re-quarantine,
    // so we trust Brain AI and forward as-is to onPass using the original schemaId.
    if (record === null || !isPlainObject(record)) {
      // No corrected record provided or invalid — skip silently
      return;
    }
    const raw = record as RawRecord;
    const schemaId = raw[this.schemaField];
    if (typeof schemaId === "string" && schemaId.trim() !== "") {
      this.passHandler?.(raw, schemaId);
    }
    // If schemaId is still missing after Brain AI correction, drop silently.
    // (quarantineId logged by Brain AI already; no further action needed here.)
    void quarantineId;
  }

  private drop(record: unknown, reason: string): void {
    this.dropHandler?.(record, reason);
    // default: silent drop
  }

  /**
   * Token-bucket style 1-second window throttle.
   * Returns true if the record should be dropped (limit exceeded).
   * Tracks per schemaId; pipeline-wide limit uses undefined key.
   */
  private isThrottled(schemaId: string, rpsLimit: number): boolean {
    const key = schemaId;
    const now = Date.now();
    let counter = this.throttleCounters.get(key);
    if (!counter || now - counter.windowStart >= 1000) {
      counter = { windowStart: now, count: 0 };
      this.throttleCounters.set(key, counter);
    }
    if (counter.count >= rpsLimit) return true;
    counter.count++;
    return false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
