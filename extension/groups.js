// named groups survive service-worker restarts without sharing a mutable current group
const mcpGroups = (() => {
  const groups = new Map();
  const locks = new Map();
  const colors = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

  function name(value) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("groupName must be a non-empty string");
    }
    const trimmed = value.trim();
    if (trimmed.length > 50) throw new Error("groupName must be 50 characters or fewer");
    return trimmed;
  }

  async function persist() {
    try {
      await chrome.storage.local.set({
        groups: Object.fromEntries([...groups].map(([key, meta]) => [key, { id: meta.id, color: meta.color }]))
      });
    } catch {}
  }

  async function load() {
    try {
      const stored = await chrome.storage.local.get(["groups"]);
      for (const [key, meta] of Object.entries(stored.groups || {})) {
        try {
          if (name(key) !== key) continue;
          let group;
          try { group = await chrome.tabGroups.get(meta.id); } catch {}
          if (!group || group.title !== key) {
            const matches = await chrome.tabGroups.query({ title: key });
            if (matches.length !== 1) continue;
            group = matches[0];
          }
          const tabs = await chrome.tabs.query({ groupId: group.id });
          if (tabs.length) {
            groups.set(key, { id: group.id, color: group.color, tabIds: new Set(tabs.map((t) => t.id)) });
          }
        } catch {}
      }
      await persist();
    } catch {}
  }

  const ready = load();

  async function get(key) {
    await ready;
    key = name(key);
    const meta = groups.get(key);
    if (!meta) return null;
    try {
      const group = await chrome.tabGroups.get(meta.id);
      const tabs = await chrome.tabs.query({ groupId: meta.id });
      if (group.title === key && tabs.length) {
        meta.color = group.color;
        meta.tabIds = new Set(tabs.map((t) => t.id));
        return meta;
      }
    } catch {}
    groups.delete(key);
    await persist();
    return null;
  }

  async function ensure(key, color) {
    await ready;
    key = name(key);
    if (color != null && !colors.includes(color)) {
      throw new Error(`color must be one of: ${colors.join(", ")}`);
    }
    if (locks.has(key)) return locks.get(key);
    const pending = (async () => {
      const existing = await get(key);
      if (existing) {
        if (color && color !== existing.color) {
          await chrome.tabGroups.update(existing.id, { color });
          existing.color = color;
          await persist();
        }
        return existing;
      }
      const win = await chrome.windows.create({ focused: false, url: "about:blank" });
      try {
        const tab = win.tabs[0];
        const id = await chrome.tabs.group({ tabIds: [tab.id] });
        const selected = color || "blue";
        await chrome.tabGroups.update(id, { title: key, color: selected });
        const meta = { id, color: selected, tabIds: new Set([tab.id]) };
        groups.set(key, meta);
        await persist();
        return meta;
      } catch (err) {
        await chrome.windows.remove(win.id).catch(() => {});
        throw err;
      }
    })();
    locks.set(key, pending);
    try {
      return await pending;
    } finally {
      locks.delete(key);
    }
  }

  async function owns(tabId) {
    await ready;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.groupId === -1) return false;
      for (const key of groups.keys()) {
        const meta = await get(key);
        if (meta?.id === tab.groupId) return true;
      }
    } catch {}
    return false;
  }

  async function all() {
    await ready;
    const entries = [];
    for (const key of [...groups.keys()]) {
      const meta = await get(key);
      if (!meta) continue;
      const tabs = await chrome.tabs.query({ groupId: meta.id });
      entries.push([key, { tabGroupId: meta.id, color: meta.color, tabs: tabs.map((t) => ({
        tabId: t.id, title: t.title || "Untitled", url: t.url || ""
      })) }]);
    }
    return Object.fromEntries(entries);
  }

  async function removeTab(tabId) {
    await ready;
    for (const [key, meta] of [...groups]) {
      if (meta.tabIds.delete(tabId)) await get(key);
    }
  }

  return { ready, name, get, ensure, owns, all, removeTab };
})();

export { mcpGroups };
