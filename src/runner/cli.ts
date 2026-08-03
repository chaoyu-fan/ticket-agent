import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { BrowserContext, Page } from "playwright-core";

import { normalizePlan, validatePlan } from "../core/policy.js";
import type { Platform, WatchPlan, WatchPlanInput } from "../core/types.js";
import { adapterFor } from "../adapters/index.js";
import { assertAttendeePersistenceBoundary } from "../identity/attendee-ref.js";
import {
  MacOsKeychainAttendeeResolver,
  type AttendeeResolver
} from "../identity/attendee-resolver.js";
import { initializeSingleContextPage, launchMacChrome } from "./browser.js";
import { ControllerClient } from "./controller-client.js";
import { LocalRunner, prewarmDelayMs } from "./executor.js";
import { digestFastPathContract } from "./fast-path-contract.js";
import { runLiveFastPathLifecycle } from "./live-fast-path.js";
import {
  PAGE_TOPOLOGY_INVALID,
  startExactPageTopologyGuard,
  type ExactPageTopologyGuard
} from "./page-topology-guard.js";
import { assertTarget, runnerSafetyPolicy } from "./safety.js";
import type { RunnerMode } from "./types.js";

type CliMode = RunnerMode | "login-only";

interface CliArgs {
  mode: CliMode;
  platform?: Platform;
  planPath?: string;
  targetUrl?: string;
  controllerUrl?: string;
  runId?: string;
  confirmLive: boolean;
  confirmRehearsal: boolean;
}

function usage(): string {
  return [
    "Usage: npm run start:runner -- --dry-run|--mock|--rehearsal|--live|--login-only [options]",
    "",
    "  --dry-run       read-only; never clicks or submits",
    "  --mock          permits only a local mock URL",
    "  --rehearsal     visible official-page selection; submit capability is absent",
    "  --live          permits only a matching official HTTPS URL",
    "  --login-only    open the dedicated visible live profile; zero purchase actions",
    "  --platform      required with --login-only; currently damai",
    "  --confirm-live  required together with --live",
    "  --confirm-rehearsal  required together with --rehearsal",
    "  --plan          path to a WatchPlan/WatchPlanInput JSON file",
    "  --url           optional target override (validated by mode)",
    "  --controller-url  loopback controller URL; required for live",
    "  --run-id        armed controller run ID; required for live",
    "  token           read only from TICKET_AGENT_TOKEN (never a CLI argument)"
  ].join("\n");
}

export function parseRunnerArgs(argv: readonly string[]): CliArgs {
  let mode: CliMode | undefined;
  let platform: Platform | undefined;
  let planPath: string | undefined;
  let targetUrl: string | undefined;
  let controllerUrl: string | undefined;
  let runId: string | undefined;
  let confirmLive = false;
  let confirmRehearsal = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (
      arg === "--dry-run" ||
      arg === "--mock" ||
      arg === "--rehearsal" ||
      arg === "--live" ||
      arg === "--login-only"
    ) {
      const requestedMode = arg.slice(2) as CliMode;
      if (mode && mode !== requestedMode) throw new Error("Choose exactly one runner mode");
      mode = requestedMode;
    } else if (arg === "--platform") {
      const value = argv[++index];
      if (value !== "damai" && value !== "maoyan") throw new Error("--platform must be damai or maoyan");
      platform = value;
    } else if (arg === "--confirm-live") {
      confirmLive = true;
    } else if (arg === "--confirm-rehearsal") {
      confirmRehearsal = true;
    } else if (arg === "--plan") {
      const value = argv[++index];
      if (!value) throw new Error("--plan requires a path");
      planPath = value;
    } else if (arg === "--url") {
      const value = argv[++index];
      if (!value) throw new Error("--url requires a URL");
      targetUrl = value;
    } else if (arg === "--controller-url") {
      const value = argv[++index];
      if (!value) throw new Error("--controller-url requires a URL");
      controllerUrl = value;
    } else if (arg === "--run-id") {
      const value = argv[++index];
      if (!value) throw new Error("--run-id requires an ID");
      runId = value;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(usage());
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!mode) throw new Error("An explicit --dry-run, --mock, --rehearsal, --live, or --login-only mode is required");
  if (mode === "live" && !confirmLive) throw new Error("--live requires --confirm-live");
  if (mode === "rehearsal" && !confirmRehearsal) {
    throw new Error("--rehearsal requires --confirm-rehearsal");
  }
  if (mode === "login-only") {
    if (!platform) throw new Error("--login-only requires --platform damai");
    if (platform !== "damai") throw new Error("LOGIN_ONLY_NOT_READY:only damai is currently supported");
    if (!targetUrl) throw new Error("--login-only requires --url with an official HTTPS page");
    if (planPath || controllerUrl || runId || confirmLive || confirmRehearsal) {
      throw new Error("--login-only cannot be combined with plan, controller, run, or live-confirmation options");
    }
  } else if (platform !== undefined) {
    throw new Error("--platform is only valid with --login-only");
  }
  if (mode === "rehearsal") {
    if (confirmLive) throw new Error("--rehearsal cannot be combined with --confirm-live");
    if (controllerUrl || runId) {
      throw new Error("--rehearsal cannot be combined with controller or run options");
    }
    if (!planPath) throw new Error("--rehearsal requires --plan with an official event binding");
  } else if (confirmRehearsal) {
    throw new Error("--confirm-rehearsal is only valid with --rehearsal");
  }
  if (mode !== "live" && mode !== "login-only" && confirmLive) {
    throw new Error("--confirm-live is only valid with --live");
  }
  return {
    mode,
    ...(platform === undefined ? {} : { platform }),
    ...(planPath === undefined ? {} : { planPath }),
    ...(targetUrl === undefined ? {} : { targetUrl }),
    ...(controllerUrl === undefined ? {} : { controllerUrl }),
    ...(runId === undefined ? {} : { runId }),
    confirmLive,
    confirmRehearsal
  };
}

export function loginOnlyTarget(platform: Platform, targetUrl: string): URL {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    throw new Error("LOGIN_TARGET_BLOCKED:URL is malformed");
  }
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  const root = platform === "damai" ? "damai.cn" : "maoyan.com";
  if (
    url.protocol !== "https:" ||
    (hostname !== root && !hostname.endsWith(`.${root}`)) ||
    url.username ||
    url.password ||
    (url.port !== "" && url.port !== "443")
  ) {
    throw new Error(`LOGIN_TARGET_BLOCKED:only an official HTTPS ${platform} URL is allowed`);
  }
  return url;
}

export async function waitForVisibleLoginSession(
  context: Awaited<ReturnType<typeof launchMacChrome>>
): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      context.off("close", finish);
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve();
    };
    context.once("close", finish);
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    try {
      const browser = context.browser();
      if (context.pages().length === 0 || (browser !== null && !browser.isConnected())) finish();
    } catch {
      finish();
    }
  });
}

type VisibleContextWait = (context: Awaited<ReturnType<typeof launchMacChrome>>) => Promise<void>;

/** Keeps an unknown live-profile page topology visible until the user has reviewed it. */
export async function waitForProfileReviewIfRequired(
  context: Awaited<ReturnType<typeof launchMacChrome>>,
  error: unknown,
  wait: VisibleContextWait = waitForVisibleLoginSession,
  notify: (message: string) => void = (message) => console.error(message)
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  if (message !== "RESTORED_PAGE_REVIEW_REQUIRED") return;
  notify(
    `PROFILE_REVIEW_REQUIRED:${message}:live profile 页面保持打开；请人工核对后关闭 TicketAgent 浏览器或按 Ctrl-C。`
  );
  await wait(context);
}

/** Pure topology assertion: never creates a replacement page after navigation. */
export async function singleContextPage(
  context: Pick<BrowserContext, "pages">
): Promise<Page> {
  const existing = context.pages();
  const page = existing[0];
  if (existing.length !== 1 || page === undefined || page.isClosed()) {
    throw new Error("SINGLE_PAGE_CONTEXT_REQUIRED");
  }
  return page;
}

function toWatchPlan(input: WatchPlanInput | WatchPlan): WatchPlan {
  const normalized = normalizePlan(input);
  const now = new Date().toISOString();
  return {
    ...normalized,
    id: "local-cli-run",
    status: "ARMED",
    createdAt: now,
    updatedAt: now
  };
}

async function readPlan(planPath: string | undefined): Promise<WatchPlan> {
  if (!planPath) {
    return toWatchPlan({ platform: "damai" });
  }
  const raw = JSON.parse(await fs.readFile(path.resolve(planPath), "utf8")) as WatchPlanInput | WatchPlan;
  // Plan files may contain opaque refs only. Real labels are resolved from
  // Mac Keychain during PREWARM and must never be read from disk.
  assertAttendeePersistenceBoundary(raw);
  const validation = validatePlan(raw);
  if (!validation.ok) throw new Error(`PLAN_INVALID:${validation.errors.join("; ")}`);
  return toWatchPlan(raw);
}

export function assertLiveAdapterReady(mode: RunnerMode, plan: Pick<WatchPlan, "platform">): void {
  const adapter = adapterFor(plan.platform);
  if (mode === "rehearsal" && !adapter.implemented) {
    throw new Error(`REHEARSAL_ADAPTER_NOT_READY:${plan.platform}:only an implemented visible-UI adapter may rehearse`);
  }
  if (
    runnerSafetyPolicy(mode).requireLiveReady &&
    (
      !adapter.implemented ||
      !adapter.liveReady ||
      !adapter.fastPathReady ||
      adapter.fastPathContractDigest === undefined ||
      adapter.fastPathContract === undefined ||
      !/^sha256:[0-9a-f]{64}$/u.test(adapter.fastPathContractDigest)
    )
  ) {
    throw new Error(
      `LIVE_FAST_PATH_NOT_READY:${plan.platform}:use rehearsal until the reviewed contract is bound`
    );
  }
  if (
    runnerSafetyPolicy(mode).requireLiveReady &&
    digestFastPathContract(adapter.fastPathContract) !== adapter.fastPathContractDigest
  ) {
    throw new Error(`LIVE_FAST_PATH_CONTRACT_MISMATCH:${plan.platform}`);
  }
}

/** Rehearsal may click reversible controls, so it requires an exact event binding. */
export function assertRehearsalPlanBinding(
  plan: Pick<WatchPlan, "officialUrl" | "eventId">,
  targetUrl?: string
): void {
  if (!plan.officialUrl?.trim() || !plan.eventId?.trim()) {
    throw new Error("REHEARSAL_EVENT_BINDING_REQUIRED:officialUrl and eventId must be present in the plan");
  }
  let planned: URL;
  let requested: URL;
  try {
    planned = new URL(plan.officialUrl);
    requested = new URL(targetUrl ?? plan.officialUrl);
  } catch {
    throw new Error("REHEARSAL_EVENT_BINDING_INVALID:officialUrl and target must be absolute URLs");
  }
  if (requested.href !== planned.href) {
    throw new Error("REHEARSAL_TARGET_MISMATCH:--url must exactly match plan.officialUrl");
  }
}

const SCHEDULE_CHECK_INTERVAL_MS = 30_000;

function waitWithSignal(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("RUN_ABORTED"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    function finish(): void {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new Error("RUN_ABORTED"));
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Keeps the coordinator alive without opening Chrome until PREWARM begins. */
export async function waitForPrewarmWindow(
  plan: Pick<WatchPlan, "saleAt">,
  options: {
    signal: AbortSignal;
    now?: () => Date;
    sleep?: (milliseconds: number, signal: AbortSignal) => void | Promise<void>;
    checkScheduled?: () => void | Promise<void>;
    checkIntervalMs?: number;
  }
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? waitWithSignal;
  const interval = options.checkIntervalMs ?? SCHEDULE_CHECK_INTERVAL_MS;
  if (!Number.isSafeInteger(interval) || interval < 1) {
    throw new Error("SCHEDULE_CHECK_INTERVAL_INVALID");
  }
  for (;;) {
    if (options.signal.aborted) throw new Error("RUN_ABORTED");
    const remaining = prewarmDelayMs(plan, "live", now());
    if (remaining <= 0) return;
    await options.checkScheduled?.();
    await sleep(Math.min(remaining, interval), options.signal);
  }
}

export function runnerExitCode(result: Awaited<ReturnType<LocalRunner["run"]>>): number {
  return result.state === "FAILED" ||
    result.message.startsWith("RUNNER_FAILED:") ||
    result.message.includes("BROWSER_CONTEXT_CLOSED:") ||
    result.message.includes(PAGE_TOPOLOGY_INVALID)
    ? 1
    : 0;
}

export function localRunnerMode(mode: RunnerMode): Exclude<RunnerMode, "live"> {
  if (mode === "live") throw new Error("LIVE_LOCAL_RUNNER_FALLBACK_BLOCKED");
  return mode;
}

/** Copy the one-run verifier key out of the environment and remove the env entry immediately. */
export function takeLiveCapabilityKey(environment: NodeJS.ProcessEnv = process.env): Uint8Array {
  const value = environment.TICKET_AGENT_CAPABILITY_KEY;
  delete environment.TICKET_AGENT_CAPABILITY_KEY;
  if (typeof value !== "string") throw new Error("LIVE_CAPABILITY_KEY_REQUIRED");
  const key = Buffer.from(value, "utf8");
  const token = Buffer.from(environment.TICKET_AGENT_TOKEN ?? "", "utf8");
  try {
    if (key.byteLength < 32) throw new Error("LIVE_CAPABILITY_KEY_INVALID");
    if (key.byteLength === token.byteLength && key.equals(token)) {
      throw new Error("LIVE_CAPABILITY_KEY_MUST_DIFFER_FROM_TOKEN");
    }
    return new Uint8Array(key);
  } finally {
    key.fill(0);
    token.fill(0);
  }
}

/**
 * Resolves labels only for official-page modes and scopes them to one browser
 * operation. Dry-run and mock never invoke the resolver, even if one is
 * injected by a test or caller.
 */
export async function withRuntimeAttendeeLabels<T>(
  mode: RunnerMode,
  plan: WatchPlan,
  operation: (runtimePlan: WatchPlan) => Promise<T>,
  resolver?: AttendeeResolver
): Promise<T> {
  if (mode === "dry-run" || mode === "mock" || (plan.attendeeRefs?.length ?? 0) === 0) {
    return operation(plan);
  }
  if (plan.attendeeAliases.length !== 0) {
    throw new Error("ATTENDEE_RUNTIME_BOUNDARY_INVALID:resolved labels must not arrive from persistence");
  }

  const resolution = await (resolver ?? new MacOsKeychainAttendeeResolver()).resolve({
    platform: plan.platform,
    attendeeRefs: plan.attendeeRefs,
    phase: "PREWARM",
    ...(plan.saleAt === undefined ? {} : { saleAt: plan.saleAt })
  });
  try {
    return await resolution.withLabels(async (labels) => {
      if (labels.length !== plan.attendeeRefs?.length) {
        throw new Error("ATTENDEE_RESOLUTION_COUNT_MISMATCH");
      }
      const runtimeAliases = [...labels];
      const runtimePlan: WatchPlan = { ...plan, attendeeAliases: runtimeAliases };
      try {
        return await operation(runtimePlan);
      } finally {
        runtimeAliases.fill("");
      }
    });
  } finally {
    resolution.dispose();
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  try {
    args = parseRunnerArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return message.startsWith("Usage:") ? 0 : 2;
  }

  try {
    if (args.mode === "login-only") {
      const target = loginOnlyTarget(args.platform!, args.targetUrl!);
      const context = await launchMacChrome({ profileScope: "live" });
      try {
        // Human-only login does not mutate or close restored tabs. The new
        // page is the only page this mode navigates automatically.
        const page = await context.newPage();
        await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
        loginOnlyTarget(args.platform!, page.url());
        console.log("LOGIN_ONLY_READY:请在可见浏览器中手动登录；完成后关闭浏览器或按 Ctrl-C。不会执行选票或提交动作。");
        await waitForVisibleLoginSession(context);
        return 0;
      } finally {
        await context.close();
      }
    }
    const runnerMode: RunnerMode = args.mode;

    const configuredController = args.mode === "live"
      ? args.controllerUrl ?? process.env.TICKET_AGENT_CONTROLLER_URL
      : undefined;
    let controller: ControllerClient | undefined;
    let plan: WatchPlan;
    let runId: string;
    if (args.mode === "live") {
      if (!configuredController || !args.runId) {
        throw new Error("LIVE_CONTROLLER_REQUIRED:use --controller-url and --run-id");
      }
      if (args.planPath) throw new Error("LIVE_PLAN_SOURCE_BLOCKED:live plans must be loaded from the controller");
      controller = new ControllerClient(configuredController, process.env.TICKET_AGENT_TOKEN ?? "");
      const loaded = await controller.loadRunPlan(args.runId);
      if (loaded.run.state !== "SCHEDULED") throw new Error(`RUN_NOT_SCHEDULED:${loaded.run.state}`);
      plan = loaded.plan;
      runId = loaded.run.id;
    } else {
      plan = await readPlan(args.planPath);
      runId = `local-${Date.now()}`;
    }
    if (args.mode === "rehearsal") assertRehearsalPlanBinding(plan, args.targetUrl);
    const abortController = new AbortController();
    const abortRun = (): void => abortController.abort();
    process.once("SIGINT", abortRun);
    process.once("SIGTERM", abortRun);
    try {
      assertLiveAdapterReady(args.mode, plan);
      // No URL in dry-run is intentionally a pure policy check and does not
      // launch Chrome or touch the network.
      if (args.mode === "dry-run" && !args.targetUrl && !plan.officialUrl) {
        const runner = new LocalRunner({ signal: abortController.signal });
        const result = await runner.run({ runId, plan, mode: args.mode });
        console.log(JSON.stringify(result, null, 2));
        return runnerExitCode(result);
      }

      // Keep a lightweight coordinator alive while the controller run remains
      // SCHEDULED. Chrome is launched only after the prewarm boundary.
      const schedulingNow = new Date();
      if (prewarmDelayMs(plan, args.mode, schedulingNow) > 0) {
        const scheduled = await new LocalRunner({ now: () => schedulingNow }).run({
          runId,
          plan,
          mode: args.mode,
          ...(args.targetUrl === undefined ? {} : { targetUrl: args.targetUrl })
        });
        if (scheduled.state !== "SCHEDULED") {
          console.log(JSON.stringify(scheduled, null, 2));
          return runnerExitCode(scheduled);
        }
        console.log(JSON.stringify(scheduled, null, 2));
        try {
          await waitForPrewarmWindow(plan, {
            signal: abortController.signal,
            checkScheduled: async () => {
              const refreshed = await controller!.loadRunPlan(runId);
              if (refreshed.run.id !== runId || refreshed.run.state !== "SCHEDULED") {
                throw new Error(`RUN_NOT_SCHEDULED:${refreshed.run.state}`);
              }
              if (refreshed.plan.id !== plan.id || refreshed.plan.updatedAt !== plan.updatedAt) {
                throw new Error("SCHEDULED_PLAN_CHANGED");
              }
            }
          });
        } catch (error) {
          if (abortController.signal.aborted) {
            console.error("SCHEDULE_ABORTED:controller run remains SCHEDULED and can be started again");
            return 130;
          }
          throw error;
        }
        const refreshed = await controller!.loadRunPlan(runId);
        if (refreshed.run.state !== "SCHEDULED" || refreshed.plan.id !== plan.id) {
          throw new Error(`RUN_NOT_SCHEDULED:${refreshed.run.state}`);
        }
        plan = refreshed.plan;
      }

      if (abortController.signal.aborted) return 130;
      if (runnerMode === "live") {
        if (controller === undefined) throw new Error("LIVE_CONTROLLER_REQUIRED");
        const adapter = adapterFor(plan.platform);
        if (adapter.fastPathContract === undefined) {
          throw new Error(`LIVE_FAST_PATH_NOT_READY:${plan.platform}`);
        }
        const target = assertTarget(plan, runnerMode, args.targetUrl ?? plan.officialUrl);
        if (target === undefined) throw new Error("LIVE_TARGET_REQUIRED");
        // Remove the capability key from the environment before Chrome can
        // inherit it. A profile review wipes the in-memory copy before waiting,
        // and attendee labels are not resolved until topology preflight passes.
        const capabilityKey = takeLiveCapabilityKey();
        let topologyGuard: ExactPageTopologyGuard | undefined;
        try {
          const context = await launchMacChrome({ profileScope: "live" });
          try {
            const page = await initializeSingleContextPage(context);
            // Install the sticky guard before the first official navigation.
            topologyGuard = startExactPageTopologyGuard(page);
            topologyGuard.assertValid();
            await adapter.navigate(page, target.href);
            topologyGuard.assertValid();
            const result = await withRuntimeAttendeeLabels(runnerMode, plan, async (runtimePlan) => {
              topologyGuard!.assertValid();
              const attendeeLabels = [...runtimePlan.attendeeAliases];
              const persistedPlan: WatchPlan = { ...runtimePlan, attendeeAliases: [] };
              try {
                return await runLiveFastPathLifecycle({
                  page,
                  topologyGuard: topologyGuard!,
                  controller,
                  runId,
                  plan: persistedPlan,
                  contract: adapter.fastPathContract,
                  attendeeLabels,
                  capabilityKey,
                  signal: abortController.signal
                });
              } finally {
                attendeeLabels.fill("");
              }
            });
            console.log(JSON.stringify(result, null, 2));
            if (
              result.fastPath.outcome === "CLICK_DISPATCHED" ||
              result.fastPath.outcome === "OUTCOME_UNKNOWN"
            ) {
              console.error(
                "LIVE_VISIBLE_RECONCILIATION_REQUIRED:请检查订单和支付页面；浏览器会保持打开，完成后关闭窗口或按 Ctrl-C。"
              );
              await waitForVisibleLoginSession(context);
            }
            return result.reportStatus === "RECORDED" && result.fastPath.outcome === "CLICK_DISPATCHED"
              ? 0
              : 1;
          } catch (error) {
            capabilityKey.fill(0);
            await waitForProfileReviewIfRequired(context, error);
            throw error;
          } finally {
            topologyGuard?.dispose();
            await context.close();
          }
        } finally {
          capabilityKey.fill(0);
        }
      }

      const nonLiveMode = localRunnerMode(runnerMode);
      // The profile topology is checked before Keychain resolution so a
      // restored-page review cannot retain attendee labels in process memory.
      const context = await launchMacChrome({ profileScope: runnerSafetyPolicy(nonLiveMode).profileScope });
      let topologyGuard: ExactPageTopologyGuard | undefined;
      try {
        const page = await initializeSingleContextPage(context, {
          allowNonEmptyRestored: nonLiveMode === "dry-run" || nonLiveMode === "mock"
        });
        if (nonLiveMode === "rehearsal") {
          // Rehearsal uses the same pre-navigation guard as live, but never
          // receives a controller capability or submit authority.
          topologyGuard = startExactPageTopologyGuard(page);
          topologyGuard.assertValid();
        }
        return await withRuntimeAttendeeLabels(nonLiveMode, plan, async (runtimePlan) => {
          topologyGuard?.assertValid();
          const runner = new LocalRunner({
            page,
            ...(topologyGuard === undefined ? {} : { pageTopologyGuard: topologyGuard }),
            signal: abortController.signal,
            onEvent: (event) => {
              console.error(JSON.stringify(event));
            }
          });
          const result = await runner.run({
            runId,
            plan: runtimePlan,
            mode: nonLiveMode,
            ...(args.targetUrl === undefined ? {} : { targetUrl: args.targetUrl })
          });
          if (
            topologyGuard !== undefined &&
            !topologyGuard.recheck() &&
            !result.message.includes(PAGE_TOPOLOGY_INVALID)
          ) {
            throw new Error(PAGE_TOPOLOGY_INVALID);
          }
          console.log(JSON.stringify(result, null, 2));
          return runnerExitCode(result);
        });
      } catch (error) {
        if (nonLiveMode === "rehearsal") {
          await waitForProfileReviewIfRequired(context, error);
        }
        throw error;
      } finally {
        topologyGuard?.dispose();
        await context.close();
      }
    } finally {
      process.off("SIGINT", abortRun);
      process.off("SIGTERM", abortRun);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await main();
}
