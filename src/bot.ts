/**
 * bot.ts — Lightweight pipeline observer (Bot).
 *
 * Bot subscribes to $ST-v / $ST-f via SimpleMonitor, runs FastGate+Weapon
 * evaluation, and — when the trigger fires — produces an $I packet that is
 * pushed to IPool for Brain AI to consume.
 *
 * L-LLM integration:
 *   Currently uses RuleBasedLlm (deterministic, zero-latency).
 *   Replace with a real phi3:mini adapter when model is available:
 *     const bot = new Bot(monitor, postbox, ipool, profile, { llm: new PhiAdapter() });
 */

import type { SimpleMonitor } from "./monitor.js";
import type { PostBox } from "./postbox.js";
import type { IPool } from "./i-pool.js";
import type { AgentProfile, Weapon, TriggerMode, IPacket } from "./types.js";
import type { StVRow, StFRow } from "./st-collector.js";
import type { OutboundMessage } from "./postbox.js";
import type { AgentProfilePayload } from "./postbox.js";

// ── Metrics snapshot passed to Weapon evaluation ──────────────────────────────

export interface StMetrics {
  pass_rate:  number;
  fail:       number;
  total:      number;
  rowsPerSec: number;
}

// ── LLM adapter (rule-based default; swap for phi3:mini later) ────────────────

export interface LlmInput {
  profile:    AgentProfile;
  schemaId:   string;
  metrics:    StMetrics;
  firedNames: string[];   // names of Weapons that fired
}

export interface LlmOutput {
  signal:   string;
  severity: "low" | "medium" | "high";
}

export interface LlmAdapter {
  infer(input: LlmInput): Promise<LlmOutput>;
}

/**
 * RuleBasedLlm — deterministic stand-in for phi3:mini.
 *
 * Severity heuristic:
 *   pass_rate < 0.5  → high
 *   pass_rate < 0.8  → medium
 *   everything else  → low
 */
export class RuleBasedLlm implements LlmAdapter {
  async infer(input: LlmInput): Promise<LlmOutput> {
    const { metrics, firedNames } = input;
    const signal = `[rule] triggered by: ${firedNames.join(", ")}`;
    let severity: LlmOutput["severity"] = "low";
    if (metrics.pass_rate < 0.5)      severity = "high";
    else if (metrics.pass_rate < 0.8) severity = "medium";
    return { signal, severity };
  }
}

// ── FastGate helpers ──────────────────────────────────────────────────────────

function evalWeapon(w: Weapon, m: StMetrics): boolean {
  const val = (m as unknown as Record<string, number>)[w.metric];
  if (val === undefined) return false;
  switch (w.op) {
    case "<":  return val <  w.threshold;
    case ">":  return val >  w.threshold;
    case "<=": return val <= w.threshold;
    case ">=": return val >= w.threshold;
    case "==": return val === w.threshold;
    case "!=": return val !== w.threshold;
    default:   return false;
  }
}

function evalTrigger(
  trigger: TriggerMode,
  weapons: Weapon[],
  metrics: StMetrics,
): { fired: boolean; firedNames: string[] } {
  const results = weapons.map((w) => ({ w, hit: evalWeapon(w, metrics) }));
  const firedNames = results.filter((r) => r.hit).map((r) => r.w.name);

  switch (trigger.mode) {
    case "any":
      return { fired: firedNames.length > 0, firedNames };
    case "score": {
      const score = results.filter((r) => r.hit).reduce((s, r) => s + r.w.weight, 0);
      return { fired: score > trigger.scoreThreshold, firedNames };
    }
    case "all":
      return { fired: firedNames.length === weapons.length, firedNames };
  }
}

// ── Bot ───────────────────────────────────────────────────────────────────────

export interface BotOptions {
  llm?: LlmAdapter;
}

export class Bot {
  private profile: AgentProfile;
  private readonly monitor: SimpleMonitor;
  private readonly postbox: PostBox;
  private readonly ipool: IPool;
  private readonly llm: LlmAdapter;

  // Running rowsPerSec — updated on every $ST-f event
  private lastRowsPerSec = 0;

  // Bound handlers (keep references so we can unsubscribe)
  private readonly stVHandler: (msg: { payload: unknown }) => void;
  private readonly stFHandler: (msg: { payload: unknown }) => void;
  private readonly apHandler:  (msg: OutboundMessage) => void;

  private running = false;

  constructor(
    monitor: SimpleMonitor,
    postbox: PostBox,
    ipool: IPool,
    profile: AgentProfile,
    options: BotOptions = {},
  ) {
    this.monitor = monitor;
    this.postbox = postbox;
    this.ipool   = ipool;
    this.profile = profile;
    this.llm     = options.llm ?? new RuleBasedLlm();

    this.stVHandler = (msg) => { void this.onStV(msg.payload as StVRow); };
    this.stFHandler = (msg) => { void this.onStF(msg.payload as StFRow); };
    this.apHandler  = (msg) => {
      if (msg.pipelineId !== this.profile.botId) return;
      this.profile = (msg.payload as AgentProfilePayload).profile;
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.monitor.subscribe("st_v", this.stVHandler);
    this.monitor.subscribe("st_f", this.stFHandler);
    this.postbox.subscribeOutbound("ap_update", this.apHandler);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.monitor.unsubscribe("st_v", this.stVHandler);
    this.monitor.unsubscribe("st_f", this.stFHandler);
    this.postbox.unsubscribeOutbound("ap_update", this.apHandler);
  }

  // ── internal ───────────────────────────────────────────────────────────────

  private async onStV(row: StVRow): Promise<void> {
    const [, schemaId, pass, fail, total, passRate] = row;
    if (!this.inScope(schemaId)) return;

    const metrics: StMetrics = {
      pass_rate:  passRate,
      fail,
      total,
      rowsPerSec: this.lastRowsPerSec,
    };

    await this.evaluate(schemaId, metrics, row);
  }

  private async onStF(row: StFRow): Promise<void> {
    const [, , rowsPerSec] = row;
    this.lastRowsPerSec = rowsPerSec;
  }

  private async evaluate(
    schemaId: string,
    metrics: StMetrics,
    context: unknown,
  ): Promise<void> {
    const { fired, firedNames } = evalTrigger(
      this.profile.trigger,
      this.profile.weapons,
      metrics,
    );
    if (!fired) return;

    const out = await this.llm.infer({
      profile: this.profile,
      schemaId,
      metrics,
      firedNames,
    });

    const packet: IPacket = {
      botId:    this.profile.botId,
      schemaId,
      signal:   out.signal,
      severity: out.severity,
      context,
      ts: Date.now(),
    };

    this.ipool.push(packet);
  }

  private inScope(schemaId: string): boolean {
    const scope = this.profile.schemaScope;
    if (!scope || scope.length === 0) return true;
    return scope.includes(schemaId);
  }
}