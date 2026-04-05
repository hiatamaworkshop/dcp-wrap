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
import type { PostBox, QuarantineApprovePayload, QuarantineRejectPayload, QuarantinePayload } from "./postbox.js";

// ── Brain adapter interface ───────────────────────────────────────────────────

export interface BrainInput {
  packets: IPacket[];                                      // drained from IPool
  quarantines: { pipelineId: string; payload: QuarantinePayload }[];  // pending quarantine items
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
  /** Approve a quarantined record (optionally with correction). */
  quarantineApprove?: { pipelineId: string } & QuarantineApprovePayload;
  /** Reject a quarantined record. */
  quarantineReject?: { pipelineId: string } & QuarantineRejectPayload;
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
    const { packets, quarantines } = input;

    // ── Quarantine: approve all by default (re-inject as-is) ──────────────────
    // RuleBasedBrain has no semantic understanding — pass everything through.
    // Override with a custom adapter for domain-specific triage.
    const decision: BrainDecision = {};

    if (quarantines.length > 0) {
      // Process first quarantine only (one decision per tick)
      const q = quarantines[0];
      decision.quarantineApprove = {
        pipelineId: q.pipelineId,
        quarantineId: q.payload.quarantineId,
      };
    }

    if (packets.length === 0) return decision;

    const maxSeverity = packets.reduce<"low" | "medium" | "high">((max, p) => {
      if (p.severity === "high")                           return "high";
      if (p.severity === "medium" && max !== "high")       return "medium";
      return max;
    }, "low");

    const first = packets[0];

    if (maxSeverity === "high") {
      return {
        ...decision,
        stop: { pipelineId: `pipeline://default`, schemaId: first.schemaId },
        rationale: `[rule] high severity $I from bot=${first.botId} — stop schema stream`,
      };
    }
    if (maxSeverity === "medium") {
      return {
        ...decision,
        throttle: { pipelineId: `pipeline://default`, schemaId: first.schemaId, rps: 10 },
        rationale: `[rule] medium severity $I from bot=${first.botId} — throttle to 10 rps`,
      };
    }
    return { ...decision, rationale: `[rule] all low severity — no action` };
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
    const { packets, quarantines } = input;
    if (packets.length === 0 && quarantines.length === 0) return {};

    const packetSummary = packets.map((p) =>
      `- bot=${p.botId} schema=${p.schemaId} severity=${p.severity} signal="${p.signal}"`,
    ).join("\n") || "(none)";

    const quarantineSummary = quarantines.map((q) =>
      `- quarantineId=${q.payload.quarantineId} schema=${q.payload.schemaId} reason=${q.payload.reason} detail="${q.payload.detail}"`,
    ).join("\n") || "(none)";

    const prompt = [
      "You are a pipeline control authority (Brain AI).",
      "You receive inference signals ($I) from Bot observers and quarantined records.",
      "Based on the inputs below, decide what control action to take.",
      "",
      "$I packets:",
      packetSummary,
      "",
      "Quarantined records (decide approve or reject for each):",
      quarantineSummary,
      "",
      "Available actions (respond with JSON only, omit fields you don't use):",
      JSON.stringify({
        rerouteSchema:    { schemaId: "<id>", toPipelineId: "pipeline://<id>" },
        throttle:         { pipelineId: "pipeline://<id>", schemaId: "<optional>", rps: 10 },
        stop:             { pipelineId: "pipeline://<id>", schemaId: "<optional>" },
        quarantineApprove: { pipelineId: "pipeline://<id>", quarantineId: "<id>", correctedRecord: "<optional>" },
        quarantineReject:  { pipelineId: "pipeline://<id>", quarantineId: "<id>", reason: "<explanation>" },
        rationale:        "<one sentence explanation>",
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
  private readonly quarantineBuffer: { pipelineId: string; payload: QuarantinePayload }[] = [];

  constructor(ipool: IPool, postbox: PostBox, options: BrainOptions = {}) {
    this.ipool      = ipool;
    this.postbox    = postbox;
    this.adapter    = options.adapter    ?? new RuleBasedBrain();
    this.intervalMs = options.intervalMs ?? 2000;
    this.pipelineId = options.pipelineId ?? "pipeline://default";

    // Subscribe to quarantine inbound — buffer until next tick
    this.postbox.subscribeInbound("quarantine", (msg) => {
      this.quarantineBuffer.push({
        pipelineId: msg.pipelineId,
        payload: msg.payload as QuarantinePayload,
      });
    });
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
    const packets     = this.ipool.drain();
    const quarantines = this.quarantineBuffer.splice(0);
    const decision    = await this.adapter.evaluate({ packets, quarantines });
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
    if (decision.quarantineApprove) {
      const { pipelineId, ...payload } = decision.quarantineApprove;
      this.postbox.issueQuarantineApprove(pipelineId, payload);
    }
    if (decision.quarantineReject) {
      const { pipelineId, ...payload } = decision.quarantineReject;
      this.postbox.issueQuarantineReject(pipelineId, payload);
    }
  }
}