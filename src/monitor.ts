/**
 * Monitor — pipeline message bus interface.
 *
 * Components emit messages; subscribers receive them.
 * Emitters know only this interface — never the concrete subscriber.
 */

export type MessageType =
  | "flow"         // Streamer: rows/sec per schema
  | "vResult"      // Gate: validation result for a row
  | "promote"      // Gate → slot manager: promote schema to fixed slot
  | "schema_loaded"; // Registry: new schema registered

export interface PipelineMessage {
  type: MessageType;
  schemaId: string;
  ts: number;
  payload: unknown;
}

export interface FlowPayload {
  rowsPerSec: number;
  windowMs: number;
}

export interface VResultPayload {
  index: number;
  pass: boolean;
  failures: { field: string; reason: string }[];
  mode: string;
  emitted: boolean; // whether the row was sent downstream
}

export interface Monitor {
  emit(msg: PipelineMessage): void;
  subscribe(type: MessageType | "*", handler: (msg: PipelineMessage) => void): void;
  unsubscribe(type: MessageType | "*", handler: (msg: PipelineMessage) => void): void;
}

/**
 * NullMonitor — no-op implementation.
 * Used when no monitoring is needed; removes null checks in Gate/Streamer.
 */
export class NullMonitor implements Monitor {
  emit(_msg: PipelineMessage): void {}
  subscribe(_type: MessageType | "*", _handler: (msg: PipelineMessage) => void): void {}
  unsubscribe(_type: MessageType | "*", _handler: (msg: PipelineMessage) => void): void {}
}

/**
 * SimpleMonitor — in-process pub/sub.
 * Suitable for single-process pipelines.
 */
export class SimpleMonitor implements Monitor {
  private readonly handlers: Map<string, Set<(msg: PipelineMessage) => void>> = new Map();

  emit(msg: PipelineMessage): void {
    this.dispatch(msg.type, msg);
    this.dispatch("*", msg);
  }

  subscribe(type: MessageType | "*", handler: (msg: PipelineMessage) => void): void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
  }

  unsubscribe(type: MessageType | "*", handler: (msg: PipelineMessage) => void): void {
    this.handlers.get(type)?.delete(handler);
  }

  private dispatch(type: string, msg: PipelineMessage): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const h of set) h(msg);
  }
}