/**
 * brain.ts — Brain AI: pipeline control authority.
 *
 * Brain reads $I packets from IPool, evaluates across schemas and time,
 * and writes control decisions to PostBox outbound channel.
 *
 * Brain never enters the data pipeline. It is purely async and out-of-pipeline.
 *
 * Adapters:
 *   RuleBasedBrain  — deterministic, zero-latency (default)
 *   ClaudeBrain     — Haiku via Anthropic SDK
 *
 * Usage:
 *   // Rule-based (default)
 *   const brain = new Brain(ipool, postbox);
 *
 *   // Haiku
 *   const brain = new Brain(ipool, postbox, {
 *     adapter: new ClaudeBrain({ model: "claude-haiku-4-5-20251001" }),
 *   });
 */

import Anthropic from "@anthropic-ai/sdk";
import type { IPool } from "./i-pool.js";
import type { IPacket, AgentProfile } from "./types.js";
import type { PostBox } from "./postbox.js";

// ── Brain adapter interface ───────────────────────────────────────────────────

export interface BrainInput {
  packets: IPacket[];   // drained from IPool
}

/**
 * Brain decision — what Brain AI chooses to do.
 * All fields are optional: Brain may act on none, some, or all.
 */
export interface BrainDecision {
  /** Reroute a schema to a different pipeline. */
  rerouteSchema?: { schemaId: string; toPipelineId: string };
  /** Throttle a schema stream (rows/sec). */
  throttle?: { pipelineId: string; schemaId?: string; rps: number };
  /** Stop a pipeline or schema stream. */
  stop?: { pipelineId: string; schemaId?: string };
  /** Rewrite a Bot's AgentProfile (adjust weapon sensitivity). */
  updateProfile?: AgentProfile;
  /** Free-text rationale (logged, not acted on). */
  rationale?: string;
}

export interface BrainAdapter {
  evaluate(input: BrainInput): Promise<BrainDecision>;
}

// ── RuleBasedBrain ────────────────────────────────────────────────────────────

/**
 * RuleBasedBrain — deterministic default.
 *
 * Rules:
 *   any high severity   → stop the pipeline
 *   any medium severity → throttle to 10 rps
 *   all low / empty     → no action
 */
export class RuleBasedBrain implements BrainAdapter {
  async evaluate(input: BrainInput): Promise<BrainDecision> {
    const { packets } = input;
    if (packets.length === 0) return {};

    const maxSeverity = packets.reduce<"low" | "medium" | "high">((max, p) => {
      if (p.severity === "high")                           return "high";
      if (p.severity === "medium" && max !== "high")       return "medium";
      return max;
    }, "low");

    // use the first packet's pipelineId context (schemaId is available)
    const first = packets[0];

    if (maxSeverity === "high") {
      return {
        stop: { pipelineId: `pipeline://default`, schemaId: first.schemaId },
        rationale: `[rule] high severity $I from bot=${first.botId} — stop schema stream`,
      };
    }
    if (maxSeverity === "medium") {
      return {
        throttle: { pipelineId: `pipeline://default`, schemaId: first.schemaId, rps: 10 },
        rationale: `[rule] medium severity $I from bot=${first.botId} — throttle to 10 rps`,
      };
    }
    return { rationale: `[rule] all low severity — no action` };
  }
}

// ── ClaudeBrain ───────────────────────────────────────────────────────────────

export interface ClaudeBrainOptions {
  model?:  string;
  apiKey?: string;
}

/**
 * ClaudeBrain — Haiku as Brain AI.
 *
 * Receives all drained $I packets, reasons across them,
 * and returns a structured BrainDecision.
 */
export class ClaudeBrain implements BrainAdapter {
  private readonly client: Anthropic;
  private readonly model:  string;

  constructor(options: ClaudeBrainOptions = {}) {
    this.client = new Anthropic({ apiKey: options.apiKey });
    this.model  = options.model ?? "claude-haiku-4-5-20251001";
  }

  async evaluate(input: BrainInput): Promise<BrainDecision> {
    const { packets } = input;
    if (packets.length === 0) return {};

    const summary = packets.map((p) =>
      `- bot=${p.botId} schema=${p.schemaId} severity=${p.severity} signal="${p.signal}"`,
    ).join("\n");

    const prompt = [
      "You are a pipeline control authority (Brain AI).",
      "You receive inference signals ($I) from lightweight Bot observers.",
      "Based on the signals below, decide what control action to take.",
      "",
      "$I packets:",
      summary,
      "",
      "Available actions (respond with JSON only, omit fields you don't use):",
      JSON.stringify({
        rerouteSchema: { schemaId: "<id>", toPipelineId: "pipeline://<id>" },
        throttle:      { pipelineId: "pipeline://<id>", schemaId: "<optional>", rps: 10 },
        stop:          { pipelineId: "pipeline://<id>", schemaId: "<optional>" },
        rationale:     "<one sentence explanation>",
      }, null, 2),
    ].join("\n");

    const msg = await this.client.messages.create({
      model:      this.model,
      max_tokens: 256,
      messages:   [{ role: "user", content: prompt }],
    });

    const text = msg.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    try {
      return JSON.parse(text) as BrainDecision;
    } catch {
      return { rationale: text.slice(0, 300) };
    }
  }
}

// ── Brain ─────────────────────────────────────────────────────────────────────

export interface BrainOptions {
  adapter?:    BrainAdapter;
  /** How often to drain IPool and evaluate (ms). Default: 2000 */
  intervalMs?: number;
  /** Pipeline ID used as default target for control actions. Default: "pipeline://default" */
  pipelineId?: string;
}

export class Brain {
  private readonly ipool:      IPool;
  private readonly postbox:    PostBox;
  private readonly adapter:    BrainAdapter;
  private readonly intervalMs: number;
  private readonly pipelineId: string;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(ipool: IPool, postbox: PostBox, options: BrainOptions = {}) {
    this.ipool      = ipool;
    this.postbox    = postbox;
    this.adapter    = options.adapter    ?? new RuleBasedBrain();
    this.intervalMs = options.intervalMs ?? 2000;
    this.pipelineId = options.pipelineId ?? "pipeline://default";
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Drain IPool and evaluate immediately (useful for testing / demos). */
  async flush(): Promise<BrainDecision> {
    return this.tick();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async tick(): Promise<BrainDecision> {
    const packets = this.ipool.drain();
    const decision = await this.adapter.evaluate({ packets });
    this.apply(decision);
    return decision;
  }

  private apply(decision: BrainDecision): void {
    if (decision.stop) {
      this.postbox.issueStop(decision.stop.pipelineId, decision.stop.schemaId);
    }
    if (decision.throttle) {
      this.postbox.issueThrottle(
        decision.throttle.pipelineId,
        decision.throttle.rps,
        decision.throttle.schemaId,
      );
    }
    if (decision.rerouteSchema) {
      const table = new Map([[decision.rerouteSchema.schemaId, decision.rerouteSchema.toPipelineId]]);
      this.postbox.issueRoutingUpdate(this.pipelineId, table);
    }
    if (decision.updateProfile) {
      this.postbox.issueAgentProfileUpdate(
        decision.updateProfile.botId,
        decision.updateProfile,
      );
    }
  }
}