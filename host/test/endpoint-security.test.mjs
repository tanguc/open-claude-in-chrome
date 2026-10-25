import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ensureSocketDir, secureSocket, socketDir } from "../endpoint.js";

function fixture(run) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-endpoint-"));
  const userInfo = os.userInfo;
  const home = process.env.HOME;
  const pipe = process.env.OCIC_PIPE;
  os.userInfo = () => ({ ...userInfo(), uid: `test-${path.basename(scratch)}` });
  process.env.HOME = scratch;
  delete process.env.OCIC_PIPE;
  const dir = socketDir();
  let owned = false;
  try {
    assert.throws(() => fs.lstatSync(dir), { code: "ENOENT" }, "do not touch a pre-existing socket directory");
    owned = true;
    run({ scratch, dir });
  } finally {
    os.userInfo = userInfo;
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    if (pipe === undefined) delete process.env.OCIC_PIPE;
    else process.env.OCIC_PIPE = pipe;
    if (owned) fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

const posixOnly = { skip: process.platform === "win32" };

test("default rendezvous directory is private and socket permissions are restricted", posixOnly, () => fixture(({ dir }) => {
  ensureSocketDir();
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(dir).uid, process.getuid());
  const file = path.join(dir, "mode-check");
  fs.writeFileSync(file, "", { mode: 0o644 });
  secureSocket(file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
}));

test("a symlink cannot redirect default directory permission changes", posixOnly, () => fixture(({ scratch, dir }) => {
  const target = path.join(scratch, "target");
  fs.mkdirSync(target, { mode: 0o755 });
  fs.symlinkSync(target, dir);
  const before = fs.statSync(target).mode;
  assert.throws(() => ensureSocketDir(), /Unsafe browser bridge directory/);
  assert.equal(fs.statSync(target).mode, before);
}));

test("a default directory owned by another user fails closed before chmod", posixOnly, () => fixture(({ dir }) => {
  fs.mkdirSync(dir, { mode: 0o755 });
  const before = fs.statSync(dir).mode;
  const lstat = fs.lstatSync;
  fs.lstatSync = (file, ...args) => {
    const stat = lstat(file, ...args);
    if (file === dir) stat.uid = process.getuid() + 1;
    return stat;
  };
  try {
    assert.throws(() => ensureSocketDir(), /Unsafe browser bridge directory/);
    assert.equal(fs.statSync(dir).mode, before);
  } finally {
    fs.lstatSync = lstat;
  }
}));

test("an explicit test pipe does not touch the live default directory", posixOnly, () => fixture(({ scratch, dir }) => {
  process.env.OCIC_PIPE = path.join(scratch, "explicit.sock");
  ensureSocketDir();
  assert.equal(fs.existsSync(dir), false);
}));

test("a configured pipe does not create an unrelated default directory", posixOnly, () => fixture(({ scratch, dir }) => {
  const config = path.join(scratch, ".config", "open-claude-in-chrome");
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, "config.json"), JSON.stringify({ pipe: path.join(scratch, "configured.sock") }));
  ensureSocketDir();
  assert.equal(fs.existsSync(dir), false);
}));
