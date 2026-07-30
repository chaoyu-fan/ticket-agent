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
import {
  assertLiveAdapterReady,
  localRunnerMode,
  singleContextPage,
  takeLiveCapabilityKey,
  waitForVisibleLoginSession
} from "../src/runner/cli.js";

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
  assert.throws(() => assertLiveAdapterReady("live", { platform: "damai" }), /LIVE_FAST_PATH_NOT_READY:damai/);
  assert.throws(() => assertLiveAdapterReady("live", { platform: "maoyan" }), /LIVE_FAST_PATH_NOT_READY:maoyan/);
  assert.doesNotThrow(() => assertLiveAdapterReady("mock", { platform: "damai" }));
  assert.doesNotThrow(() => assertLiveAdapterReady("dry-run", { platform: "damai" }));
  assert.doesNotThrow(() => assertLiveAdapterReady("rehearsal", { platform: "damai" }));
  assert.throws(
    () => assertLiveAdapterReady("rehearsal", { platform: "maoyan" }),
    /REHEARSAL_ADAPTER_NOT_READY:maoyan/
  );
});

test("live CLI takes a separate capability key once and removes the environment entry", () => {
  const secret = "runner-capability-key-at-least-thirty-two-bytes";
  const environment: NodeJS.ProcessEnv = {
    TICKET_AGENT_CAPABILITY_KEY: secret,
    TICKET_AGENT_TOKEN: "controller-token-at-least-thirty-two-bytes"
  };
  const key = takeLiveCapabilityKey(environment);
  assert.equal(Buffer.from(key).toString("utf8"), secret);
  assert.equal(environment.TICKET_AGENT_CAPABILITY_KEY, undefined);
  key.fill(0);

  const short: NodeJS.ProcessEnv = { TICKET_AGENT_CAPABILITY_KEY: "short" };
  assert.throws(() => takeLiveCapabilityKey(short), /LIVE_CAPABILITY_KEY_INVALID/);
  assert.equal(short.TICKET_AGENT_CAPABILITY_KEY, undefined);

  const reused = "same-controller-and-capability-key-at-least-thirty-two-bytes";
  const same: NodeJS.ProcessEnv = {
    TICKET_AGENT_CAPABILITY_KEY: reused,
    TICKET_AGENT_TOKEN: reused
  };
  assert.throws(() => takeLiveCapabilityKey(same), /LIVE_CAPABILITY_KEY_MUST_DIFFER_FROM_TOKEN/);
  assert.equal(same.TICKET_AGENT_CAPABILITY_KEY, undefined);
});

test("production live mode cannot fall back to LocalRunner", () => {
  assert.throws(() => localRunnerMode("live"), /LIVE_LOCAL_RUNNER_FALLBACK_BLOCKED/);
  assert.equal(localRunnerMode("rehearsal"), "rehearsal");
  assert.equal(localRunnerMode("mock"), "mock");
  assert.equal(localRunnerMode("dry-run"), "dry-run");
});

test("runner reuses one persistent page and rejects restored multi-page contexts", async () => {
  const existing = { id: "existing" };
  let newPageCount = 0;
  const onePage = {
    pages: () => [existing],
    newPage: async () => {
      newPageCount += 1;
      return { id: "unexpected" };
    }
  };
  assert.equal(await singleContextPage(onePage as never), existing);
  assert.equal(newPageCount, 0);

  await assert.rejects(
    () => singleContextPage({
      pages: () => [existing, { id: "restored-extra" }],
      newPage: async () => ({ id: "unexpected" })
    } as never),
    /SINGLE_PAGE_CONTEXT_REQUIRED/
  );

  const created: unknown[] = [];
  const empty = {
    pages: () => created,
    newPage: async () => {
      const page = { id: "created" };
      created.push(page);
      return page;
    }
  };
  assert.equal(await singleContextPage(empty as never), created[0]);
  assert.equal(created.length, 1);
});

test("visible-session wait resolves when Chrome closed before listener registration", async () => {
  let closeListeners = 0;
  const alreadyClosed = {
    once: (event: string) => {
      if (event === "close") closeListeners += 1;
      return alreadyClosed;
    },
    off: (event: string) => {
      if (event === "close") closeListeners -= 1;
      return alreadyClosed;
    },
    pages: () => [],
    browser: () => ({ isConnected: () => false })
  };
  await waitForVisibleLoginSession(alreadyClosed as never);
  assert.equal(closeListeners, 0);
});
