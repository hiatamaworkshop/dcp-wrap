import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DcpSchema } from "./schema.js";
import { DcpDecoder } from "./decoder.js";
import type { DcpSchemaDef } from "./types.js";

const reportDef: DcpSchemaDef = {
  $dcp: "schema",
  id: "ctrl-report:v1",
  description: "Task completion report controller",
  fields: ["action", "target", "detail", "cost"],
  fieldCount: 4,
  types: {
    action: { type: "string", enum: ["done", "error", "skip", "partial"] },
    target: { type: "string" },
    detail: { type: ["string", "null"] },
    cost: { type: ["number", "null"] },
  },
};

const reportTemplates = {
  done: "✓ {{target}} — {{detail}} ({{cost}}ms)",
  error: "✗ {{target}} — {{detail}}",
  skip: "⊘ {{target}} skipped",
  partial: "◐ {{target}} — {{detail}}",
  default: "{{action}} {{target}} {{detail}}",
};

const logDef: DcpSchemaDef = {
  $dcp: "schema",
  id: "ctrl-log:v1",
  description: "Event log controller",
  fields: ["ts", "level", "source", "msg"],
  fieldCount: 4,
  types: {
    ts: { type: "string" },
    level: { type: "string", enum: ["info", "warn", "error", "debug"] },
    source: { type: "string" },
    msg: { type: "string" },
  },
};

const logTemplates = {
  error: "[{{ts}}] ERROR {{source}}: {{msg}}",
  warn: "[{{ts}}] WARN  {{source}}: {{msg}}",
  info: "[{{ts}}] INFO  {{source}}: {{msg}}",
  default: "[{{ts}}] {{level}} {{source}}: {{msg}}",
};

describe("DcpDecoder", () => {
  describe("decode", () => {
    it("decodes report:done with template", () => {
      const schema = new DcpSchema(reportDef);
      const decoder = new DcpDecoder(schema, reportTemplates);
      const result = decoder.decode(["done", "/v1/auth", "200 ok", 42]);
      assert.deepEqual(result.keyValues, {
        action: "done",
        target: "/v1/auth",
        detail: "200 ok",
        cost: 42,
      });
      assert.equal(result.text, "✓ /v1/auth — 200 ok (42ms)");
    });

    it("decodes report:error", () => {
      const schema = new DcpSchema(reportDef);
      const decoder = new DcpDecoder(schema, reportTemplates);
      const result = decoder.decode(["error", "/v1/orders", "timeout", 0]);
      assert.equal(result.text, "✗ /v1/orders — timeout");
    });

    it("decodes report:skip with nulls", () => {
      const schema = new DcpSchema(reportDef);
      const decoder = new DcpDecoder(schema, reportTemplates);
      const result = decoder.decode(["skip", "cleanup", null, null]);
      assert.equal(result.text, "⊘ cleanup skipped");
    });

    it("decodes log row with level-specific template", () => {
      const schema = new DcpSchema(logDef);
      const decoder = new DcpDecoder(schema, logTemplates, "level");
      const result = decoder.decode([
        "2026-03-28T14:30:00Z",
        "error",
        "db-writer",
        "connection refused",
      ]);
      assert.equal(
        result.text,
        "[2026-03-28T14:30:00Z] ERROR db-writer: connection refused",
      );
    });

    it("falls back to field:value when no templates", () => {
      const schema = new DcpSchema(reportDef);
      const decoder = new DcpDecoder(schema);
      const result = decoder.decode(["done", "/v1/auth", "ok", 42]);
      assert.equal(result.text, "action: done | target: /v1/auth | detail: ok | cost: 42");
    });
  });

  describe("decodeRows", () => {
    it("decodes multiple rows", () => {
      const schema = new DcpSchema(reportDef);
      const decoder = new DcpDecoder(schema, reportTemplates);
      const results = decoder.decodeRows([
        ["done", "/v1/auth", "200 ok", 42],
        ["error", "/v1/orders", "timeout", 0],
      ]);
      assert.equal(results.length, 2);
      assert.ok(results[0].text.includes("/v1/auth"));
      assert.ok(results[1].text.includes("/v1/orders"));
    });
  });

  describe("decodeRaw", () => {
    it("parses header + rows from raw DCP string", () => {
      const schema = new DcpSchema(reportDef);
      const decoder = new DcpDecoder(schema, reportTemplates);

      const raw = [
        '["$S","ctrl-report:v1","action","target","detail","cost"]',
        '["done","/v1/auth","200 ok",42]',
        '["error","/v1/orders","timeout",0]',
      ].join("\n");

      const { header, results } = decoder.decodeRaw(raw);
      assert.equal(header[0], "$S");
      assert.equal(results.length, 2);
      assert.ok(results[0].text.includes("✓"));
      assert.ok(results[1].text.includes("✗"));
    });

    it("handles rows without header", () => {
      const schema = new DcpSchema(reportDef);
      const decoder = new DcpDecoder(schema, reportTemplates);
      const raw = '["done","/v1/auth","ok",42]';
      const { header, results } = decoder.decodeRaw(raw);
      assert.equal(header.length, 0);
      assert.equal(results.length, 1);
    });
  });

  describe("with DcpSchema.validateRow", () => {
    it("validate + decode roundtrip", () => {
      const schema = new DcpSchema(reportDef);
      const decoder = new DcpDecoder(schema, reportTemplates);
      const row = ["done", "/v1/auth", "200 ok", 42];

      const errors = schema.validateRow(row);
      assert.equal(errors.length, 0);

      const result = decoder.decode(row);
      assert.equal(result.text, "✓ /v1/auth — 200 ok (42ms)");
    });

    it("validation catches bad enum", () => {
      const schema = new DcpSchema(reportDef);
      const row = ["invalid", "/v1/auth", "ok", 42];
      const errors = schema.validateRow(row);
      assert.ok(errors.length > 0);
      assert.ok(errors[0].includes("not in enum"));
    });
  });
});