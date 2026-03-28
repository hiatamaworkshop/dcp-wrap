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

## Next steps

- [DCP Specification](https://dcp-docs.pages.dev/dcp/specification) — full protocol design
- [dcp-wrap README](../README.md) — CLI and programmatic API
- [Schema-Driven Encoder](https://dcp-docs.pages.dev/dcp/schema-driven-encoder) — how encoding works