import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireProfileLock,
  DEFAULT_MAC_PROFILE_DIR,
  DEFAULT_MAC_SANDBOX_PROFILE_DIR,
  macChromeLaunchOptions,
  prepareProfileDirectory,
  resolveMacProfileDir
} from "../src/runner/browser.js";
import { assertLiveAdapterReady } from "../src/runner/cli.js";

test("live and non-live browser modes use separate profiles", () => {
  assert.notEqual(DEFAULT_MAC_PROFILE_DIR, DEFAULT_MAC_SANDBOX_PROFILE_DIR);
  const live = macChromeLaunchOptions({ profileScope: "live" });
  const sandbox = macChromeLaunchOptions({ profileScope: "sandbox" });
  assert.notEqual(live.userDataDir.toLowerCase(), sandbox.userDataDir.toLowerCase());
  assert.throws(
    () => resolveMacProfileDir(live.userDataDir, "sandbox"),
    /same or nested/
  );
  assert.throws(
    () => resolveMacProfileDir(path.parse(os.homedir()).root, "live"),
    /normal Chrome directory/
  );
  assert.throws(
    () => resolveMacProfileDir(path.join(os.homedir(), "Library", "Application Support"), "live"),
    /normal Chrome directory/
  );
  assert.throws(
    () => macChromeLaunchOptions({ profileScope: "live", headless: true }),
    /LIVE_HEADLESS_BLOCKED/
  );
  assert.doesNotThrow(() => macChromeLaunchOptions({ profileScope: "sandbox", headless: true }));
});

test("live and sandbox profiles cannot be parent and child directories", () => {
  const previousLive = process.env.TICKET_AGENT_PROFILE;
  const previousSandbox = process.env.TICKET_AGENT_SANDBOX_PROFILE;
  const root = path.join(os.tmpdir(), "TicketAgent-Nested-Test");
  try {
    process.env.TICKET_AGENT_PROFILE = path.join(root, "Live");
    process.env.TICKET_AGENT_SANDBOX_PROFILE = path.join(root, "Live", "Sandbox");
    assert.throws(() => resolveMacProfileDir(undefined, "live"), /same or nested/);
    assert.throws(() => resolveMacProfileDir(undefined, "sandbox"), /same or nested/);
  } finally {
    if (previousLive === undefined) delete process.env.TICKET_AGENT_PROFILE;
    else process.env.TICKET_AGENT_PROFILE = previousLive;
    if (previousSandbox === undefined) delete process.env.TICKET_AGENT_SANDBOX_PROFILE;
    else process.env.TICKET_AGENT_SANDBOX_PROFILE = previousSandbox;
  }
});

test("profile preparation rejects symlinks and restricts permissions", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ticket-agent-profile-"));
  context.after(async () => fs.rm(root, { recursive: true, force: true }));

  const profile = path.join(root, "profile");
  await fs.mkdir(profile, { mode: 0o755 });
  await prepareProfileDirectory(profile);
  const mode = (await fs.stat(profile)).mode & 0o777;
  assert.equal(mode, 0o700);

  const real = path.join(root, "real");
  const linked = path.join(root, "linked");
  await fs.mkdir(real);
  await fs.symlink(real, linked, "dir");
  await assert.rejects(() => prepareProfileDirectory(path.join(linked, "nested")), /PROFILE_SYMLINK_BLOCKED/);
});

test("profile lock is exclusive, releasable, and idempotent", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ticket-agent-lock-"));
  context.after(async () => fs.rm(root, { recursive: true, force: true }));

  const first = await acquireProfileLock(root);
  await assert.rejects(() => acquireProfileLock(root), /PROFILE_IN_USE/);
  await first.release();
  await first.release();

  const second = await acquireProfileLock(root);
  await second.release();
});

test("CLI blocks live mode until an adapter is explicitly live-ready", () => {
  assert.throws(() => assertLiveAdapterReady("live", { platform: "damai" }), /LIVE_ADAPTER_NOT_READY:damai/);
  assert.throws(() => assertLiveAdapterReady("live", { platform: "maoyan" }), /LIVE_ADAPTER_NOT_READY:maoyan/);
  assert.doesNotThrow(() => assertLiveAdapterReady("mock", { platform: "damai" }));
  assert.doesNotThrow(() => assertLiveAdapterReady("dry-run", { platform: "damai" }));
  assert.doesNotThrow(() => assertLiveAdapterReady("rehearsal", { platform: "damai" }));
  assert.throws(
    () => assertLiveAdapterReady("rehearsal", { platform: "maoyan" }),
    /REHEARSAL_ADAPTER_NOT_READY:maoyan/
  );
});
