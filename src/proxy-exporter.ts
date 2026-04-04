/**
 * ProxyExporter — MessagePool → PostBox bridge.
 *
 * Registers as a Messenger on the local MessagePool.
 * Exports $ST and $V-fail messages to the PostBox inbound channel.
 *
 * The pipeline has no knowledge of the PostBox address.
 * The pipeline only knows the Monitor interface.
 * ProxyExporter is the sole export point.
 *
 * Also implements RoutingSink for the $R layer:
 * routed rows are forwarded to the PostBox as "routed" events (future extension).
 * For now, RoutingSink delivery is kept local (in-process pipeline consumer).
 */

import type { Messenger, MessagePool, PipelineMessage } from "./monitor.ts";
import type { VResultPayload } from "./monitor.ts";
import type { PostBox, InboundMessage } from "./postbox.ts";

// ── ProxyExporter ─────────────────────────────────────────────────────────────

export interface ProxyExporterOptions {
  /** Pipeline instance ID. Attached to every inbound message. */
  pipelineId: string;
  /**
   * Which message types to export.
   * Default: st_v, st_f (flow/quality stats).
   * Add "v_fail" to also export validation failures.
   */
  export?: ("st_v" | "st_f" | "v_fail")[];
}

/**
 * ProxyExporter — attaches to a MessagePool, exports to a PostBox.
 *
 * Usage:
 *   const exporter = new ProxyExporter(pool, postbox, { pipelineId: "pipeline://ingest-01" });
 *   // starts immediately — no explicit start() needed
 *   // call detach() on shutdown
 */
export class ProxyExporter {
  private readonly messenger: Messenger;
  private readonly exportTypes: Set<string>;

  constructor(
    private readonly pool: MessagePool,
    private readonly postbox: PostBox,
    private readonly options: ProxyExporterOptions,
  ) {
    this.exportTypes = new Set(options.export ?? ["st_v", "st_f"]);

    const filter = this.buildFilter();
    this.messenger = {
      filter,
      handle: (msgs: PipelineMessage[]) => {
        for (const msg of msgs) this.forward(msg);
      },
    };
    pool.addMessenger(this.messenger);
  }

  /** Detach from the pool. Call on pipeline shutdown. */
  detach(): void {
    this.pool.removeMessenger(this.messenger);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private buildFilter() {
    // Collect MessagePool types we need to subscribe to
    const types: string[] = [];
    if (this.exportTypes.has("st_v")) types.push("st_v");
    if (this.exportTypes.has("st_f")) types.push("st_f");
    if (this.exportTypes.has("v_fail")) types.push("vResult");

    return {
      types: types as ("st_v" | "st_f" | "vResult")[],
      // failOnly applies only if we only want v_fail and not all vResult
      failOnly: this.exportTypes.has("v_fail") && !this.exportTypes.has("vResult"),
    };
  }

  private forward(msg: PipelineMessage): void {
    let inboundType: InboundMessage["type"] | null = null;

    if (msg.type === "st_v") {
      inboundType = "st_v";
    } else if (msg.type === "st_f") {
      inboundType = "st_f";
    } else if (msg.type === "vResult") {
      const v = msg.payload as VResultPayload;
      if (!v.pass && this.exportTypes.has("v_fail")) {
        inboundType = "v_fail";
      }
    }

    if (!inboundType) return;

    this.postbox.pushInbound({
      type: inboundType,
      pipelineId: this.options.pipelineId,
      ts: msg.ts,
      payload: msg.payload,
    });
  }
}