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
  | "schema_loaded" // Registry: new schema registered
  | "st_v"         // StCollector: windowed validation statistics (pass/fail)
  | "st_f";        // StCollector: windowed flow statistics (rows/sec)

export type MessagePriority = "immediate" | "batch";

export interface PipelineMessage {
  type: MessageType;
  schemaId: string;
  ts: number;
  priority?: MessagePriority;
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
 * SimpleMonitor — in-process pub/sub, synchronous dispatch.
 * Suitable for single-process pipelines with few subscribers.
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

// ── MessagePool + PooledMonitor ───────────────────────────────────────────────

export interface MessengerFilter {
  /** Message types this messenger handles. Omit or use "*" for all types. */
  types?: (MessageType | "*")[];
  /** If set, only messages with pass===false in VResultPayload are delivered. */
  failOnly?: boolean;
}

export interface Messenger {
  filter: MessengerFilter;
  handle(msgs: PipelineMessage[]): void;
}

/**
 * MessagePool — decoupled delivery layer between emitters and subscribers.
 *
 * Gate (and other emitters) call emit() and return immediately (O(1)).
 * The pool holds two queues:
 *   immediateQueue — flushed on the next flush() call unconditionally
 *   batchQueue     — flushed on flush() when windowMs has elapsed
 *
 * Flush is triggered automatically via setInterval when started, or
 * manually via flush() for testing and shutdown.
 *
 * Messengers declare a filter; the pool only delivers matching messages.
 */
export class MessagePool {
  private readonly immediateQueue: PipelineMessage[] = [];
  private readonly batchQueue: PipelineMessage[] = [];
  private readonly messengers: Messenger[] = [];
  private lastBatchFlush = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly windowMs: number = 100) {}

  push(msg: PipelineMessage): void {
    if (msg.priority === "immediate") {
      this.immediateQueue.push(msg);
    } else {
      this.batchQueue.push(msg);
    }
  }

  addMessenger(messenger: Messenger): void {
    this.messengers.push(messenger);
  }

  removeMessenger(messenger: Messenger): void {
    const idx = this.messengers.indexOf(messenger);
    if (idx !== -1) this.messengers.splice(idx, 1);
  }

  /**
   * Start automatic periodic flushing.
   * Call stop() to clear the interval (e.g. on pipeline shutdown).
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), this.windowMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush(); // drain remaining messages on shutdown
  }

  flush(): void {
    const now = Date.now();

    // Always drain immediateQueue
    if (this.immediateQueue.length > 0) {
      const msgs = this.immediateQueue.splice(0);
      this.deliver(msgs);
    }

    // Drain batchQueue only when window has elapsed
    if (now - this.lastBatchFlush >= this.windowMs && this.batchQueue.length > 0) {
      const msgs = this.batchQueue.splice(0);
      this.deliver(msgs);
      this.lastBatchFlush = now;
    }
  }

  private deliver(msgs: PipelineMessage[]): void {
    for (const messenger of this.messengers) {
      const filtered = msgs.filter((m) => this.matches(m, messenger.filter));
      if (filtered.length > 0) messenger.handle(filtered);
    }
  }

  private matches(msg: PipelineMessage, filter: MessengerFilter): boolean {
    // Type filter
    if (filter.types && !filter.types.includes("*") && !filter.types.includes(msg.type)) {
      return false;
    }
    // failOnly filter — only applies to vResult messages
    if (filter.failOnly && msg.type === "vResult") {
      const payload = msg.payload as VResultPayload;
      if (payload.pass) return false;
    }
    return true;
  }
}

/**
 * PooledMonitor — Monitor interface backed by MessagePool.
 *
 * Drop-in replacement for SimpleMonitor in high-throughput pipelines.
 * emit() is O(1): it only pushes to the pool. Delivery is asynchronous,
 * batched by windowMs (default 100ms), with immediate flush on FAIL.
 *
 * subscribe() registers a Messenger with a pass-through filter (all types).
 * For fine-grained filtering (failOnly, specific types), use addMessenger()
 * on the underlying pool directly.
 */
export class PooledMonitor implements Monitor {
  readonly pool: MessagePool;
  // Map from handler function → Messenger wrapper, for unsubscribe support
  private readonly messengerMap = new Map<(msg: PipelineMessage) => void, Messenger>();

  constructor(windowMs = 100) {
    this.pool = new MessagePool(windowMs);
  }

  emit(msg: PipelineMessage): void {
    this.pool.push(msg);
  }

  subscribe(type: MessageType | "*", handler: (msg: PipelineMessage) => void): void {
    const messenger: Messenger = {
      filter: { types: [type] },
      handle: (msgs) => { for (const m of msgs) handler(m); },
    };
    this.messengerMap.set(handler, messenger);
    this.pool.addMessenger(messenger);
  }

  unsubscribe(_type: MessageType | "*", handler: (msg: PipelineMessage) => void): void {
    const messenger = this.messengerMap.get(handler);
    if (messenger) {
      this.pool.removeMessenger(messenger);
      this.messengerMap.delete(handler);
    }
  }

  /** Start the pool's flush interval. Call on pipeline start. */
  start(): void { this.pool.start(); }

  /** Stop the pool and flush remaining messages. Call on pipeline shutdown. */
  stop(): void { this.pool.stop(); }
}