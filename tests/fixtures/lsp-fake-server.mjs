import process from "node:process";
let buf = Buffer.alloc(0);
function send(msg) {
  const json = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;
  process.stdout.write(header + json);
}
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const idx = buf.indexOf("\r\n\r\n");
    if (idx === -1) break;
    const header = buf.slice(0, idx).toString();
    const m = header.match(/Content-Length:\s*(\d+)/i);
    if (!m) {
      buf = buf.slice(idx + 4);
      continue;
    }
    const len = Number(m[1]);
    const start = idx + 4;
    if (buf.length < start + len) break;
    const body = buf.slice(start, start + len).toString();
    buf = buf.slice(start + len);
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      continue;
    }
    if (msg.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { capabilities: { textDocumentSync: 1 } },
      });
    } else if (
      msg.method === "textDocument/didOpen" ||
      msg.method === "textDocument/didChange"
    ) {
      const uri = msg.params.textDocument.uri;
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "textDocument/publishDiagnostics",
          params: {
            uri,
            diagnostics: [
              {
                message: "fake diag",
                severity: 1,
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 1 },
                },
              },
            ],
          },
        });
      }, 20);
    } else if (msg.method === "textDocument/documentSymbol") {
      send({ jsonrpc: "2.0", id: msg.id, result: [{ name: "Foo", kind: 12 }] });
    } else if (msg.method === "workspace/symbol") {
      send({ jsonrpc: "2.0", id: msg.id, result: [{ name: "Bar", kind: 12 }] });
    } else if (msg.method === "shutdown") {
      send({ jsonrpc: "2.0", id: msg.id, result: null });
    }
  }
});
process.stdin.resume();
