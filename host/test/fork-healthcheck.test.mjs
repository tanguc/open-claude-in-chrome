import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TOOLS } from "../tool-definitions.js";

let seq = 0;

async function withRuntime(respond, run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-health-"));
  const pipe = process.platform === "win32"
    ? `\\\\.\\pipe\\ocic-health-${process.pid}-${++seq}`
    : path.join(home, "bridge.sock");
  const previous = process.env.OCIC_PIPE;
  process.env.OCIC_PIPE = pipe;
  const sockets = new Set();
  let server;
  let runtime;
  try {
    if (respond) {
      server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => {});
        let buffer = "";
        socket.on("data", (data) => {
          buffer += data;
          let end;
          while ((end = buffer.indexOf("\n")) !== -1) {
            const msg = JSON.parse(buffer.slice(0, end));
            buffer = buffer.slice(end + 1);
            if (msg.type !== "tool_request") continue;
            const result = respond(msg);
            socket.write(JSON.stringify({ id: msg.id, result }) + "\n");
          }
        });
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(pipe, resolve);
      });
    }
    runtime = await import(`../tool-runtime.js?fork-test=${++seq}`);
    await runtime.init();
    await run(runtime);
  } finally {
    runtime?.shutdown();
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.OCIC_PIPE;
    else process.env.OCIC_PIPE = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("healthcheck unwraps the extension envelope and reports the new transport", async () => {
  await withRuntime(
    () => ({ content: [{ type: "text", text: JSON.stringify({ version: "test", groups: { alpha: {} } }) }] }),
    async (runtime) => {
      const result = await runtime.callTool("healthcheck", {});
      const health = JSON.parse(result.content[0].text);
      assert.equal(health.extensionReachable, true);
      assert.equal(health.extension.version, "test");
      assert.equal(health.mcpServer.bridgeConnected, true);
      assert.equal(health.mcpServer.mode, "client");
      assert.equal(health.mcpServer.transport, process.platform === "win32" ? "named-pipe" : "unix-socket");
      assert.equal(health.mcpServer.pendingRequests, 0);
    }
  );
});

test("healthcheck without a bridge returns diagnostic JSON within its deadline", async () => {
  await withRuntime(null, async (runtime) => {
    const start = Date.now();
    const result = await runtime.callTool("healthcheck", {});
    const health = JSON.parse(result.content[0].text);
    assert.equal(health.extensionReachable, false);
    assert.equal(health.mcpServer.bridgeConnected, false);
    assert.match(health.advice, /install|browser|extension/i);
    assert(Date.now() - start < 7000);
  });
});

test("ordinary tool calls retain the upstream coercion and response envelope", async () => {
  await withRuntime((msg) => ({ content: [{ type: "text", text: JSON.stringify(msg.args) }] }), async (runtime) => {
    const result = await runtime.callTool("navigate", { tabId: "7", url: "https://example.com" });
    assert.equal(JSON.parse(result.content[0].text).tabId, 7);
  });
});

test("all server modes expose named groups and both cleanup APIs", () => {
  const tools = new Map(TOOLS.map((tool) => [tool.name, tool]));
  assert.equal(tools.size, TOOLS.length);
  assert(tools.has("healthcheck"));
  assert(tools.has("close_tabs"));
  assert(tools.has("tabs_close_mcp"));
  assert(tools.get("tabs_context_mcp").paramShape.groupName);
  const createName = tools.get("tabs_create_mcp").paramShape.groupName;
  assert(createName.safeParse("alpha").success);
  assert.equal(createName.safeParse(undefined).success, false);
});
