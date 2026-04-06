/**
 * pipeline-connector.ts — In-process inter-pipeline connection.
 *
 * PipelineConnector sits at the onPass boundary of an upstream Preprocessor
 * and forwards validated records to one or more downstream Preprocessors,
 * keyed by schemaId.
 *
 * Routing table:
 *   schemaId → Preprocessor  (specific schema)
 *   "*"      → Preprocessor  (wildcard fallback)
 *
 * Brain AI can update the routing table at runtime via setTable().
 * PipelineControl calls setTable() when it receives a routing_update from PostBox.
 *
 * Design constraints:
 *   - Synchronous, zero-copy: record reference is passed directly.
 *   - Never buffers: if no destination is found, the record is dropped silently
 *     (or an optional onDrop callback is invoked).
 *   - Same-process only: for cross-process delivery use ProxyExporter instead.
 *
 * Usage (wiring):
 *   // Upstream pipeline
 *   const connector = new PipelineConnector();
 *   connector.register("knowledge-entry:v1", pipelineB.pre);
 *   connector.register("*", pipelineC.pre);
 *
 *   preA.onPass((record, schemaId) => {
 *     // ... existing gate logic ...
 *     connector.forward(record, schemaId);
 *   });
 *
 * Usage (Brain AI runtime update):
 *   // Brain AI issues routing_update → PipelineControl.applyRoutingUpdate() calls:
 *   connector.setTable(new Map([["knowledge-entry:v1", pipelineB.pre]]));
 */

import type { Preprocessor } from "./preprocessor.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Routing table for PipelineConnector.
 * schemaId (or "*") → downstream Preprocessor instance(s).
 * Use an array for fanout (1:N delivery).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ConnectorTable = Map<string, Preprocessor<any> | Preprocessor<any>[]>;

/**
 * Called when a record has no registered destination and is dropped.
 * Optional — default is silent drop.
 */
export type ConnectorDropHandler = (record: unknown, schemaId: string) => void;

// ── PipelineConnector ─────────────────────────────────────────────────────────

/**
 * PipelineConnector — routes validated records from one pipeline to another.
 *
 * Sits at the onPass boundary of an upstream pipeline's Preprocessor.
 * Delivers records synchronously to the downstream Preprocessor.process().
 * The downstream Preprocessor re-validates, allowing each pipeline to apply
 * its own schema rules independently.
 */
export class PipelineConnector {
  private table: ConnectorTable = new Map();
  private dropHandler: ConnectorDropHandler | null = null;

  /**
   * Register a downstream Preprocessor (or multiple for fanout) for a schemaId.
   * Use "*" to register a wildcard fallback for all unmatched schemas.
   *
   * Calling register() again with the same schemaId replaces the previous entry.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(schemaId: string, target: Preprocessor<any> | Preprocessor<any>[]): void {
    this.table.set(schemaId, target);
  }

  /**
   * Remove a registered destination.
   */
  unregister(schemaId: string): void {
    this.table.delete(schemaId);
  }

  /**
   * Replace the entire routing table atomically.
   * Called by PipelineControl when Brain AI issues a routing_update.
   *
   * Note: Brain AI's routing_update uses pipelineId strings as destinations.
   * The caller is responsible for resolving pipelineId → Preprocessor mapping
   * before calling setTable().
   */
  setTable(table: ConnectorTable): void {
    this.table = table;
  }

  /**
   * Read the current routing table (for inspection / recording).
   */
  getTable(): Readonly<ConnectorTable> {
    return this.table;
  }

  /**
   * Register a drop handler invoked when no destination is found.
   * Optional — default is silent drop.
   */
  onDrop(handler: ConnectorDropHandler): void {
    this.dropHandler = handler;
  }

  /**
   * Forward a validated record to the registered downstream Preprocessor.
   *
   * Resolution order:
   *   1. Exact schemaId match
   *   2. Wildcard "*" fallback
   *   3. Drop (invoke onDrop if registered)
   *
   * The record is passed by reference — no copy is made.
   * The downstream Preprocessor.process() applies its own schema validation
   * independently (re-validation is intentional: each pipeline owns its rules).
   */
  forward(record: unknown, schemaId: string): void {
    const target = this.resolve(schemaId);
    if (!target) {
      this.dropHandler?.(record, schemaId);
      return;
    }
    if (Array.isArray(target)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const t of target) (t as Preprocessor<any>).process(record as any);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (target as Preprocessor<any>).process(record as any);
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private resolve(schemaId: string): Preprocessor | Preprocessor[] | undefined {
    return this.table.get(schemaId) ?? this.table.get("*");
  }
}