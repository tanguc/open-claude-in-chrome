import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const scratch = fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "ocic-test-"));
const env = { ...process.env, HOME: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch };

try {
  for (const dir of ["test", "host/test"]) {
    const files = fs.readdirSync(path.join(root, dir)).filter((file) => file.endsWith(".test.mjs")).sort();
    for (const file of files) {
      console.log(`\nTEST ${dir}/${file}`);
      const result = spawnSync(process.execPath, [path.join(root, dir, file)], {
        cwd: root, env, stdio: "inherit", timeout: 120000
      });
      if (result.error || result.status !== 0) {
        if (result.error) console.error(result.error.message);
        process.exitCode = result.status || 1;
        break;
      }
    }
    if (process.exitCode) break;
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
