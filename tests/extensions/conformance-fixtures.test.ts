// Contract tests for ticket 14 (conformance suite seed).
//
// Seam: runExtensionTest() over the published fault-injection fixtures. Each
// fixture asserts the containment contract from ticket 05; this test pins that
// the fixtures stay runnable, so they can seed the conformance matrix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { runExtensionTest } from "../../dist/extensions/harness.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "extensions");

test("published fault-injection fixtures pass through the harness", async () => {
  const fixtures = readdirSync(FIXTURES)
    .filter((file) => file.endsWith(".js"))
    .sort();
  assert.deepEqual(fixtures, [
    "activation-throw.js",
    "dialog-teardown.js",
    "event-throw.js",
    "tool-throw.js",
  ]);

  for (const fixture of fixtures) {
    const result = await runExtensionTest(join(FIXTURES, fixture));
    assert.equal(
      result.passed,
      true,
      `${fixture}: ${result.failures.join("; ")} ${result.errors.join("; ")}`,
    );
    assert.ok(result.assertions > 0, `${fixture}: assertions ran`);
  }
});
