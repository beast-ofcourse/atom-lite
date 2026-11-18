// Generates the ExtensionAPI compatibility matrix from the interface in
// src/extensions/api.ts. Consumers are located by a stable source token and
// recorded as file:line, so the matrix always points at real code.
//
//   node scripts/generate-compatibility-matrix.mjs          # write
//   node scripts/generate-compatibility-matrix.mjs --check  # verify
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const API_FILE = "src/extensions/api.ts";
const OUTPUT_FILE = "src/extensions/compatibility-matrix.ts";

// Status rules. `supported` must list at least one consumer; `reduced` may list
// consumers; `no-op` and `unsupported` list none. Evidence is [file, token].
// A self-contained method points at its own implementation line in api.ts.
const rules = {
  registerTool: [
    "supported",
    [["src/extensions/tool-adapter.ts", "registries.tools.values()"]],
  ],
  unregisterTool: [
    "supported",
    [["src/extensions/tool-adapter.ts", "registries.tools.values()"]],
  ],
  setActiveTools: [
    "supported",
    [["src/extensions/api.ts", "if (registries.activeTools) return"]],
  ],
  getActiveTools: [
    "supported",
    [["src/extensions/api.ts", "if (registries.activeTools) return"]],
  ],
  getAllTools: [
    "supported",
    [["src/extensions/api.ts", "[...registries.tools.values()].map((tool)"]],
  ],
  registerCommand: [
    "supported",
    [["src/cli/app.ts", "registries?.commands?.values?.()"]],
  ],
  unregisterCommand: [
    "supported",
    [["src/cli/app.ts", "registries?.commands?.values?.()"]],
  ],
  on: [
    "supported",
    [["src/extensions/loader.ts", "registries.handlers.get(type)"]],
  ],
  off: [
    "supported",
    [["src/extensions/loader.ts", "registries.handlers.get(type)"]],
  ],
  appendEntry: [
    "supported",
    [["src/extensions/api.ts", "return registries.entries.filter"]],
  ],
  getSessionEntries: [
    "supported",
    [["src/extensions/api.ts", "return registries.entries.filter"]],
  ],
  setStatus: ["no-op", []],
  notify: [
    "supported",
    [["src/extensions/api.ts", "`[extension:${id}] ${level ?? \"info\"}: ${message}`"]],
  ],
  registerWidget: ["no-op", []],
  unregisterWidget: ["no-op", []],
  registerToolRenderer: ["no-op", []],
  registerMessageRenderer: ["no-op", []],
  registerEntryRenderer: ["no-op", []],
  registerMarkdownTransformer: ["no-op", []],
  registerShortcut: ["no-op", []],
  registerFlag: [
    "supported",
    [["src/extensions/api.ts", "getFlag: (name) => registries.flagValues.get(name)"]],
  ],
  getFlag: [
    "supported",
    [["src/extensions/api.ts", "getFlag: (name) => registries.flagValues.get(name)"]],
  ],
  addAutocompleteProvider: ["no-op", []],
  setWidget: ["no-op", []],
  setFooter: ["no-op", []],
  setHeader: ["no-op", []],
  setTitle: ["no-op", []],
  setWorkingMessage: ["no-op", []],
  setWorkingVisible: ["no-op", []],
  setWorkingIndicator: ["no-op", []],
  setHiddenThinkingLabel: ["no-op", []],
  getToolsExpanded: [
    "supported",
    [["src/extensions/ui.ts", "callbacks.getToolsExpanded"]],
  ],
  setToolsExpanded: [
    "supported",
    [["src/extensions/ui.ts", "callbacks.setToolsExpanded"]],
  ],
  select: [
    "supported",
    [["src/extensions/ui.ts", "callbacks.select"]],
  ],
  confirm: [
    "supported",
    [["src/extensions/ui.ts", "callbacks.confirm"]],
  ],
  input: [
    "supported",
    [["src/extensions/ui.ts", "callbacks.input"]],
  ],
  getWorkspace: [
    "supported",
    [["src/extensions/api.ts", "getWorkspace: () => ctx.workspace"]],
  ],
  getSession: [
    "supported",
    [["src/extensions/api.ts", "getSession: () => ({ id: sessionId })"]],
  ],
  getSessionManager: ["no-op", []],
  isProjectTrusted: [
    "supported",
    [["src/extensions/api.ts", "isProjectTrusted: () => ctx.trusted"]],
  ],
  registerProvider: [
    "reduced",
    [["src/cli/app.ts", "loaded.registries?.providers ?? new Map()"]],
  ],
  unregisterProvider: [
    "supported",
    [["src/cli/app.ts", "loaded.registries?.providers ?? new Map()"]],
  ],
  registerModel: ["no-op", []],
  exec: [
    "supported",
    [["src/extensions/api.ts", "const { execFileSync } = await import"]],
  ],
  log: [
    "supported",
    [["src/extensions/api.ts", "`[extension:${id}] ${message}`"]],
  ],
};

function apiMethods() {
  const source = readFileSync(join(root, API_FILE), "utf8");
  const body = /export interface ExtensionAPI \{([\s\S]*?)\n\}/.exec(source)?.[1];
  if (!body) throw new Error(`Cannot parse ExtensionAPI from ${API_FILE}`);
  return [...body.matchAll(/^\s{2}([A-Za-z_]\w*)\s*\(/gm)].map((m) => m[1]);
}

function locate(file, token) {
  const lines = readFileSync(join(root, file), "utf8").split("\n");
  const index = lines.findIndex((line) => line.includes(token));
  if (index < 0) throw new Error(`Consumer token not found: ${file}: '${token}'`);
  return `${file}:${index + 1}`;
}

function generate() {
  const methods = apiMethods();
  const entries = methods.map((method) => {
    const rule = rules[method];
    if (!rule) throw new Error(`No compatibility rule for ExtensionAPI method '${method}'`);
    const [status, evidence] = rule;
    if (status === "supported" && evidence.length === 0) {
      throw new Error(`'${method}' is supported but has no consumer`);
    }
    const consumers = evidence.map(([file, token]) => locate(file, token));
    return { method, status, consumers };
  });

  const rows = entries
    .map(
      (entry) =>
        `  {\n` +
        `    method: ${JSON.stringify(entry.method)},\n` +
        `    status: ${JSON.stringify(entry.status)},\n` +
        `    consumers: ${JSON.stringify(entry.consumers)},\n` +
        `  },`,
    )
    .join("\n");

  return (
    `// Generated by scripts/generate-compatibility-matrix.mjs. Do not edit by hand.\n` +
    `// Methods come from ${API_FILE}; consumers are located by source token.\n\n` +
    `export type CompatibilityStatus =\n` +
    `  | "supported"\n` +
    `  | "reduced"\n` +
    `  | "no-op"\n` +
    `  | "unsupported";\n\n` +
    `export interface CompatibilityMatrixEntry {\n` +
    `  method: string;\n` +
    `  status: CompatibilityStatus;\n` +
    `  consumers: string[];\n` +
    `}\n\n` +
    `export const compatibilityMatrix: CompatibilityMatrixEntry[] = [\n${rows}\n];\n\n` +
    `export const compatibilityMethodNames: string[] = compatibilityMatrix.map(\n` +
    `  (entry) => entry.method,\n` +
    `);\n`
  );
}

const content = generate();
if (process.argv.includes("--check")) {
  let current;
  try {
    current = readFileSync(join(root, OUTPUT_FILE), "utf8");
  } catch {
    current = "";
  }
  if (current !== content) {
    console.error(`${OUTPUT_FILE} is stale; run npm run matrix:generate`);
    process.exit(1);
  }
  console.log(`compatibility matrix ok: ${apiMethods().length} methods`);
} else {
  writeFileSync(join(root, OUTPUT_FILE), content);
  console.log(`wrote ${OUTPUT_FILE}: ${apiMethods().length} methods`);
}
