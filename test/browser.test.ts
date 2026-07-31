import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireProfileLock,
  DEFAULT_MAC_PROFILE_DIR,
  DEFAULT_MAC_SANDBOX_PROFILE_DIR,
  initializeSingleContextPage,
  macChromeChildEnvironment,
  macChromeLaunchOptions,
  prepareProfileDirectory,
  resolveMacProfileDir
} from "../src/runner/browser.js";
import {
  assertLiveAdapterReady,
  localRunnerMode,
  runnerExitCode,
  singleContextPage,
  takeLiveCapabilityKey,
  waitForProfileReviewIfRequired,
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

test("Chrome child environment excludes controller and capability secrets", () => {
  const child = macChromeChildEnvironment({
    PATH: "/usr/bin:/bin",
    LANG: "zh_CN.UTF-8",
    TICKET_AGENT_TOKEN: "controller-secret",
    TICKET_AGENT_CAPABILITY_KEY: "capability-secret"
  });
  assert.deepEqual(child, {
    PATH: "/usr/bin:/bin",
    LANG: "zh_CN.UTF-8"
  });
  const launch = macChromeLaunchOptions({ profileScope: "sandbox" });
  assert.equal(launch.env?.TICKET_AGENT_TOKEN, undefined);
  assert.equal(launch.env?.TICKET_AGENT_CAPABILITY_KEY, undefined);
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
  const firstRelease = first.release();
  const concurrentRelease = first.release();
  assert.strictEqual(concurrentRelease, firstRelease);
  await Promise.all([firstRelease, concurrentRelease]);
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

test("runner topology assertion reuses exactly one live page without creating replacements", async () => {
  const existing = { id: "existing", isClosed: () => false };
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
      pages: () => [existing, { id: "restored-extra", isClosed: () => false }],
      newPage: async () => ({ id: "unexpected" })
    } as never),
    /SINGLE_PAGE_CONTEXT_REQUIRED/
  );
  await assert.rejects(
    () => singleContextPage({
      pages: () => [{ id: "closed", isClosed: () => true }]
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
  await assert.rejects(() => singleContextPage(empty as never), /SINGLE_PAGE_CONTEXT_REQUIRED/);
  assert.equal(created.length, 0);
  assert.equal(newPageCount, 0);
});

test("runner replaces one restored persistent page before official navigation", async () => {
  const pages: unknown[] = [];
  let restoredClosed = false;
  const restored = {
    url: () => "about:blank",
    isClosed: () => restoredClosed,
    close: async () => {
      restoredClosed = true;
      const index = pages.indexOf(restored);
      if (index >= 0) pages.splice(index, 1);
    }
  };
  const fresh = {
    isClosed: () => false,
    close: async () => undefined
  };
  pages.push(restored);
  const context = {
    pages: () => pages,
    newPage: async () => {
      pages.push(fresh);
      return fresh;
    }
  };

  assert.equal(await initializeSingleContextPage(context as never), fresh);
  assert.equal(restoredClosed, true);
  assert.deepEqual(pages, [fresh]);
});

test("runner creates one fresh page when a persistent context restores none", async () => {
  const pages: unknown[] = [];
  const fresh = {
    isClosed: () => false,
    close: async () => undefined
  };
  let newPageCount = 0;
  const context = {
    pages: () => pages,
    newPage: async () => {
      newPageCount += 1;
      pages.push(fresh);
      return fresh;
    }
  };

  assert.equal(await initializeSingleContextPage(context as never), fresh);
  assert.equal(newPageCount, 1);
  assert.deepEqual(pages, [fresh]);
});

test("runner requires review for multiple restored pages before creating or closing any page", async () => {
  let closeCount = 0;
  let newPageCount = 0;
  const restored = [1, 2].map((id) => ({
    id,
    isClosed: () => false,
    close: async () => {
      closeCount += 1;
    }
  }));
  await assert.rejects(
    () => initializeSingleContextPage({
      pages: () => restored,
      newPage: async () => {
        newPageCount += 1;
        return restored[0];
      }
    } as never),
    /RESTORED_PAGE_REVIEW_REQUIRED/
  );
  assert.equal(newPageCount, 0);
  assert.equal(closeCount, 0);
});

test("runner tolerates the sole restored page closing while a fresh page opens", async () => {
  const pages: unknown[] = [];
  let restoredClosed = false;
  const restored = {
    url: () => "about:blank",
    isClosed: () => restoredClosed,
    close: async () => {
      throw new Error("unexpected close call");
    }
  };
  const fresh = {
    isClosed: () => false,
    close: async () => undefined
  };
  pages.push(restored);
  const context = {
    pages: () => pages,
    newPage: async () => {
      restoredClosed = true;
      pages.splice(0, pages.length, fresh);
      return fresh;
    }
  };

  assert.equal(await initializeSingleContextPage(context as never), fresh);
  assert.deepEqual(pages, [fresh]);
});

test("runner leaves the restored page untouched when fresh page creation fails", async () => {
  let closeCount = 0;
  const restored = {
    url: () => "about:blank",
    isClosed: () => false,
    close: async () => {
      closeCount += 1;
    }
  };
  await assert.rejects(
    () => initializeSingleContextPage({
      pages: () => [restored],
      newPage: async () => {
        throw new Error("browser closed");
      }
    } as never),
    /SINGLE_PAGE_CONTEXT_REQUIRED/
  );
  assert.equal(closeCount, 0);
});

test("runner fails closed when the restored page cannot be closed", async () => {
  const pages: unknown[] = [];
  const restored = {
    url: () => "about:blank",
    isClosed: () => false,
    close: async () => {
      throw new Error("close blocked");
    }
  };
  const fresh = {
    isClosed: () => false,
    close: async () => undefined
  };
  pages.push(restored);
  await assert.rejects(
    () => initializeSingleContextPage({
      pages: () => pages,
      newPage: async () => {
        pages.push(fresh);
        return fresh;
      }
    } as never),
    /SINGLE_PAGE_CONTEXT_REQUIRED/
  );
  assert.deepEqual(pages, [restored, fresh]);
});

test("runner preserves a non-empty restored page unless a no-submit sandbox explicitly replaces it", async () => {
  let newPageCount = 0;
  let closeCount = 0;
  const blockedRestored = {
    url: () => "https://buy.damai.cn/order/unknown",
    isClosed: () => false,
    close: async () => {
      closeCount += 1;
    }
  };
  await assert.rejects(
    () => initializeSingleContextPage({
      pages: () => [blockedRestored],
      newPage: async () => {
        newPageCount += 1;
        return blockedRestored;
      }
    } as never),
    /RESTORED_PAGE_REVIEW_REQUIRED/
  );
  assert.equal(newPageCount, 0);
  assert.equal(closeCount, 0);

  const pages: unknown[] = [];
  let sandboxClosed = false;
  const sandboxRestored = {
    url: () => "https://detail.damai.cn/item.htm?id=stale",
    isClosed: () => sandboxClosed,
    close: async () => {
      sandboxClosed = true;
      pages.splice(pages.indexOf(sandboxRestored), 1);
    }
  };
  const fresh = {
    url: () => "about:blank",
    isClosed: () => false,
    close: async () => undefined
  };
  pages.push(sandboxRestored);
  assert.equal(await initializeSingleContextPage({
    pages: () => pages,
    newPage: async () => {
      pages.push(fresh);
      return fresh;
    }
  } as never, { allowNonEmptyRestored: true }), fresh);
  assert.equal(sandboxClosed, true);
  assert.deepEqual(pages, [fresh]);
});

test("runner rejects a closed fresh page or an unexpected late extra page", async () => {
  const closedFresh = {
    isClosed: () => true,
    close: async () => undefined
  };
  const closedPages: unknown[] = [];
  await assert.rejects(
    () => initializeSingleContextPage({
      pages: () => closedPages,
      newPage: async () => {
        closedPages.push(closedFresh);
        return closedFresh;
      }
    } as never),
    /SINGLE_PAGE_CONTEXT_REQUIRED/
  );

  const pages: unknown[] = [];
  const fresh = {
    isClosed: () => false,
    close: async () => undefined
  };
  const extra = {
    isClosed: () => false,
    close: async () => undefined
  };
  await assert.rejects(
    () => initializeSingleContextPage({
      pages: () => pages,
      newPage: async () => {
        pages.push(fresh, extra);
        return fresh;
      }
    } as never),
    /SINGLE_PAGE_CONTEXT_REQUIRED/
  );
  assert.deepEqual(pages, [fresh, extra]);
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

test("profile topology review waits only for exact live-profile review errors", async () => {
  const context = { marker: "visible-context" };
  const notices: string[] = [];
  let waits = 0;
  const wait = async (received: unknown): Promise<void> => {
    assert.equal(received, context);
    waits += 1;
  };
  const notify = (message: string): void => { notices.push(message); };

  await waitForProfileReviewIfRequired(
    context as never,
    new Error("RESTORED_PAGE_REVIEW_REQUIRED"),
    wait as never,
    notify
  );
  await waitForProfileReviewIfRequired(
    context as never,
    new Error("SINGLE_PAGE_CONTEXT_REQUIRED"),
    wait as never,
    notify
  );
  await waitForProfileReviewIfRequired(
    context as never,
    new Error("unrelated failure"),
    wait as never,
    notify
  );

  assert.equal(waits, 1);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /RESTORED_PAGE_REVIEW_REQUIRED/);
});

test("browser-context closure is a nonzero CLI result while ordinary calibration remains reviewable", () => {
  assert.equal(runnerExitCode({
    state: "PAGE_CHANGED",
    message: "BROWSER_CONTEXT_CLOSED:prewarm"
  } as never), 1);
  assert.equal(runnerExitCode({
    state: "PAGE_CHANGED",
    message: "A verified visible total was not returned"
  } as never), 0);
  assert.equal(runnerExitCode({
    state: "REVIEW_REQUIRED",
    message: "Dry-run complete"
  } as never), 0);
});
