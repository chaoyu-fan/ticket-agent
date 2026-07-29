import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = path.resolve("scripts/setup-macos.sh");

function runSetup(live: string, sandbox: string) {
  return spawnSync("bash", [script], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      TICKET_AGENT_CHROME: process.execPath,
      TICKET_AGENT_PROFILE: live,
      TICKET_AGENT_SANDBOX_PROFILE: sandbox
    }
  });
}

test("macOS preflight rejects nested, broad, and symlinked profile paths without creating them", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ticket-agent-setup-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  const live = path.join(root, "live");
  const sandbox = path.join(root, "sandbox");
  const valid = runSetup(live, sandbox);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(existsSync(live), false);
  assert.equal(existsSync(sandbox), false);

  const nested = runSetup(live, path.join(live, "sandbox"));
  assert.equal(nested.status, 1);
  assert.match(nested.stderr, /彼此隔离/);

  const broad = runSetup(path.join(os.homedir(), "Library", "Application Support", "Google"), sandbox);
  assert.equal(broad.status, 1);
  assert.match(broad.stderr, /日常 Chrome/);

  const real = path.join(root, "real");
  const linked = path.join(root, "linked");
  mkdirSync(real);
  symlinkSync(real, linked, "dir");
  const symlinked = runSetup(linked, sandbox);
  assert.equal(symlinked.status, 1);
  assert.match(symlinked.stderr, /符号链接/);
});
