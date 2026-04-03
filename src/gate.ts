/**
 * Gate — $V shadow evaluation and row routing.
 *
 * Sits between Streamer and downstream consumers.
 * Applies validation mode per schema and emits results to Monitor.
 *
 * Slot model:
 *   fixed slots [0..HOT_SLOTS)  — hot schemas, array index lookup
 *   dynamic slots               — remaining, Map lookup
 *
 * Monitor notifies slot manager when to promote/demote.
 */

import type { SchemaRegistry, RegistryEntry } from "./registry.js";
import type { Monitor, VResultPayload } from "./monitor.js";
import { NullMonitor } from "./monitor.js";

export type ValidationMode = "filter" | "flag" | "isolate";

export interface GateOptions {
  /** Default validation mode when schema has no explicit mode set. */
  defaultMode?: ValidationMode;
  /** Number of fixed (hot) slots. Default: 8. */
  hotSlots?: number;
  monitor?: Monitor;
}

export interface GateResult {
  /** Whether the row should be forwarded downstream. */
  emit: boolean;
  /** Raw validation pass/fail. */
  pass: boolean;
  /** Failure details if any. */
  failures: { field: string; value: unknown; reason: string }[];
}

// ── Slot entry ─────────────────────────────────────────────────

interface SlotEntry {
  entry: RegistryEntry;
  mode: ValidationMode;
  hitCount: number;
}

// ── Gate ───────────────────────────────────────────────────────

export class Gate {
  private readonly registry: SchemaRegistry;
  private readonly monitor: Monitor;
  private readonly defaultMode: ValidationMode;
  private readonly HOT_SLOTS: number;

  // Fixed slots: array of HOT_SLOTS length, null = empty
  private readonly fixedSlots: (SlotEntry | null)[];
  // Map from schemaId → fixed slot index (for O(1) fixed lookup)
  private readonly fixedIndex: Map<string, number> = new Map();
  // Dynamic slots: schemaId → SlotEntry
  private readonly dynamicSlots: Map<string, SlotEntry> = new Map();

  constructor(registry: SchemaRegistry, options: GateOptions = {}) {
    this.registry = registry;
    this.monitor = options.monitor ?? new NullMonitor();
    this.defaultMode = options.defaultMode ?? "filter";
    this.HOT_SLOTS = options.hotSlots ?? 8;
    this.fixedSlots = new Array(this.HOT_SLOTS).fill(null);
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Process a decoded row. Returns GateResult indicating whether to emit.
   *
   * @param schemaId  Current schema context (from $S header tracking)
   * @param fields    Field names in positional order
   * @param row       Positional value array
   * @param index     Row index for Monitor reporting
   * @param mode      Override validation mode (optional)
   */
  process(
    schemaId: string,
    fields: string[],
    row: unknown[],
    index: number,
    mode?: ValidationMode,
    ts?: number,
  ): GateResult {
    const slot = this.resolveSlot(schemaId);

    if (!slot) {
      // Unknown schema — pass through, no validation
      return { emit: true, pass: true, failures: [] };
    }

    slot.hitCount++;
    const effectiveMode = mode ?? slot.mode;

    const vResult = slot.entry.vShadow.validatePositional(fields, row);
    const failures = vResult.failures.map((f) => ({
      field: f.field,
      value: f.value,
      reason: f.reason ?? "invalid",
    }));

    const emit = shouldEmit(vResult.pass, effectiveMode);

    // Emit to Monitor
    const payload: VResultPayload = {
      index,
      pass: vResult.pass,
      failures: failures.map((f) => ({ field: f.field, reason: f.reason })),
      mode: effectiveMode,
      emitted: emit,
    };
    this.monitor.emit({
      type: "vResult",
      schemaId,
      ts: ts ?? Date.now(),
      priority: vResult.pass ? "batch" : "immediate",
      payload,
    });

    // Check if this schema should be promoted to a fixed slot
    this.maybePromote(schemaId, slot);

    return { emit, pass: vResult.pass, failures };
  }

  /**
   * Notify Gate about a new schema from a $S header.
   * Ensures the schema is loaded into slots.
   */
  onSchemaHeader(schemaId: string, mode?: ValidationMode): void {
    this.resolveSlot(schemaId, mode);
  }

  /** Manually promote a schema to a fixed slot. */
  promote(schemaId: string): boolean {
    if (this.fixedIndex.has(schemaId)) return true; // already fixed

    const dynamic = this.dynamicSlots.get(schemaId);
    if (!dynamic) return false;

    const emptyIdx = this.fixedSlots.indexOf(null);
    if (emptyIdx === -1) return false; // no empty fixed slot

    this.fixedSlots[emptyIdx] = dynamic;
    this.fixedIndex.set(schemaId, emptyIdx);
    this.dynamicSlots.delete(schemaId);

    this.monitor.emit({
      type: "promote",
      schemaId,
      ts: Date.now(),
      payload: { slotIndex: emptyIdx },
    });

    return true;
  }

  /** Current slot occupancy summary. */
  slotSummary(): string {
    const fixed = this.fixedSlots
      .map((s, i) => (s ? `  [${i}] ${s.entry.schema.id} hits=${s.hitCount}` : `  [${i}] empty`))
      .join("\n");
    const dynamic = [...this.dynamicSlots.entries()]
      .map(([id, s]) => `  dyn ${id} hits=${s.hitCount}`)
      .join("\n");
    return `Gate slots:\n${fixed}${dynamic ? "\n" + dynamic : ""}`;
  }

  // ── Internal ────────────────────────────────────────────────

  private resolveSlot(schemaId: string, mode?: ValidationMode): SlotEntry | null {
    // 1. Fixed slot (array index — fastest path)
    const fixedIdx = this.fixedIndex.get(schemaId);
    if (fixedIdx !== undefined) {
      return this.fixedSlots[fixedIdx];
    }

    // 2. Dynamic slot
    const dyn = this.dynamicSlots.get(schemaId);
    if (dyn) return dyn;

    // 3. Not loaded yet — fetch from registry
    const entry = this.registry.get(schemaId);
    if (!entry) return null;

    const slot: SlotEntry = {
      entry,
      mode: mode ?? this.defaultMode,
      hitCount: 0,
    };
    this.dynamicSlots.set(schemaId, slot);
    return slot;
  }

  private maybePromote(schemaId: string, slot: SlotEntry): void {
    // Promote to fixed slot after 100 hits if space is available
    if (
      slot.hitCount === 100 &&
      !this.fixedIndex.has(schemaId) &&
      this.fixedSlots.includes(null)
    ) {
      this.promote(schemaId);
    }
  }
}

function shouldEmit(pass: boolean, mode: ValidationMode): boolean {
  if (mode === "filter")  return pass;
  if (mode === "flag")    return true;
  if (mode === "isolate") return !pass;
  return pass;
}