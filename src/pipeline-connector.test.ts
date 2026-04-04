/**
 * pipeline-connector.test.ts
 *
 * Covers:
 *   1. PipelineConnector — single route, fanout, wildcard fallback, drop callback
 *   2. PipelineControl.setConnector() + routing_update → connector table updated in sync
 *   3. Preprocessor stop (pipeline-wide and schema-level) and throttle enforcement
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { PipelineConnector }  from "./pipeline-connector.js";
import { PipelineControl }    from "./pipeline-control.js";
import { PostBox }            from "./postbox.js";
import { RoutingLayer }       from "./router.js";
import { SchemaRegistry }     from "./registry.js";
import { Preprocessor }       from "./preprocessor.js";
import { SimpleMonitor, MessagePool } from "./monitor.js";
import type { RawRecord }     from "./preprocessor.js";
import type { DcpSchemaDef }  from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const SCHEMA: DcpSchemaDef = {
  $dcp: "schema",
  id: "test-schema:v1",
  description: "test",
  fields: ["value"],
  fieldCount: 1,
  types: { value: { type: "string" } },
};

function makeRecord(extra: Record<string, unknown> = {}): RawRecord {
  return { $schema: SCHEMA.id, value: "hello", ...extra };
}

/** Build a minimal Preprocessor wired to a PipelineControl. */
function makePre(pipelineId: string) {
  const registry = new SchemaRegistry();
  registry.register(SCHEMA);
  const postbox = new PostBox();
  const router  = new RoutingLayer(new MessagePool(), { receive: () => {} });
  const ctrl    = new PipelineControl(pipelineId, postbox, router);
  const pre     = new Preprocessor(registry, postbox, ctrl, { pipelineId, schemaField: "$schema" });
  return { pre, ctrl, postbox, router };
}

// ── 1. PipelineConnector ──────────────────────────────────────────────────────

describe("PipelineConnector", () => {
  it("routes to single registered target", () => {
    const connector = new PipelineConnector();
    const { pre } = makePre("pipeline://B");

    const received: RawRecord[] = [];
    pre.onPass((r) => received.push(r));

    connector.register(SCHEMA.id, pre);
    connector.forward(makeRecord(), SCHEMA.id);

    assert.equal(received.length, 1);
    assert.equal(received[0]!.value, "hello");
  });

  it("fanout delivers to all targets", () => {
    const connector = new PipelineConnector();
    const b = makePre("pipeline://B");
    const c = makePre("pipeline://C");

    const recB: RawRecord[] = [];
    const recC: RawRecord[] = [];
    b.pre.onPass((r) => recB.push(r));
    c.pre.onPass((r) => recC.push(r));

    connector.register(SCHEMA.id, [b.pre, c.pre]);
    connector.forward(makeRecord(), SCHEMA.id);

    assert.equal(recB.length, 1);
    assert.equal(recC.length, 1);
  });

  it("wildcard fallback fires when no exact match", () => {
    const connector = new PipelineConnector();
    const { pre } = makePre("pipeline://B");

    const received: RawRecord[] = [];
    pre.onPass((r) => received.push(r));

    connector.register("*", pre);
    connector.forward(makeRecord(), SCHEMA.id);  // no exact match → wildcard

    assert.equal(received.length, 1);
  });

  it("exact match takes priority over wildcard", () => {
    const connector = new PipelineConnector();
    const exact = makePre("pipeline://exact");
    const wild  = makePre("pipeline://wild");

    const recExact: RawRecord[] = [];
    const recWild: RawRecord[]  = [];
    exact.pre.onPass((r) => recExact.push(r));
    wild.pre.onPass((r)  => recWild.push(r));

    connector.register(SCHEMA.id, exact.pre);
    connector.register("*", wild.pre);
    connector.forward(makeRecord(), SCHEMA.id);

    assert.equal(recExact.length, 1);
    assert.equal(recWild.length, 0);
  });

  it("invokes onDrop when no destination found", () => {
    const connector = new PipelineConnector();
    let dropped = false;
    connector.onDrop(() => { dropped = true; });
    connector.forward(makeRecord(), SCHEMA.id);
    assert.ok(dropped);
  });

  it("setTable replaces routing atomically", () => {
    const connector = new PipelineConnector();
    const b = makePre("pipeline://B");
    const c = makePre("pipeline://C");

    const recB: RawRecord[] = [];
    const recC: RawRecord[] = [];
    b.pre.onPass((r) => recB.push(r));
    c.pre.onPass((r) => recC.push(r));

    connector.register(SCHEMA.id, b.pre);
    connector.forward(makeRecord(), SCHEMA.id);
    assert.equal(recB.length, 1);

    // Replace table — now routes to C
    connector.setTable(new Map([[SCHEMA.id, c.pre]]));
    connector.forward(makeRecord(), SCHEMA.id);
    assert.equal(recB.length, 1, "B should not receive after table swap");
    assert.equal(recC.length, 1, "C should receive after table swap");
  });
});

// ── 2. PipelineControl + PipelineConnector routing_update ─────────────────────

describe("PipelineControl + PipelineConnector routing_update", () => {
  it("routing_update via PostBox updates connector table", () => {
    const a = makePre("pipeline://A");
    const b = makePre("pipeline://B");
    const c = makePre("pipeline://C");

    const connector = new PipelineConnector();
    connector.register(SCHEMA.id, b.pre);  // initial: routes to B

    const pipelineMap = new Map([
      ["pipeline://B", b.pre],
      ["pipeline://C", c.pre],
    ]);
    a.ctrl.setConnector(connector, (id) => pipelineMap.get(id));

    const recB: RawRecord[] = [];
    const recC: RawRecord[] = [];
    b.pre.onPass((r) => recB.push(r));
    c.pre.onPass((r) => recC.push(r));

    // Before routing_update: forwards to B
    connector.forward(makeRecord(), SCHEMA.id);
    assert.equal(recB.length, 1);
    assert.equal(recC.length, 0);

    // Brain AI issues routing_update → reroute to C
    a.postbox.issueRoutingUpdate("pipeline://A", new Map([[SCHEMA.id, "pipeline://C"]]));

    // After routing_update: connector table updated, forwards to C
    connector.forward(makeRecord(), SCHEMA.id);
    assert.equal(recB.length, 1, "B should not receive after routing_update");
    assert.equal(recC.length, 1, "C should receive after routing_update");
  });

  it("routing_update with fanout array updates connector to deliver to both", () => {
    const a = makePre("pipeline://A");
    const b = makePre("pipeline://B");
    const c = makePre("pipeline://C");

    const connector = new PipelineConnector();
    const pipelineMap = new Map([
      ["pipeline://B", b.pre],
      ["pipeline://C", c.pre],
    ]);
    a.ctrl.setConnector(connector, (id) => pipelineMap.get(id));

    const recB: RawRecord[] = [];
    const recC: RawRecord[] = [];
    b.pre.onPass((r) => recB.push(r));
    c.pre.onPass((r) => recC.push(r));

    // Brain AI issues fanout routing_update
    a.postbox.issueRoutingUpdate("pipeline://A", new Map([[SCHEMA.id, ["pipeline://B", "pipeline://C"]]]));

    connector.forward(makeRecord(), SCHEMA.id);
    assert.equal(recB.length, 1, "B should receive fanout");
    assert.equal(recC.length, 1, "C should receive fanout");
  });
});

// ── 3. Preprocessor stop / throttle ──────────────────────────────────────────

describe("Preprocessor stop and throttle", () => {
  it("drops all records when pipeline is stopped", () => {
    const { pre, postbox } = makePre("pipeline://A");
    const passed: RawRecord[] = [];
    const dropped: unknown[]  = [];
    pre.onPass((r) => passed.push(r));
    pre.onDrop((r) => dropped.push(r));

    postbox.issueStop("pipeline://A");  // pipeline-wide stop

    pre.process(makeRecord());
    pre.process(makeRecord());

    assert.equal(passed.length, 0);
    assert.equal(dropped.length, 2);
  });

  it("drops records for a stopped schema only", () => {
    const { pre, postbox } = makePre("pipeline://A");
    const passed: RawRecord[] = [];
    const dropped: unknown[]  = [];
    pre.onPass((r) => passed.push(r));
    pre.onDrop((r) => dropped.push(r));

    postbox.issueStop("pipeline://A", SCHEMA.id);  // schema-level stop

    pre.process(makeRecord());

    assert.equal(passed.length, 0);
    assert.equal(dropped.length, 1);
  });

  it("enforces rps throttle — drops records beyond limit within 1s window", () => {
    const { pre, postbox } = makePre("pipeline://A");
    const passed: RawRecord[] = [];
    const dropped: unknown[]  = [];
    pre.onPass((r) => passed.push(r));
    pre.onDrop((r) => dropped.push(r));

    postbox.issueThrottle("pipeline://A", 2, SCHEMA.id);  // 2 rps cap

    // Send 5 records rapidly (same window)
    for (let i = 0; i < 5; i++) pre.process(makeRecord());

    assert.equal(passed.length, 2, "only 2 should pass within throttle window");
    assert.equal(dropped.length, 3, "3 should be throttle-dropped");
  });
});