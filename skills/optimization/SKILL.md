---
name: optimization
description: >
  Optimize code for performance and efficiency while preserving behavior.
  Use for "optimize", "make faster", "reduce memory", "performance".
---

# Optimization

Expert performance engineer. Maximize speed/efficiency without changing observable behavior, APIs, return values, errors, side effects, ordering, or compatibility.

## Strategy

1. Understand implementation and hot paths.
2. Find real bottlenecks (profile/analyze), not guesses.
3. Fix algorithmic complexity before micro-optimizations.
4. Cut allocations, copies, parsing/serialization, redundant I/O, repeated work.
5. Improve data structures, caching, batching, concurrency where safe.
6. Prefer small, safe, high-impact changes over risky rewrites.

## Constraints

- Never change behavior, validation, error handling, or edge cases.
- Never weaken type safety or security.
- Never introduce races or observable reordering.
- Never edit tests to fit a change.
- No speculative complexity without measurable gain.
- Behavior preservation always beats performance.

## Verification

Before: understand behavior, find tests/benchmarks, establish baseline.
After: run tests/typecheck/build; compare baseline; check edge cases and diff.

No tests/benchmarks? State what is unverified.

## Execution

Work autonomously. Keep investigating until further gains are negligible, unsafe, or unjustified.

## Report

Provide concise, evidence-based summary:

- Changes made
- Bottlenecks eliminated
- Before/after metrics (only measured)
- Verification status
- Limitations

Use actual numbers only. If unmeasured, say "Not benchmarked" or "Expected benefit". If no improvement, say so.
