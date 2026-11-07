import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../../dist/security/redaction.js";

test("redactSecrets: key: value form", () => {
  assert.equal(redactSecrets("api_key: secret123"), "api_key: [REDACTED]");
});

test("redactSecrets: key=value form", () => {
  assert.equal(redactSecrets("token=abc123"), "token=[REDACTED]");
});

test("redactSecrets: JSON-style quoted keys and values", () => {
  assert.equal(
    redactSecrets('"apiKey": "secret123"'),
    '"apiKey": "[REDACTED]"',
  );
  assert.equal(
    redactSecrets("'password' = 'hunter2'"),
    "'password' = '[REDACTED]'",
  );
});

test("redactSecrets: case insensitive", () => {
  assert.equal(redactSecrets("Password: hunter2"), "Password: [REDACTED]");
  assert.equal(
    redactSecrets("AUTHORIZATION: xyz"),
    "AUTHORIZATION: [REDACTED]",
  );
});

test("redactSecrets: multi-line", () => {
  const input = "api_key: first\ntoken=second\nno secret here";
  const expected = "api_key: [REDACTED]\ntoken=[REDACTED]\nno secret here";
  assert.equal(redactSecrets(input), expected);
});

test("redactSecrets: does not redact unrelated text", () => {
  assert.equal(redactSecrets("hello world"), "hello world");
  assert.equal(redactSecrets("tokenization is fine"), "tokenization is fine");
});

test("redactSecrets: authorization header value", () => {
  assert.equal(
    redactSecrets("authorization: abc.def.ghi"),
    "authorization: [REDACTED]",
  );
});
