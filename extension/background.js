// Background service worker for Open Claude in Chrome extension.
// Handles: native messaging, CDP via chrome.debugger, tool dispatch, tab group management.

// Prevent unhandled rejections from killing the service worker
self.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
});

const NATIVE_HOST_NAME = "com.anthropic.open_claude_in_chrome";

// --- Multi-group state ---
// Each agent owns a named tab group. groupName is the identity and the per-tab
// metadata: any tab inside a named group "belongs to" the agent that named it.
const DEFAULT_GROUP_COLOR = "blue";
const VALID_GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

// groupName -> { id: <chrome tabGroupId>, color: string, tabIds: Set<number> }
const groupsByName = new Map();
// Per-name de-dup: callers asking for the same name share one in-flight promise
const groupCreationLocks = new Map();
// Global creation mutex: serializes all NEW group creations so two concurrent
// bootstraps from an empty state can't both spawn a host window. Once any group
// exists, subsequent creates inside the locked section see the host window and
// reuse it.
let creationMutex = Promise.resolve();
// Init promise, awaited in handleToolRequest before processing any tool
let stateLoaded = null;

async function persistGroupsState() {
  try {
    const out = {};
    for (const [name, meta] of groupsByName) {
      out[name] = { id: meta.id, color: meta.color };
    }
    await chrome.storage.local.set({ groups: out });
  } catch {}
}

async function loadGroupsState() {
  try {
    const stored = await chrome.storage.local.get(["groups"]);
    const persisted = stored.groups || {};
    for (const [name, meta] of Object.entries(persisted)) {
      try {
        const group = await chrome.tabGroups.get(meta.id);
        if (group && group.title === name) {
          const tabs = await chrome.tabs.query({ groupId: group.id });
          groupsByName.set(name, {
            id: group.id,
            color: VALID_GROUP_COLORS.includes(meta.color) ? meta.color : DEFAULT_GROUP_COLOR,
            tabIds: new Set(tabs.map((t) => t.id)),
          });
        }
      } catch {
        // Group is gone since last persist; drop it silently
      }
    }
    // Persist back any cleanup
    await persistGroupsState();
  } catch {}
}

function validateGroupName(name) {
  if (typeof name !== "string") throw new Error("groupName must be a string");
  const trimmed = name.trim();
  if (!trimmed) throw new Error("groupName must be non-empty");
  if (trimmed.length > 50) throw new Error("groupName must be 50 characters or fewer");
  return trimmed;
}

function validateColor(color) {
  if (color === undefined || color === null || color === "") return null;
  if (typeof color !== "string" || !VALID_GROUP_COLORS.includes(color)) {
    throw new Error(`color must be one of: ${VALID_GROUP_COLORS.join(", ")}`);
  }
  return color;
}

// --- State ---
let nativePort = null;
const attachedTabs = new Map(); // tabId -> { enabledDomains: Set }
const consoleMessages = new Map(); // tabId -> [{level, text, timestamp, url}]
const networkRequests = new Map(); // tabId -> [{url, method, status, type, timestamp}]
const screenshotStore = new Map(); // imageId -> base64

// --- Keep-alive alarm ---
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    if (!nativePort) connectNativeHost();
  }
});

// --- Native messaging ---
function connectNativeHost() {
  if (nativePort) return;
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);

    nativePort.onMessage.addListener((msg) => {
      if (msg.type === "tool_request" && msg.id) {
        handleToolRequest(msg.id, msg.tool, msg.args || {});
      }
    });

    nativePort.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      nativePort = null;
      // Retry in 2 seconds
      setTimeout(connectNativeHost, 2000);
    });
  } catch (e) {
    nativePort = null;
    setTimeout(connectNativeHost, 2000);
  }
}

function sendResponse(id, result) {
  if (!nativePort) return;
  try {
    nativePort.postMessage({ id, type: "tool_response", result });
  } catch {
    // Port disconnected
  }
}

function sendError(id, error) {
  if (!nativePort) return;
  try {
    nativePort.postMessage({ id, type: "tool_error", error: String(error) });
  } catch {
    // Port disconnected
  }
}

// --- Multi-group management ---

// Verify a tracked group still exists in chrome. If not, drop from state.
async function refreshGroupMeta(name) {
  const meta = groupsByName.get(name);
  if (!meta) return null;
  try {
    await chrome.tabGroups.get(meta.id);
    const tabs = await chrome.tabs.query({ groupId: meta.id });
    meta.tabIds = new Set(tabs.map((t) => t.id));
    return meta;
  } catch {
    groupsByName.delete(name);
    await persistGroupsState();
    return null;
  }
}

// Idempotent: returns existing group meta if present, otherwise creates a new
// window+tab+group with the given name and color. Race-safe via per-name lock.
async function ensureNamedGroup(name, color) {
  const trimmed = validateGroupName(name);
  const validatedColor = validateColor(color);

  const existing = await refreshGroupMeta(trimmed);
  if (existing) {
    if (validatedColor && validatedColor !== existing.color) {
      try {
        await chrome.tabGroups.update(existing.id, { color: validatedColor });
        existing.color = validatedColor;
        await persistGroupsState();
      } catch {}
    }
    return existing;
  }

  if (groupCreationLocks.has(trimmed)) return groupCreationLocks.get(trimmed);

  const promise = (async () => {
    // Acquire the global creation mutex so concurrent first-time bootstraps
    // can't both spawn a host window. Pattern: chain a new promise onto the
    // mutex, await the previous tail, run, then release.
    const previousTail = creationMutex;
    let release;
    creationMutex = new Promise((r) => { release = r; });
    await previousTail;

    try {
      // Re-check after acquiring: while we waited, another caller may have
      // created our exact name OR established a host window we should reuse.
      const recheck = await refreshGroupMeta(trimmed);
      if (recheck) return recheck;

      const finalColor = validatedColor || DEFAULT_GROUP_COLOR;

      // Reuse an existing window that already hosts one of our groups so all
      // named groups live side-by-side in one tab strip. Only spawn a fresh
      // window if no host window exists yet.
      let hostWindowId = null;
      for (const meta of groupsByName.values()) {
        try {
          const g = await chrome.tabGroups.get(meta.id);
          hostWindowId = g.windowId;
          break;
        } catch {}
      }

      let tab;
      if (hostWindowId !== null) {
        tab = await chrome.tabs.create({ active: true, windowId: hostWindowId, url: "about:blank" });
      } else {
        const win = await chrome.windows.create({ focused: true, url: "about:blank" });
        tab = win.tabs[0];
      }

      const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
      await chrome.tabGroups.update(groupId, { title: trimmed, color: finalColor });
      const meta = { id: groupId, color: finalColor, tabIds: new Set([tab.id]) };
      groupsByName.set(trimmed, meta);
      await persistGroupsState();
      return meta;
    } finally {
      release();
    }
  })();

  groupCreationLocks.set(trimmed, promise);
  try {
    return await promise;
  } finally {
    groupCreationLocks.delete(trimmed);
  }
}

// Find which (if any) of our named groups owns a given tabId.
async function findGroupForTab(tabId) {
  // Quick path: scan in-memory state
  for (const [name, meta] of groupsByName) {
    if (meta.tabIds.has(tabId)) return { name, meta };
  }
  // Slow path: maybe service worker lost in-memory tabIds. Resolve via chrome.
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.groupId === -1) return null;
    for (const [name, meta] of groupsByName) {
      if (meta.id === tab.groupId) {
        meta.tabIds.add(tabId);
        return { name, meta };
      }
    }
    // Maybe a brand new group whose title matches one we persisted but didn't reload yet
    const group = await chrome.tabGroups.get(tab.groupId);
    if (group && groupsByName.has(group.title)) {
      const meta = groupsByName.get(group.title);
      meta.id = group.id;
      meta.tabIds.add(tabId);
      return { name: group.title, meta };
    }
  } catch {}
  return null;
}

async function isInOurGroup(tabId) {
  return (await findGroupForTab(tabId)) !== null;
}

function tabSummary(tabs) {
  return tabs.map((t) => ({
    tabId: t.id,
    title: t.title || "Untitled",
    url: t.url || "",
  }));
}

function formatSingleGroupContext(name, meta, tabs) {
  const available = tabSummary(tabs);
  let text = `Tab Context (group "${name}"):\n- Available tabs:\n`;
  for (const t of available) {
    text += `  \u2022 tabId ${t.tabId}: "${t.title}" (${t.url})\n`;
  }
  return {
    content: [
      {
        type: "text",
        text:
          JSON.stringify({
            groupName: name,
            tabGroupId: meta.id,
            color: meta.color,
            availableTabs: available,
          }) +
          "\n\n" +
          text,
      },
    ],
  };
}

async function formatAllGroupsContext() {
  const groups = {};
  let text = `Tab Context (all MCP-managed groups):\n`;
  if (groupsByName.size === 0) {
    text += `- No groups exist yet. Call tabs_context_mcp({ groupName: "<your-name>", createIfEmpty: true }) to create one.\n`;
  }
  for (const [name, meta] of groupsByName) {
    const tabs = await chrome.tabs.query({ groupId: meta.id });
    const available = tabSummary(tabs);
    groups[name] = { tabGroupId: meta.id, color: meta.color, tabs: available };
    text += `\n[${name}] color=${meta.color} tabGroupId=${meta.id}\n`;
    for (const t of available) {
      text += `  \u2022 tabId ${t.tabId}: "${t.title}" (${t.url})\n`;
    }
  }
  return {
    content: [
      { type: "text", text: JSON.stringify({ groups }) + "\n\n" + text },
    ],
  };
}

// --- CDP helpers ---
async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  attachedTabs.set(tabId, { enabledDomains: new Set() });
  // Force devicePixelRatio to 1 so screenshots match CSS coordinate space.
  // Without this, Retina displays produce 2x screenshots and all coordinates are wrong.
  const tab = await chrome.tabs.get(tabId);
  const win = await chrome.windows.get(tab.windowId);
  await chrome.debugger.sendCommand({ tabId }, "Emulation.setDeviceMetricsOverride", {
    width: win.width,
    height: win.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function ensureDomain(tabId, domain) {
  const state = attachedTabs.get(tabId);
  if (!state) throw new Error("Not attached to tab");
  if (state.enabledDomains.has(domain)) return;
  await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`, {});
  state.enabledDomains.add(domain);
}

async function cdp(tabId, method, params = {}) {
  await ensureAttached(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
  let mutated = false;
  for (const [name, meta] of groupsByName) {
    if (meta.tabIds.delete(tabId)) {
      mutated = true;
      if (meta.tabIds.size === 0) {
        // Chrome auto-removes the group when its last tab closes; drop our state too
        groupsByName.delete(name);
      }
      break;
    }
  }
  if (mutated) await persistGroupsState();
  if (attachedTabs.has(tabId)) {
    try { chrome.debugger.detach({ tabId }); } catch {}
    attachedTabs.delete(tabId);
  }
  consoleMessages.delete(tabId);
  networkRequests.delete(tabId);
});

// Handle user dismissing debugger bar
chrome.debugger.onDetach.addListener((source, reason) => {
  attachedTabs.delete(source.tabId);
});

// --- CDP event listeners for console and network ---
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;

  if (method === "Console.messageAdded" && params.message) {
    const msgs = consoleMessages.get(tabId) || [];
    msgs.push({
      level: params.message.level,
      text: params.message.text,
      url: params.message.url || "",
      timestamp: Date.now(),
    });
    // Keep last 1000
    if (msgs.length > 1000) msgs.splice(0, msgs.length - 1000);
    consoleMessages.set(tabId, msgs);
  }

  if (method === "Runtime.consoleAPICalled" && params.args) {
    const msgs = consoleMessages.get(tabId) || [];
    const text = params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    msgs.push({
      level: params.type || "log",
      text,
      url: params.stackTrace?.callFrames?.[0]?.url || "",
      timestamp: Date.now(),
    });
    if (msgs.length > 1000) msgs.splice(0, msgs.length - 1000);
    consoleMessages.set(tabId, msgs);
  }

  if (method === "Network.responseReceived" && params.response) {
    const reqs = networkRequests.get(tabId) || [];
    reqs.push({
      url: params.response.url,
      method: params.response.requestHeaders ? "?" : "GET",
      status: params.response.status,
      statusText: params.response.statusText,
      type: params.type || "Other",
      mimeType: params.response.mimeType,
      timestamp: Date.now(),
    });
    if (reqs.length > 1000) reqs.splice(0, reqs.length - 1000);
    networkRequests.set(tabId, reqs);
  }

  if (method === "Network.requestWillBeSent" && params.request) {
    const reqs = networkRequests.get(tabId) || [];
    reqs.push({
      url: params.request.url,
      method: params.request.method,
      status: 0,
      type: params.type || "Other",
      timestamp: Date.now(),
    });
    if (reqs.length > 1000) reqs.splice(0, reqs.length - 1000);
    networkRequests.set(tabId, reqs);
  }
});

// --- Key code mapping ---
const KEY_MAP = {
  enter: "Enter", return: "Enter", tab: "Tab", escape: "Escape", esc: "Escape",
  backspace: "Backspace", delete: "Delete", space: "Space", " ": "Space",
  arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
  f1: "F1", f2: "F2", f3: "F3", f4: "F4", f5: "F5", f6: "F6",
  f7: "F7", f8: "F8", f9: "F9", f10: "F10", f11: "F11", f12: "F12",
};

function parseKeyCombo(keyStr) {
  const parts = keyStr.split("+").map((p) => p.trim().toLowerCase());
  let modifiers = 0;
  let key = "";
  for (const part of parts) {
    if (part === "ctrl" || part === "control") modifiers |= 2;
    else if (part === "alt") modifiers |= 1;
    else if (part === "shift") modifiers |= 8;
    else if (part === "meta" || part === "cmd" || part === "command" || part === "win" || part === "windows") modifiers |= 4;
    else key = KEY_MAP[part] || part;
  }
  return { key, modifiers };
}

function parseModifierString(modStr) {
  if (!modStr) return 0;
  let modifiers = 0;
  const parts = modStr.split("+").map((p) => p.trim().toLowerCase());
  for (const part of parts) {
    if (part === "ctrl" || part === "control") modifiers |= 2;
    else if (part === "alt") modifiers |= 1;
    else if (part === "shift") modifiers |= 8;
    else if (part === "meta" || part === "cmd" || part === "command" || part === "win" || part === "windows") modifiers |= 4;
  }
  return modifiers;
}

// --- Content script communication ---
async function sendContentMessage(tabId, message) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    return response;
  } catch {
    // Content script might not be injected yet, try injecting
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    // Retry
    return chrome.tabs.sendMessage(tabId, message);
  }
}

// --- Resolve ref to coordinates ---
async function resolveRefToCoordinates(tabId, ref) {
  const resp = await sendContentMessage(tabId, { type: "getRefCoordinates", ref });
  if (resp?.result) return [resp.result.x, resp.result.y];
  return null;
}

// --- Screenshot helper ---
// Cap viewport to 1280x800 for screenshots to keep size manageable.
// Retina displays produce 2x+ resolution PNGs that blow up base64 size.
const MAX_SCREENSHOT_WIDTH = 1280;
const MAX_SCREENSHOT_HEIGHT = 800;

async function takeScreenshot(tabId) {
  await ensureAttached(tabId);

  // With deviceScaleFactor: 1 set in ensureAttached, screenshots are captured
  // at CSS pixel dimensions (e.g., 1080x746), matching the coordinate space
  // used by Input.dispatchMouseEvent. No scaling tricks needed.
  const result = await cdp(tabId, "Page.captureScreenshot", {
    format: "jpeg",
    quality: 55,
    optimizeForSpeed: true,
    captureBeyondViewport: false,
  });
  let base64 = result.data;

  // If still too large (>500KB base64 ≈ ~375KB binary), reduce quality further
  if (base64.length > 500000) {
    const smaller = await cdp(tabId, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 30,
      optimizeForSpeed: true,
      captureBeyondViewport: false,
    });
    base64 = smaller.data;
  }

  const imageId = `screenshot_${Date.now()}`;
  screenshotStore.set(imageId, base64);
  // Keep only last 10 screenshots (less memory pressure)
  const keys = Array.from(screenshotStore.keys());
  while (keys.length > 10) {
    screenshotStore.delete(keys.shift());
  }

  return { base64, imageId };
}

// --- Mouse helpers ---
async function dispatchMouse(tabId, type, x, y, opts = {}) {
  await cdp(tabId, "Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: opts.button || "left",
    clickCount: opts.clickCount || 1,
    modifiers: opts.modifiers || 0,
  });
}

async function mouseClick(tabId, x, y, opts = {}) {
  const button = opts.button || "left";
  const clickCount = opts.clickCount || 1;
  const modifiers = opts.modifiers || 0;

  await dispatchMouse(tabId, "mouseMoved", x, y, { modifiers });
  await sleep(50);
  await dispatchMouse(tabId, "mousePressed", x, y, { button, clickCount, modifiers });
  await sleep(50);
  await dispatchMouse(tabId, "mouseReleased", x, y, { button, clickCount, modifiers });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Tool handlers ---
const toolHandlers = {
  async tabs_context_mcp(args) {
    const { groupName, createIfEmpty, color } = args || {};

    // No groupName: return ALL groups owned by this extension instance.
    if (groupName === undefined || groupName === null || groupName === "") {
      return formatAllGroupsContext();
    }

    const trimmed = validateGroupName(groupName);

    // Group exists already
    const existing = await refreshGroupMeta(trimmed);
    if (existing) {
      const tabs = await chrome.tabs.query({ groupId: existing.id });
      return formatSingleGroupContext(trimmed, existing, tabs);
    }

    // Doesn't exist
    if (!createIfEmpty) {
      return {
        content: [
          {
            type: "text",
            text: `No MCP tab group named "${trimmed}" exists. Pass createIfEmpty: true to create it.`,
          },
        ],
      };
    }

    const meta = await ensureNamedGroup(trimmed, color);
    const tabs = await chrome.tabs.query({ groupId: meta.id });
    return formatSingleGroupContext(trimmed, meta, tabs);
  },

  async tabs_create_mcp(args) {
    const { groupName, color } = args || {};
    if (groupName === undefined || groupName === null || groupName === "") {
      throw new Error('groupName is required. Call tabs_context_mcp({ groupName, createIfEmpty: true }) first to establish your group.');
    }
    const trimmed = validateGroupName(groupName);

    // ensureNamedGroup is idempotent — creates the group if missing, returns existing meta otherwise.
    const meta = await ensureNamedGroup(trimmed, color);

    const tab = await chrome.tabs.create({ active: true, windowId: (await chrome.tabGroups.get(meta.id)).windowId });
    await chrome.tabs.group({ tabIds: [tab.id], groupId: meta.id });
    meta.tabIds.add(tab.id);
    await persistGroupsState();

    const tabs = await chrome.tabs.query({ groupId: meta.id });
    const result = formatSingleGroupContext(trimmed, meta, tabs);
    result.content[0].text = `Created new tab in group "${trimmed}". Tab ID: ${tab.id}\n\n` + result.content[0].text;
    return result;
  },

  async navigate(args) {
    const { url, tabId } = args;
    if (!(await isInOurGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in any MCP-managed tab group.` }] };

    if (url === "back") {
      await chrome.tabs.goBack(tabId);
    } else if (url === "forward") {
      await chrome.tabs.goForward(tabId);
    } else {
      let targetUrl = url;
      // Strip any malformed protocol prefix before normalizing
      if (!targetUrl.match(/^https?:\/\//i) && !targetUrl.startsWith("about:") && !targetUrl.startsWith("chrome:") && !targetUrl.startsWith("brave:")) {
        // Remove any partial/broken protocol prefix (e.g., "hps://", "http:/", "ht://")
        targetUrl = targetUrl.replace(/^[a-z]{1,5}:\/+/i, "");
        targetUrl = "https://" + targetUrl;
      }
      try {
        new URL(targetUrl); // Validate URL before passing to Chrome
      } catch {
        return { content: [{ type: "text", text: `Invalid URL: "${url}". Could not parse as a valid URL.` }] };
      }
      await chrome.tabs.update(tabId, { url: targetUrl });
    }

    // Wait for page load — short timeout to avoid service worker idle kill
    // If the page takes longer, the caller can use screenshot/wait to check
    await new Promise((resolve) => {
      const listener = (updatedTabId, info) => {
        if (updatedTabId === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      // 10s max — enough for most pages, avoids service worker timeout
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 10000);
    });

    const tab = await chrome.tabs.get(tabId);
    const tabs = tab.groupId !== -1
      ? await chrome.tabs.query({ groupId: tab.groupId })
      : [tab];
    const loading = tab.status !== "complete" ? " (still loading)" : "";
    const text = `Navigated to ${tab.url}${loading}.\n## Pages\n` +
      tabs.map((t, i) => `${i + 1}: ${t.url}${t.id === tabId ? " [selected]" : ""}`).join("\n");

    return { content: [{ type: "text", text }] };
  },

  async computer(args) {
    const { action, tabId } = args;
    if (!(await isInOurGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in any MCP-managed tab group.` }] };

    let coordinate = args.coordinate;
    // Resolve ref to coordinates if provided
    if (args.ref && !coordinate) {
      const coords = await resolveRefToCoordinates(tabId, args.ref);
      if (!coords) return { content: [{ type: "text", text: `Could not resolve ref "${args.ref}" to coordinates.` }] };
      coordinate = coords;
    }

    const modifiers = parseModifierString(args.modifiers);

    switch (action) {
      case "screenshot": {
        const { base64, imageId } = await takeScreenshot(tabId);
        // Get viewport dimensions for the response message
        let dims = "";
        try {
          const vp = await cdp(tabId, "Runtime.evaluate", {
            expression: "window.innerWidth + 'x' + window.innerHeight",
          });
          if (vp?.result?.value) dims = vp.result.value;
        } catch {}
        return {
          content: [
            { type: "text", text: `Successfully captured screenshot (${dims}, jpeg) - ID: ${imageId}` },
            { type: "image", data: base64, mimeType: "image/jpeg" },
          ],
        };
      }

      case "left_click": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for left_click" }] };
        await mouseClick(tabId, coordinate[0], coordinate[1], { modifiers });
        return { content: [{ type: "text", text: `Clicked at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "right_click": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for right_click" }] };
        await mouseClick(tabId, coordinate[0], coordinate[1], { button: "right", modifiers });
        return { content: [{ type: "text", text: `Right-clicked at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "double_click": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for double_click" }] };
        await mouseClick(tabId, coordinate[0], coordinate[1], { clickCount: 2, modifiers });
        return { content: [{ type: "text", text: `Double-clicked at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "triple_click": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for triple_click" }] };
        await mouseClick(tabId, coordinate[0], coordinate[1], { clickCount: 3, modifiers });
        return { content: [{ type: "text", text: `Triple-clicked at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "hover": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for hover" }] };
        await dispatchMouse(tabId, "mouseMoved", coordinate[0], coordinate[1], { modifiers });
        await sleep(200);
        return { content: [{ type: "text", text: `Hovered at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "type": {
        if (!args.text) return { content: [{ type: "text", text: "text is required for type action" }] };
        await ensureAttached(tabId);
        // Type character by character for better compatibility
        for (const char of args.text) {
          await cdp(tabId, "Input.insertText", { text: char });
          await sleep(10);
        }
        return { content: [{ type: "text", text: `Typed "${args.text.substring(0, 50)}${args.text.length > 50 ? "..." : ""}"` }] };
      }

      case "key": {
        if (!args.text) return { content: [{ type: "text", text: "text is required for key action" }] };
        await ensureAttached(tabId);
        const repeat = Math.min(args.repeat || 1, 100);
        // Parse space-separated key combos
        const keys = args.text.split(" ").filter(Boolean);
        for (let r = 0; r < repeat; r++) {
          for (const keyStr of keys) {
            const { key, modifiers: keyMod } = parseKeyCombo(keyStr);
            const resolvedKey = key.length === 1 ? key : key;
            await cdp(tabId, "Input.dispatchKeyEvent", {
              type: "keyDown",
              key: resolvedKey,
              code: resolvedKey.length === 1 ? `Key${resolvedKey.toUpperCase()}` : resolvedKey,
              modifiers: keyMod,
              windowsVirtualKeyCode: resolvedKey.charCodeAt ? resolvedKey.charCodeAt(0) : 0,
            });
            await cdp(tabId, "Input.dispatchKeyEvent", {
              type: "keyUp",
              key: resolvedKey,
              code: resolvedKey.length === 1 ? `Key${resolvedKey.toUpperCase()}` : resolvedKey,
              modifiers: keyMod,
            });
            await sleep(30);
          }
        }
        return { content: [{ type: "text", text: `Pressed ${repeat} key${repeat > 1 ? "s" : ""}: ${args.text}` }] };
      }

      case "scroll": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for scroll" }] };
        const dir = args.scroll_direction || "down";
        const amount = Math.min(args.scroll_amount || 3, 10);
        const deltaX = dir === "left" ? -amount * 100 : dir === "right" ? amount * 100 : 0;
        const deltaY = dir === "up" ? -amount * 100 : dir === "down" ? amount * 100 : 0;
        await cdp(tabId, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: coordinate[0],
          y: coordinate[1],
          deltaX,
          deltaY,
          modifiers,
        });
        await sleep(300);
        const { base64 } = await takeScreenshot(tabId);
        return {
          content: [
            { type: "text", text: `Scrolled ${dir} by ${amount} ticks at (${coordinate[0]}, ${coordinate[1]})` },
            { type: "image", data: base64, mimeType: "image/jpeg" },
          ],
        };
      }

      case "scroll_to": {
        if (!coordinate && !args.ref) return { content: [{ type: "text", text: "coordinate or ref is required for scroll_to" }] };
        if (args.ref) {
          await sendContentMessage(tabId, {
            type: "scrollToRef",
            ref: args.ref,
          });
        }
        // Scroll target element into view via JS
        if (coordinate) {
          await cdp(tabId, "Runtime.evaluate", {
            expression: `window.scrollTo(${coordinate[0]}, ${coordinate[1]})`,
          });
        }
        await sleep(300);
        return { content: [{ type: "text", text: `Scrolled to target` }] };
      }

      case "wait": {
        const duration = Math.min(args.duration || 1, 30);
        await sleep(duration * 1000);
        return { content: [{ type: "text", text: `Waited for ${duration} second${duration !== 1 ? "s" : ""}` }] };
      }

      case "left_click_drag": {
        if (!args.start_coordinate || !coordinate) {
          return { content: [{ type: "text", text: "start_coordinate and coordinate are required for left_click_drag" }] };
        }
        const [sx, sy] = args.start_coordinate;
        const [ex, ey] = coordinate;
        await dispatchMouse(tabId, "mouseMoved", sx, sy, { modifiers });
        await sleep(50);
        await dispatchMouse(tabId, "mousePressed", sx, sy, { button: "left", modifiers });
        await sleep(50);
        // Move in steps
        const steps = 10;
        for (let i = 1; i <= steps; i++) {
          const mx = sx + ((ex - sx) * i) / steps;
          const my = sy + ((ey - sy) * i) / steps;
          await dispatchMouse(tabId, "mouseMoved", mx, my, { modifiers });
          await sleep(20);
        }
        await dispatchMouse(tabId, "mouseReleased", ex, ey, { button: "left", modifiers });
        return { content: [{ type: "text", text: `Dragged from (${sx}, ${sy}) to (${ex}, ${ey})` }] };
      }

      case "zoom": {
        if (!args.region || args.region.length !== 4) {
          return { content: [{ type: "text", text: "region [x0, y0, x1, y1] is required for zoom" }] };
        }
        // Capture full screenshot then crop region
        const { base64: fullBase64 } = await takeScreenshot(tabId);
        // Return the full screenshot with region info — client can crop
        return {
          content: [
            { type: "text", text: `Zoom region: [${args.region.join(", ")}]` },
            { type: "image", data: fullBase64, mimeType: "image/png" },
          ],
        };
      }

      default:
        return { content: [{ type: "text", text: `Unknown computer action: ${action}` }] };
    }
  },

  async read_page(args) {
    const { tabId } = args;
    if (!(await isInOurGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in any MCP-managed tab group.` }] };

    const resp = await sendContentMessage(tabId, {
      type: "generateAccessibilityTree",
      options: {
        filter: args.filter,
        depth: args.depth,
        max_chars: args.max_chars,
        ref_id: args.ref_id,
      },
    });

    let tree = resp?.result || "Error: Could not generate accessibility tree";
    // Append viewport dimensions so Claude knows the coordinate space
    try {
      await ensureAttached(tabId);
      const vp = await cdp(tabId, "Runtime.evaluate", {
        expression: "window.innerWidth + 'x' + window.innerHeight",
      });
      if (vp?.result?.value) tree += `\n\nViewport: ${vp.result.value}`;
    } catch {}
    return { content: [{ type: "text", text: tree }] };
  },

  async get_page_text(args) {
    const { tabId } = args;
    if (!(await isInOurGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in any MCP-managed tab group.` }] };

    const resp = await sendContentMessage(tabId, { type: "getPageText" });
    if (!resp?.result) return { content: [{ type: "text", text: "Error: Could not extract page text" }] };

    try {
      const data = JSON.parse(resp.result);
      return {
        content: [
          {
            type: "text",
            text: `Title: ${data.title}\nURL: ${data.url}\nSource: <${data.sourceTag}>\n\n${data.text}`,
          },
        ],
      };
    } catch {
      return { content: [{ type: "text", text: resp.result }] };
    }
  },

  async find(args) {
    const { query, tabId } = args;
    if (!(await isInOurGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in any MCP-managed tab group.` }] };

    const resp = await sendContentMessage(tabId, { type: "findElements", query });
    const results = resp?.result || [];

    if (results.length === 0) {
      return { content: [{ type: "text", text: `No elements found matching "${query}"` }] };
    }

    let text = `Found ${results.length} element(s) matching "${query}":\n\n`;
    for (const r of results) {
      text += `[${r.ref}] ${r.role} "${r.name}" at (${r.coordinates[0]}, ${r.coordinates[1]})\n`;
    }

    return { content: [{ type: "text", text }] };
  },

  async form_input(args) {
    const { ref, value, tabId } = args;
    if (!(await isInOurGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in any MCP-managed tab group.` }] };

    const resp = await sendContentMessage(tabId, { type: "setFormValue", ref, value });
    const result = resp?.result;

    if (result?.error) return { content: [{ type: "text", text: `Error: ${result.error}` }] };
    return { content: [{ type: "text", text: `Set ${ref} to "${value}". Result: ${JSON.stringify(result)}` }] };
  },

  async javascript_tool(args) {
    const { text, tabId } = args;
    if (!(await isInOurGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in any MCP-managed tab group.` }] };

    await ensureAttached(tabId);
    try {
      const result = await cdp(tabId, "Runtime.evaluate", {
        expression: text,
        returnByValue: true,
        awaitPromise: true,
      });

      if (result.exceptionDetails) {
        return {
          content: [{ type: "text", text: `Error: ${result.exceptionDetails.text || JSON.stringify(result.exceptionDetails)}` }],
        };
      }

      const val = result.result;
      if (val.type === "undefined") return { content: [{ type: "text", text: "undefined" }] };
      return {
        content: [{ type: "text", text: val.value !== undefined ? JSON.stringify(val.value) : val.description || String(val) }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  },

  async read_console_messages(args) {
    const { tabId, pattern, limit = 100, onlyErrors, clear } = args;
    if (!(await isInOurGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in any MCP-managed tab group.` }] };

    // Ensure console domain is enabled
    await ensureAttached(tabId);
    await ensureDomain(tabId, "Console");
    await ensureDomain(tabId, "Runtime");

    let msgs = consoleMessages.get(tabId) || [];

    if (onlyErrors) {
      msgs = msgs.filter((m) => ["error", "exception"].includes(m.level));
    }

    if (pattern) {
      try {
        const re = new RegExp(pattern, "i");
        msgs = msgs.filter((m) => re.test(m.text) || re.test(m.level));
      } catch {
        // Invalid regex, use as substring
        msgs = msgs.filter((m) => m.text.includes(pattern));
      }
    }

    msgs = msgs.slice(-limit);

    if (clear) {
      consoleMessages.set(tabId, []);
    }

    if (msgs.length === 0) {
      return { content: [{ type: "text", text: "No console messages matching the pattern." }] };
    }

    const text = msgs
      .map((m) => `[${m.level}] ${m.text}${m.url ? ` (${m.url})` : ""}`)
      .join("\n");

    return { content: [{ type: "text", text: `Console messages (${msgs.length}):\n${text}` }] };
  },

  async read_network_requests(args) {
    const { tabId, urlPattern, limit = 100, clear } = args;
    if (!(await isInOurGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in any MCP-managed tab group.` }] };

    // Ensure network domain is enabled
    await ensureAttached(tabId);
    await ensureDomain(tabId, "Network");

    let reqs = networkRequests.get(tabId) || [];

    if (urlPattern) {
      reqs = reqs.filter((r) => r.url.includes(urlPattern));
    }

    reqs = reqs.slice(-limit);

    if (clear) {
      networkRequests.set(tabId, []);
    }

    if (reqs.length === 0) {
      return { content: [{ type: "text", text: "No network requests matching the pattern." }] };
    }

    const text = reqs
      .map((r) => `${r.method} ${r.url} ${r.status ? `→ ${r.status}` : "(pending)"}${r.mimeType ? ` [${r.mimeType}]` : ""}`)
      .join("\n");

    return { content: [{ type: "text", text: `Network requests (${reqs.length}):\n${text}` }] };
  },

  async resize_window(args) {
    const { width, height, tabId } = args;
    if (!(await isInOurGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in any MCP-managed tab group.` }] };

    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { width, height });
    return { content: [{ type: "text", text: `Resized window to ${width}x${height}` }] };
  },

  async upload_image(args) {
    const { imageId, tabId, ref, coordinate, filename = "image.png" } = args;
    if (!(await isInOurGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in any MCP-managed tab group.` }] };

    const base64 = screenshotStore.get(imageId);
    if (!base64) {
      return { content: [{ type: "text", text: `Image ${imageId} not found. Take a screenshot first.` }] };
    }

    // Use CDP to set file input
    if (ref) {
      // Find the element and set its files via CDP
      await ensureAttached(tabId);
      const result = await cdp(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const el = window.__unblockedChrome?.resolveRef?.("${ref}");
          if (!el) return null;
          return el.tagName.toLowerCase();
        })()`,
        returnByValue: true,
      });

      if (result.result?.value === "input") {
        // For file inputs, we need DOM.setFileInputFiles via CDP
        // First get the node
        const doc = await cdp(tabId, "DOM.getDocument", {});
        const nodeResult = await cdp(tabId, "Runtime.evaluate", {
          expression: `(() => {
            const el = window.__unblockedChrome?.resolveRef?.("${ref}");
            if (el) el.scrollIntoView();
            return true;
          })()`,
          returnByValue: true,
        });
        return { content: [{ type: "text", text: `Upload via file input requires a temporary file. Use the file input directly.` }] };
      }
    }

    return { content: [{ type: "text", text: `Image upload for ref=${ref}, coordinate=${coordinate} — use drag & drop or file input.` }] };
  },

  async gif_creator(args) {
    return { content: [{ type: "text", text: "GIF recording is not yet implemented in this extension." }] };
  },

  async shortcuts_list(args) {
    return { content: [{ type: "text", text: "No shortcuts available. Shortcuts are not supported in this extension." }] };
  },

  async shortcuts_execute(args) {
    return { content: [{ type: "text", text: "Shortcuts are not supported in this extension." }] };
  },

  async switch_browser(args) {
    return { content: [{ type: "text", text: "Browser switching is not yet supported. The extension connects to whichever browser has it loaded (Chrome, Brave, or Edge). To switch, disable the extension in the current browser, enable it in the target browser, and restart both." }] };
  },

  async update_plan(args) {
    const { domains, approach } = args;
    let text = `Plan:\n\nDomains: ${domains.join(", ")}\n\nApproach:\n`;
    for (const step of approach) {
      text += `- ${step}\n`;
    }
    text += "\nPlan auto-approved (no permission restrictions in this extension).";
    return { content: [{ type: "text", text }] };
  },
};

// --- Tool dispatch ---
async function handleToolRequest(id, tool, args) {
  // Block until persisted multi-group state is loaded so handlers see the right Map.
  if (stateLoaded) {
    try { await stateLoaded; } catch {}
  }
  const handler = toolHandlers[tool];
  if (!handler) {
    sendError(id, `Unknown tool: ${tool}`);
    return;
  }

  try {
    const result = await handler(args);
    sendResponse(id, result);
  } catch (err) {
    sendError(id, `${tool} failed: ${err.message}`);
  }
}

// --- Init ---

stateLoaded = loadGroupsState();
stateLoaded.then(connectNativeHost);
