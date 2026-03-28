#!/usr/bin/env node
/**
 * PicoClaw DCP Hook — out-of-process JSON-RPC over stdio.
 *
 * Intercepts `after_tool` and DCP-encodes tool results to reduce tokens.
 * Configured via PICOCLAW_DCP_TOOLS env var (JSON) or config passed at hello.
 *
 * Usage:
 *   node dist/picoclaw-hook.js
 *
 * Config (picoclaw config.json):
 *   {
 *     "hooks": {
 *       "enabled": true,
 *       "processes": {
 *         "dcp_encoder": {
 *           "enabled": true,
 *           "transport": "stdio",
 *           "command": ["node", "path/to/dcp-wrap/dist/picoclaw-hook.js"],
 *           "intercept": ["after_tool"],
 *           "env": {
 *             "PICOCLAW_DCP_TOOLS": "{\"mcp_engram_pull\":{\"id\":\"engram-recall:v1\",\"fields\":[\"id\",\"relevance\",\"summary\",\"tags\",\"hitCount\",\"weight\",\"status\"]}}"
 *           }
 *         }
 *       }
 *     }
 *   }
 */

import { createInterface } from "node:readline";
import { dcpEncode, SchemaGenerator } from "./index.js";
import type { InlineSchema, SchemaDraft } from "./index.js";

// --- Types ---

interface ToolConfig {
  id: string;
  fields: string[];
}

type ToolsConfig = Record<string, ToolConfig | "auto">;

interface RPCMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolResultPayload {
  meta: Record<string, unknown>;
  tool: string;
  arguments?: Record<string, unknown>;
  result?: {
    for_llm: string;
    for_user?: string;
    silent?: boolean;
    is_error?: boolean;
    media?: string[];
  };
  duration?: number;
  channel?: string;
  chat_id?: string;
}

// --- State ---

let toolsConfig: ToolsConfig = {};
const autoSchemaCache = new Map<string, InlineSchema>();

// --- Config loading ---

function loadConfig(): void {
  const envTools = process.env.PICOCLAW_DCP_TOOLS;
  if (envTools) {
    try {
      toolsConfig = JSON.parse(envTools);
    } catch {
      log(`Failed to parse PICOCLAW_DCP_TOOLS: ${envTools}`);
    }
  }
}

// --- Logging ---

function log(msg: string): void {
  process.stderr.write(`[dcp-hook] ${msg}\n`);
}

// --- JSON-RPC ---

function sendResponse(id: number, result: unknown): void {
  const msg: RPCMessage = { jsonrpc: "2.0", id, result };
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendError(id: number, code: number, message: string): void {
  const msg: RPCMessage = { jsonrpc: "2.0", id, error: { code, message } };
  process.stdout.write(JSON.stringify(msg) + "\n");
}

// --- DCP encoding ---

function tryParseJSON(text: string): unknown[] | null {
  // Tool output may be JSON array or JSON object or text.
  // Try to parse as JSON. If it's an array of objects, return it.
  // If it's a single object, wrap in array.
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      if (parsed.length > 0 && typeof parsed[0] === "object" && parsed[0] !== null) {
        return parsed;
      }
      return null;
    }
    if (typeof parsed === "object" && parsed !== null) {
      return [parsed];
    }
    return null;
  } catch {
    return null;
  }
}

function encodeToolResult(toolName: string, forLlm: string): string | null {
  const config = toolsConfig[toolName];
  if (!config) return null;

  const records = tryParseJSON(forLlm);
  if (!records) return null;

  if (config === "auto") {
    return encodeAuto(toolName, records as Record<string, unknown>[]);
  }

  // Explicit schema
  const schema: InlineSchema = { id: config.id, fields: config.fields };
  return dcpEncode(records as Record<string, unknown>[], schema);
}

function encodeAuto(toolName: string, records: Record<string, unknown>[]): string | null {
  let schema = autoSchemaCache.get(toolName);

  if (!schema) {
    // Generate schema from first batch
    const gen = new SchemaGenerator();
    const draft: SchemaDraft = gen.fromSamples(records, {
      domain: toolName,
      maxDepth: 3,
      maxFields: 20,
    });
    schema = { id: draft.schema.id, fields: draft.schema.fields };
    autoSchemaCache.set(toolName, schema);
    log(`Auto-generated schema for ${toolName}: ${schema.fields.join(",")}`);
  }

  return dcpEncode(records, schema);
}

// --- Hook handlers ---

function handleHello(_params: Record<string, unknown>): unknown {
  return { ok: true, name: "dcp-encoder" };
}

function handleAfterTool(params: unknown): unknown {
  const payload = params as ToolResultPayload;
  const toolName = payload.tool;
  const result = payload.result;

  if (!result || result.is_error || !result.for_llm) {
    return { action: "continue" };
  }

  const encoded = encodeToolResult(toolName, result.for_llm);
  if (!encoded) {
    return { action: "continue" };
  }

  const originalLen = result.for_llm.length;
  const encodedLen = encoded.length;
  const reduction = ((1 - encodedLen / originalLen) * 100).toFixed(0);
  log(`${toolName}: ${originalLen} → ${encodedLen} chars (${reduction}% reduction)`);

  // Return modified result
  return {
    action: "modify",
    result: {
      ...payload,
      result: {
        ...result,
        for_llm: encoded,
      },
    },
  };
}

function handleRequest(method: string, params: unknown): unknown {
  switch (method) {
    case "hook.hello":
      return handleHello((params ?? {}) as Record<string, unknown>);
    case "hook.after_tool":
      return handleAfterTool(params);
    case "hook.before_tool":
    case "hook.before_llm":
    case "hook.after_llm":
    case "hook.approve_tool":
      return { action: "continue" };
    default:
      throw new Error(`method not found: ${method}`);
  }
}

// --- Main loop ---

function main(): void {
  loadConfig();
  log(`Started. Tools configured: ${Object.keys(toolsConfig).join(", ") || "(none — use PICOCLAW_DCP_TOOLS env)"}`);

  const rl = createInterface({ input: process.stdin });

  rl.on("line", (line: string) => {
    if (!line.trim()) return;

    let msg: RPCMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      log(`Failed to parse: ${line.slice(0, 100)}`);
      return;
    }

    // Notification (no id) — ignore
    if (!msg.id) return;

    try {
      const result = handleRequest(msg.method ?? "", msg.params);
      sendResponse(msg.id, result);
    } catch (err) {
      sendError(msg.id, -32000, (err as Error).message);
    }
  });

  rl.on("close", () => {
    process.exit(0);
  });
}

main();