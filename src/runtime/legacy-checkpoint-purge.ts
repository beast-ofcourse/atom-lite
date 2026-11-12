import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { userConfigDir } from "../config/paths.js";

/**
 * Automatic checkpoints were removed (ADR 0018). Capture directories left
 * behind by terminated workers have no manifest.json and are useless — they
 * were the multi-hundred-thousand-file orphans that made `du` time out.
 * This sweep is safe to run at startup: it only deletes checkpoint
 * directories that never completed a write, and valid captures keep their
 * manifest. Returns the number of orphan directories removed.
 */
export function purgeOrphanCheckpoints(root?: string): number {
  const base = root ?? join(userConfigDir(), "checkpoints");
  if (!existsSync(base)) return 0;
  let removed = 0;
  for (const workspaceHash of readdirSync(base, { withFileTypes: true })) {
    if (!workspaceHash.isDirectory()) continue;
    const wsDir = join(base, workspaceHash.name);
    for (const sessionId of readdirSync(wsDir, { withFileTypes: true })) {
      if (!sessionId.isDirectory()) continue;
      const sessionDir = join(wsDir, sessionId.name);
      for (const checkpoint of readdirSync(sessionDir, {
        withFileTypes: true,
      })) {
        if (!checkpoint.isDirectory()) continue;
        const cpDir = join(sessionDir, checkpoint.name);
        if (!existsSync(join(cpDir, "manifest.json"))) {
          try {
            rmSync(cpDir, { recursive: true, force: true });
            removed++;
          } catch {
            // best effort
          }
        }
      }
    }
  }
  return removed;
}
