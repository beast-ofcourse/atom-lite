# Single agent loop, no sub-agents in v1

Atom-lite runs one agent, one conversation, one tool registry, and one control loop. Parallelism happens inside a tool-call batch, not via competing loops or sub-agents. Sub-agents, swarms, and workflow graphs are explicitly out of scope for v1.

Avoids orchestration complexity and competing state over a shared session; keeps the loop followable in one sitting. Revisit only if real requirements emerge.