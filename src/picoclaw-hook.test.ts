import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const hookPath = resolve(__dirname, "../dist/picoclaw-hook.js");

function startHook(envTools?: Record<string, unknown>): ChildProcess {
  const env: Record<string, string | undefined> = { ...process.env };
  if (envTools) {
    env.PICOCLAW_DCP_TOOLS = JSON.stringify(envTools);
  }
  return spawn("node", [hookPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
}

function rpc(proc: ChildProcess, id: number, method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timeout for ${method}`)), 5000);

    const onData = (chunk: Buffer) => {
      const lines = chunk.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            clearTimeout(timeout);
            proc.stdout!.off("data", onData);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
          }
        } catch { /* ignore parse errors */ }
      }
    };

    proc.stdout!.on("data", onData);
    proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

describe("picoclaw-hook", () => {
  it("responds to hook.hello", async () => {
    const proc = startHook();
    try {
      const result = await rpc(proc, 1, "hook.hello", { name: "test", version: 1, modes: ["tool"] });
      assert.deepStrictEqual(result, { ok: true, name: "dcp-encoder" });
    } finally {
      proc.kill();
    }
  });

  it("passes through unconfigured tools", async () => {
    const proc = startHook({});
    try {
      const result = await rpc(proc, 1, "hook.hello", {});
      assert.ok(result);

      const afterResult = await rpc(proc, 2, "hook.after_tool", {
        meta: { session_key: "s1" },
        tool: "unknown_tool",
        result: { for_llm: '{"foo":"bar"}', silent: false, is_error: false },
      });
      assert.deepStrictEqual(afterResult, { action: "continue" });
    } finally {
      proc.kill();
    }
  });

  it("DCP-encodes configured tool results", async () => {
    const tools = {
      mcp_engram_pull: {
        id: "engram-recall:v1",
        fields: ["id", "relevance", "summary", "tags"],
      },
    };
    const proc = startHook(tools);
    try {
      await rpc(proc, 1, "hook.hello", {});

      const toolOutput = JSON.stringify([
        { id: "abc-123", relevance: 0.95, summary: "Test node", tags: ["howto", "gateway"], hitCount: 3, weight: 1.2 },
        { id: "def-456", relevance: 0.72, summary: "Another node", tags: ["why"], hitCount: 1, weight: 0.5 },
      ]);

      const result = (await rpc(proc, 2, "hook.after_tool", {
        meta: { session_key: "s1" },
        tool: "mcp_engram_pull",
        result: { for_llm: toolOutput, silent: false, is_error: false },
      })) as { action: string; result?: { result?: { for_llm: string } } };

      assert.equal(result.action, "modify");
      assert.ok(result.result?.result?.for_llm);

      const encoded = result.result!.result!.for_llm;
      // Should contain $S header
      assert.ok(encoded.includes("$S"));
      assert.ok(encoded.includes("engram-recall:v1"));
      // Should be shorter than original
      assert.ok(encoded.length < toolOutput.length, `Encoded (${encoded.length}) should be shorter than original (${toolOutput.length})`);

      // Verify it's valid DCP: header + 2 rows
      const lines = encoded.split("\n");
      assert.equal(lines.length, 3, "header + 2 data rows");

      // Header should be parseable JSON array starting with $S
      const header = JSON.parse(lines[0]);
      assert.equal(header[0], "$S");
      assert.equal(header[1], "engram-recall:v1");
    } finally {
      proc.kill();
    }
  });

  it("passes through error results without encoding", async () => {
    const tools = {
      mcp_engram_pull: { id: "test:v1", fields: ["id", "summary"] },
    };
    const proc = startHook(tools);
    try {
      await rpc(proc, 1, "hook.hello", {});

      const result = await rpc(proc, 2, "hook.after_tool", {
        meta: {},
        tool: "mcp_engram_pull",
        result: { for_llm: "Error: connection refused", is_error: true },
      });
      assert.deepStrictEqual(result, { action: "continue" });
    } finally {
      proc.kill();
    }
  });

  it("passes through non-JSON tool output", async () => {
    const tools = {
      mcp_engram_pull: { id: "test:v1", fields: ["id", "summary"] },
    };
    const proc = startHook(tools);
    try {
      await rpc(proc, 1, "hook.hello", {});

      const result = await rpc(proc, 2, "hook.after_tool", {
        meta: {},
        tool: "mcp_engram_pull",
        result: { for_llm: "This is just plain text output", is_error: false },
      });
      assert.deepStrictEqual(result, { action: "continue" });
    } finally {
      proc.kill();
    }
  });

  it("auto-generates schema for 'auto' tools", async () => {
    const tools = {
      web_search: "auto" as const,
    };
    const proc = startHook(tools);
    try {
      await rpc(proc, 1, "hook.hello", {});

      const toolOutput = JSON.stringify([
        { title: "Result 1", url: "https://example.com/1", snippet: "First result snippet", score: 0.9 },
        { title: "Result 2", url: "https://example.com/2", snippet: "Second result snippet", score: 0.7 },
      ]);

      const result = (await rpc(proc, 2, "hook.after_tool", {
        meta: {},
        tool: "web_search",
        result: { for_llm: toolOutput, is_error: false },
      })) as { action: string; result?: { result?: { for_llm: string } } };

      assert.equal(result.action, "modify");
      const encoded = result.result!.result!.for_llm;
      assert.ok(encoded.includes("$S"));
      assert.ok(encoded.length < toolOutput.length);
    } finally {
      proc.kill();
    }
  });
});