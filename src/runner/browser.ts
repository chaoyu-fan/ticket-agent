import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { FileHandle } from "node:fs/promises";
import type { BrowserContext, BrowserType } from "playwright-core";

type PersistentContextOptions = NonNullable<Parameters<BrowserType["launchPersistentContext"]>[1]>;

export const DEFAULT_MAC_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const DEFAULT_MAC_PROFILE_DIR = path.join("Library", "Application Support", "TicketAgent", "ChromeProfile");
export const DEFAULT_MAC_SANDBOX_PROFILE_DIR = path.join(
  "Library",
  "Application Support",
  "TicketAgent",
  "SandboxChromeProfile"
);
export const PROFILE_LOCK_NAME = ".ticket-agent.runner.lock";

export type BrowserProfileScope = "live" | "sandbox";

export interface MacChromeOptions {
  executablePath?: string;
  profileDir?: string;
  profileScope?: BrowserProfileScope;
  headless?: boolean;
}

export interface ProfileLock {
  readonly profileDir: string;
  readonly lockPath: string;
  release(): Promise<void>;
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function resolveMacChromePath(value = process.env.TICKET_AGENT_CHROME): string {
  return expandHome(value?.trim() || DEFAULT_MAC_CHROME_PATH);
}

function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function overlappingPaths(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left).toLowerCase();
  const normalizedRight = path.resolve(right).toLowerCase();
  return containsPath(normalizedLeft, normalizedRight) || containsPath(normalizedRight, normalizedLeft);
}

function configuredProfile(scope: BrowserProfileScope): string | undefined {
  return scope === "live" ? process.env.TICKET_AGENT_PROFILE : process.env.TICKET_AGENT_SANDBOX_PROFILE;
}

export function resolveMacProfileDir(
  value?: string,
  scope: BrowserProfileScope = "live"
): string {
  const fallback = scope === "live" ? DEFAULT_MAC_PROFILE_DIR : DEFAULT_MAC_SANDBOX_PROFILE_DIR;
  const configured = expandHome(value?.trim() || configuredProfile(scope)?.trim() || path.join("~", fallback));
  const resolved = path.resolve(configured);
  const normalChrome = path.resolve(os.homedir(), "Library", "Application Support", "Google", "Chrome");
  if (overlappingPaths(resolved, normalChrome)) {
    throw new Error("PROFILE_BLOCKED:profile must not contain, equal, or be inside the normal Chrome directory");
  }
  const otherConfigured = expandHome(
    scope === "live"
      ? process.env.TICKET_AGENT_SANDBOX_PROFILE?.trim() || path.join("~", DEFAULT_MAC_SANDBOX_PROFILE_DIR)
      : process.env.TICKET_AGENT_PROFILE?.trim() || path.join("~", DEFAULT_MAC_PROFILE_DIR)
  );
  if (overlappingPaths(resolved, otherConfigured)) {
    throw new Error("PROFILE_BLOCKED:sandbox and live profiles must not be the same or nested");
  }
  return resolved;
}

export function macChromeLaunchOptions(options: MacChromeOptions = {}): PersistentContextOptions & { userDataDir: string } {
  const profileScope = options.profileScope ?? "live";
  if (profileScope === "live" && options.headless === true) {
    throw new Error("LIVE_HEADLESS_BLOCKED:live runs require a visible browser for human takeover");
  }
  const executablePath = resolveMacChromePath(options.executablePath);
  const userDataDir = resolveMacProfileDir(options.profileDir, profileScope);
  return {
    userDataDir,
    executablePath,
    headless: options.headless ?? false,
    acceptDownloads: false,
    // Keep the browser on the user's normal network and visible UI. No proxy,
    // stealth, fingerprint, or remote-debugging flags are added.
    args: []
  };
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function assertNoSymlinkComponents(target: string): Promise<void> {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  const components = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const component of components) {
    current = path.join(current, component);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`PROFILE_SYMLINK_BLOCKED:${current}`);
      if (!stat.isDirectory() && current !== resolved) {
        throw new Error(`PROFILE_PATH_BLOCKED:not a directory:${current}`);
      }
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
  }
}

/** Creates and validates the dedicated profile without following symlinks. */
export async function prepareProfileDirectory(profileDir: string): Promise<string> {
  const resolved = path.resolve(profileDir);
  await assertNoSymlinkComponents(resolved);
  await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
  // Recheck after mkdir to narrow the race window around missing components.
  await assertNoSymlinkComponents(resolved);
  const stat = await fs.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("PROFILE_PATH_BLOCKED:not a real directory");
  await fs.chmod(resolved, 0o700);
  return resolved;
}

/** Acquires an atomic, cross-process lock. Stale locks are never removed automatically. */
export async function acquireProfileLock(profileDir: string): Promise<ProfileLock> {
  const resolved = await prepareProfileDirectory(profileDir);
  const lockPath = path.join(resolved, PROFILE_LOCK_NAME);
  let handle: FileHandle;
  try {
    handle = await fs.open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`PROFILE_IN_USE:${resolved}`);
    }
    throw error;
  }

  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
    await handle.sync();
    const owned = await handle.stat();
    let released = false;
    return {
      profileDir: resolved,
      lockPath,
      async release(): Promise<void> {
        if (released) return;
        released = true;
        try {
          const current = await fs.lstat(lockPath);
          if (current.dev !== owned.dev || current.ino !== owned.ino || current.isSymbolicLink()) {
            throw new Error("PROFILE_LOCK_OWNERSHIP_LOST");
          }
          await fs.unlink(lockPath);
        } finally {
          await handle.close();
        }
      }
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.unlink(lockPath).catch(() => undefined);
    throw error;
  }
}

/** Launches a visible persistent context only when explicitly called by the Mac runner. */
export async function launchMacChrome(options: MacChromeOptions = {}): Promise<BrowserContext> {
  if (process.platform !== "darwin") throw new Error("MACOS_ONLY:the local runner must run on macOS");
  const launch = macChromeLaunchOptions(options);
  const lock = await acquireProfileLock(launch.userDataDir);
  try {
    const { chromium } = await import("playwright-core");
    const context = await chromium.launchPersistentContext(launch.userDataDir, launch);
    const closeContext = context.close.bind(context);
    let closing: Promise<void> | undefined;
    context.close = (...args: Parameters<BrowserContext["close"]>): Promise<void> => {
      closing ??= (async () => {
        try {
          await closeContext(...args);
        } finally {
          await lock.release();
        }
      })();
      return closing;
    };
    context.once("close", () => {
      void lock.release().catch(() => undefined);
    });
    return context;
  } catch (error) {
    await lock.release();
    throw error;
  }
}
