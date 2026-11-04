import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getApiKey,
  loadCredentials,
  removeApiKey,
  resolveApiKey,
  saveApiKey,
} from "../../dist/config/credentials.js";

test("saveApiKey persists a key with owner-only permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-creds-"));
  const path = join(dir, "credentials.json");
  saveApiKey("openai", "sk-test", path);
  assert.equal(getApiKey("openai", path), "sk-test");
  assert.deepEqual(loadCredentials(path), { apiKeys: { openai: "sk-test" } });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(raw.apiKeys.openai, "sk-test");
});

test("credentials preserve other profiles and can be removed", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-creds-"));
  const path = join(dir, "credentials.json");
  saveApiKey("openai", "a", path);
  saveApiKey("anthropic", "b", path);
  assert.equal(getApiKey("openai", path), "a");
  assert.equal(getApiKey("anthropic", path), "b");
  removeApiKey("openai", path);
  assert.equal(getApiKey("openai", path), null);
  assert.equal(getApiKey("anthropic", path), "b");
});

test("resolveApiKey prefers environment over the stored key", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-creds-"));
  const path = join(dir, "credentials.json");
  saveApiKey("openai", "stored", path);
  process.env.ATOM_TEST_CRED_KEY = "from-env";
  try {
    assert.equal(
      resolveApiKey("openai", { apiKeyEnv: "ATOM_TEST_CRED_KEY", path }),
      "from-env",
    );
    assert.equal(resolveApiKey("openai", { path }), "stored");
  } finally {
    delete process.env.ATOM_TEST_CRED_KEY;
  }
});

test("malformed credentials file yields an empty set", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-creds-"));
  const path = join(dir, "credentials.json");
  writeFileSync(path, "{not json");
  assert.deepEqual(loadCredentials(path), { apiKeys: {} });
});
