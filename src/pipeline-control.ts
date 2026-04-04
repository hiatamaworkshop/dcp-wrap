/**
 * PipelineControl — PostBox outbound → local pipeline application.
 *
 * Subscribes to the PostBox outbound channel filtered by this pipeline's ID.
 * Translates Brain AI decisions into local pipeline state changes:
 *   routing_update → RoutingLayer.setTable()
 *   throttle       → ThrottleState (Streamer reads this)
 *   stop           → StopState
 *   ap_update      → AgentProfileMap (Brain AI reads; not applicable here)
 *
 * Brain AI writes to PostBox; PipelineControl applies locally.
 * Brain AI never touches pipeline internals directly.
 */

import type { PostBox, OutboundMessage, RoutingUpdatePayload, ThrottlePayload, StopPayload } from "./postbox.ts";
import type { RoutingLayer, RoutingTable } from "./router.ts";

// ── State types ───────────────────────────────────────────────────────────────

export interface ThrottleState {
  /** schemaId → rps cap. undefined key = pipeline-wide cap. */
  limits: Map<string | undefined, number>;
}

export interface StopState {
  /** schemaIds to stop. Empty set = stop entire pipeline. */
  stopped: Set<string | undefined>;
}

// ── PipelineControl ───────────────────────────────────────────────────────────

/**
 * PipelineControl — wires PostBox outbound to local pipeline components.
 *
 * Usage:
 *   const ctrl = new PipelineControl("pipeline://ingest-01", postbox, router);
 *   // Brain AI calls postbox.issueRoutingUpdate("pipeline://ingest-01", newTable)
 *   // → ctrl applies it to router automatically
 *   ctrl.detach(); // on shutdown
 */
export class PipelineControl {
  readonly throttle: ThrottleState = { limits: new Map() };
  readonly stop: StopState = { stopped: new Set() };

  private readonly handler: (msg: OutboundMessage) => void;

  constructor(
    readonly pipelineId: string,
    private readonly postbox: PostBox,
    private readonly router: RoutingLayer,
  ) {
    this.handler = (msg: OutboundMessage) => {
      if (msg.pipelineId !== this.pipelineId) return;
      this.apply(msg);
    };
    postbox.subscribeOutbound("*", this.handler);
  }

  /** Detach from PostBox. Call on pipeline shutdown. */
  detach(): void {
    this.postbox.unsubscribeOutbound("*", this.handler);
  }

  /** True if the given schemaId (or the pipeline entirely) has been stopped. */
  isStopped(schemaId?: string): boolean {
    return this.stop.stopped.has(undefined) || this.stop.stopped.has(schemaId);
  }

  /** rps cap for the given schemaId, or pipeline-wide cap, or undefined (uncapped). */
  getRpsLimit(schemaId?: string): number | undefined {
    return this.throttle.limits.get(schemaId) ?? this.throttle.limits.get(undefined);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private apply(msg: OutboundMessage): void {
    switch (msg.type) {
      case "routing_update":
        this.applyRoutingUpdate(msg.payload as RoutingUpdatePayload);
        break;
      case "throttle":
        this.applyThrottle(msg.payload as ThrottlePayload);
        break;
      case "stop":
        this.applyStop(msg.payload as StopPayload);
        break;
      case "ap_update":
        // AgentProfile updates are consumed by Brain AI's in-memory registry.
        // PipelineControl receives them but has no local action to take.
        break;
    }
  }

  private applyRoutingUpdate(payload: RoutingUpdatePayload): void {
    const table: RoutingTable = new Map();
    for (const [schemaId, dest] of payload.table) {
      table.set(schemaId, dest);
    }
    this.router.setTable(table);
  }

  private applyThrottle(payload: ThrottlePayload): void {
    // schemaId undefined = pipeline-wide throttle
    this.throttle.limits.set(payload.schemaId, payload.rps);
  }

  private applyStop(payload: StopPayload): void {
    // schemaId undefined = stop entire pipeline
    this.stop.stopped.add(payload.schemaId);
  }
}