// Test fixture: hold a session lock from a separate process, like another
// terminal or a second server would.
//
// Usage: node tests/fixtures/hold-session-lock.mjs <lockPath> <sessionId>
import { acquireSessionLock } from "../../dist/sessions/lock.js";

const [lockPath, sessionId] = process.argv.slice(2);
if (!lockPath || !sessionId) {
  process.stderr.write("usage: hold-session-lock.mjs <lockPath> <sessionId>\n");
  process.exit(2);
}

acquireSessionLock(lockPath, sessionId, { reclaimAfterMs: 5 });
process.stdout.write("locked\n");
setInterval(() => {}, 1000);
