/**
 * pipeline-chain.test.ts
 *
 * Integration tests for multi-pipeline chains and Brain AI control.
 *
 * Covers:
 *   1. A→B→C chain — record traverses 3 pipelines in order
 *   2. Brain rerouteSchema — connector switches from B to C at runtime
 *   3. quarantine → Brain approve (correctedRecord) → re-inject → downstream arrival
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SchemaRegistry }         from "./registry.js";
import { SchemaCache }            from "./schema-cache.js";
import { PostBox }                from "./postbox.js";
import { RoutingLayer }           from "./router.js";
import { MessagePool }            from "./monitor.js";
import { PipelineControl }        from "./pipeline-control.js";
import { Preprocessor }           from "./preprocessor.js";
import { JSONAdapter }            from "./adapters/json-adapter.js";
import { PipelineConnector }      from "./pipeline-connector.js";
import { IPool }                  from "./i-pool.js";
import { Brain }                  from "./brain.js";
import type { DcpSchemaDef }      from "./types.js";
import type { RawRecord }         from "./preprocessor.js";
import type { QuarantinePayload } from "./postbox.js";

// ── Schema ────────────────────────────────────────────────────────────────────

const SCHEMA: DcpSchemaDef = {
  $dcp: "schema",
  id: "event:v1",
  description: "pipeline chain test schema",
  fields: ["id", "value", "status"],
  fieldCount: 3,
  types: {
    id:     { type: "string" },
    value:  { type: "number", min: 0, max: 100 },
    status: { type: "string", enum: ["ok", "warn"] },
  },
};

// ── Pipeline factory ──────────────────────────────────────────────────────────

interface PL {
  id:      string;
  pre:     Preprocessor<RawRecord>;
  postbox: PostBox;
  ctrl:    PipelineControl;
  arrived: unknown[][];
}

function makePipeline(id: string, registry?: SchemaRegistry): PL {
  const reg = registry ?? (() => { const r = new SchemaRegistry(); r.register(SCHEMA); return r; })();
  const postbox = new PostBox();
  const router  = new RoutingLayer(new MessagePool(), { receive: () => {} });
  const ctrl    = new PipelineControl(id, postbox, router, reg);
  const adapter = new JSONAdapter("$schema");
  const cache   = new SchemaCache(reg);
  const pre     = new Preprocessor<RawRecord>(adapter, cache, postbox, ctrl, { pipelineId: id });
  const arrived: unknown[][] = [];
  // Default onPass: record arrived at this pipeline
  pre.onPass((arr) => arrived.push(arr));
  return { id, pre, postbox, ctrl, arrived };
}

/** Wire A's onPass to also forward via connector (arrived still receives). */
function wireForward(pl: PL, connector: PipelineConnector): void {
  pl.pre.onPass((arr, schemaId, raw) => {
    pl.arrived.push(arr);
    connector.forward(raw, schemaId);
  });
}

function validRecord(extra: Partial<RawRecord> = {}): RawRecord {
  return { $schema: SCHEMA.id, id: "r1", value: 42, status: "ok", ...extra };
}

// ── 1. A→B→C chain ───────────────────────────────────────────────────────────

describe("A→B→C pipeline chain", () => {
  it("record passes through all three pipelines in order", () => {
    const A = makePipeline("pipeline://A");
    const B = makePipeline("pipeline://B");
    const C = makePipeline("pipeline://C");

    const connAB = new PipelineConnector();
    connAB.register(SCHEMA.id, B.pre);
    wireForward(A, connAB);

    const connBC = new PipelineConnector();
    connBC.register(SCHEMA.id, C.pre);
    wireForward(B, connBC);

    A.pre.process(validRecord());

    assert.equal(A.arrived.length, 1, "A received record");
    assert.equal(B.arrived.length, 1, "B received record");
    assert.equal(C.arrived.length, 1, "C received record");
  });

  it("schema mismatch in B does not propagate to C", () => {
    const A = makePipeline("pipeline://A");

    // B has stricter schema — value max is 10
    const strictSchema: DcpSchemaDef = {
      ...SCHEMA,
      types: { ...SCHEMA.types, value: { type: "number", min: 0, max: 10 } },
    };
    const regB = new SchemaRegistry();
    regB.register(strictSchema);
    const B = makePipeline("pipeline://B", regB);
    const C = makePipeline("pipeline://C");

    const connAB = new PipelineConnector();
    connAB.register(SCHEMA.id, B.pre);
    wireForward(A, connAB);

    const connBC = new PipelineConnector();
    connBC.register(SCHEMA.id, C.pre);
    wireForward(B, connBC);

    // value=50 passes A (max 100) but fails B (max 10) → C receives nothing
    A.pre.process(validRecord({ value: 50 }));

    assert.equal(A.arrived.length, 1, "A passed");
    assert.equal(B.arrived.length, 0, "B quarantined — did not pass to C");
    assert.equal(C.arrived.length, 0, "C received nothing");
  });
});

// ── 2. Brain rerouteSchema ────────────────────────────────────────────────────

describe("Brain rerouteSchema — runtime connector switch", () => {
  it("routing_update via PostBox switches A→B to A→C", () => {
    const A = makePipeline("pipeline://A");
    const B = makePipeline("pipeline://B");
    const C = makePipeline("pipeline://C");

    const connector = new PipelineConnector();
    connector.register(SCHEMA.id, B.pre);
    wireForward(A, connector);

    const pipelineMap = new Map([
      ["pipeline://B", B.pre],
      ["pipeline://C", C.pre],
    ]);
    A.ctrl.setConnector(connector, (id) => pipelineMap.get(id));

    // Before reroute: goes to B
    A.pre.process(validRecord({ id: "before" }));
    assert.equal(B.arrived.length, 1, "before: B received");
    assert.equal(C.arrived.length, 0, "before: C empty");

    // Brain issues routing_update: event:v1 → pipeline://C
    A.postbox.issueRoutingUpdate("pipeline://A", new Map([[SCHEMA.id, "pipeline://C"]]));

    // After reroute: goes to C
    A.pre.process(validRecord({ id: "after" }));
    assert.equal(B.arrived.length, 1, "after: B unchanged");
    assert.equal(C.arrived.length, 1, "after: C received");
  });

  it("Brain.flush() with rerouteSchema propagates via PostBox", async () => {
    const A = makePipeline("pipeline://A");
    const B = makePipeline("pipeline://B");
    const C = makePipeline("pipeline://C");

    const connector = new PipelineConnector();
    connector.register(SCHEMA.id, B.pre);
    wireForward(A, connector);

    const pipelineMap = new Map([
      ["pipeline://B", B.pre],
      ["pipeline://C", C.pre],
    ]);
    A.ctrl.setConnector(connector, (id) => pipelineMap.get(id));

    // Before: B
    A.pre.process(validRecord({ id: "r1" }));
    assert.equal(B.arrived.length, 1);

    // Custom Brain adapter that issues rerouteSchema
    const ipool = new IPool();
    const brain = new Brain(ipool, A.postbox, {
      pipelineId: "pipeline://A",
      adapter: {
        async evaluate() {
          return { rerouteSchema: { schemaId: SCHEMA.id, toPipelineId: "pipeline://C" } };
        },
      },
    });

    await brain.flush();
    brain.stop();

    // After Brain decision: C
    A.pre.process(validRecord({ id: "r2" }));
    assert.equal(B.arrived.length, 1, "B unchanged after reroute");
    assert.equal(C.arrived.length, 1, "C received after reroute");
  });
});

// ── 3. quarantine → Brain approve → re-inject → downstream ───────────────────

describe("quarantine → Brain approve → downstream arrival", () => {
  it("Brain approves with correctedRecord — re-injected record reaches B", () => {
    const A = makePipeline("pipeline://A");
    const B = makePipeline("pipeline://B");

    const connector = new PipelineConnector();
    connector.register(SCHEMA.id, B.pre);
    wireForward(A, connector);

    const quarantined: QuarantinePayload[] = [];
    A.postbox.subscribeInbound("quarantine", (msg) => {
      quarantined.push(msg.payload as QuarantinePayload);
    });

    // Record with missing field → quarantined in A
    A.pre.process({ $schema: SCHEMA.id, id: "q1", value: 10 }); // missing: status

    assert.equal(quarantined.length, 1, "quarantined");
    assert.equal(quarantined[0].reason, "missing_field");
    assert.equal(A.arrived.length, 0, "not yet passed A");
    assert.equal(B.arrived.length, 0, "not yet in B");

    // Brain approves with corrected record
    A.postbox.issueQuarantineApprove("pipeline://A", {
      quarantineId: quarantined[0].quarantineId,
      correctedRecord: { $schema: SCHEMA.id, id: "q1", value: 10, status: "ok" },
    });

    // Re-injected → passes A → forwarded to B
    assert.equal(A.arrived.length, 1, "corrected record passed A");
    assert.equal(B.arrived.length, 1, "corrected record reached B");
    // SCHEMA.fields = ["id", "value", "status"], so index 2 = status
    assert.equal(B.arrived[0]![2], "ok");
  });

  it("Brain reject — record does not reach B", () => {
    const A = makePipeline("pipeline://A");
    const B = makePipeline("pipeline://B");

    const connector = new PipelineConnector();
    connector.register(SCHEMA.id, B.pre);
    wireForward(A, connector);

    const quarantined: QuarantinePayload[] = [];
    A.postbox.subscribeInbound("quarantine", (msg) => {
      quarantined.push(msg.payload as QuarantinePayload);
    });

    const rejected: string[] = [];
    A.ctrl.onQuarantineReject((_qId, reason) => rejected.push(reason));

    A.pre.process({ $schema: SCHEMA.id, id: "q2", value: 10 }); // missing: status

    assert.equal(quarantined.length, 1);

    A.postbox.issueQuarantineReject("pipeline://A", {
      quarantineId: quarantined[0].quarantineId,
      reason: "unfixable",
    });

    assert.equal(A.arrived.length, 0, "never passed A");
    assert.equal(B.arrived.length, 0, "never reached B");
    assert.equal(rejected.length, 1, "reject handler called");
    assert.equal(rejected[0], "unfixable");
  });

  it("Brain.flush() approves quarantine — re-injected record reaches B", async () => {
    const A = makePipeline("pipeline://A");
    const B = makePipeline("pipeline://B");

    const connector = new PipelineConnector();
    connector.register(SCHEMA.id, B.pre);
    wireForward(A, connector);

    const ipool = new IPool();
    const brain = new Brain(ipool, A.postbox, {
      pipelineId: "pipeline://A",
      adapter: {
        async evaluate(input) {
          if (input.quarantines.length === 0) return {};
          const q = input.quarantines[0];
          return {
            quarantineApprove: {
              pipelineId: q.pipelineId,
              quarantineId: q.payload.quarantineId,
              correctedRecord: { $schema: SCHEMA.id, id: "fixed", value: 5, status: "ok" },
            },
          };
        },
      },
    });

    // value=999 → range_violation → quarantined
    A.pre.process(validRecord({ id: "rv", value: 999 }));
    assert.equal(A.arrived.length, 0);
    assert.equal(B.arrived.length, 0);

    // Brain.flush() drains quarantine buffer → approve → re-inject
    await brain.flush();

    assert.equal(A.arrived.length, 1, "re-injected record passed A");
    assert.equal(B.arrived.length, 1, "re-injected record reached B");
    // SCHEMA.fields = ["id", "value", "status"], so index 0 = id
    assert.equal(A.arrived[0]![0], "fixed");

    brain.stop();
  });
});