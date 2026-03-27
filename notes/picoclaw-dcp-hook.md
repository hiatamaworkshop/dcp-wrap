# PicoClaw DCP Hook — Design Notes

## Discovery (2026-03-28)

PicoClaw has a modifiable `after_tool` hook that can transform tool output before it reaches the LLM. Out-of-process hooks communicate via JSON-RPC over stdio — any language works, including Node.js.

This means dcp-wrap can run as an external hook process. No Go port needed.

## Hook System

| Hook | Type | Modifiable |
|------|------|:----------:|
| before_llm | LLMInterceptor | yes |
| after_llm | LLMInterceptor | yes |
| before_tool | ToolInterceptor | yes |
| **after_tool** | **ToolInterceptor** | **yes** |
| approve_tool | ToolApprover | allow/deny |

Out-of-process hooks: JSON-RPC over stdio, configured via command + env + intercept array.

## Architecture

```
Tool execution → JSON result
  → after_tool hook (Node.js external process)
    → if tool in dcp-enabled list: dcpEncode(result, schema)
    → else: pass through unchanged
  → LLM receives DCP (or original JSON)
```

## Config Shape (tentative)

```json
{
  "command": "node",
  "args": ["path/to/dcp-hook.js"],
  "intercept": ["after_tool"],
  "env": {},
  "config": {
    "tools": {
      "mcp_engram_pull": { "id": "engram-recall:v1", "fields": ["id","relevance","summary","tags","hitCount","weight","status"] },
      "mcp_engram_ls": { "id": "engram-scan:v1", "fields": ["id","summary","tags","hitCount","weight","status"] },
      "web_search": "auto"
    }
  }
}
```

- Explicit schema: inline `{ id, fields }` per tool → uses dcpEncode directly
- `"auto"`: run SchemaGenerator on first batch, cache schema for subsequent calls
- Unlisted tools: pass through, no transformation

## What this enables

- DCP compression on any PicoClaw tool output, selectable per tool
- No modification to PicoClaw core
- dcp-wrap as the encoding engine (Node.js, already built)
- Particularly valuable on edge devices (Raspberry Pi) where token cost matters most

## Open Questions

- JSON-RPC message format for after_tool: need to inspect PicoClaw source for exact payload shape
- Schema caching: where to persist auto-generated schemas between hook invocations
- PicoClaw's after_llm hook could also be used for output controller (AI → DCP) — the claw-type decode scenario

## Dependencies

- PicoClaw v0.2.4+ (hook system)
- dcp-wrap (npm, already published)
- Node.js runtime on target device

## Status

Research complete. Implementation blocked on: verifying JSON-RPC payload format from PicoClaw source.
