/**
 * PostBox — single message broker between all pipelines and Brain AI.
 *
 * Inbound  (pipelines → Brain AI): $ST, $I, $V fail events
 * Outbound (Brain AI → pipelines): routing_update, throttle, stop, ap_update
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

// ── Inbound message types (pipeline → PostBox) ────────────────────────────────

export type InboundType = "st_v" | "st_f" | "v_fail" | "i_result";

export interface InboundMessage {
  type: InboundType;
  pipelineId: string;
  ts: number;
  payload: unknown;
}

// ── Outbound message types (PostBox → pipeline) ──────────────────────────────

export type OutboundType = "routing_update" | "throttle" | "stop" | "ap_update";

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

export interface AgentProfilePayload {
  pipelineId: string;
  capabilities: string[];
  capacity: number;       // max rps this pipeline can sustain
  schemaAffinity: string[];  // schemaIds this pipeline handles well
}

export type OutboundPayload =
  | RoutingUpdatePayload
  | ThrottlePayload
  | StopPayload
  | AgentProfilePayload;

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