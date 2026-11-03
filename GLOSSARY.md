# Atom-lite

A local-first, model-agnostic coding agent with exactly four built-in tools (`read`, `write`, `edit`, `bash`), one agent loop, and a deterministic tool scheduler. Runs against local or hosted model providers through interchangeable adapters.

## Language

**Workspace**:
The root directory an Atom-lite session operates within. `read`, `write`, and `edit` resolve paths against it and reject escapes; it is the boundary for file-tool safety (but not for shell commands).
_Avoid_: project root, repo root, working directory (when meaning the safety boundary)

**Provider profile**:
A named combination of endpoint, model, authentication source, and options. Selectable at startup or at a safe conversation boundary; switching mid-tool-exchange is disallowed.
_Avoid_: provider, model config, endpoint

**Agent turn**:
One iteration of the agent loop: build context → model response → (if tool calls) execute the tool-call batch → append results. The loop runs turns until a final answer or a limit.
_Avoid_: iteration, step, round

**Tool-call batch**:
All tool calls returned in a single model response, scheduled together with conflict-aware locking and returned in original call order.
_Avoid_: tool call group, batch of calls

**Scheduler**:
The component that groups a tool-call batch into parallel and sequential execution based on resource locks (per-file read/write locks, global bash barrier).
_Avoid_: executor, task queue, orchestrator

**Compaction**:
Summarizing older conversation history into a compact session summary to stay within the context budget, while retaining the full transcript in the session store.
_Avoid_: summarization, truncation, pruning

**Session**:
An append-only JSONL event log recording everything that happened in one conversation; resumable across CLI restarts and grouped by workspace.
_Avoid_: conversation, thread, chat

**Approval mode**:
`ask` / `trusted` / `deny` — controls whether and how shell commands are confirmed before execution.
_Avoid_: permission mode, trust level

**Hash guard**:
The `expected_hash` mechanism that rejects `write`/`edit` operations when the file changed since it was read, preventing stale overwrites.
_Avoid_: optimistic lock, version check, etag

**Context budget**:
The token budget available for a model request after reserving space for the response and tool calls; compaction triggers before it is exceeded.
_Avoid_: context window, token limit (when meaning the usable budget)

**Context manager**:
The component that builds model input, estimates tokens, and triggers compaction; not a knowledge-management or retrieval system.
_Avoid_: memory, retriever
