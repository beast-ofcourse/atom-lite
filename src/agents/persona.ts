import type { AgentPersona } from "./registry.js";

const POLICY_MARKER = "\n\nTask discipline:";

/**
 * Compose the runtime system prompt. The persona body replaces the default
 * role instructions while the base prompt's task-discipline and tool-policy
 * sections stay intact. Project instructions and the skill index are appended
 * later by ContextManager.
 */
export function composePersonaSystemPrompt(
  base: string,
  persona?: Pick<AgentPersona, "name" | "body"> | null,
): string {
  const body = persona?.body?.trim();
  if (!body) return base;
  const heading = persona?.name
    ? `Active persona: ${persona.name}`
    : "Active persona";

  // Standard base prompts separate an identity line from role instructions and
  // then keep task discipline and tool policy. Replace only the role block.
  const policyIndex = base.indexOf(POLICY_MARKER);
  const identityEnd = base.indexOf("\n\n");
  if (policyIndex !== -1 && identityEnd !== -1 && identityEnd < policyIndex) {
    const identity = base.slice(0, identityEnd).trim();
    const policy = base.slice(policyIndex);
    return `${identity}\n\n${heading}\n\n${body}${policy}`;
  }

  // Custom prompts without the policy sections keep their full base text.
  return `${base.trim()}\n\n${heading}\n\n${body}`;
}
