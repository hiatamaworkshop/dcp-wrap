/**
 * validation.test.ts
 *
 * Covers:
 *   1. VShadow — type, range, enum, pattern, nullable checks
 *   2. Preprocessor → quarantine on type_mismatch / range_violation
 *   3. validation_update — Brain AI replaces VShadow at runtime
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { VShadow, vShadowFromSchema } from "./validator.js";
import { SchemaRegistry }             from "./registry.js";
import { SchemaCache }                from "./schema-cache.js";
import { PostBox }                    from "./postbox.js";
import { RoutingLayer }               from "./router.js";
import { PipelineControl }            from "./pipeline-control.js";
import { Preprocessor }               from "./preprocessor.js";
import { JSONAdapter }                from "./adapters/json-adapter.js";
import { MessagePool }                from "./monitor.js";
import type { DcpSchemaDef }          from "./types.js";
import type { InboundMessage }        from "./postbox.js";
import type { RawRecord }             from "./preprocessor.js";

// ── Schema defs ───────────────────────────────────────────────────────────────

const SENSOR_SCHEMA: DcpSchemaDef = {
  $dcp: "schema",
  id: "sensor:v1",
  description: "sensor reading",
  fields: ["temp", "status", "label"],
  fieldCount: 3,
  types: {
    temp:   { type: "number", min: -50, max: 150 },
    status: { type: "string", enum: ["ok", "warn", "error"] },
    label:  { type: "string" },
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEnv(schema: DcpSchemaDef = SENSOR_SCHEMA) {
  const registry = new SchemaRegistry();
  registry.register(schema);
  const postbox  = new PostBox();
  const router   = new RoutingLayer(new MessagePool(), { receive: () => {} });
  const ctrl     = new PipelineControl("pipeline://test", postbox, router, registry);
  const adapter  = new JSONAdapter("$schema");
  const cache    = new SchemaCache(registry);
  const pre      = new Preprocessor(adapter, cache, postbox, ctrl, {
    pipelineId: "pipeline://test",
  });
  return { registry, postbox, ctrl, pre };
}

function validRecord(extra: Record<string, unknown> = {}): RawRecord {
  return { $schema: SENSOR_SCHEMA.id, temp: 25.0, status: "ok", label: "unit-A", ...extra };
}

// ── 1. VShadow unit tests ─────────────────────────────────────────────────────

describe("VShadow", () => {
  it("passes a valid record", () => {
    const shadow = vShadowFromSchema(SENSOR_SCHEMA);
    const result = shadow.validate({ temp: 25.0, status: "ok", label: "unit-A" });
    assert.equal(result.pass, true);
    assert.equal(result.failures.length, 0);
  });

  it("fails on type mismatch — string for number", () => {
    const shadow = vShadowFromSchema(SENSOR_SCHEMA);
    const result = shadow.validate({ temp: "hot", status: "ok", label: "unit-A" });
    assert.equal(result.pass, false);
    const fail = result.failures.find((f) => f.field === "temp");
    assert.ok(fail, "expected failure on temp");
    assert.match(fail!.reason ?? "", /expected number/);
  });

  it("fails on range violation — below min", () => {
    const shadow = vShadowFromSchema(SENSOR_SCHEMA);
    const result = shadow.validate({ temp: -100, status: "ok", label: "unit-A" });
    assert.equal(result.pass, false);
    const fail = result.failures.find((f) => f.field === "temp");
    assert.ok(fail);
    assert.match(fail!.reason ?? "", /< min/);
  });

  it("fails on range violation — above max", () => {
    const shadow = vShadowFromSchema(SENSOR_SCHEMA);
    const result = shadow.validate({ temp: 200, status: "ok", label: "unit-A" });
    assert.equal(result.pass, false);
    const fail = result.failures.find((f) => f.field === "temp");
    assert.ok(fail);
    assert.match(fail!.reason ?? "", /> max/);
  });

  it("fails on enum violation", () => {
    const shadow = vShadowFromSchema(SENSOR_SCHEMA);
    const result = shadow.validate({ temp: 25, status: "critical", label: "unit-A" });
    assert.equal(result.pass, false);
    const fail = result.failures.find((f) => f.field === "status");
    assert.ok(fail);
    assert.match(fail!.reason ?? "", /not in enum/);
  });

  it("passes nullable field with '-' marker", () => {
    const schema: DcpSchemaDef = {
      $dcp: "schema",
      id: "nullable-test:v1",
      description: "",
      fields: ["val"],
      fieldCount: 1,
      types: { val: { type: ["string", "null"] } },
    };
    const shadow = vShadowFromSchema(schema);
    const result = shadow.validate({ val: "-" });
    assert.equal(result.pass, true);
  });

  it("fails absent value on non-nullable field", () => {
    const shadow = vShadowFromSchema(SENSOR_SCHEMA);
    const result = shadow.validate({ temp: null, status: "ok", label: "unit-A" });
    assert.equal(result.pass, false);
    const fail = result.failures.find((f) => f.field === "temp");
    assert.ok(fail);
    assert.match(fail!.reason ?? "", /absent/);
  });

  it("pattern constraint — rejects non-matching string", () => {
    const shadow = new VShadow("pat-test:v1", {
      code: { type: "string", pattern: "^[A-Z]{3}$" },
    });
    const fail = shadow.validate({ code: "abc" });
    assert.equal(fail.pass, false);
    assert.match(fail.failures[0].reason ?? "", /pattern mismatch/);

    const pass = shadow.validate({ code: "ABC" });
    assert.equal(pass.pass, true);
  });

  it("maxLength constraint", () => {
    const shadow = new VShadow("len-test:v1", {
      tag: { type: "string", maxLength: 5 },
    });
    assert.equal(shadow.validate({ tag: "hi" }).pass, true);
    assert.equal(shadow.validate({ tag: "toolong" }).pass, false);
  });
});

// ── 2. Preprocessor → quarantine on validation failure ───────────────────────

describe("Preprocessor validation integration", () => {
  it("passes a valid record to onPass", () => {
    const { pre } = makeEnv();
    const passed: unknown[][] = [];
    pre.onPass((arr) => passed.push(arr));
    pre.process(validRecord());
    assert.equal(passed.length, 1);
  });

  it("quarantines type_mismatch (string for number)", () => {
    const { pre, postbox } = makeEnv();
    const quarantined: InboundMessage[] = [];
    postbox.subscribeInbound("quarantine", (m) => quarantined.push(m));

    const passed: unknown[][] = [];
    pre.onPass((arr) => passed.push(arr));

    pre.process(validRecord({ temp: "hot" }));

    assert.equal(passed.length, 0);
    assert.equal(quarantined.length, 1);
    const payload = quarantined[0].payload as { reason: string };
    assert.equal(payload.reason, "type_mismatch");
  });

  it("quarantines range_violation (temp too high)", () => {
    const { pre, postbox } = makeEnv();
    const quarantined: InboundMessage[] = [];
    postbox.subscribeInbound("quarantine", (m) => quarantined.push(m));

    pre.process(validRecord({ temp: 999 }));

    assert.equal(quarantined.length, 1);
    const payload = quarantined[0].payload as { reason: string };
    assert.equal(payload.reason, "range_violation");
  });

  it("quarantines enum violation as type_mismatch", () => {
    const { pre, postbox } = makeEnv();
    const quarantined: InboundMessage[] = [];
    postbox.subscribeInbound("quarantine", (m) => quarantined.push(m));

    pre.process(validRecord({ status: "critical" }));

    assert.equal(quarantined.length, 1);
    const payload = quarantined[0].payload as { reason: string };
    assert.equal(payload.reason, "type_mismatch");
  });
});

// ── 3. validation_update — Brain AI replaces VShadow at runtime ───────────────

describe("validation_update (Brain AI runtime constraint update)", () => {
  it("tightens range constraint and new record is rejected", () => {
    const { pre, postbox } = makeEnv();
    const quarantined: InboundMessage[] = [];
    postbox.subscribeInbound("quarantine", (m) => quarantined.push(m));

    const passed: unknown[][] = [];
    pre.onPass((arr) => passed.push(arr));

    // Before update: temp=80 is within [-50, 150] → passes
    pre.process(validRecord({ temp: 80 }));
    assert.equal(passed.length, 1);

    // Brain AI tightens range to [-50, 50]
    postbox.issueValidationUpdate("pipeline://test", SENSOR_SCHEMA.id, {
      temp:   { type: "number", min: -50, max: 50 },
      status: { type: "string", enum: ["ok", "warn", "error"] },
      label:  { type: "string" },
    });

    // After update: temp=80 exceeds new max 50 → range_violation
    pre.process(validRecord({ temp: 80 }));
    assert.equal(passed.length, 1, "no new pass after update");
    assert.equal(quarantined.length, 1);
    const payload = quarantined[0].payload as { reason: string };
    assert.equal(payload.reason, "range_violation");
  });

  it("loosens constraint and previously rejected record now passes", () => {
    const { pre, postbox } = makeEnv();
    const passed: unknown[][] = [];
    pre.onPass((arr) => passed.push(arr));

    // Before update: temp=200 exceeds max 150 → quarantine
    const quarantined: InboundMessage[] = [];
    postbox.subscribeInbound("quarantine", (m) => quarantined.push(m));
    pre.process(validRecord({ temp: 200 }));
    assert.equal(quarantined.length, 1);

    // Brain AI widens range to [-50, 300]
    postbox.issueValidationUpdate("pipeline://test", SENSOR_SCHEMA.id, {
      temp:   { type: "number", min: -50, max: 300 },
      status: { type: "string", enum: ["ok", "warn", "error"] },
      label:  { type: "string" },
    });

    // After update: temp=200 is now within range → passes
    pre.process(validRecord({ temp: 200 }));
    assert.equal(passed.length, 1);
  });

  it("update to unknown schemaId is a no-op — existing shadow unchanged", () => {
    const { pre, postbox } = makeEnv();
    const passed: unknown[][] = [];
    pre.onPass((arr) => passed.push(arr));

    // Issue update for a schema that doesn't exist in registry
    postbox.issueValidationUpdate("pipeline://test", "nonexistent:v1", {
      temp: { type: "number", min: 0, max: 1 },
    });

    // sensor:v1 shadow unchanged — valid record still passes
    pre.process(validRecord());
    assert.equal(passed.length, 1);
  });
});