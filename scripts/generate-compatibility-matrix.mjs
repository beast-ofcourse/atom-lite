// Generates the ExtensionAPI compatibility matrix from the interface in
// src/extensions/api.ts. Status is derived from two explicit facts: whether the
// method is implemented, and whether host code outside api.ts consumes its
// effect. Consumers are located by a stable source token and recorded as
// `{ file, line }`, so the matrix always points at real code.
//
//   node scripts/generate-compatibility-matrix.mjs          # write
//   node scripts/generate-compatibility-matrix.mjs --check  # verify
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const API_FILE = "src/extensions/api.ts";
const OUTPUT_FILE = "src/extensions/compatibility-matrix.ts";

// Host readers. A `supported` entry must point here: a method's own
// implementation line in api.ts is not evidence that anything consumes it.
const hostConsumers = {
  registerTool: [
    ["src/extensions/tool-adapter.ts", "registries.tools.values()"],
  ],
  unregisterTool: [
    ["src/extensions/tool-adapter.ts", "registries.tools.values()"],
  ],
  wrapTool: [
    ["src/extensions/tool-adapter.ts", "collectToolMiddleware(loader)"],
  ],
  provide: [
    [
      "src/extensions/loader.ts",
      "const services: ServiceRegistry = new Map();",
    ],
  ],
  consume: [
    ["src/extensions/loader.ts", "orderByServices(discovered, declarations)"],
  ],
  setActiveTools: [
    [
      "src/extensions/tool-adapter.ts",
      "const active = loaded.registries.activeTools;",
    ],
  ],
  getActiveTools: [
    [
      "src/extensions/tool-adapter.ts",
      "const active = loaded.registries.activeTools;",
    ],
  ],
  getAllTools: [
    ["src/extensions/tool-adapter.ts", "registries.tools.values()"],
  ],
  registerCommand: [["src/cli/app.ts", "registries?.commands?.values?.()"]],
  unregisterCommand: [["src/cli/app.ts", "registries?.commands?.values?.()"]],
  on: [["src/extensions/loader.ts", "registries.handlers.get(event.type)"]],
  off: [["src/extensions/loader.ts", "registries.handlers.get(event.type)"]],
  getToolsExpanded: [["src/extensions/ui.ts", "callbacks.getToolsExpanded"]],
  setToolsExpanded: [["src/extensions/ui.ts", "callbacks.setToolsExpanded"]],
  select: [["src/extensions/ui.ts", "callbacks.select"]],
  confirm: [["src/extensions/ui.ts", "callbacks.confirm"]],
  input: [["src/extensions/ui.ts", "callbacks.input"]],
  getWorkspace: [["src/extensions/loader.ts", "workspace: this.workspace()"]],
  getSession: [["src/extensions/loader.ts", "createExtensionAPI("]],
  isProjectTrusted: [["src/extensions/loader.ts", "trusted: entry.trusted"]],
  registerProvider: [
    ["src/cli/app.ts", "loaded.registries?.providers ?? new Map()"],
  ],
  unregisterProvider: [
    ["src/cli/app.ts", "loaded.registries?.providers ?? new Map()"],
  ],
};

// Implemented and useful, but the host does not consume the result or output.
// The entry may still list consumer evidence (registerProvider maps into the
// host provider list with documented limits).
const reduced = new Set([
  "supports",
  "registerProvider",
  "appendEntry",
  "getSessionEntries",
  "getSessionManager",
  "notify",
  "exec",
  "fetch",
  "log",
]);

// Accepted for compatibility; no host code reads the stored value. These
// entries carry no consumers, like setStatus.
const noOp = new Set([
  "setStatus",
  "registerWidget",
  "unregisterWidget",
  "registerToolRenderer",
  "registerMessageRenderer",
  "registerEntryRenderer",
  "registerMarkdownTransformer",
  "registerShortcut",
  "registerFlag",
  "getFlag",
  "addAutocompleteProvider",
  "setWidget",
  "setFooter",
  "setHeader",
  "setTitle",
  "setWorkingMessage",
  "setWorkingVisible",
  "setWorkingIndicator",
  "setHiddenThinkingLabel",
  "registerModel",
]);

// Deferred Tier 3 APIs. They are present on ExtensionAPI as failing stubs so
// callers get a typed ExtensionCompatibilityError instead of a raw TypeError;
// the matrix labels them `unsupported` and doctor reports them as such.
const unsupported = new Set([
  "getSessionTree",
  "forkSession",
  "registerMcpServer",
  "registerOAuthProvider",
  "virtualModel",
  "enableRpcMode",
  "registerCustomEditor",
]);

// One table drives both status resolution and validation. Rule order is
// precedence: reduced methods may also carry host-consumer evidence, so the
// documented limits win over the `supported` classification.
const statusRules = [
  { status: "unsupported", members: unsupported },
  { status: "no-op", members: noOp },
  { status: "reduced", members: reduced },
  { status: "supported", members: new Set(Object.keys(hostConsumers)) },
];

function apiMethods() {
  const source = readFileSync(join(root, API_FILE), "utf8");
  const body = /export interface ExtensionAPI \{([\s\S]*?)\n\}/.exec(
    source,
  )?.[1];
  if (!body) throw new Error(`Cannot parse ExtensionAPI from ${API_FILE}`);
  return [...body.matchAll(/^\s{2}([A-Za-z_]\w*)(?:<[^>]+>)?\s*\(/gm)].map(
    (m) => m[1],
  );
}

function locate(file, token) {
  const lines = readFileSync(join(root, file), "utf8").split("\n");
  const index = lines.findIndex((line) => line.includes(token));
  if (index < 0)
    throw new Error(`Consumer token not found: ${file}: '${token}'`);
  return { file, line: index + 1 };
}

/** Derive one status from implementation and the shared rule table. */
function statusFor(method, implemented) {
  if (!implemented) return "unsupported";
  const rule = statusRules.find((entry) => entry.members.has(method));
  if (rule) return rule.status;
  throw new Error(`No status evidence for ExtensionAPI method '${method}'`);
}

function validate(methods) {
  const implemented = new Set(methods);
  for (const rule of statusRules) {
    for (const method of rule.members) {
      if (!implemented.has(method)) {
        throw new Error(
          `Status map (${rule.status}) names a method not in ${API_FILE}: '${method}'`,
        );
      }
      const resolved = statusFor(method, true);
      // `reduced` may also list host-consumer evidence; every other overlap
      // is a configuration error, not a valid precedence rule.
      const allowed =
        resolved === rule.status ||
        (rule.status === "supported" && resolved === "reduced");
      if (!allowed) {
        throw new Error(
          `'${method}' has conflicting status evidence (${rule.status})`,
        );
      }
    }
  }
  for (const [method, evidence] of Object.entries(hostConsumers)) {
    for (const [file] of evidence) {
      if (file === API_FILE) {
        throw new Error(
          `'${method}': a supported consumer cannot be ${API_FILE}`,
        );
      }
    }
  }
}

function generate() {
  const methods = apiMethods();
  validate(methods);
  const implemented = new Set(methods);
  const entries = methods.map((method) => {
    const status = statusFor(method, implemented.has(method));
    const evidence = hostConsumers[method] ?? [];
    return {
      method,
      status,
      consumers: evidence.map(([file, token]) => locate(file, token)),
    };
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
    `export interface CompatibilityMatrixLocation {\n` +
    `  file: string;\n` +
    `  line: number;\n` +
    `}\n\n` +
    `export interface CompatibilityMatrixEntry {\n` +
    `  method: string;\n` +
    `  status: CompatibilityStatus;\n` +
    `  consumers: CompatibilityMatrixLocation[];\n` +
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
