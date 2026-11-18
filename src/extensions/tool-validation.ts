import type { ExtensionTool } from "./types.js";

/**
 * Validate a tool at registration time. A tool that fails these checks is
 * silently dropped by the caller and reported as an `extension_error`, so an
 * invalid definition never reaches the model or an `AgentRuntime` tool map.
 */
export function validateExtensionTool(tool: unknown): string[] {
  const errors: string[] = [];
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
    return ["tool must be an object"];
  }
  const candidate = tool as Partial<ExtensionTool>;
  const name = candidate.name;
  if (typeof name !== "string" || name.trim() === "") {
    errors.push("name must be a non-empty string");
  } else if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    errors.push("name may contain only letters, digits, '_', '-' or '.'");
  }
  if (
    typeof candidate.description !== "string" ||
    candidate.description.trim() === ""
  ) {
    errors.push("description must be a non-empty string");
  }
  if (candidate.parameters !== undefined) {
    const params = candidate.parameters;
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      errors.push("parameters must be a JSON Schema object");
    } else {
      const schema = params as Record<string, unknown>;
      if (schema.type !== undefined && schema.type !== "object") {
        errors.push("parameters.type must be 'object'");
      }
      if (schema.properties !== undefined) {
        if (
          !schema.properties ||
          typeof schema.properties !== "object" ||
          Array.isArray(schema.properties)
        ) {
          errors.push("parameters.properties must be an object");
        }
      }
      if (schema.required !== undefined) {
        if (
          !Array.isArray(schema.required) ||
          schema.required.some((key) => typeof key !== "string")
        ) {
          errors.push("parameters.required must be an array of strings");
        } else if (
          schema.properties &&
          typeof schema.properties === "object" &&
          !Array.isArray(schema.properties)
        ) {
          const properties = schema.properties as Record<string, unknown>;
          const missing = (schema.required as string[]).filter(
            (key) => !(key in properties),
          );
          if (missing.length > 0) {
            errors.push(
              `parameters.required references unknown properties: ${missing.join(", ")}`,
            );
          }
        }
      }
    }
  }
  return errors;
}
