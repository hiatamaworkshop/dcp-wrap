/**
 * PostBox — single message broker between all pipelines and Brain AI.
 *
 * Inbound  (pipelines → Brain AI): $ST, $I, $V fail events, quarantine
 * Outbound (Brain AI → pipelines): routing_update, throttle, stop, ap_update,
 *                                   quarantine_approve, quarantine_reject
 *
 * Neither pipelines nor Brain AI know each other's internals.
 * PostBox is the only address both sides know.
 *
 * Brain AI (when integrated) will:
 *   - subscribe to inbound channels to observe pipeline state
 *   - write to outbound channel to issue control instructions
 *
 * Until Brain AI is integrated, outbound messages can be written manually
 * for testing and routing verification.
 */

import type { RoutingTable } from "./router.ts";
import type { AgentProfile } from "./types.ts";

// ── Inbound message types (pipeline → PostBox) ────────────────────────────────

export type InboundType = "st_v" | "st_f" | "v_fail" | "i_result" | "quarantine";

export interface InboundMessage {
  type: InboundType;
  pipelineId: string;
  ts: number;
  payload: unknown;
}

// ── Outbound message types (PostBox → pipeline) ──────────────────────────────

export type OutboundType =
  | "routing_update"
  | "throttle"
  | "stop"
  | "ap_update"
  | "quarantine_approve"
  | "quarantine_reject"
  | "validation_update";

// ── Quarantine types ──────────────────────────────────────────────────────────

export type QuarantineReason =
  | "unknown_field"
  | "missing_field"
  | "type_mismatch"
  | "range_violation";

/**
 * Inbound: Preprocessor detected a schema mismatch and quarantines the record.
 * Brain AI reads this, inspects the record, and issues approve or reject.
 */
export interface QuarantinePayload {
  quarantineId: string;         // unique ID for Brain AI to reference in its decision
  schemaId: string;
  reason: QuarantineReason;
  detail: string;               // human-readable description of the mismatch
  record: unknown;              // original JSON record as-is
}

/**
 * Outbound: Brain AI approves a quarantined record.
 * correctedRecord: Brain AI may return a corrected version of the record.
 * If omitted, the original record is re-injected as-is.
 */
export interface QuarantineApprovePayload {
  quarantineId: string;
  correctedRecord?: unknown;    // Brain AI may fix the record before re-injection
}

/**
 * Outbound: Brain AI rejects a quarantined record → Drop + log.
 */
export interface QuarantineRejectPayload {
  quarantineId: string;
  reason: string;               // Brain AI's explanation for the rejection
}

export interface RoutingUpdatePayload {
  table: [string, string | string[]][];   // serializable RoutingTable entries
}

export interface ThrottlePayload {
  schemaId?: string;    // if omitted: throttle entire pipeline
  rps: number;          // target rows/sec
}

export interface StopPayload {
  schemaId?: string;    // if omitted: stop entire pipeline
}

/** Outbound: Brain AI rewrites a Bot's AgentProfile. Bot reloads on receipt. */
export interface AgentProfilePayload {
  profile: AgentProfile;
}

/**
 * Outbound: Brain AI issues new per-field constraints for a schema's VShadow.
 * PipelineControl replaces the compiled VShadow in SchemaRegistry on receipt.
 * Next record processed will use the new constraints.
 */
export interface ValidationUpdatePayload {
  schemaId: string;
  /** Per-field constraints. Keys must match schema field names. */
  constraints: Record<string, import("./validator.js").VConstraint>;
}

export type OutboundPayload =
  | RoutingUpdatePayload
  | ThrottlePayload
  | StopPayload
  | AgentProfilePayload
  | QuarantineApprovePayload
  | QuarantineRejectPayload
  | ValidationUpdatePayload;

export interface OutboundMessage {
  type: OutboundType;
  pipelineId: string;   // target pipeline
  ts: number;
  payload: OutboundPayload;
}

// ── Subscriber types ──────────────────────────────────────────────────────────

export type InboundHandler  = (msg: InboundMessage)  => void;
export type OutboundHandler = (msg: OutboundMessage) => void;

// ── PostBox ───────────────────────────────────────────────────────────────────

/**
 * PostBox — in-process broker (Brain AI placeholder-ready).
 *
 * In production, replace with a named pipe / socket / queue transport.
 * The interface stays the same; only the delivery mechanism changes.
 */
export class PostBox {
  private readonly inboundSubs  = new Map<InboundType  | "*", Set<InboundHandler>>();
  private readonly outboundSubs = new Map<OutboundType | "*", Set<OutboundHandler>>();

  // ── Inbound (pipeline → Brain AI) ──────────────────────────────────────────

  /**
   * Pipelines push inbound messages here (via ProxyExporter).
   * Brain AI (or Recorder) subscribes to receive them.
   */
  pushInbound(msg: InboundMessage): void {
    this.dispatchInbound(msg.type, msg);
    this.dispatchInbound("*", msg);
  }

  subscribeInbound(type: InboundType | "*", handler: InboundHandler): void {
    if (!this.inboundSubs.has(type)) this.inboundSubs.set(type, new Set());
    this.inboundSubs.get(type)!.add(handler);
  }

  unsubscribeInbound(type: InboundType | "*", handler: InboundHandler): void {
    this.inboundSubs.get(type)?.delete(handler);
  }

  // ── Outbound (Brain AI → pipeline) ─────────────────────────────────────────

  /**
   * Brain AI (or test code) writes control decisions here.
   * PipelineControl subscribes and applies instructions locally.
   */
  pushOutbound(msg: OutboundMessage): void {
    this.dispatchOutbound(msg.type, msg);
    this.dispatchOutbound("*", msg);
  }

  subscribeOutbound(type: OutboundType | "*", handler: OutboundHandler): void {
    if (!this.outboundSubs.has(type)) this.outboundSubs.set(type, new Set());
    this.outboundSubs.get(type)!.add(handler);
  }

  unsubscribeOutbound(type: OutboundType | "*", handler: OutboundHandler): void {
    this.outboundSubs.get(type)?.delete(handler);
  }

  // ── Convenience: issue routing update (for manual testing / Brain AI) ───────

  /**
   * Write a routing_update to the outbound channel.
   * PipelineControl on the target pipeline will apply it.
   */
  issueRoutingUpdate(pipelineId: string, table: RoutingTable): void {
    const entries: [string, string | string[]][] = [];
    for (const [k, v] of table) entries.push([k, v]);
    this.pushOutbound({
      type: "routing_update",
      pipelineId,
      ts: Date.now(),
      payload: { table: entries } satisfies RoutingUpdatePayload,
    });
  }

  issueThrottle(pipelineId: string, rps: number, schemaId?: string): void {
    this.pushOutbound({
      type: "throttle",
      pipelineId,
      ts: Date.now(),
      payload: { rps, schemaId } satisfies ThrottlePayload,
    });
  }

  issueStop(pipelineId: string, schemaId?: string): void {
    this.pushOutbound({
      type: "stop",
      pipelineId,
      ts: Date.now(),
      payload: { schemaId } satisfies StopPayload,
    });
  }

  /**
   * Preprocessor pushes a quarantined record to Brain AI for inspection.
   * Brain AI will respond with quarantine_approve or quarantine_reject.
   */
  pushQuarantine(pipelineId: string, payload: QuarantinePayload): void {
    this.pushInbound({
      type: "quarantine",
      pipelineId,
      ts: Date.now(),
      payload,
    });
  }

  /**
   * Brain AI (or test code) approves a quarantined record.
   * PipelineControl re-injects correctedRecord (or original) into the Encoder.
   */
  issueQuarantineApprove(pipelineId: string, payload: QuarantineApprovePayload): void {
    this.pushOutbound({
      type: "quarantine_approve",
      pipelineId,
      ts: Date.now(),
      payload,
    });
  }

  /**
   * Brain AI rewrites a Bot's AgentProfile.
   * Bot subscribes to "ap_update" outbound and reloads its weapons on receipt.
   */
  issueAgentProfileUpdate(botId: string, profile: AgentProfile): void {
    this.pushOutbound({
      type: "ap_update",
      pipelineId: botId,
      ts: Date.now(),
      payload: { profile } satisfies AgentProfilePayload,
    });
  }

  /**
   * Brain AI issues updated validation constraints for a schema.
   * PipelineControl recompiles and replaces the VShadow in SchemaRegistry.
   */
  issueValidationUpdate(
    pipelineId: string,
    schemaId: string,
    constraints: ValidationUpdatePayload["constraints"],
  ): void {
    this.pushOutbound({
      type: "validation_update",
      pipelineId,
      ts: Date.now(),
      payload: { schemaId, constraints } satisfies ValidationUpdatePayload,
    });
  }

  /**
   * Brain AI rejects a quarantined record → PipelineControl drops it.
   */
  issueQuarantineReject(pipelineId: string, payload: QuarantineRejectPayload): void {
    this.pushOutbound({
      type: "quarantine_reject",
      pipelineId,
      ts: Date.now(),
      payload,
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private dispatchInbound(type: InboundType | "*", msg: InboundMessage): void {
    const set = this.inboundSubs.get(type);
    if (!set) return;
    for (const h of set) h(msg);
  }

  private dispatchOutbound(type: OutboundType | "*", msg: OutboundMessage): void {
    const set = this.outboundSubs.get(type);
    if (!set) return;
    for (const h of set) h(msg);
  }
}