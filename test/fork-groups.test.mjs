import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const source = fs.readFileSync(new URL("../extension/groups.js", import.meta.url), "utf8")
  .replace(/^export \{ mcpGroups \};$/m, "");

function fixture() {
  const tabs = new Map();
  const groups = new Map();
  const storage = {};
  const created = [];
  let seq = 0;
  const chrome = {
    storage: { local: {
      async get() { return structuredClone(storage); },
      async set(value) { Object.assign(storage, structuredClone(value)); }
    } },
    windows: {
      async create(options) {
        created.push(options);
        const id = ++seq;
        const tab = { id: ++seq, windowId: id, groupId: -1, url: "about:blank" };
        tabs.set(tab.id, tab);
        return { id, tabs: [tab] };
      },
      async remove(id) {
        for (const tab of [...tabs.values()]) if (tab.windowId === id) tabs.delete(tab.id);
      }
    },
    tabs: {
      async get(id) {
        if (!tabs.has(id)) throw new Error("missing tab");
        return { ...tabs.get(id) };
      },
      async query({ groupId }) { return [...tabs.values()].filter((t) => t.groupId === groupId); },
      async group({ tabIds, groupId }) {
        const id = groupId ?? ++seq;
        if (!groups.has(id)) groups.set(id, { id, title: "", color: "grey" });
        for (const tabId of tabIds) tabs.get(tabId).groupId = id;
        return id;
      }
    },
    tabGroups: {
      async get(id) {
        if (!groups.has(id)) throw new Error("missing group");
        return { ...groups.get(id) };
      },
      async query({ title }) { return [...groups.values()].filter((g) => g.title === title); },
      async update(id, value) { Object.assign(groups.get(id), value); }
    }
  };
  function boot() {
    const context = vm.createContext({ chrome });
    vm.runInContext(source, context);
    return vm.runInContext("mcpGroups", context);
  }
  return { api: boot(), boot, tabs, groups, storage, created, chrome };
}

test("parallel names get distinct unfocused windows and persisted colors", async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.api.ensure("alpha", "red"), f.api.ensure("beta", "green")]);
  assert.notEqual(a.id, b.id);
  assert.equal(f.created.length, 2);
  assert(f.created.every((o) => o.focused === false));
  const state = await f.api.all();
  assert.equal(state.alpha.color, "red");
  assert.equal(state.beta.color, "green");
  assert.notEqual(f.tabs.get(state.alpha.tabs[0].tabId).windowId, f.tabs.get(state.beta.tabs[0].tabId).windowId);
  assert.equal(f.storage.groups.alpha.id, a.id);
});

test("parallel bootstraps of the same name share one window", async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 12 }, () => f.api.ensure("alpha")));
  assert.equal(new Set(results.map((r) => r.id)).size, 1);
  assert.equal(f.created.length, 1);
});

test("worker restart restores groups without creating windows", async () => {
  const f = fixture();
  const first = await f.api.ensure("alpha");
  const restarted = f.boot();
  assert.equal((await restarted.get("alpha")).id, first.id);
  assert.equal(f.created.length, 1);
});

test("restart recovers a persisted name when Chrome changes the group id", async () => {
  const f = fixture();
  const first = await f.api.ensure("alpha");
  const group = f.groups.get(first.id);
  f.groups.delete(first.id);
  f.groups.set(999, { ...group, id: 999 });
  for (const tab of f.tabs.values()) tab.groupId = 999;
  assert.equal((await f.boot().get("alpha")).id, 999);
  assert.equal(f.storage.groups.alpha.id, 999);
});

test("moving a tab outside its managed group revokes access immediately", async () => {
  const f = fixture();
  const group = await f.api.ensure("alpha");
  const [id] = group.tabIds;
  assert.equal(await f.api.owns(id), true);
  f.tabs.get(id).groupId = -1;
  assert.equal(await f.api.owns(id), false);
  assert.equal(await f.api.owns(12345), false);
});

test("a renamed group is not silently treated as owned", async () => {
  const f = fixture();
  const group = await f.api.ensure("alpha");
  const [id] = group.tabIds;
  f.groups.get(group.id).title = "user workspace";
  assert.equal(await f.api.owns(id), false);
  assert.equal(await f.api.get("alpha"), null);
});

test("removing the last tab drops only its own persisted group", async () => {
  const f = fixture();
  const a = await f.api.ensure("alpha");
  await f.api.ensure("beta");
  const [id] = a.tabIds;
  f.tabs.delete(id);
  f.groups.delete(a.id);
  await f.api.removeTab(id);
  assert.equal(await f.api.get("alpha"), null);
  assert.equal(f.storage.groups.alpha, undefined);
  assert(await f.api.get("beta"));
});

test("invalid names and colors do not create windows", async () => {
  const f = fixture();
  for (const name of [null, "", "  ", "x".repeat(51)]) {
    await assert.rejects(f.api.ensure(name), /groupName/);
  }
  await assert.rejects(f.api.ensure("alpha", "invisible"), /color/);
  assert.equal(f.created.length, 0);
});

test("color changes persist and special property names remain own keys", async () => {
  const f = fixture();
  await f.api.ensure("__proto__", "red");
  await f.api.ensure("__proto__", "cyan");
  const state = await f.api.all();
  assert(Object.hasOwn(state, "__proto__"));
  assert.equal(state.__proto__.color, "cyan");
  assert(Object.hasOwn(f.storage.groups, "__proto__"));
});
