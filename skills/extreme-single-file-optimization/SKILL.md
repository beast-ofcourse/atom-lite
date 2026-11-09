
---
name: extreme-single-file-optimization
description: >
  Aggressively optimize a single source file in any programming language
  for maximum practical performance, memory efficiency, and resource usage
  while preserving all functionality. Analyze repository-wide dependencies,
  validate every optimization, benchmark improvements, and iteratively
  optimize until diminishing returns.
---

# Extreme Single-File Optimization

## Mission

Optimize the specified file to its maximum practical potential without
breaking any functionality, changing observable behavior, or introducing
regressions elsewhere in the repository.

Be aggressive with optimization and absolute about correctness.

The goal is not shorter code. The goal is the most efficient practical
implementation that preserves the original behavior.

## 1. Understand Before Modifying

Read the entire target file.

Understand:

- Its purpose, structure, and responsibilities.
- All functions, classes, interfaces, and data structures.
- Its inputs, outputs, side effects, and error behavior.
- Its runtime, language, and relevant compiler characteristics.
- Existing tests and performance bottlenecks.

Do not begin optimizing based on partial inspection.

## 2. Analyze the Entire Repository

The target file must not be treated as an isolated unit.

Inspect relevant repository files to understand:

- Functions imported and exported.
- Callers and consumers.
- Public and internal interfaces.
- Shared state and mutable data.
- Side effects and execution ordering.
- Callbacks, asynchronous behavior, and concurrency.
- Error handling and compatibility requirements.
- Data structures and assumptions relied upon by other functions.

Use repository search, symbol references, tests, and other available tools.

Determine how every proposed optimization could affect downstream
functions and consumers.

The target file is the only file that should be modified unless the
user explicitly authorizes a broader scope.

## 3. Establish a Baseline

Before optimization:

- Run relevant existing tests.
- Identify performance bottlenecks.
- Benchmark the original implementation when possible.
- Record execution time, memory usage, allocations, or other relevant
  metrics.
- Identify important behavioral constraints.

Use representative workloads.

Never invent benchmark results.

If performance measurement is unavailable, use code analysis and
clearly state the limitation.

## 4. Identify All Meaningful Optimizations

Explore the target file for:

### Algorithmic inefficiencies
- Poor time complexity.
- Repeated searches or traversals.
- Unnecessary sorting.
- Inefficient data structures.
- Redundant computation.

### Runtime inefficiencies
- Unnecessary function calls.
- Excessive allocations.
- Repeated conversions.
- Redundant branches.
- Excessive dispatch or synchronization.

### Memory inefficiencies
- Unnecessary copies.
- Temporary objects.
- Duplicate data.
- Excessive retained references.
- Memory leaks.

### Resource inefficiencies
- Redundant I/O.
- Repeated requests.
- Unnecessary parsing or serialization.
- Inefficient resource initialization and cleanup.

### Structural inefficiencies
- Duplicated logic.
- Unnecessary abstractions.
- Excessive indirection.
- Poorly optimized hot paths.

Prioritize algorithmic improvements, redundant work, and resource usage
before micro-optimizations.

Use language-specific and runtime-specific techniques when appropriate.

Do not assume an optimization effective in one language is effective
in another.

## 5. Preserve Complete Functionality

The original implementation is the behavioral reference.

Preserve all observable behavior, including:

- Function signatures and exports.
- Return values and output types.
- Error behavior.
- Side effects.
- Mutation and object identity.
- Ordering guarantees.
- Edge cases.
- Lazy versus eager execution.
- Asynchronous behavior.
- Resource ownership.
- Compatibility with existing consumers.

Do not remove functionality, weaken validation, silently change
contracts, or assume undocumented behavior is irrelevant.

If a behavior is observable by another part of the repository,
preserve it unless explicitly authorized otherwise.

## 6. Execute an Iterative Optimization Loop

Do not perform a single-pass optimization.

Maintain a record of the current best implementation, its measurements,
accepted changes, rejected candidates, and remaining opportunities.

Repeat the following process:

### A. Analyze

Re-examine the current best implementation.

Identify new bottlenecks and opportunities.

### B. Generate and Rank Candidates

Evaluate potential optimizations based on:

- Expected performance gain.
- Confidence in the improvement.
- Correctness risk.
- Memory impact.
- Implementation complexity.
- Repository compatibility.

Reject candidates that violate behavioral constraints.

### C. Select One Candidate

Choose the highest-value viable optimization.

Avoid combining unrelated changes unnecessarily.

### D. Implement

Apply the optimization to the target file.

Keep the change isolated and understandable.

### E. Validate

Run relevant tests, type checks, static analysis, compilation,
and other applicable validation.

When practical, compare the optimized implementation against the
original using differential, property-based, or fuzz testing.

### F. Benchmark

Measure the candidate using the same conditions as the current best.

Compare relevant performance metrics.

### G. Decide

If correctness is established and the improvement is meaningful:

- Accept the optimization.
- Promote it to the current best implementation.
- Update the baseline.
- Re-analyze the entire file.

Otherwise:

- Revert the candidate.
- Preserve the current best implementation.
- Record why the candidate was rejected.

### H. Repeat

Continue optimizing the updated best implementation.

Never blindly follow a static candidate list. Each accepted optimization
may expose new bottlenecks.

## 7. Transactional Optimization

Every optimization attempt must be reversible.

Maintain a known-good version of the target file.

Use Git, isolated worktrees, temporary copies, patches, or another
available mechanism.

Never continue from a known-broken implementation.

If validation fails:

1. Identify the cause.
2. Fix or revert the candidate.
3. Re-run validation.
4. Continue only from a known-good state.

Do not modify unrelated files during optimization.

## 8. Performance Evaluation

Prefer measurable improvements over theoretical assumptions.

Use consistent:

- Hardware.
- Runtime.
- Compiler configuration.
- Input data.
- Workloads.
- Measurement methodology.

Consider warm-up, JIT compilation, garbage collection, caching,
and benchmark noise.

For metrics where lower is better:

Improvement (%) = ((Before - After) / Before) × 100

For throughput:

Improvement (%) = ((After - Before) / Before) × 100

Do not retain an optimization that introduces disproportionate
complexity for negligible or negative gains.

Correctness must never be traded for performance.

## 9. Repository-Wide Regression Validation

After optimization:

- Run relevant unit and integration tests.
- Run the broadest practical regression suite.
- Verify affected callers and consumers.
- Check public interfaces and exports.
- Inspect the complete diff.
- Confirm no unrelated files were modified.
- Verify no debugging code or temporary artifacts remain.

A successful compilation alone is not sufficient.

If full validation is unavailable, explicitly report the limitation.

## 10. Stopping Conditions

Continue until no meaningful optimization opportunities remain.

Stop when:

- All major bottlenecks have been addressed.
- Remaining candidates offer negligible gains.
- Remaining candidates introduce disproportionate complexity or risk.
- Further optimization cannot be validated.
- The iteration budget is exhausted.

Default iteration budget: 20 optimization attempts.

The budget is a safety limit, not a requirement to perform 20 changes.

Never claim mathematical optimality.

Instead, report that no further worthwhile optimizations were identified
within the available constraints.

## 11. Final Report

Provide a concise report containing:

### Optimization Summary
- Target file.
- Main bottlenecks.
- Accepted optimizations.
- Rejected optimizations and reasons.

### Performance
- Before and after measurements.
- Actual improvement percentages.
- Measurement limitations.

### Repository Impact
- Files modified.
- Interfaces preserved.
- Relevant downstream dependencies analyzed.

### Validation
- Tests executed and results.
- Compilation and static analysis.
- Remaining risks or unverified behavior.

### Final Assessment

Choose one:

- FULLY VALIDATED: Behavior preserved and performance improvement
  demonstrated.
- FUNCTIONALLY VALIDATED: Behavior preserved, but performance gains
  were not conclusively measured.
- PARTIALLY VALIDATED: Some validation was unavailable.
- NOT VALIDATED: Correctness could not be established.

Never claim validation that was not performed.

---

# Final Directive

Think deeply. Analyze the entire repository. Optimize aggressively.

Treat every meaningful performance opportunity as a candidate for
investigation.

Use an iterative, reversible, evidence-driven optimization process.

Preserve all existing functionality and observable behavior.

The final implementation must be the best practical version of the
specified file, not merely a cleaner or shorter version.

