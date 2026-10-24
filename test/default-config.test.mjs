import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import * as humanize from "../extension/humanize/index.js";
import { BACKGROUND, compile, extractFunction } from "./_extract.mjs";

const source = fs.readFileSync(BACKGROUND, "utf8");
const start = source.indexOf("const CONFIG_KEY =");
const end = source.indexOf("\n/**\n * Execute a humanize plan", start);
assert(start >= 0 && end > start, "configuration section is present");

function fixture({ local = {}, session = {}, storageError = false } = {}) {
  const listeners = [];
  const writes = [];
  const audits = [];
  const chrome = { storage: {
    local: {
      async get() {
        if (storageError) throw new Error("storage unavailable");
        return { ocic_config_v1: local };
      },
      async set(value) { writes.push(value); }
    },
    session: {
      async get() { return { ocic_tab_config_v1: session }; },
      async set(value) { writes.push(value); }
    },
    onChanged: { addListener(listener) { listeners.push(listener); } }
  } };
  const config = compile(source.slice(start, end), {
    chrome, audit: { setEnabled(value) { audits.push(value); } }
  }, "({ ready: configHydrated, effectiveConfig, writeConfig, humanizeOn, defaults: DEFAULT_CONFIG })");
  return { ...config, listeners, writes, audits };
}

test("fresh startup enables natural humanization without enabling audits", async () => {
  const f = fixture();
  assert.equal(f.effectiveConfig(1).humanize, true);
  assert.equal(f.effectiveConfig(1).humanize_speed, "natural");
  await f.ready;
  assert.equal(await f.humanizeOn(1), true);
  assert.equal(f.effectiveConfig(1).audit_mode, "off");
  assert.deepEqual(f.audits, [false]);
  assert.deepEqual(f.writes, []);
});

test("storage failure leaves the source defaults intact", async () => {
  const f = fixture({ storageError: true });
  await f.ready;
  assert.equal(f.effectiveConfig(1).humanize, true);
  assert.equal(f.effectiveConfig(1).humanize_speed, "natural");
});

test("partial stored configuration inherits the natural defaults", async () => {
  const f = fixture({ local: { humanize_seed: 42 } });
  await f.ready;
  assert.equal(f.effectiveConfig(1).humanize, true);
  assert.equal(f.effectiveConfig(1).humanize_speed, "natural");
  assert.equal(f.effectiveConfig(1).humanize_seed, 42);
});

test("explicit stored global and per-tab choices are preserved", async () => {
  const f = fixture({
    local: { humanize: false, humanize_speed: "fast" },
    session: { 7: { humanize: true, humanize_speed: "relaxed" } }
  });
  await f.ready;
  assert.equal(await f.humanizeOn(1), false);
  assert.equal(f.effectiveConfig(1).humanize_speed, "fast");
  assert.equal(await f.humanizeOn(7), true);
  assert.equal(f.effectiveConfig(7).humanize_speed, "relaxed");
  assert.deepEqual(f.writes, []);
});

test("partial live storage changes retain all source defaults", async () => {
  const f = fixture();
  await f.ready;
  f.listeners[0]({ ocic_config_v1: { newValue: { humanize: false } } }, "local");
  assert.equal(await f.humanizeOn(1), false);
  assert.equal(f.effectiveConfig(1).humanize_speed, "natural");
  f.listeners[0]({ ocic_config_v1: {} }, "local");
  assert.equal(await f.humanizeOn(1), true);
  assert.equal(f.effectiveConfig(1).humanize_speed, "natural");
});

test("clearing global and per-tab values restores natural defaults", async () => {
  const f = fixture();
  await f.ready;
  await f.writeConfig("humanize", false);
  await f.writeConfig("humanize_speed", "fast");
  await f.writeConfig("humanize", null);
  await f.writeConfig("humanize_speed", null);
  assert.equal(await f.humanizeOn(1), true);
  assert.equal(f.effectiveConfig(1).humanize_speed, "natural");
  await f.writeConfig("humanize", false, 1);
  await f.writeConfig("humanize", null, 1);
  assert.equal(await f.humanizeOn(1), true);
});

test("the planner and worker fallback use the natural tempo", () => {
  assert.equal(humanize.DEFAULT_TEMPO, "natural");
  assert.equal(humanize.createSession(42).tempo, humanize.TEMPOS.natural);
  assert.equal(humanize.createSession(42, "invalid").tempo, humanize.TEMPOS.natural);
  const hand = compile(`let humanSession = null; let humanSessionSeed = null; ${extractFunction("human")}`,
    { humanize }, "human");
  assert.equal(hand(undefined, 42).tempo, humanize.TEMPOS.natural);
  assert.equal(hand("fast", 42).tempo, humanize.TEMPOS.fast);
});
