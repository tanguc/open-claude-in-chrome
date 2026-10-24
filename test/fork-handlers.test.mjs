import assert from "node:assert/strict";
import { test } from "node:test";
import { compile, extractFunction, extractMethod } from "./_extract.mjs";

function fixture() {
  const groups = new Map([
    ["alpha", { id: 11, color: "red", tabIds: new Set([1]) }],
    ["beta", { id: 22, color: "blue", tabIds: new Set([2]) }]
  ]);
  const tabs = new Map([
    [1, { id: 1, groupId: 11, windowId: 101 }],
    [2, { id: 2, groupId: 22, windowId: 202 }]
  ]);
  const created = [];
  const removed = [];
  let next = 10;
  const mcpGroups = {
    name(value) {
      if (typeof value !== "string" || !value.trim()) throw new Error("groupName required");
      return value.trim();
    },
    async get(name) { return groups.get(name) || null; },
    async ensure(name) { return groups.get(name); },
    async owns(id) { return tabs.has(id); },
    async all() {
      return Object.fromEntries([...groups].map(([name, meta]) => [name, {
        tabGroupId: meta.id, color: meta.color,
        tabs: [...meta.tabIds].map((tabId) => ({ tabId }))
      }]));
    },
    async removeTab(id) {
      for (const [name, meta] of groups) {
        meta.tabIds.delete(id);
        if (!meta.tabIds.size) groups.delete(name);
      }
    }
  };
  const chrome = {
    tabs: {
      async query({ groupId }) { return [...tabs.values()].filter((t) => t.groupId === groupId); },
      async create(options) {
        created.push(options);
        const tab = { id: ++next, groupId: -1, windowId: options.windowId };
        tabs.set(tab.id, tab);
        return tab;
      },
      async group({ tabIds, groupId }) {
        for (const id of tabIds) tabs.get(id).groupId = groupId;
      },
      async remove(ids) {
        removed.push(...ids);
        for (const id of ids) tabs.delete(id);
      }
    },
    debugger: { async detach() {} },
    runtime: { getManifest: () => ({ version: "test" }) }
  };
  const names = ["tabs_context_mcp", "tabs_create_mcp", "close_tabs", "tabs_close_mcp", "healthcheck"];
  const source = [
    extractFunction("formatTabContext"), extractFunction("isInGroup"),
    `const toolHandlers = { ${names.map((name) => extractMethod(name)).join(",\n")} };`
  ].join("\n");
  const handlers = compile(source, {
    chrome, mcpGroups, nativePort: {}, attachedTabs: new Map([[1, {}], [2, {}]])
  }, "toolHandlers");
  return { handlers, groups, tabs, created, removed };
}

test("context lists groups but requires an explicit name to create one", async () => {
  const f = fixture();
  const all = JSON.parse((await f.handlers.tabs_context_mcp({})).content[0].text);
  assert.deepEqual(Object.keys(all.groups), ["alpha", "beta"]);
  assert.equal(all.availableTabs.length, 2);
  await assert.rejects(f.handlers.tabs_context_mcp({ createIfEmpty: true }), /groupName/);
});

test("parallel tab creation stays in each named group's own window", async () => {
  const f = fixture();
  await Promise.all([
    f.handlers.tabs_create_mcp({ groupName: "alpha" }),
    f.handlers.tabs_create_mcp({ groupName: "beta" })
  ]);
  assert.deepEqual(f.created.map((o) => o.windowId).sort(), [101, 202]);
  assert(f.created.every((o) => o.active === false));
  for (const tab of f.tabs.values()) {
    assert.equal(tab.groupId, tab.windowId === 101 ? 11 : 22);
  }
  await assert.rejects(f.handlers.tabs_create_mcp({}), /groupName/);
});

test("strict cleanup validates the whole batch before closing any tab", async () => {
  const f = fixture();
  await assert.rejects(f.handlers.close_tabs({ tabIds: [1, 999] }), /managed group/);
  assert.deepEqual(f.removed, []);
  await assert.rejects(f.handlers.close_tabs({ groupName: "alpha", tabIds: [1] }), /exactly one/);
  await assert.rejects(f.handlers.close_tabs({ tabIds: [] }), /non-empty/);
  assert.deepEqual(f.removed, []);
});

test("group cleanup leaves another agent's tabs alone and is idempotent", async () => {
  const f = fixture();
  await f.handlers.close_tabs({ groupName: "alpha" });
  assert.deepEqual(f.removed, [1]);
  assert(f.tabs.has(2));
  assert(f.groups.has("beta"));
  await f.handlers.close_tabs({ groupName: "alpha" });
  assert.deepEqual(f.removed, [1]);
});

test("the upstream cleanup API skips unmanaged tabs without closing them", async () => {
  const f = fixture();
  const result = await f.handlers.tabs_close_mcp({ tabIds: [1, 999] });
  assert.deepEqual(f.removed, [1]);
  assert(f.tabs.has(2));
  assert.match(result.content[0].text, /Skipped unmanaged tabs/);
});

test("extension diagnostics include the version and all named groups", async () => {
  const f = fixture();
  const health = JSON.parse((await f.handlers.healthcheck({})).content[0].text);
  assert.equal(health.version, "test");
  assert.equal(health.nativePortConnected, true);
  assert.deepEqual(Object.keys(health.groups), ["alpha", "beta"]);
});
