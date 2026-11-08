import type { AgentPersona, AgentRegistry } from "./registry.js";

export interface ConfiguredAgentSelection {
  persona?: AgentPersona;
  /** Human-readable reason the configured name could not be applied. */
  warning?: string;
}

/**
 * Resolve `runtime.agent` against the loaded registry. Only primary personas
 * are selectable; an untrusted project persona gets a distinct warning so the
 * user knows trust review, not a typo, is the blocker.
 */
export function resolveConfiguredAgent(
  registry: Pick<AgentRegistry, "get" | "untrusted">,
  name: string | undefined,
): ConfiguredAgentSelection {
  if (!name) return {};

  const persona = registry.get(name);
  if (persona?.mode === "primary") return { persona };
  if (persona) {
    return { warning: `configured agent "${name}" is not a primary agent` };
  }

  const untrusted = registry
    .untrusted()
    .find((candidate) => candidate.name === name);
  if (untrusted) {
    return {
      warning: `configured agent "${name}" is project-local and this project is not trusted`,
    };
  }
  return { warning: `configured agent "${name}" was not found` };
}
