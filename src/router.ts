/**
 * Router ($R layer) — routing authority for the pipeline.
 *
 * Receives PASS rows from MessagePool via Messenger.
 * Dispatches to downstream destinations keyed by schemaId.
 *
 * The routing table is the Brain AI's configuration target.
 * Brain AI calls setTable() (via PipelineControl) to update routing at runtime.
 * The change takes effect on the next row — no pipeline interruption.
 */

import type { Messenger, MessagePool, PipelineMessage } from "./monitor.ts";
import type { VResultPayload } from "./monitor.ts";

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * pipelineId(s) as routing destination.
 * Single string or array for fanout.
 * Use "pipeline://<id>" convention.
 */
export type RoutingDestination = string | string[];

/**
 * schemaId → destination(s).
 * "*" is the wildcard fallback — matched when no specific entry exists.
 */
export type RoutingTable = Map<string, RoutingDestination>;

/**
 * A row delivered to a destination pipeline.
 * The router writes these; consumers (pipeline or PostBox) read them.
 */
export interface RoutedRow {
  pipelineId: string;
  schemaId: string;
  payload: unknown;   // original row data from VResultPayload
  ts: number;
}

/**
 * Sink that receives routed rows.
 * In-process: direct function call.
 * Cross-process / PostBox: ProxyExporter implements this.
 */
export interface RoutingSink {
  receive(row: RoutedRow): void;
}

// ── RoutingLayer ─────────────────────────────────────────────────────────────

/**
 * RoutingLayer — sole routing authority.
 *
 * Usage:
 *   const router = new RoutingLayer(pool, sink);
 *   router.setTable(new Map([["user:v1", "pipeline://ingest-01"], ["*", "pipeline://default"]]));
 *   pool.start();
 */
export class RoutingLayer {
  private table: RoutingTable = new Map([["*", "pipeline://default"]]);
  private readonly messenger: Messenger;

  constructor(
    private readonly pool: MessagePool,
    private readonly sink: RoutingSink,
  ) {
    this.messenger = {
      filter: { types: ["vResult"] },
      handle: (msgs: PipelineMessage[]) => {
        for (const msg of msgs) {
          const v = msg.payload as VResultPayload;
          if (!v.pass) continue;       // only route PASS rows
          this.route(msg.schemaId, msg.payload, msg.ts);
        }
      },
    };
    pool.addMessenger(this.messenger);
  }

  /**
   * Replace the routing table atomically.
   * Called by PipelineControl when Brain AI writes a routing update to PostBox.
   * Takes effect on the next flush cycle — no in-flight rows are reordered.
   */
  setTable(table: RoutingTable): void {
    this.table = table;
  }

  /**
   * Read current table (for inspection / recording).
   */
  getTable(): Readonly<RoutingTable> {
    return this.table;
  }

  /**
   * Detach from the pool. Call on pipeline shutdown.
   */
  detach(): void {
    this.pool.removeMessenger(this.messenger);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private route(schemaId: string, payload: unknown, ts: number): void {
    const dest = this.resolve(schemaId);
    if (!dest) return;

    if (Array.isArray(dest)) {
      // fanout — deliver to each destination independently
      for (const pipelineId of dest) {
        this.sink.receive({ pipelineId, schemaId, payload, ts });
      }
    } else {
      this.sink.receive({ pipelineId: dest, schemaId, payload, ts });
    }
  }

  private resolve(schemaId: string): RoutingDestination | undefined {
    return this.table.get(schemaId) ?? this.table.get("*");
  }
}