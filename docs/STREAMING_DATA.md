# DCP Streaming Data — Design Basis

## The Problem

DCP is a batch format. Sensors, autonomous vehicles, and external AI systems produce
continuous, high-frequency streams — millisecond-level data that cannot be fed directly
to an LLM. Sending raw streams to an LLM is both cost-prohibitive and semantically wrong:
LLMs are not stream processors.

The question is not how to serialize a stream. It is **what to distill from the stream,
and when to surface it.**

---

## Core Principle

**LLMs receive only events, not streams.**

Everything between the sensor and the LLM exists to reduce, not relay. The stream is
transformed into a sparse sequence of meaningful signals. The LLM is invoked only when
a threshold is crossed — not on every tick.

---

## Layer Structure

```
[Sensor / External AI]       ms-level continuous data
        ↓
[Scheduler]                  ms-level polling, time-window management
        ↓
[Stats Shadow]               snapshot generation per window
                             - field values: mean, delta, variance, etc.
                             - bit flags: threshold conditions as booleans
                             - maps the stream state; makes no decisions
        ↓
[Analyzer]                   optional — insert only when needed
                             complex integration, cross-field correlation,
                             multi-source aggregation
        ↓
[Receptor Neuron System]     threshold monitoring and signal emission
                             - fires only when threshold is crossed
                             - suppresses during normal operation
        ↓
[LLM]                        receives distilled events only
```

For simple cases, omit the Analyzer. Stats Shadow feeds the Receptor directly.
The Analyzer is an extension layer, not a default component.

---

## Stats Shadow

Stats Shadow is a **snapshot, not an analyzer**. Its job is to translate the current
window state into a fixed DCP positional array. It computes. It does not judge.

**Responsibilities:**
- Calculate field values within the time window (mean, delta, slope, count, etc.)
- Set bit flags based on observed conditions
- Emit a DCP-formatted snapshot for the Receptor to evaluate

**Not its job:**
- Threshold decisions
- Cross-source correlation
- Trend accumulation (delegate to Analyzer if needed)

Stats Shadow schema fields are domain-derived values and bit flags only.

```
["$S","sensor-window:v1","mean","delta","variance","flags"]
[42.1, 3.2, 0.8, 0b0101]
```

---

## Receptor Neuron System

The receptor design established in the engram project applies directly here.
The core mechanisms transfer without modification:

| Mechanism | Purpose |
|-----------|---------|
| **EMA baseline** | Tracks the agent's normal operating level dynamically. Threshold is relative to baseline, not an absolute value. |
| **Hold/Release** | Prevents flapping. A signal must fall below threshold 3 consecutive times before release. Eliminates ON/OFF oscillation on noisy data. |
| **MetaNeuron (C) field emission** | Adjusts thresholds indirectly based on observed signal patterns. Sensitivity adapts to the current environment without the B layer knowing why. |

The receptor core is domain-agnostic. Each domain provides a configuration equivalent
to engram's `emotion-profile.json` — field names, baseline offsets, threshold ranges.
The core processes all domains identically.

---

## Domain Adapter

The Normalizer pattern from engram applies here too. Raw sensor events use
domain-specific vocabulary. The adapter translates to normalized actions before
the receptor core sees them.

```
LLM coding agent:    tool_name       → file_read, shell_exec, ...
Autonomous vehicle:  control_command → lane_change, brake, scan, ...
Robotics AI:         motor_command   → grasp, reach, wait, ...
Sensor stream:       measurement     → in_range, spike, dropout, ...
```

The adapter layer is thin — it isolates domain-specific noise and preserves
core purity. Swapping domains means swapping the adapter and the profile config.
The receptor core does not change.

---

## DCP as the Interface

Stats Shadow emits DCP positional arrays. This is the natural fit:

- **Fixed-length arrays** — the receptor evaluates fields by index directly, no key lookup
- **Bitmask for field presence** — handles partial sensor dropout cleanly
- **Schema ID per domain** — multiple streams can coexist, each identified by schema
- **$S header** — schema travels with the snapshot; no external docs needed

The receptor reads position N. That is the value. No parsing cost.

---

## Summary

| Problem | Solution |
|---------|----------|
| Raw streams cannot go to LLMs | Scheduler + Stats Shadow distills to snapshots |
| Distillation logic varies by domain | Analyzer as optional extension layer |
| Absolute thresholds are fragile | EMA baseline adapts to normal operating level |
| Noisy signals cause flapping | Hold/Release suppresses oscillation |
| Sensitivity needs context | MetaNeuron adjusts thresholds indirectly |
| Multiple domains, one core | Normalizer adapter + domain profile config |

The receptor fires. The LLM responds. Everything in between exists to make that
firing rare, meaningful, and well-timed.