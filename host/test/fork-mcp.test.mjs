import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("the stdio MCP server advertises the fork contracts over the real protocol", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-mcp-"));
  const client = new Client({ name: "fork-test", version: "1.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../mcp-server.js", import.meta.url))],
    env: {
      ...process.env, HOME: home, TMPDIR: home,
      OCIC_PIPE: process.platform === "win32"
        ? `\\\\.\\pipe\\ocic-mcp-${process.pid}`
        : path.join(home, "bridge.sock")
    },
    stderr: "pipe"
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk; });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = new Map(tools.map((tool) => [tool.name, tool]));
    assert.equal(names.size, tools.length);
    for (const name of ["healthcheck", "close_tabs", "tabs_close_mcp", "file_upload", "debug"]) {
      assert(names.has(name), `missing ${name}`);
    }
    assert(names.get("tabs_create_mcp").inputSchema.required.includes("groupName"));
    assert(names.get("tabs_context_mcp").inputSchema.properties.groupName);
    const invalid = await client.callTool({ name: "tabs_create_mcp", arguments: {} });
    assert.equal(invalid.isError, true);
    const result = await client.callTool({ name: "healthcheck", arguments: {} });
    const health = JSON.parse(result.content[0].text);
    assert.equal(health.extensionReachable, false);
    assert.equal(health.mcpServer.mode, "client");
    assert.doesNotMatch(stderr, /SyntaxError|ERR_MODULE_NOT_FOUND/);
  } finally {
    await client.close();
    await transport.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
