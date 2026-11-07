import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeHeaders,
  setHeader,
  resolveRequestId,
  applyRequestId,
} from "../../dist/providers/http-headers.js";

test("setHeader replaces a differently-cased existing key", () => {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  setHeader(headers, "content-type", "text/plain");
  assert.deepEqual(Object.keys(headers), ["content-type"]);
  assert.equal(headers["content-type"], "text/plain");
});

test("mergeHeaders lets later maps override case-insensitively", () => {
  const merged = mergeHeaders(
    { "Content-Type": "application/json", Authorization: "Bearer old" },
    { "content-type": "text/plain", authorization: "Bearer new" },
  );
  assert.equal(Object.keys(merged).length, 2);
  assert.equal(merged["content-type"], "text/plain");
  assert.equal(merged["authorization"], "Bearer new");
});

test("mergeHeaders does not leave duplicate casing behind", () => {
  const merged = mergeHeaders(
    { "X-Request-ID": "default" },
    { "x-request-id": "caller" },
  );
  const matching = Object.keys(merged).filter(
    (key) => key.toLowerCase() === "x-request-id",
  );
  assert.equal(matching.length, 1);
  assert.equal(merged["x-request-id"], "caller");
});

test("resolveRequestId keeps an explicit id", () => {
  assert.equal(resolveRequestId("rid-123"), "rid-123");
  assert.equal(resolveRequestId("  rid-456  "), "rid-456");
});

test("resolveRequestId generates a non-empty unique id", () => {
  const a = resolveRequestId();
  const b = resolveRequestId(undefined);
  assert.ok(a.length > 0);
  assert.notEqual(a, b);
});

test("applyRequestId uses an explicit id and replaces casing", () => {
  const headers: Record<string, string> = { "X-REQUEST-ID": "old" };
  const id = applyRequestId(headers, "rid-999");
  assert.equal(id, "rid-999");
  assert.equal(Object.keys(headers).length, 1);
  assert.equal(headers["X-Request-ID"], "rid-999");
});

test("applyRequestId generates an id when none is provided", () => {
  const headers: Record<string, string> = {};
  const id = applyRequestId(headers);
  assert.ok(id.length > 0);
  assert.equal(headers["X-Request-ID"], id);
});
