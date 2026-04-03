/**
 * $ST Collector — windowed pass/fail statistics subscriber.
 *
 * Subscribes to "vResult" messages on a Monitor and accumulates
 * per-schema pass/fail counts. At each window boundary, emits a
 * $ST positional array as the payload — conforming to DCP Stats Shadow form:
 *
 *   ["$ST", schemaId, pass_count, fail_count, sample_n, pass_rate]
 *
 * This follows the DCP convention: in-memory aggregation uses $ST form.
 * Positional array, schema-scoped, emitted per window boundary.
 *
 * Usage:
 *   const st = new StCollector(monitor, { windowMs: 1000 });
 *   st.start();
 *   // ... pipeline runs ...
 *   st.stop(); // flushes final window
 */

import type { Monitor, PipelineMessage, VResultPayload } from "./monitor.js";

export interface StWindow {
  schemaId: string;
  pass: number;
  fail: number;
  windowStart: number;
}

/**
 * $ST positional array: ["$ST", schemaId, pass, fail, total, pass_rate, window_ms]
 * Conforms to DCP Stats Shadow form.
 */
export type StRow = [
  "$ST",
  string,   // schemaId
  number,   // pass_count
  number,   // fail_count
  number,   // sample_n (total)
  string,   // pass_rate  e.g. "0.999"
  string,   // window_ms  e.g. "1000ms"
];

export interface StCollectorOptions {
  /** Flush interval in ms. Default: 1000 */
  windowMs?: number;
}

export class StCollector {
  private readonly windowMs: number;
  private readonly windows: Map<string, StWindow> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly monitor: Monitor,
    options: StCollectorOptions = {},
  ) {
    this.windowMs = options.windowMs ?? 1000;
    this.onVResult = this.onVResult.bind(this);
  }

  start(): void {
    this.monitor.subscribe("vResult", this.onVResult);
    this.timer = setInterval(() => this.flush(), this.windowMs);
  }

  stop(): void {
    this.monitor.unsubscribe("vResult", this.onVResult);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush(); // drain remaining counts
  }

  private onVResult(msg: PipelineMessage): void {
    const p = msg.payload as VResultPayload;
    let win = this.windows.get(msg.schemaId);
    if (!win) {
      win = { schemaId: msg.schemaId, pass: 0, fail: 0, windowStart: Date.now() };
      this.windows.set(msg.schemaId, win);
    }
    if (p.pass) win.pass++; else win.fail++;
  }

  private flush(): void {
    const now = Date.now();
    for (const [schemaId, win] of this.windows) {
      const total = win.pass + win.fail;
      if (total === 0) continue;

      const elapsed = now - win.windowStart;
      const stRow: StRow = [
        "$ST",
        schemaId,
        win.pass,
        win.fail,
        total,
        (win.pass / total).toFixed(3),
        `${elapsed}ms`,
      ];

      this.monitor.emit({
        type: "st",
        schemaId,
        ts: now,
        priority: "batch",
        payload: stRow,
      });

      // Reset window
      win.pass = 0;
      win.fail = 0;
      win.windowStart = now;
    }
  }
}