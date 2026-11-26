import { test } from "node:test";
import assert from "node:assert/strict";
import { openerCommand } from "../../dist/cli/open-url.js";

test("clickable links use the platform opener", () => {
  const url = "https://example.com/docs?a=1";
  assert.deepEqual(openerCommand(url, "darwin"), {
    command: "open",
    args: [url],
  });
  assert.deepEqual(openerCommand(url, "linux"), {
    command: "xdg-open",
    args: [url],
  });
});

test("non-web schemes are not opened", () => {
  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/plain,hello",
    "not a url",
  ]) {
    assert.equal(openerCommand(url, "linux"), undefined);
  }
});

test("Windows does not pass URLs through cmd", () => {
  const url = "https://example.com/?a=1&b=2";
  assert.deepEqual(openerCommand(url, "win32"), {
    command: "explorer.exe",
    args: [url],
  });
});
