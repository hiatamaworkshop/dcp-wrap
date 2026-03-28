# DCP Integration with PicoClaw

Reduce LLM token consumption by 40-60% on structured tool output — without modifying PicoClaw's core.

PicoClaw's [hook system](https://github.com/sipeed/picoclaw) provides `after_tool` interception points. dcp-wrap runs as an out-of-process hook that intercepts JSON tool results and converts them to DCP positional arrays before they reach the LLM.

```
Tool execution → JSON result
  → after_tool hook (dcp-wrap, Node.js)
    → DCP encode: {"id":"abc","score":0.9,"tags":["fix"]} → ["abc",0.9,"fix"]
  → LLM receives compact DCP instead of verbose JSON
```

## Prerequisites

- PicoClaw v0.2.4+
- Node.js 18+ (installed in PicoClaw's environment)
- dcp-wrap (`npm install dcp-wrap`)

## Quick Start

### 1. Install dcp-wrap

```bash
npm install dcp-wrap
```

### 2. Add the hook to PicoClaw config

In your `config.json`, add the `hooks` section. The hook runs as an external process communicating via JSON-RPC over stdio.

```json
{
  "version": 1,
  "hooks": {
    "enabled": true,
    "processes": {
      "dcp_encoder": {
        "enabled": true,
        "priority": 50,
        "transport": "stdio",
        "command": ["node", "./node_modules/dcp-wrap/dist/picoclaw-hook.js"],
        "intercept": ["after_tool"],
        "env": {
          "PICOCLAW_DCP_TOOLS": "{\"my_api_tool\":{\"id\":\"api-response:v1\",\"fields\":[\"endpoint\",\"method\",\"status\",\"latency_ms\"]}}"
        }
      }
    }
  }
}
```

### 3. Restart PicoClaw

The hook starts automatically on the first user message (hooks are lazily initialized).

Check the logs for:
```
Process hook stderr | hook=dcp_encoder | stderr="[dcp-hook] Started. Tools configured: my_api_tool"
```

## Configuring Tools

The `PICOCLAW_DCP_TOOLS` environment variable maps tool names to DCP schemas. Two modes:

### Explicit schema (recommended for known tools)

Define the schema ID and field list. Fields are extracted by name from the JSON output.

```json
{
  "mcp_engram_pull": {
    "id": "engram-recall:v1",
    "fields": ["id", "relevance", "summary", "tags", "hitCount", "weight", "status"]
  }
}
```

### Auto schema (for unknown/varying tools)

Set `"auto"` and dcp-wrap will infer the schema from the first batch of results.

```json
{
  "web_fetch": "auto"
}
```

Auto-generated schemas are cached for the hook process lifetime. Good for exploration; switch to explicit schemas once you know the output shape.

### Mixed configuration

```json
{
  "mcp_engram_pull": {
    "id": "engram-recall:v1",
    "fields": ["id", "relevance", "summary", "tags", "hitCount", "weight", "status"]
  },
  "mcp_engram_ls": {
    "id": "engram-scan:v1",
    "fields": ["id", "summary", "tags", "hitCount", "weight", "status"]
  },
  "web_fetch": "auto"
}
```

Unlisted tools pass through unchanged.

## What gets encoded

The hook intercepts `result.for_llm` — the string that PicoClaw sends to the LLM as tool output. Encoding happens only when:

1. The tool is listed in `PICOCLAW_DCP_TOOLS`
2. The result is not an error (`is_error: false`)
3. The result parses as JSON (object or array of objects)

If any condition fails, the result passes through unchanged. The hook never breaks tool output.

## Where DCP helps most

DCP reduces tokens on **structured, multi-record data**:

| Tool output type | DCP effect | Why |
|---|---|---|
| Array of JSON objects (API results, search results, database rows) | 40-60% reduction | Repeated keys eliminated, positional encoding |
| Single JSON object with large text field | ~0% reduction | Text dominates, schema overhead > savings |
| Plain text | Passthrough | Not JSON, nothing to encode |

Best candidates: MCP tool results, API responses, database queries, structured search results.

## Docker Setup

PicoClaw's official Docker image (`sipeed/picoclaw:latest`) is Alpine-based with no Node.js. Add it:

```dockerfile
FROM docker.io/sipeed/picoclaw:latest

USER root
RUN apk add --no-cache nodejs npm

# Option A: npm install (when dcp-wrap is published)
# WORKDIR /opt/dcp-hook
# RUN npm install dcp-wrap

# Option B: copy built dist (local development)
WORKDIR /opt/dcp-hook/node_modules/dcp-wrap
COPY dcp-wrap-dist/ ./dist/
COPY dcp-wrap-package.json ./package.json

WORKDIR /root
ENTRYPOINT ["picoclaw"]
CMD ["gateway"]
```

Update the hook command path in config:
```json
"command": ["node", "/opt/dcp-hook/node_modules/dcp-wrap/dist/picoclaw-hook.js"]
```

Mount config via volume:
```yaml
services:
  picoclaw-gateway:
    build: .
    volumes:
      - ./data:/root/.picoclaw
    extra_hosts:
      - "host.docker.internal:host-gateway"
    ports:
      - "127.0.0.1:18800:18790"
```

## Gotchas

### Config must have `"version": 1`

PicoClaw's config migration runs when `version` is missing (treated as v0). The v0-to-v1 migration re-serializes the Go struct with `omitempty`, which silently drops `hooks.processes` if it wasn't recognized during migration.

Always start your config with:
```json
{
  "version": 1,
  ...
}
```

### Hooks initialize lazily

Don't expect hook logs at gateway startup. The `hook.hello` handshake happens on the first user message that triggers a turn. If you only see startup logs with no hook activity, send a message first.

### `intercept: ["after_tool"]` also sends `before_tool`

PicoClaw maps both `before_tool` and `after_tool` to a single `InterceptTool` flag. The hook receives both RPCs. dcp-wrap handles this correctly (returns `{"action": "continue"}` for `before_tool`).

### Plain text tool output

Some built-in tools (e.g., DuckDuckGo `web_search`) return plain text, not JSON. The hook passes these through unchanged. This is correct behavior — DCP encodes structure, not prose.

## How it works internally

The hook process communicates with PicoClaw via [JSON-RPC over stdio](https://github.com/sipeed/picoclaw):

```
PicoClaw                          dcp-wrap hook (Node.js)
   │                                    │
   ├──hook.hello──────────────────────▶│
   │◀─────────────{ok:true}────────────┤
   │                                    │
   │  (user sends message, LLM calls tool)
   │                                    │
   ├──hook.before_tool────────────────▶│
   │◀─────────{action:"continue"}──────┤
   │                                    │
   │  (tool executes, produces result)  │
   │                                    │
   ├──hook.after_tool─────────────────▶│
   │  {tool:"mcp_query",               │
   │   result:{for_llm:"[{...},...]"}} │
   │                                    │
   │  (hook encodes for_llm via DCP)    │
   │                                    │
   │◀──{action:"modify",───────────────┤
   │    result:{for_llm:"[$S,...]\n..."}}│
   │                                    │
   │  (LLM receives DCP-encoded output) │
```

### RPC payloads

**after_tool request** (PicoClaw sends):
```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "hook.after_tool",
  "params": {
    "meta": {"session_key": "..."},
    "tool": "mcp_engram_pull",
    "arguments": {"query": "docker port conflict"},
    "result": {
      "for_llm": "[{\"id\":\"abc\",\"relevance\":0.95,...}]",
      "is_error": false
    },
    "duration": 234000000
  }
}
```

**after_tool response** (hook returns, when encoding):
```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "result": {
    "action": "modify",
    "result": {
      "meta": {"session_key": "..."},
      "tool": "mcp_engram_pull",
      "result": {
        "for_llm": "[\"$S\",\"engram-recall:v1\",\"id\",\"relevance\",\"summary\",\"tags\"]\n[\"abc\",0.95,\"docker port fix\",\"docker,gotcha\"]"
      }
    }
  }
}
```

## Why PicoClaw, not OpenClaw

We evaluated both frameworks for DCP integration. PicoClaw is the clear choice.

### OpenClaw: skill/prompt-level DCP constraints don't work

OpenClaw's architecture makes hook-level interception impractical:

- **Built-in prompts override skill prompts.** DCP formatting instructions added via skills or custom prompts are silently overridden by OpenClaw's internal system prompt. The LLM never sees the DCP constraint.
- **No output hooks.** OpenClaw has no `after_tool` equivalent. There is no way to intercept tool results before they reach the LLM. This is tracked as [OpenClaw #12914](https://github.com/openclaw/openclaw) but unimplemented as of March 2026.
- **Plugin architecture is input-only.** OpenClaw plugins can modify the system prompt but cannot intercept or transform tool output.

Bottom line: without output hooks, DCP encoding at the tool result boundary is impossible in OpenClaw.

### PicoClaw: 4 modifiable hooks = complete DCP pipeline

PicoClaw's hook system was designed for exactly this kind of interception:

| Hook | DCP role | Status |
|---|---|---|
| `after_tool` | Encode tool JSON → DCP positional arrays | **Implemented** |
| `before_llm` | Inject output controller ("respond as DCP") | Planned |
| `after_llm` | Cap non-conforming output + decode for messaging | Planned |
| `before_tool` | (Optional) Tool argument optimization | Not needed |

Key advantages:
- **Out-of-process hooks** via JSON-RPC over stdio — any language works, no Go port needed
- **Modifiable responses** — hooks can rewrite tool results, not just observe them
- **Per-tool selectivity** — DCP encode only configured tools, everything else passes through
- **Edge device focus** — PicoClaw targets Raspberry Pi and resource-constrained hardware where token cost is a real constraint, not theoretical

### Practical comparison

| | OpenClaw | PicoClaw |
|---|---|---|
| Hook system | No output hooks | 4 modifiable hooks |
| Tool result interception | Impossible | `after_tool` with modify |
| DCP encoding | Not feasible | Working (dcp-wrap hook) |
| LLM output control | Prompt-level only (overridden) | `before_llm` injection |
| External process hooks | Not supported | JSON-RPC over stdio |
| Token cost sensitivity | Cloud-focused | Edge-device-focused |

## Rate limits and tool count

PicoClaw sends all tool definitions to the LLM on every turn. With MCP servers, tool count can grow quickly:

| Configuration | Tool count | ~Input tokens per turn |
|---|---|---|
| Default (built-in only) | 14 | ~8K |
| + 1 MCP server (6 tools) | 20 | ~15K |
| + skills, multiple MCP servers | 30+ | ~25K+ |

On Anthropic's free/low-tier plans (50K input tokens/min), a single multi-iteration turn with 20+ tools can hit rate limits. Mitigations:

1. **Disable unused tools** — Set `"enabled": false` for tools you don't need (exec, read_file, write_file, spawn, subagent, skills)
2. **Clear session history** — Delete `data/sessions/` to reset accumulated context
3. **Limit iterations** — Set `max_tool_iterations` lower (e.g., 5)
4. **Use a higher-tier API plan** — More headroom for agentic loops

This is actually where `before_llm` DCP encoding of ToolDefinition[] would have the highest impact — compressing 20+ tool schemas that ship on every single turn.

## Real-world results: engram MCP integration

### The problem with naive after_tool encoding

The initial approach — intercept JSON tool results in `after_tool` and DCP-encode them — hit a fundamental issue: **most tool output is not JSON**.

| Tool | Output format | DCP encodable? |
|---|---|---|
| web_search (DuckDuckGo) | Plain text (`"Results for: ..."`) | No |
| web_fetch | Single JSON object, `text` field dominates | ~0% reduction |
| read_file, exec, list_dir | Plain text | No |
| cron (list) | Plain text (`"Scheduled jobs:\n- ..."`) | No |
| **MCP tools (engram_pull)** | **Depends on output mode** | **Yes, with the right approach** |

Even engram's MCP server returns human-readable text by default:
```
Found 10 results for "DCP" (cross-project):
[1] DCP formatter placement: OUT-side...
    hits=2 weight=-2.58 status=recent relevance=0.345
    tags: why, dcp, formatter, architecture
    id: a7b5dce9-...
```

This is 5649 chars for 10 results. Not JSON, so the after_tool hook passes it through unchanged.

### The solution: before_tool parameter injection

engram's MCP server already supports a `queryType` parameter:
- `queryType: "human"` (default) — verbose natural language
- `queryType: "agent"` — DCP positional arrays with `$S` header

The problem: PicoClaw's LLM doesn't know to pass `queryType: "agent"`. It uses whatever parameters it decides on.

The fix: **use `before_tool` to inject `queryType: "agent"` before the MCP call executes**.

```typescript
// In picoclaw-hook.ts
const AGENT_QUERY_TOOLS = new Set(["mcp_engram_engram_pull", "mcp_engram_engram_ls"]);

function handleBeforeTool(params: unknown): unknown {
  const payload = params as ToolCallPayload;
  if (AGENT_QUERY_TOOLS.has(payload.tool)) {
    return {
      action: "modify",
      call: {
        ...payload,
        arguments: { ...payload.arguments, queryType: "agent" },
      },
    };
  }
  return { action: "continue" };
}
```

This is transparent to the LLM — it calls `engram_pull` normally, the hook injects the parameter, engram returns DCP, and the LLM reads compact positional arrays.

### Measured results

```
before_tool: injecting queryType=agent for mcp_engram_engram_pull
Tool call: mcp_engram_engram_pull({"crossProject":true,"limit":10,"query":"DCP","queryType":"agent"})
Tool execution completed | result_length=1697 | tool=mcp_engram_engram_pull
```

| | Human format | DCP format | Reduction |
|---|---|---|---|
| engram_pull (10 results) | 5649 chars | 1697 chars | **70%** |
| LLM iterations to answer | 3 | 2 | **-33%** |

The LLM correctly interprets the DCP `$S` header and positional rows, extracting the same information from 70% fewer tokens.

### Key insight: two-hook pattern

The effective pattern is not `after_tool` alone, but **`before_tool` + `after_tool` working together**:

1. **`before_tool`**: Inject parameters that tell the MCP server to return compact format
2. **`after_tool`**: Available as fallback for tools that don't have a compact mode (auto-encode JSON via SchemaGenerator)

This avoids the fundamental problem of trying to parse and re-encode text that was never JSON in the first place.

### Difficulties encountered during integration

**engram MCP dist was stale.** The `dcp-format.ts` source existed but `dist/dcp-format.js` did not — the MCP server had never been rebuilt after adding DCP output support. The hook injected `queryType: "agent"` correctly, the MCP server received it, but the import of `formatRecallDcp` failed silently and fell through to the human format codepath. Always rebuild MCP servers before copying dist into Docker.

**MCP tool naming convention.** PicoClaw prefixes MCP tools with `mcp_{serverName}_{toolName}`. For server `engram` and tool `engram_pull`, the full name is `mcp_engram_engram_pull` — not `mcp_engram_pull`. This affects both the DCP_TOOLS config and the AGENT_QUERY_TOOLS set.

**Environment variable naming.** engram's MCP server uses `GATEWAY_URL`, not `ENGRAM_GATEWAY_URL`. The first attempt used the wrong name, causing `Cannot reach http://localhost:3100` errors inside the container (the default fallback).

**Rate limits with many tools.** PicoClaw sends all tool definitions on every LLM turn. With 6 MCP tools + 14 built-in tools = 20 tools, a multi-iteration turn can exceed Anthropic's 50K input tokens/min limit. Disabling unused tools (exec, file I/O, skills, spawn) reduced the count from 21 to 11 and resolved the issue.

## For MCP server authors: why your server should speak DCP

This integration proved one thing clearly: **DCP cannot be bolted on from outside.** A hook sitting between the tool and the LLM can only work with what the tool gives it. If the tool returns plain text, there is nothing to compress.

### The plain text problem

Most tools — web_search, exec, read_file, cron, list_dir — return plain text for a good reason: maximum compatibility. Any LLM can read text. No schema knowledge required.

But this "compatibility" has a cost. When an MCP tool returns 10 structured records as formatted text:

```
[1] DCP formatter placement: OUT-side...
    hits=2 weight=-2.58 status=recent relevance=0.345
    tags: why, dcp, formatter, architecture
    id: a7b5dce9-...
```

Every field label (`hits=`, `weight=`, `status=`, `tags:`, `id:`) is repeated per record. For 10 records, that's 10x the overhead. The LLM reads all of it, pays for all of it, and extracts the same information that a positional array conveys in a fraction of the tokens.

### What MCP servers should do

Add a `queryType` parameter (or equivalent) to your tool schema:

```typescript
server.tool("my_tool", {
  query: z.string(),
  queryType: z.enum(["human", "agent"]).optional()
    .describe("'agent' returns DCP compact format. Default: 'human'."),
}, async ({ query, queryType }) => {
  const results = await fetchResults(query);

  if (queryType === "agent") {
    // DCP positional arrays — 70% fewer tokens
    return { content: [{ type: "text", text: dcpEncode(results, schema) }] };
  }

  // Human-readable text — default, compatible with everything
  return { content: [{ type: "text", text: formatHuman(results) }] };
});
```

This is the contract. The MCP tool declares it can speak DCP. The consumer (LLM, hook, agent framework) decides whether to ask for it.

### Why this matters

Without this contract:
- Hooks can only observe text, not compress it
- Every agent framework must implement its own parsing for every tool's text format
- Token costs scale linearly with verbosity

With this contract:
- A `before_tool` hook injects `queryType: "agent"` once
- The MCP server returns DCP natively — no parsing, no re-encoding
- 70% token reduction, measured and proven
- The human format remains the default — nothing breaks for consumers that don't know DCP

The MCP protocol already provides the mechanism: typed parameters via tool schemas. DCP doesn't require a new protocol — it requires MCP servers to **offer a compact output mode** and consumers to **ask for it**.

### The pattern for any MCP server

1. **Keep human format as default.** Backward compatible. Text works everywhere.
2. **Add `queryType: "agent"` parameter.** Declare the compact mode exists.
3. **Return DCP when asked.** Use [dcp-wrap](https://github.com/hiatamaworkshop/dcp-wrap) or format positional arrays directly.
4. **Let hooks handle the switching.** Agent frameworks inject the parameter automatically — the LLM never needs to learn about it.

## Scheduled tasks and DCP: where it applies

PicoClaw has two schedulers: **cron** (user-defined jobs) and **heartbeat** (periodic `HEARTBEAT.md` check). Whether DCP applies depends on the execution path.

### Execution paths

| Scheduler | Mode | Flow | DCP applies? |
|---|---|---|---|
| Cron | `deliver=false` (default) | Message → LLM turn → LLM calls tools → response | **Yes** — tools go through hooks |
| Cron | `deliver=true` | Message → direct to Telegram | No — LLM not involved |
| Cron | `command` set | Shell exec → output to Telegram | No — LLM not involved |
| Heartbeat | — | HEARTBEAT.md → LLM turn → LLM calls tools → response | **Yes** — same as cron deliver=false |

The key: cron `deliver=false` and heartbeat both start an LLM turn via `ProcessDirectWithChannel`. The LLM decides which tools to call. Those tool calls go through `before_tool` (parameter injection) and `after_tool` (encoding fallback) — the same DCP pipeline as interactive messages.

### What this means in practice

A heartbeat task like "Check engram for new knowledge about DCP" triggers:

```
Heartbeat tick (every 30 min)
  → LLM reads HEARTBEAT.md task list
  → LLM calls mcp_engram_engram_pull(query="DCP")
  → before_tool injects queryType=agent     ← DCP kicks in here
  → engram returns 1697 chars (not 5649)    ← 70% saved
  → LLM summarizes and sends to Telegram
```

Every 30 minutes, 70% fewer tokens per engram query. Over a day, that compounds.

### Input-side DCP: the before_llm frontier

The current implementation handles **tool output** (after_tool) and **tool parameters** (before_tool). But the largest token cost is on the **input side** — what gets sent to the LLM on every single turn:

| Input component | Sent every turn | Approximate tokens | DCP potential |
|---|---|---|---|
| Tool definitions (12+ tools) | Yes | ~4K-8K | **High** — repeated structured schemas |
| Conversation history | Yes | Grows over time | **High** — message[] with repeated structure |
| System prompt | Yes (cached by LLM) | ~2K | Low — already prefix-cached |
| User message | Yes | Small | None — natural language |

The `before_llm` hook can intercept the full `LLMHookRequest` including `messages[]` and `tools[]`. Compressing tool definitions from verbose JSON Schema to DCP positional format could save 50%+ on every turn — but this requires the LLM to understand DCP tool schemas, which is unverified territory.

This is the next frontier. The tool output side is solved. The input side is where the remaining cost lives.

### Guidance for task authors

When writing `HEARTBEAT.md` tasks or cron job messages, structure them so the LLM calls MCP tools (which benefit from DCP) rather than built-in text tools:

```markdown
## Good — triggers MCP tool with DCP benefit
- Check engram for recent knowledge about deployment issues
- Search engram for error patterns from this week

## Less effective — triggers text-output tools
- Run `df -h` and report disk usage
- Fetch https://status.example.com and summarize
```

The former triggers `engram_pull` → DCP encoding → 70% savings. The latter triggers `exec` or `web_fetch` → plain text → no DCP benefit.

## Next steps

- [DCP Specification](https://dcp-docs.pages.dev/dcp/specification) — full protocol design
- [dcp-wrap README](../README.md) — CLI and programmatic API
- [Schema-Driven Encoder](https://dcp-docs.pages.dev/dcp/schema-driven-encoder) — how encoding works