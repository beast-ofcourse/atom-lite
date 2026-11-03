# ThinAgent — Project Overview

> **Working title:** ThinAgent  
> **Project type:** Minimal-harness, model-agnostic coding agent  
> **Primary interface:** CLI  
> **Initial implementation target:** TypeScript on Node.js  
> **Status:** Architecture proposal / implementation blueprint

---

## 1. Executive summary

ThinAgent is a local-first coding agent built around one intentionally small idea:

**Give the model four powerful tools, a reliable agent loop, and as little framework as possible.**

The agent should be able to inspect a codebase, understand project instructions, make targeted changes, run commands, inspect failures, and iterate until the requested task is complete. It should do this without requiring a large collection of built-in tools, sub-agents, planning frameworks, retrieval systems, or orchestration layers.

The default tool surface is exactly:

1. `read` — inspect files.
2. `write` — create or replace files safely.
3. `edit` — make precise changes to existing files.
4. `bash` — execute shell commands.

The four tools are intentionally general. File discovery, search, tests, Git operations, builds, package managers, formatters, and other developer workflows are available through `bash` rather than through additional built-in tools.

ThinAgent is provider-agnostic at the runtime level. It should support:

- **Ollama** through its native chat API.
- **Google Gemini** through the official Gemini API.
- **LM Studio** through its OpenAI-compatible endpoint.
- **llama.cpp / llama-server** through its OpenAI-compatible endpoint.
- **Kilo AI Gateway** through its OpenAI-compatible endpoint.
- Other compatible endpoints through a configurable generic adapter.

The system should run as one agent, with one conversation, one tool registry, and one control loop. It should support both parallel and sequential execution, but parallelism must be governed by resource conflicts rather than applied blindly.

The goal is not to build the agent with the fewest lines of code at any cost. The goal is to keep the **harness conceptually thin** while making the runtime dependable, observable, configurable, and useful with both small local models and high-capability hosted models.

---

## 2. Product principles

### 2.1 Small core, strong primitives

The core should contain only the pieces needed to run a capable tool-using agent:

- A model/provider interface.
- A conversation and session model.
- A single agent loop.
- Four built-in tools.
- A tool scheduler/executor.
- Context-window management.
- Configuration and a basic CLI.

Everything else should be an optional layer or a later feature.

### 2.2 The model decides; the runtime enforces

The model decides which tool to call and what to do next. The runtime is responsible for validating tool arguments, enforcing workspace boundaries, applying approval rules, scheduling calls safely, executing them, and returning accurate results.

Do not hard-code a workflow such as “always plan, then inspect, then edit, then test.” Different tasks require different workflows. The agent loop should remain general-purpose.

### 2.3 Do not confuse a thin harness with weak engineering

The runtime must still handle the difficult details:

- Provider-specific tool-call formats.
- Interrupted or malformed streaming responses.
- Tool-call ID preservation.
- Concurrent file access.
- Shell process timeouts and cancellation.
- Large tool outputs.
- Context-window exhaustion.
- Session persistence and recovery.
- Permission and path validation.

These are not unnecessary features. They are the reliability layer that makes a small harness useful.

### 2.4 Local-first, online-capable

Local inference should be a first-class path, not an afterthought. The application must not require a cloud account, telemetry service, hosted database, or remote control plane to run with a local provider.

Online providers are optional configuration choices. API keys must be read from environment variables or an OS-backed secret mechanism, never placed in project configuration files.

### 2.5 No framework-shaped features in the core

The first release should not include:

- Sub-agents or agent swarms.
- A mandatory plan mode.
- Built-in web search or browser automation.
- Built-in grep, find, or directory-listing tools.
- A vector database or RAG pipeline.
- A workflow graph engine.
- A memory service beyond the current session and project instructions.
- A mandatory MCP layer.
- A large plugin marketplace.

These may be explored later, but they must not complicate the initial runtime.

---

## 3. Goals and non-goals

### Goals

1. Provide a strong coding-agent experience with only four built-in tools.
2. Work with local and hosted models through interchangeable provider adapters.
3. Support tool calling, streaming, multi-step execution, and cancellation.
4. Execute independent tool calls concurrently while serializing conflicting operations.
5. Keep conversation history durable and recoverable.
6. Control context growth without discarding important recent events.
7. Make model/provider settings configurable without code changes.
8. Keep the core library usable independently of the CLI.
9. Make safety boundaries explicit and configurable.
10. Keep dependencies and abstractions to a minimum.

### Non-goals for the first release

- Building or training models.
- Managing model downloads or quantization.
- Guaranteeing that every model is equally good at tool use.
- Supporting every inference provider on day one.
- Running multiple autonomous agents.
- Providing a full IDE, editor, or graphical interface.
- Providing an OS-grade sandbox internally.
- Automatically understanding every repository or build system.
- Guaranteeing correctness of code written by the model.

---

## 4. High-level architecture

```text
┌────────────────────────────────────────────────────────────┐
│                         CLI / REPL                          │
│  input · streaming output · approvals · commands · cancel   │
└──────────────────────────────┬─────────────────────────────┘
                               │
┌──────────────────────────────▼─────────────────────────────┐
│                       Agent Runtime                          │
│                                                              │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐  │
│  │ Agent Loop     │  │ Context Manager│  │ Session Store  │  │
│  │                │  │                │  │                │  │
│  │ model → tools  │  │ budget/trim/   │  │ JSONL events   │  │
│  │ → results → …  │  │ compact        │  │ resume/replay  │  │
│  └───────┬────────┘  └────────────────┘  └────────────────┘  │
│          │                                                   │
│  ┌───────▼────────┐  ┌────────────────────────────────────┐  │
│  │ Provider       │  │ Tool Runtime                       │  │
│  │ Adapter        │  │                                    │  │
│  │                │  │ registry → validation → scheduler  │  │
│  │ Ollama         │  │                 → approval          │  │
│  │ Gemini         │  │                 → execution         │  │
│  │ OpenAI compat. │  │                                    │  │
│  └────────────────┘  └────────────────────────────────────┘  │
│                                                              │
└────────────────────────────────────────────────────────────┘
                               │
                 ┌─────────────▼─────────────┐
                 │       Local machine      │
                 │                           │
                 │ Workspace files           │
                 │ Config and sessions       │
                 │ Shell processes           │
                 │ Local model endpoints     │
                 └───────────────────────────┘
```

### Core modules

| Module      | Responsibility                                              | Must not become                          |
| ----------- | ----------------------------------------------------------- | ---------------------------------------- |
| `agent`     | Owns the agentic loop and stopping conditions               | A workflow engine                        |
| `providers` | Converts canonical requests/responses to provider protocols | A provider-specific agent implementation |
| `tools`     | Defines the four tools and their schemas                    | A large tool ecosystem                   |
| `scheduler` | Handles safe parallel/sequential execution                  | A task planner                           |
| `context`   | Builds the model input and manages token budgets            | A knowledge-management system            |
| `sessions`  | Persists conversation events and supports resume            | A hosted database                        |
| `security`  | Validates paths, approvals, limits, and process policy      | A pretend replacement for OS sandboxing  |
| `cli`       | Handles input/output and user controls                      | The place where agent logic lives        |

The core runtime should not import CLI-specific code. The CLI should call the core through a small public API.

---

## 5. The agentic loop

The agent loop is the heart of the project. Keep it understandable enough that a developer can follow the full control flow in one sitting.

### 5.1 Basic loop

```text
User submits a task
        │
        ▼
Create or resume a session
        │
        ▼
Build model context
(system prompt + project instructions + history)
        │
        ▼
Send request to configured provider
        │
        ▼
Receive assistant response
        │
        ├── No tool calls ──► Save response ──► Return to user
        │
        ▼
Validate tool calls
        │
        ▼
Schedule tool calls
(parallel where safe, sequential where required)
        │
        ▼
Execute tools and collect results
        │
        ▼
Append assistant tool-call message + tool results
        │
        └──────────────► Build next model context
```

The loop repeats until one of the following happens:

- The model returns a final answer with no tool calls.
- The user cancels the run.
- A configured iteration, tool-call, or time budget is reached.
- The provider returns a non-recoverable error.
- The runtime cannot safely continue.

### 5.2 Pseudocode

```ts
async function runAgentTurn(
  input: string,
  session: Session,
  signal: AbortSignal,
) {
  session.append({ type: "user_message", content: input });

  for (let iteration = 0; iteration < limits.maxIterations; iteration++) {
    throwIfAborted(signal);

    const context = await contextManager.build(session, provider.modelLimits);
    const response = await provider.generate({
      messages: context.messages,
      tools: toolRegistry.definitions,
      signal,
      options: config.modelOptions,
    });

    session.append({ type: "assistant_message", message: response.message });

    if (response.toolCalls.length === 0) {
      return response.message.text;
    }

    const validatedCalls = toolRuntime.validate(response.toolCalls);
    const results = await scheduler.execute(validatedCalls, { signal });

    // Preserve the original model-emitted call order in the conversation,
    // even when independent calls completed in a different order.
    for (const result of results.inModelOrder) {
      session.append({ type: "tool_result", result });
    }
  }

  return finishWithBudgetNotice(session);
}
```

This is illustrative pseudocode, not a complete implementation. Provider continuation messages and streaming events must be handled by the provider adapter.

### 5.3 Keep the loop sequential across reasoning rounds

The next model request must not begin until the current batch's required tool results have been collected and appended. This gives the model a consistent view of what happened.

Parallelism happens **inside a tool-call batch**, not by running multiple competing agent loops against the same session.

### 5.4 Iteration and execution limits

Make these configurable:

- `maxIterations`: maximum model/tool rounds for one user task.
- `maxToolCalls`: maximum individual tool calls per task.
- `maxExecutionMs`: maximum wall-clock time for a task.
- `maxParallelToolCalls`: maximum concurrent tool executions.
- `maxToolOutputBytes`: maximum output returned from one tool.
- `maxBashTimeMs`: maximum runtime for one shell command.

When a limit is reached, report it clearly. Do not silently discard the last tool result or pretend the task completed.

---

## 6. The four built-in tools

The model should always see concise, unambiguous schemas. Tool descriptions are part of the prompt surface, so avoid lengthy descriptions and overlapping responsibilities.

### 6.1 `read`

**Purpose:** Read a file or a selected range of a file.

Suggested schema:

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Path relative to the workspace root."
    },
    "offset": {
      "type": "integer",
      "minimum": 1,
      "description": "Starting line, 1-based."
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "description": "Maximum number of lines to return."
    }
  },
  "required": ["path"],
  "additionalProperties": false
}
```

Recommended behavior:

- Resolve relative paths against the active workspace.
- Reject paths that escape the workspace boundary.
- Return line numbers for text files.
- Support `offset` and `limit` so large files can be inspected in chunks.
- Apply a maximum file-size and output-size limit.
- Detect binary files and return a clear message instead of corrupt text.
- Return metadata such as file size and a content hash.
- Report missing files and permission errors precisely.

Images and other multimodal files can be added later if the selected provider and model support them. The initial implementation can be text-first.

### 6.2 `write`

**Purpose:** Create a new file or replace the full contents of a file.

Suggested schema:

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Path relative to the workspace root."
    },
    "content": { "type": "string", "description": "Complete file contents." },
    "expected_hash": {
      "type": "string",
      "description": "Hash returned by read when replacing an existing file."
    }
  },
  "required": ["path", "content"],
  "additionalProperties": false
}
```

Recommended behavior:

- Create parent directories only when enabled by configuration; default to creating them.
- Creating a new file is allowed within the workspace.
- Replacing an existing file requires a prior read and a matching `expected_hash`.
- Fail when the file has changed since it was read; ask the model to read again.
- Write atomically using a temporary file in the same directory followed by rename where supported.
- Preserve or explicitly define file permission behavior.
- Return bytes written and the new content hash.

The `expected_hash` field is an optimistic concurrency guard. It prevents a stale model response from overwriting a file that changed after the model inspected it.

### 6.3 `edit`

**Purpose:** Make a precise find-and-replace modification to an existing file.

Suggested schema:

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Path relative to the workspace root."
    },
    "old_string": { "type": "string", "description": "Exact text to replace." },
    "new_string": { "type": "string", "description": "Replacement text." },
    "expected_hash": {
      "type": "string",
      "description": "Optional hash from the most recent read."
    }
  },
  "required": ["path", "old_string", "new_string"],
  "additionalProperties": false
}
```

Recommended behavior:

- Require an existing text file.
- Match `old_string` exactly, including whitespace and line endings.
- Require exactly one match by default.
- If there are zero matches, return `NOT_FOUND` and do not modify the file.
- If there are multiple matches, return `AMBIGUOUS_MATCH` and do not modify the file.
- Never silently use fuzzy matching.
- If `expected_hash` is present, verify it before applying the edit.
- Write atomically and return the new hash.

A single exact replacement is predictable and works well with tool-using models. More complicated edits can be performed through repeated `edit` calls or by using `write` after reading the file.

### 6.4 `bash`

**Purpose:** Execute a shell command and return its output.

Suggested schema:

```json
{
  "type": "object",
  "properties": {
    "command": { "type": "string", "description": "Shell command to execute." },
    "cwd": {
      "type": "string",
      "description": "Optional working directory relative to the workspace root."
    },
    "timeout_ms": {
      "type": "integer",
      "minimum": 1,
      "description": "Optional timeout, capped by runtime configuration."
    }
  },
  "required": ["command"],
  "additionalProperties": false
}
```

Recommended behavior:

- Run in the workspace root unless another valid workspace-relative `cwd` is provided.
- Use the configured shell for the current operating system.
- Stream stdout and stderr while the command is running.
- Enforce a timeout and terminate the process when it expires.
- Limit captured output and clearly mark truncation.
- Return exit code, stdout, stderr, duration, timeout status, and termination signal when available.
- Do not silently retry commands.
- Do not allow the model to set arbitrary environment variables through tool arguments.
- Support cancellation from the CLI.

`bash` is intentionally broad. It lets the model use the tools already available in the development environment: `git`, `rg`, `grep`, `find`, `ls`, `cat`, `sed`, `npm`, `pnpm`, `pytest`, compilers, test runners, and so on.

### Tool contract rules

All four tools should:

- Validate arguments against a strict schema.
- Reject unknown fields.
- Return structured, machine-readable results internally.
- Produce concise text suitable for a model context.
- Include stable error codes.
- Respect cancellation.
- Enforce output and execution limits.
- Emit execution events for the CLI and session recorder.

Do not expose internal Node.js objects, raw exceptions, or stack traces to the model by default.

---

## 7. Parallel and sequential tool execution

Parallel execution should improve speed without creating nondeterministic file corruption. The scheduler is a small but important part of the design.

### 7.1 Core rule

**Parallelize independent work. Serialize work that may conflict.**

The model may return several tool calls in one response. The scheduler validates the calls, identifies their resource access, groups compatible calls, and executes them under a concurrency limit.

### 7.2 Default scheduling policy

| Tool operation                        | Default scheduling                        |
| ------------------------------------- | ----------------------------------------- |
| `read` on file A + `read` on file B   | Parallel                                  |
| `read` on file A + `read` on file A   | Parallel                                  |
| `read` on file A + `edit` on file A   | Sequential; mutation waits for the read   |
| `edit` on file A + `edit` on file A   | Sequential in model-emitted order         |
| `write` on file A + `edit` on file A  | Sequential in model-emitted order         |
| `write` on file A + `write` on file B | Parallel                                  |
| `edit` on file A + `edit` on file B   | Parallel                                  |
| `bash` + any mutation                 | `bash` is an exclusive barrier by default |
| `bash` + `bash`                       | Sequential by default                     |

The scheduler should use canonical, resolved file paths as lock keys. Reads acquire shared locks; `write` and `edit` acquire exclusive locks.

### 7.3 Why `bash` is an exclusive operation

A shell command can read or modify almost anything the process can access. The runtime generally cannot know whether `npm test`, `git status`, `python script.py`, or a custom shell command will modify files.

Therefore, treat `bash` as a workspace-wide exclusive operation by default. It waits for active file operations, runs alone, and completes before conflicting operations continue.

An advanced configuration may allow concurrent shell commands, but this must be explicitly enabled and documented as potentially unsafe. Do not attempt to infer that an arbitrary shell command is read-only using fragile string matching.

### 7.4 Deterministic result ordering

Tool calls may complete in a different order from the order in which the model requested them. The runtime must preserve the original call order when appending tool results to the conversation.

Each result must be associated with the original provider tool-call ID. A failed call should produce an error result for that call without discarding successful results from other calls in the batch.

### 7.5 Scheduler implementation

Start with:

- A bounded worker pool or small task queue.
- A per-file read/write lock manager.
- A global exclusive lock for `bash`.
- Stable call IDs and original-order result collection.
- Cancellation propagation.

Do not introduce a general-purpose dependency-graph framework unless real requirements emerge.

---

## 8. Provider architecture

Providers are transport adapters. They must not own agent logic, workspace behavior, tool execution, or session state.

### 8.1 Canonical provider interface

Define one internal interface that every adapter implements. A simplified shape:

```ts
interface ProviderAdapter {
  readonly id: string;

  generate(request: ModelRequest): Promise<ModelResponse>;

  stream?(request: ModelRequest): AsyncIterable<ModelStreamEvent>;

  getModelInfo?(): Promise<ModelInfo | undefined>;
}
```

The actual interface may combine `generate` and `stream` into one method. Do not build two independent request pipelines if a single streaming pipeline can produce a final response.

Canonical request data should include:

- Model identifier.
- Canonical messages.
- Tool definitions.
- Sampling and reasoning options.
- Abort signal.
- Optional provider-specific parameters.

Canonical response data should include:

- Assistant text/content blocks.
- Complete tool calls with IDs, names, and parsed arguments.
- Finish reason.
- Token usage when available.
- Provider/model metadata.
- Opaque provider continuation state when required.

### 8.2 Provider-specific details

#### Ollama

Use Ollama's native chat endpoint as the primary implementation:

- Default endpoint: `http://127.0.0.1:11434`.
- Native chat route: `/api/chat`.
- Supports message history and tool definitions for models that support tool calling.
- Handle streamed response chunks and the final completion metadata.
- Expose useful Ollama settings such as `keep_alive`, `think`, and supported model options without leaking Ollama-specific logic into the agent loop.

Not every Ollama model has equally reliable tool-use behavior. The UI should make it clear that provider connectivity and model tool-calling quality are separate concerns.

#### Google Gemini

Use the official Gemini API/SDK adapter.

Responsibilities include:

- Map canonical tool declarations to Gemini function declarations.
- Parse function calls and their IDs.
- Return function results in the format expected by Gemini.
- Preserve required provider-specific continuation data, including thought/signature metadata where applicable.
- Support streaming where available.
- Map safety blocks, rate limits, and token usage into common runtime errors/metadata.

Do not flatten Gemini messages into plain text if doing so would lose information needed for a valid next request.

#### OpenAI-compatible adapter

Create one configurable adapter for endpoints implementing the OpenAI Chat Completions-style protocol.

Initial targets:

| Target                     | Typical local/base URL              | Notes                                                                                                                                  |
| -------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| LM Studio                  | `http://127.0.0.1:1234/v1`          | Tool calling depends on model/template support and server behavior.                                                                    |
| llama.cpp / `llama-server` | `http://127.0.0.1:8080/v1`          | Server configuration and chat template affect tool-call parsing; function calling may require the appropriate server/template options. |
| Kilo AI Gateway            | `https://ai-gateway.kilo.ai/api/v1` | Uses an API key and provider/model-qualified model IDs.                                                                                |
| Other compatible servers   | User-configured                     | Base URL, key, headers, and model are configurable.                                                                                    |

The adapter should support:

- Configurable base URL.
- Optional API key from an environment variable.
- Optional custom headers.
- Configurable model ID.
- Streaming and non-streaming responses.
- Tool-call argument assembly from streaming chunks.
- Tool-call ID preservation.
- Usage extraction when returned.
- Provider-specific request options where necessary.

“OpenAI-compatible” is a protocol starting point, not a guarantee that every endpoint behaves identically. Keep small compatibility settings in provider configuration rather than adding provider checks throughout the runtime.

### 8.3 Internal message format

Use a canonical representation, but preserve fields needed by the original provider:

```ts
type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: ContentPart[] }
  | {
      role: "assistant";
      content?: ContentPart[];
      toolCalls?: ToolCall[];
      providerState?: unknown;
    }
  | {
      role: "tool";
      toolCallId: string;
      name: string;
      content: string;
    };

interface ToolCall {
  id: string;
  name: "read" | "write" | "edit" | "bash";
  arguments: Record<string, unknown>;
}
```

This is a conceptual shape. The final types should be stricter and should not use `unknown` as a substitute for documented provider state handling.

### 8.4 Provider capability metadata

Each adapter should expose capabilities where known:

- Tool calling support.
- Streaming support.
- Vision/image input support.
- Context-window size if known.
- Reasoning/thinking options if supported.
- Usage reporting support.

Unknown capability values should remain unknown; do not guess. The CLI can warn when a configured model is not known to support tools.

---

## 9. Configuration

Configuration should be explicit, readable, and provider-neutral. Use one user-level configuration file and allow project-level overrides only for non-secret settings.

Suggested locations:

- User config: `~/.config/thinagent/config.json` (platform-specific config directory resolution is acceptable).
- Project config: `.thinagent/config.json` in the workspace.
- Project instructions: `AGENTS.md` in the workspace root, with optional user-level instructions.
- Sessions: user data directory, grouped by workspace.

Never store API keys in project configuration or session files.

### 9.1 Example configuration

```json
{
  "defaultProvider": "ollama-local",
  "providers": {
    "ollama-local": {
      "type": "ollama",
      "baseUrl": "http://127.0.0.1:11434",
      "model": "your-local-coder-model",
      "keepAlive": "10m",
      "options": {
        "temperature": 0.2
      }
    },
    "lm-studio": {
      "type": "openai-compatible",
      "baseUrl": "http://127.0.0.1:1234/v1",
      "model": "your-loaded-model",
      "apiKeyEnv": null
    },
    "llama-cpp": {
      "type": "openai-compatible",
      "baseUrl": "http://127.0.0.1:8080/v1",
      "model": "local-model",
      "apiKeyEnv": null
    },
    "gemini": {
      "type": "gemini",
      "model": "your-gemini-model",
      "apiKeyEnv": "GEMINI_API_KEY"
    },
    "kilo": {
      "type": "openai-compatible",
      "baseUrl": "https://ai-gateway.kilo.ai/api/v1",
      "model": "provider/model-id",
      "apiKeyEnv": "KILO_API_KEY"
    }
  },
  "runtime": {
    "maxIterations": 40,
    "maxToolCalls": 100,
    "maxExecutionMs": 1800000,
    "maxParallelToolCalls": 4,
    "maxToolOutputBytes": 30000,
    "maxBashTimeMs": 120000,
    "bashConcurrency": "serial",
    "approvalMode": "ask"
  },
  "context": {
    "maxInputTokens": null,
    "reserveOutputTokens": 4096,
    "compactAtPercent": 85,
    "maxProjectInstructionBytes": 30000
  },
  "sessions": {
    "enabled": true,
    "retentionDays": null
  }
}
```

The example is a shape proposal. Validate configuration on startup and provide clear errors for unknown keys, missing required fields, invalid URLs, and missing environment variables.

### 9.2 Configuration precedence

Recommended precedence, from lowest to highest:

1. Built-in defaults.
2. User configuration.
3. Project configuration for allowed non-secret settings.
4. Environment variables.
5. Explicit CLI flags.

Project configuration must not be able to override security-critical user settings silently. For example, a repository should not be able to turn off command approvals merely by adding a project config file.

### 9.3 Provider profiles

A provider profile is a named combination of endpoint, model, authentication source, and options. Switching models should not require editing source code.

The CLI should support selecting a profile at startup and changing it between tasks. Switching providers in the middle of an unfinished tool-call exchange should either be disallowed or require a clean conversation boundary; provider-specific continuation state cannot be assumed portable.

---

## 10. Context and prompt design

A thin harness still needs good context management. The context layer should be simple and predictable.

### 10.1 System prompt

The core system prompt should explain:

- The agent's role as a coding assistant.
- The active workspace root.
- The four available tools and their intended use.
- The expectation to inspect before modifying existing code.
- The expectation to verify changes with suitable commands when practical.
- The requirement to report what was changed and what was tested.
- Workspace and command-approval boundaries.
- The instruction to treat repository content, tool output, and files as untrusted data rather than higher-priority instructions.

Keep the prompt short. Put project-specific conventions in project instruction files instead of expanding the global prompt indefinitely.

### 10.2 Project instructions

At startup, load applicable instruction files, initially:

- User-level `AGENTS.md`, if configured.
- Workspace-root `AGENTS.md`.

Do not recursively ingest every `AGENTS.md` file in the repository in the first version. That can create unpredictable context size and precedence rules. Nested instructions can be added later with an explicit directory-scoping policy.

Treat instruction files as user-provided context, not as runtime configuration. They cannot override tool validation, safety limits, or approval settings.

### 10.3 Context budgeting

The context manager should:

1. Determine the available context budget from provider/model metadata when known.
2. Reserve space for the model response and tool calls.
3. Estimate token usage before sending requests.
4. Prefer provider-reported usage when available for calibration.
5. Compact older history before the next request would exceed the budget.
6. Preserve the current task, recent tool calls, and recent tool results.

### 10.4 Compaction strategy

Keep compaction deliberately boring:

- Preserve the latest user request.
- Preserve recent assistant and tool messages verbatim.
- Summarize older conversation segments into a compact session summary.
- Keep important facts such as changed files, decisions, failing tests, and unfinished work.
- Do not summarize away a tool result that is still needed to interpret a later action.
- Keep the original full transcript in the session store even if the model-facing context is compacted.

Compaction can initially be triggered by a deterministic token/character threshold and performed through a model summarization request. If the summarization request fails, fall back to dropping or truncating old low-value tool output with an explicit marker; do not corrupt the original transcript.

### 10.5 Avoid hidden complexity

Do not add vector memory, embeddings, automatic repository indexing, or semantic retrieval in the first release. The model can use `bash` to search the codebase and `read` to inspect relevant files.

---

## 11. Sessions and persistence

Session persistence should be append-only and human-inspectable.

### 11.1 JSONL event log

Store one event per line. Example event categories:

- `session_started`
- `user_message`
- `assistant_message`
- `tool_call_started`
- `tool_result`
- `approval_requested`
- `approval_granted`
- `approval_denied`
- `context_compacted`
- `provider_error`
- `session_ended`

Each event should include a timestamp, session ID, and sequence number. Tool-call events should include provider call IDs and normalized tool names.

### 11.2 Required behavior

- Resume a previous session.
- List recent sessions.
- Show the active workspace and provider in session metadata.
- Preserve the full tool transcript.
- Recover from an incomplete final JSONL line by ignoring or repairing only the incomplete tail, not rewriting valid earlier events.
- Avoid persisting API keys, authorization headers, or unnecessary environment data.
- Use restrictive file permissions where supported.

A session is a record of what happened, not a memory system that silently invents facts.

---

## 12. Safety and execution boundaries

This section is essential. A coding agent can execute arbitrary code and modify files. The project must be honest about what it protects against.

### 12.1 Workspace path protection

For `read`, `write`, and `edit`:

- Resolve relative paths against the workspace root.
- Reject lexical traversal outside the root.
- Resolve existing symlinks and reject targets outside the root.
- Validate parent directories for new files.
- Reject unsafe special files and unsupported file types.
- Use atomic writes where possible.
- Detect stale-file changes with content hashes.

Path checks should account for symlinks, path separators on Windows, and platform-specific canonicalization. Tests must include traversal and symlink escape cases.

These protections apply to the file tools. They do **not** constrain what an arbitrary shell command can access.

### 12.2 Shell security

`bash` runs with the operating-system permissions of the ThinAgent process unless an external sandbox is configured.

A workspace-relative `cwd` is not a sandbox. A command can still access files outside the workspace, use the network, install software, or execute destructive operations if the process has permission.

Recommended approval modes:

| Mode      | Behavior                                                                        |
| --------- | ------------------------------------------------------------------------------- |
| `ask`     | Ask before each shell command. Recommended default for interactive use.         |
| `trusted` | Run commands without interactive approval. User explicitly opts into this risk. |
| `deny`    | Disable shell execution. Useful for read-only or constrained workflows.         |

An optional “trust this session” approval can reduce repeated prompts without permanently changing global configuration.

Do not describe a command-string classifier as a security sandbox. If stronger isolation is required, run the agent or shell in a real OS/container sandbox with restricted filesystem, process, and network permissions.

### 12.3 Prompt injection

Repository files, source comments, test output, terminal output, and generated content can contain instructions. They are data, not trusted system instructions.

The prompt should tell the model to follow the user's task and project conventions while treating discovered content as untrusted. Runtime security must still be enforced outside the model; prompt wording alone is not a security boundary.

### 12.4 Approval surface

Approval prompts should display:

- The exact command.
- The working directory.
- Whether the command will run with normal host permissions or inside a sandbox.
- Any timeout.
- The available choices: approve once, trust for this session, or deny.

A non-interactive mode must not silently approve commands that require a user decision. It should fail safely with a clear error.

---

## 13. CLI experience

Start with a useful interactive terminal interface. Avoid spending early effort on a complex TUI framework.

### 13.1 Initial commands

```text
thinagent                 Start an interactive session in the current directory
thinagent "task"          Run one task, then exit
thinagent --provider NAME Select a provider profile
thinagent --model MODEL   Override the configured model
thinagent --continue      Resume the most recent session for this workspace
thinagent --session ID    Resume a specific session
thinagent --no-tools      Run without tool access
thinagent --help          Show help
```

### 13.2 Useful in-session commands

```text
/help       Show commands and key bindings
/model      Show or switch the provider/model at a safe conversation boundary
/session    Show session information
/compact    Compact model-facing history
/clear      Start a new session
/approval   Show or change approval mode for the current session
/doctor     Check provider connectivity and tool-call support
/exit       Exit the session
```

These are CLI commands, not model tools. They should not appear in the model's tool schema.

### 13.3 Output behavior

The CLI should show:

- Streaming assistant text.
- Tool name and concise arguments when a tool begins.
- Running state and elapsed time for long commands.
- Tool result summaries.
- Approval prompts.
- Clear provider and runtime errors.
- A final summary of modified files and verification performed when appropriate.

Do not flood the terminal with entire large tool outputs by default. The full result remains available in session history; the CLI can show a concise summary and allow the user to expand it.

### 13.4 Non-interactive mode

Support plain text output and machine-readable JSON output. Ensure that prompts and status messages do not contaminate JSON output on stdout; send diagnostic/status information to stderr.

---

## 14. Suggested technology choices

### Primary stack

- **Language:** TypeScript.
- **Runtime:** Node.js.
- **Module format:** ESM.
- **Validation:** A lightweight schema validator such as Zod, Valibot, or JSON Schema/Ajv. Pick one; do not stack multiple validators.
- **Tests:** Node's test runner or Vitest. Pick one.
- **CLI:** Start with Node readline and a small rendering layer; adopt a TUI library only when the interaction design requires it.
- **Persistence:** JSONL files; no database for the first release.

### Dependency discipline

Keep dependencies small. Prefer built-in Node APIs for:

- File access.
- Child-process management.
- Streams.
- Abort signals.
- Path operations.
- JSONL session storage.

Use official SDKs where they materially reduce provider-protocol complexity. Avoid bringing in a large agent framework to implement a loop that should remain small and understandable.

### Runtime compatibility

Choose and document a minimum Node.js version at implementation time. Test supported operating systems explicitly, especially shell invocation, process termination, path canonicalization, and file permission behavior.

---

## 15. Proposed repository structure

```text
thinagent/
├── src/
│   ├── index.ts
│   ├── cli/
│   │   ├── main.ts
│   │   ├── repl.ts
│   │   ├── commands.ts
│   │   ├── renderer.ts
│   │   └── approvals.ts
│   ├── agent/
│   │   ├── loop.ts
│   │   ├── types.ts
│   │   └── limits.ts
│   ├── providers/
│   │   ├── types.ts
│   │   ├── registry.ts
│   │   ├── ollama.ts
│   │   ├── gemini.ts
│   │   └── openai-compatible.ts
│   ├── tools/
│   │   ├── types.ts
│   │   ├── registry.ts
│   │   ├── read.ts
│   │   ├── write.ts
│   │   ├── edit.ts
│   │   └── bash.ts
│   ├── runtime/
│   │   ├── scheduler.ts
│   │   ├── executor.ts
│   │   ├── locks.ts
│   │   └── approvals.ts
│   ├── context/
│   │   ├── builder.ts
│   │   ├── instructions.ts
│   │   ├── budget.ts
│   │   └── compaction.ts
│   ├── sessions/
│   │   ├── store.ts
│   │   ├── events.ts
│   │   └── recovery.ts
│   ├── config/
│   │   ├── load.ts
│   │   ├── schema.ts
│   │   └── defaults.ts
│   └── security/
│       ├── paths.ts
│       ├── process.ts
│       └── redaction.ts
├── tests/
│   ├── agent/
│   ├── providers/
│   ├── tools/
│   ├── runtime/
│   ├── context/
│   └── fixtures/
├── docs/
│   ├── architecture.md
│   └── providers.md
├── .gitignore
├── package.json
├── tsconfig.json
├── README.md
└── project-overview.md
```

The structure is a starting point, not a requirement to create every file immediately. Implement only modules needed for the current milestone. Avoid empty abstraction folders and premature interfaces.

---

## 16. Error handling and recovery

Errors should be explicit and recoverable where possible.

### Error categories

- `PROVIDER_CONNECTION_FAILED`
- `PROVIDER_RATE_LIMITED`
- `PROVIDER_AUTH_FAILED`
- `PROVIDER_UNSUPPORTED_TOOL_CALLS`
- `PROVIDER_INVALID_RESPONSE`
- `TOOL_ARGUMENT_INVALID`
- `TOOL_NOT_FOUND`
- `PATH_OUTSIDE_WORKSPACE`
- `FILE_NOT_FOUND`
- `FILE_CHANGED_SINCE_READ`
- `EDIT_NOT_FOUND`
- `EDIT_AMBIGUOUS_MATCH`
- `COMMAND_APPROVAL_REQUIRED`
- `COMMAND_TIMED_OUT`
- `COMMAND_FAILED`
- `OUTPUT_TRUNCATED`
- `CONTEXT_LIMIT_REACHED`
- `TASK_BUDGET_REACHED`
- `USER_CANCELLED`

### Recovery rules

- Retry transient provider/network failures only with a small bounded retry policy and backoff.
- Do not automatically retry arbitrary shell commands.
- Do not automatically retry file mutations after uncertain outcomes.
- Return tool errors to the model when it can make a meaningful correction.
- Keep successful results when another independent tool call fails.
- Preserve the original session events even when a task ends with an error.
- If the provider response is malformed, retain enough diagnostic metadata for debugging without dumping secrets.

---

## 17. Observability and debugging

Keep observability lightweight but useful.

Record per model request:

- Provider profile and model ID.
- Start/end time and latency.
- Input/output token counts when available.
- Finish reason.
- Number of tool calls.
- Provider error category.

Record per tool execution:

- Tool name and call ID.
- Start/end time.
- Duration.
- Exit code or result status.
- Output bytes and truncation status.
- Approval outcome.

Add a `--debug` mode that can show normalized requests and responses with secrets redacted. Do not log API keys, authorization headers, or complete environment variables.

A small `/doctor` command should test:

1. Configuration validity.
2. Provider endpoint connectivity.
3. Model availability where the provider exposes it.
4. A short text-generation request.
5. Tool-call capability with a harmless test tool schema or a clearly non-destructive diagnostic.
6. Workspace read/write access using a temporary file that is removed afterward.

The diagnostic must not execute arbitrary commands or modify user files.

---

## 18. Testing strategy

A coding agent needs tests for runtime correctness, not only for prompt quality.

### Unit tests

- Tool argument validation.
- Path traversal rejection.
- Symlink escape rejection.
- File read range behavior.
- Write create/overwrite rules.
- Hash mismatch detection.
- Exact edit matching and ambiguous-match handling.
- Output truncation.
- Bash timeout and cancellation.
- Scheduler lock behavior.
- Tool-result ordering.
- Context budget and compaction boundaries.
- Session JSONL append and recovery.
- Config precedence and secret handling.

### Provider adapter tests

Use recorded fixtures or mocked HTTP responses for:

- Standard text response.
- Single tool call.
- Multiple tool calls in one response.
- Streaming text chunks.
- Streaming tool-call argument chunks.
- Malformed arguments.
- Missing usage fields.
- Rate limiting.
- Authentication failure.
- Provider-specific continuation metadata.

Do not require live cloud credentials in the normal test suite.

### Integration tests

Use a fake provider to test the complete loop:

1. Model requests `read`.
2. Runtime executes it.
3. Model receives the result.
4. Model requests `edit`.
5. Runtime modifies the file.
6. Model requests `bash` to run a check.
7. Model receives the result and returns a final answer.

Also test cancellation, tool-call limits, partial failures, and session resumption.

### Model evaluation

Maintain a small reproducible task set that tests:

- Repository understanding.
- Finding a symbol and tracing its usage.
- Editing a single file.
- Coordinated edits across multiple files.
- Fixing a test failure.
- Adding a small feature.
- Handling ambiguous instructions by asking a question.
- Recovering from a failed command.
- Avoiding unnecessary file changes.

Measure success, tool-call count, wall-clock time, context usage, and unnecessary edits. Evaluate local models separately; a provider accepting the tool schema does not prove the selected model uses it reliably.

---

## 19. Performance targets

The initial focus should be low overhead and predictable behavior rather than benchmark chasing.

Suggested engineering targets:

- No background daemon required.
- No database required.
- No project indexing during startup.
- Fast startup with configuration and session loading only.
- Stream model output as soon as it is available.
- Execute independent read operations concurrently.
- Avoid repeatedly sending large unchanged tool outputs when the context can safely summarize them.
- Keep the dependency graph small and startup diagnostics useful.

Measure the harness separately from model inference. Local model generation time will often dominate total task latency.

---

## 20. Development roadmap

### Phase 0 — Skeleton

- Set up TypeScript project, ESM, linting, formatting, and tests.
- Implement config loading and validation.
- Implement canonical message, tool, and provider types.
- Implement a fake provider for deterministic tests.

**Exit criteria:** The application starts, validates config, and can run a fake model response through the loop.

### Phase 1 — Minimal vertical slice

- Implement `read`, `write`, `edit`, and `bash`.
- Implement workspace path checks.
- Implement a sequential agent loop.
- Implement an OpenAI-compatible adapter.
- Add simple CLI input/output.

**Exit criteria:** A model can inspect a repository, modify a file, run a command, receive the result, and produce a final response.

### Phase 2 — Local provider support

- Add native Ollama adapter.
- Add LM Studio compatibility profile.
- Add llama.cpp compatibility profile.
- Test streaming and tool-call parsing against supported local server versions.
- Add `/doctor` diagnostics.

**Exit criteria:** A user can switch among the local endpoints through configuration without changing agent code.

### Phase 3 — Safe parallel execution

- Implement shared/exclusive file locks.
- Implement bounded parallel scheduling.
- Add the global `bash` execution barrier.
- Preserve tool-call/result ordering.
- Add cancellation and timeout handling.

**Exit criteria:** Independent file operations execute concurrently; conflicting operations are deterministic; shell execution is serialized by default.

### Phase 4 — Durable sessions and context management

- Add JSONL session persistence.
- Add resume and session listing.
- Add token estimation and context budgeting.
- Add history compaction.
- Add project instruction loading.

**Exit criteria:** Long-running work can continue across CLI restarts without losing the relevant conversation state.

### Phase 5 — Hosted providers and hardening

- Add Gemini adapter.
- Add Kilo Gateway profile through OpenAI-compatible adapter.
- Add retry handling for transient provider errors.
- Add approval modes and non-interactive safety behavior.
- Add security and integration test coverage.

**Exit criteria:** Local and hosted providers work through the same agent runtime with clear provider-specific behavior.

### Phase 6 — Quality-of-life features

Only after the core is stable:

- Better terminal rendering.
- Session export/import.
- Configurable model presets.
- Image input for models that support it.
- Optional skills or instruction bundles.
- Extension hooks for lifecycle events.
- Optional OS/container sandbox integrations.

These features should remain optional and should not expand the default tool surface without a strong reason.

---

## 21. Key architectural decisions

| Decision                     | Recommendation                        | Reason                                                       |
| ---------------------------- | ------------------------------------- | ------------------------------------------------------------ |
| Number of built-in tools     | Four                                  | Keeps the action surface small and general.                  |
| Agent loops                  | One                                   | Avoids orchestration complexity and competing state.         |
| Provider abstraction         | Canonical interface + native adapters | Keeps the runtime independent of transport protocols.        |
| Ollama integration           | Native adapter                        | Preserves Ollama-specific capabilities and message behavior. |
| Gemini integration           | Native adapter                        | Preserves Gemini function-call and continuation metadata.    |
| LM Studio / llama.cpp / Kilo | OpenAI-compatible adapter             | Shared protocol is sufficient for the initial common path.   |
| Tool parallelism             | Scheduler with locks                  | Fast for independent work, deterministic for conflicts.      |
| Shell concurrency            | Serial by default                     | Arbitrary commands have unknown side effects.                |
| File writes                  | Hash-aware and atomic                 | Prevents stale or partial overwrites.                        |
| Session persistence          | JSONL                                 | Simple, inspectable, append-only.                            |
| Context memory               | History + compaction                  | Avoids premature vector/RAG infrastructure.                  |
| CLI                          | First-class, simple                   | Fastest route to a useful product.                           |
| Extensions                   | Later                                 | Prevents the core from becoming a plugin framework.          |

---

## 22. Risks and mitigations

### Model tool-use quality varies

**Risk:** Some local models may ignore tool schemas, emit invalid JSON, or repeatedly call tools incorrectly.

**Mitigation:** Provide `/doctor`, test model-specific profiles, validate every call, return actionable errors, and maintain model evaluation tasks. Do not promise equal performance across models.

### Protocol compatibility is imperfect

**Risk:** OpenAI-compatible endpoints differ in streaming details, finish reasons, tool-call IDs, and parameter support.

**Mitigation:** Keep compatibility options inside the adapter, preserve raw diagnostic metadata, and run adapter conformance tests against real endpoints.

### Parallel actions may conflict

**Risk:** Concurrent edits, writes, or shell commands can overwrite or invalidate one another.

**Mitigation:** Use file locks, hash checks, a global shell barrier, bounded concurrency, and deterministic result ordering.

### Arbitrary shell commands are powerful

**Risk:** A model can execute destructive operations or access data outside the workspace.

**Mitigation:** Make approval behavior explicit and support external sandboxing. Never claim workspace path checks make shell execution safe.

### Context can become too large

**Risk:** Large files and terminal output consume the model's context window.

**Mitigation:** Bound tool output, read files in ranges, compact old history, and retain full transcripts outside the model-facing context.

### The project can grow into a framework

**Risk:** New abstractions and features undermine the original purpose.

**Mitigation:** Require every core feature to justify its impact on the loop, reliability, or user experience. Keep optional features outside the core.

---

## 23. Definition of done for version 1

Version 1 is ready when all of the following are true:

- [ ] A user can configure a provider without editing code.
- [ ] Ollama works through its native chat API.
- [ ] LM Studio and llama.cpp work through the generic OpenAI-compatible adapter.
- [ ] Gemini works through its native adapter.
- [ ] Kilo Gateway works through the generic OpenAI-compatible adapter.
- [ ] The agent exposes exactly four built-in tools: `read`, `write`, `edit`, and `bash`.
- [ ] The agent can make multiple reasoning/tool rounds in one task.
- [ ] Streaming assistant output works.
- [ ] Tool-call IDs and provider continuation metadata are preserved.
- [ ] Independent file operations can execute in parallel.
- [ ] Conflicting file operations are serialized.
- [ ] Shell commands are serialized by default and have timeout/cancellation support.
- [ ] File tools reject workspace path escapes, including tested symlink escapes.
- [ ] Replacing an existing file is protected against stale reads.
- [ ] Exact edits fail safely when matching text is missing or ambiguous.
- [ ] Tool output is bounded and truncation is visible.
- [ ] Sessions persist and can be resumed.
- [ ] Context compaction does not destroy the original transcript.
- [ ] Approval behavior is clear and configurable.
- [ ] Errors are understandable and do not leak secrets.
- [ ] Core behavior is covered by unit and integration tests.
- [ ] The CLI can complete a real coding task using a local model.

---

## 24. Final product statement

ThinAgent should feel like a small, direct interface between a capable model and a development environment.

The runtime should not try to be smarter than the model about how every task must be performed. It should give the model a clear set of primitives, execute its requests reliably, preserve what happened, and expose enough guardrails to keep the machine and workspace under control.

The intended architecture is therefore:

**One agent loop. Four tools. A few provider adapters. A deterministic scheduler. Durable context. Explicit safety boundaries.**

Everything else is optional.

---

## 25. References

These references document the provider protocols and the minimal coding-agent design patterns that informed this proposal. Provider endpoints and capabilities can change; verify them against the linked official documentation during implementation.

1. [Ollama — Chat API](https://github.com/ollama/ollama/blob/main/docs/api.md) — native chat messages, streaming, tool definitions, and tool calls.
2. [Google Gemini — Function calling](https://ai.google.dev/gemini-api/docs/function-calling) — function declarations, application-side execution, multi-tool calls, and provider-specific continuation behavior.
3. [LM Studio — Tool use](https://lmstudio.ai/docs/developer/openai-compat/tools) — OpenAI-compatible tool calling and model/template-dependent support.
4. [llama.cpp — Function calling](https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md) — server-side function-calling and chat-template considerations.
5. [Kilo AI Gateway](https://kilo.ai/docs/gateway) — OpenAI-compatible endpoint, streaming, tool calling, and gateway model routing.
6. [Pi repository](https://github.com/earendil-works/pi) — reference implementation and design inspiration for a minimal, extensible agent harness and coding-agent CLI.
