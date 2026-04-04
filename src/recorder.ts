/**
 * recorder.ts — PostBox snapshot recorder and replay.
 *
 * Recorder subscribes to all inbound and outbound PostBox messages
 * and writes them as JSONL to a snapshot file.
 *
 * Replay feeds recorded outbound messages back to PostBox,
 * replacing Brain AI entirely for deterministic testing.
 *
 * Snapshot format (one JSON object per line):
 *   {"dir":"in",  "ts":..., "type":"st_v",         "pipelineId":"...", "payload":...}
 *   {"dir":"out", "ts":..., "type":"routing_update","pipelineId":"...", "payload":...}
 */

import { createWriteStream, readFileSync, type WriteStream } from "node:fs";
import type { PostBox, InboundMessage, OutboundMessage } from "./postbox.js";

// ── Snapshot record ───────────────────────────────────────────────────────────

export interface SnapshotRecord {
  dir:        "in" | "out";
  ts:         number;
  type:       string;
  pipelineId: string;
  payload:    unknown;
}

// ── Recorder ──────────────────────────────────────────────────────────────────

export interface RecorderOptions {
  /** Path to snapshot JSONL file. Default: "snapshot.jsonl" */
  path?: string;
}

export class Recorder {
  private readonly postbox: PostBox;
  private readonly path: string;
  private stream: WriteStream | null = null;

  private readonly inHandler:  (msg: InboundMessage)  => void;
  private readonly outHandler: (msg: OutboundMessage) => void;

  constructor(postbox: PostBox, options: RecorderOptions = {}) {
    this.postbox = postbox;
    this.path    = options.path ?? "snapshot.jsonl";

    this.inHandler  = (msg) => this.write({ dir: "in",  ts: msg.ts, type: msg.type, pipelineId: msg.pipelineId, payload: msg.payload });
    this.outHandler = (msg) => this.write({ dir: "out", ts: msg.ts, type: msg.type, pipelineId: msg.pipelineId, payload: msg.payload });
  }

  /** Start recording. Opens (or appends to) the snapshot file. */
  start(): void {
    this.stream = createWriteStream(this.path, { flags: "a", encoding: "utf-8" });
    this.postbox.subscribeInbound("*",  this.inHandler);
    this.postbox.subscribeOutbound("*", this.outHandler);
  }

  /** Stop recording and close the file. */
  stop(): Promise<void> {
    this.postbox.unsubscribeInbound("*",  this.inHandler);
    this.postbox.unsubscribeOutbound("*", this.outHandler);
    return new Promise((resolve) => {
      if (!this.stream) { resolve(); return; }
      this.stream.end(resolve);
      this.stream = null;
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private write(record: SnapshotRecord): void {
    this.stream?.write(JSON.stringify(record) + "\n");
  }
}

// ── Replay ────────────────────────────────────────────────────────────────────

export interface ReplayOptions {
  /** If true, preserve original timestamps (sleep between events). Default: false (instant). */
  realtime?: boolean;
}

/**
 * Replay recorded outbound messages back into PostBox.
 * Replaces Brain AI for deterministic testing and demos.
 *
 * Only "out" direction records are replayed — inbound records are skipped
 * (they were produced by the pipeline and will be re-produced live).
 */
export async function replay(
  postbox: PostBox,
  snapshotPath: string,
  options: ReplayOptions = {},
): Promise<void> {
  const lines = readFileSync(snapshotPath, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0);

  const records = lines.map((l) => JSON.parse(l) as SnapshotRecord);
  const outbound = records.filter((r) => r.dir === "out");

  for (let i = 0; i < outbound.length; i++) {
    const rec = outbound[i];

    if (options.realtime && i > 0) {
      const prev = outbound[i - 1];
      const delay = Math.max(0, rec.ts - prev.ts);
      if (delay > 0) await sleep(delay);
    }

    postbox.pushOutbound({
      type:       rec.type as OutboundMessage["type"],
      pipelineId: rec.pipelineId,
      ts:         rec.ts,
      payload:    rec.payload as OutboundMessage["payload"],
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}