import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("POSIX installation keeps the host and its ESM dependencies off the source volume", {
  skip: process.platform === "win32"
}, () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-install-"));
  try {
    const repo = path.join(scratch, "source");
    const home = path.join(scratch, "home");
    fs.mkdirSync(path.join(repo, "host", "node_modules"), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.copyFileSync(path.join(root, "install.sh"), path.join(repo, "install.sh"));
    for (const file of ["native-host.js", "endpoint.js", "package.json"]) {
      fs.copyFileSync(path.join(root, "host", file), path.join(repo, "host", file));
    }
    const browsers = process.platform === "darwin"
      ? ["Library/Application Support/Google/Chrome", "Library/Application Support/Microsoft Edge", "Library/Application Support/BraveSoftware/Brave-Browser"]
      : [".config/google-chrome", ".config/microsoft-edge", ".config/BraveSoftware/Brave-Browser"];
    for (const browser of browsers) fs.mkdirSync(path.join(home, browser), { recursive: true });
    const env = { ...process.env, HOME: home, TMPDIR: scratch, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` };
    const installed = spawnSync("bash", [path.join(repo, "install.sh"), "a".repeat(32)], {
      cwd: scratch, env, encoding: "utf8", timeout: 10000
    });
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    const destination = path.join(home, process.platform === "darwin"
      ? "Library/Application Support/open-claude-in-chrome"
      : ".local/share/open-claude-in-chrome");
    const wrapper = path.join(destination, "native-host-wrapper.sh");
    assert(fs.existsSync(path.join(destination, "native-host.js")));
    assert(fs.existsSync(path.join(destination, "endpoint.js")));
    assert.equal(JSON.parse(fs.readFileSync(path.join(destination, "package.json"), "utf8")).type, "module");
    assert(fs.statSync(wrapper).mode & 0o100);
    assert(!fs.readFileSync(wrapper, "utf8").includes(repo));
    for (const browser of browsers) {
      const manifest = JSON.parse(fs.readFileSync(path.join(home, browser, "NativeMessagingHosts", "com.anthropic.open_claude_in_chrome.json"), "utf8"));
      assert.equal(manifest.path, wrapper);
      assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${"a".repeat(32)}/`]);
    }
    const launched = spawnSync(wrapper, [], {
      cwd: scratch, env: { ...env, OCIC_PIPE: path.join(scratch, "bridge.sock") },
      input: "", encoding: "utf8", timeout: 10000
    });
    assert.equal(launched.status, 0, launched.stderr);
    assert.doesNotMatch(launched.stderr, /ERR_MODULE_NOT_FOUND|SyntaxError/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
