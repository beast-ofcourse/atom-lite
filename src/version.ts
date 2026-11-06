import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let version = "0.0.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
  );
  if (typeof pkg?.version === "string") version = pkg.version;
} catch {
  // Keep fallback.
}

export const VERSION = version;
