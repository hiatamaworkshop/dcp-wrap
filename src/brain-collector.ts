/**
 * BrainCollector — windowed $ST-brain statistics.
 *
 * Subscribes to "st_brain" messages on a Monitor and accumulates per-schema
 * divergence statistics between the canonical (holy scripture) adapter and
 * the primary (LLM) adapter.
 *
 * At each window boundary, emits:
 *
 *   $ST-brain  divergence statistics:
 *     ["$ST-brain", schemaId, aligned, diverged, diverge_rate,
 *      top_llm_action, top_canon_action, windowMs]
 *
 * Every n windows, a summary payload is also emitted for Brain self-calibration.
 */

import type { Monitor, PipelineMessage } from "./monitor.js";

// ── $ST-brain row ──────────────────────────────────────────────────────────────

/**
 * $ST-brain positional array:
 *   ["$ST-brain", schemaId, aligned, diverged, diverge_rate,
 *    top_llm_action, top_canon_action, windowMs]
 */
export type StBrainRow = [
  "$ST-brain",
  string,   // schemaId
  number,   // aligned count
  number,   // diverged count
  number,   // diverge_rate (0.000–1.000)
  string,   // top_llm_action (most frequent LLM action in window)
  string,   // top_canon_action (most frequent canonical action in window)
  number,   // windowMs
];

// ── Internal window state ──────────────────────────────────────────────────────

interface BrainWindow {
  aligned:      number;
  diverged:     number;
  llmActions:   Map<string, number>;
  canonActions: Map<string, number>;
  windowStart:  number;
}

export interface BrainCollectorOptions {
  /** Flush interval in ms. Default: 10000 (10s) */
  windowMs?: number;
}

// ── BrainCollector ─────────────────────────────────────────────────────────────

export class BrainCollector {
  private readonly windowMs: number;
  private readonly windows:  Map<string, BrainWindow> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly monitor: Monitor,
    options: BrainCollectorOptions = {},
  ) {
    this.windowMs  = options.windowMs ?? 10_000;
    this.onBrain   = this.onBrain.bind(this);
  }

  start(): void {
    this.monitor.subscribe("st_brain", this.onBrain);
    this.timer = setInterval(() => this.flush(), this.windowMs);
  }

  stop(): void {
    this.monitor.unsubscribe("st_brain", this.onBrain);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
  }

  // ── Handler ────────────────────────────────────────────────────────────────

  private onBrain(msg: PipelineMessage): void {
    const p = msg.payload as {
      aligned:         boolean;
      canonicalAction: string;
      llmAction:       string;
      packetCount:     number;
    };

    const schemaId = msg.schemaId;
    let win = this.windows.get(schemaId);
    if (!win) {
      win = {
        aligned:      0,
        diverged:     0,
        llmActions:   new Map(),
        canonActions: new Map(),
        windowStart:  Date.now(),
      };
      this.windows.set(schemaId, win);
    }

    if (p.aligned) {
      win.aligned++;
    } else {
      win.diverged++;
    }

    win.llmActions.set(p.llmAction,       (win.llmActions.get(p.llmAction)       ?? 0) + 1);
    win.canonActions.set(p.canonicalAction, (win.canonActions.get(p.canonicalAction) ?? 0) + 1);
  }

  // ── Flush ──────────────────────────────────────────────────────────────────

  private flush(): void {
    const now = Date.now();

    for (const [schemaId, win] of this.windows) {
      const total = win.aligned + win.diverged;
      if (total === 0) continue;

      const elapsed      = now - win.windowStart;
      const divergeRate  = parseFloat((win.diverged / total).toFixed(3));
      const topLlm       = topKey(win.llmActions);
      const topCanon     = topKey(win.canonActions);

      const row: StBrainRow = [
        "$ST-brain",
        schemaId,
        win.aligned,
        win.diverged,
        divergeRate,
        topLlm,
        topCanon,
        elapsed,
      ];

      this.monitor.emit({
        type:     "st_brain",
        schemaId,
        ts:       now,
        priority: "batch",
        payload:  row,
      });

      // Reset window
      win.aligned      = 0;
      win.diverged     = 0;
      win.llmActions   = new Map();
      win.canonActions = new Map();
      win.windowStart  = now;
    }
  }
}

// ── Helper ─────────────────────────────────────────────────────────────────────

function topKey(map: Map<string, number>): string {
  let best = "none";
  let max  = 0;
  for (const [k, v] of map) {
    if (v > max) { max = v; best = k; }
  }
  return best;
}
