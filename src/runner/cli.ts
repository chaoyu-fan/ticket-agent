import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { normalizePlan, validatePlan } from "../core/policy.js";
import type { Platform, RunState, WatchPlan, WatchPlanInput } from "../core/types.js";
import { adapterFor } from "../adapters/index.js";
import { launchMacChrome } from "./browser.js";
import { ControllerClient, submitDenial } from "./controller-client.js";
import { LocalRunner, prewarmDelayMs } from "./executor.js";
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
}

function usage(): string {
  return [
    "Usage: npm run start:runner -- --dry-run|--mock|--live|--login-only [options]",
    "",
    "  --dry-run       read-only; never clicks or submits",
    "  --mock          permits only a local mock URL",
    "  --live          permits only a matching official HTTPS URL",
    "  --login-only    open the dedicated visible live profile; zero purchase actions",
    "  --platform      required with --login-only; currently damai",
    "  --confirm-live  required together with --live",
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
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run" || arg === "--mock" || arg === "--live" || arg === "--login-only") {
      const requestedMode = arg.slice(2) as CliMode;
      if (mode && mode !== requestedMode) throw new Error("Choose exactly one runner mode");
      mode = requestedMode;
    } else if (arg === "--platform") {
      const value = argv[++index];
      if (value !== "damai" && value !== "maoyan") throw new Error("--platform must be damai or maoyan");
      platform = value;
    } else if (arg === "--confirm-live") {
      confirmLive = true;
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
  if (!mode) throw new Error("An explicit --dry-run, --mock, --live, or --login-only mode is required");
  if (mode === "live" && !confirmLive) throw new Error("--live requires --confirm-live");
  if (mode === "login-only") {
    if (!platform) throw new Error("--login-only requires --platform damai");
    if (platform !== "damai") throw new Error("LOGIN_ONLY_NOT_READY:only damai is currently supported");
    if (!targetUrl) throw new Error("--login-only requires --url with an official HTTPS page");
    if (planPath || controllerUrl || runId || confirmLive) {
      throw new Error("--login-only cannot be combined with plan, controller, run, or live-confirmation options");
    }
  } else if (platform !== undefined) {
    throw new Error("--platform is only valid with --login-only");
  }
  return {
    mode,
    ...(platform === undefined ? {} : { platform }),
    ...(planPath === undefined ? {} : { planPath }),
    ...(targetUrl === undefined ? {} : { targetUrl }),
    ...(controllerUrl === undefined ? {} : { controllerUrl }),
    ...(runId === undefined ? {} : { runId }),
    confirmLive
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

async function waitForVisibleLoginSession(context: Awaited<ReturnType<typeof launchMacChrome>>): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve();
    };
    context.once("close", finish);
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
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
  const validation = validatePlan(raw);
  if (!validation.ok) throw new Error(`PLAN_INVALID:${validation.errors.join("; ")}`);
  return toWatchPlan(raw);
}

export function assertLiveAdapterReady(mode: RunnerMode, plan: Pick<WatchPlan, "platform">): void {
  if (mode !== "live") return;
  const adapter = adapterFor(plan.platform);
  if (!adapter.implemented || !adapter.liveReady) {
    throw new Error(`LIVE_ADAPTER_NOT_READY:${plan.platform}:use mock or dry-run until the adapter is reviewed`);
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

function runnerExitCode(result: Awaited<ReturnType<LocalRunner["run"]>>): number {
  return result.state === "FAILED" || result.message.startsWith("RUNNER_FAILED:") ? 1 : 0;
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
        const page = context.pages()[0] ?? await context.newPage();
        await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
        loginOnlyTarget(args.platform!, page.url());
        console.log("LOGIN_ONLY_READY:请在可见浏览器中手动登录；完成后关闭浏览器或按 Ctrl-C。不会执行选票或提交动作。");
        await waitForVisibleLoginSession(context);
        return 0;
      } finally {
        await context.close();
      }
    }

    const configuredController = args.controllerUrl ?? process.env.TICKET_AGENT_CONTROLLER_URL;
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
      const context = await launchMacChrome({ profileScope: args.mode === "live" ? "live" : "sandbox" });
      try {
        const page = await context.newPage();
        const runner = new LocalRunner({
          page,
          signal: abortController.signal,
          onEvent: async (event) => {
            console.error(JSON.stringify(event));
            await controller?.recordEvent(event);
          },
          ...(controller === undefined ? {} : {
            checkRunActive: async ({ expectedState }: { expectedState: RunState }) => {
              const loaded = await controller.loadRunPlan(runId);
              const active = loaded.run.id === runId && loaded.plan.id === plan.id && loaded.run.state === expectedState;
              return {
                active,
                ...(active ? {} : { message: `controller state is ${loaded.run.state}` })
              };
            },
            authorizeSubmit: async (input) => {
              try {
                const approvedRun = await controller.approveSubmit(input.runId, input.observedTotalFen);
                if (
                  approvedRun.planId !== input.plan.id ||
                  approvedRun.observedTotalFen !== input.observedTotalFen
                ) {
                  return {
                    allowed: false,
                    state: "HUMAN_TAKEOVER",
                    message: "Controller approval did not match the armed plan and verified total"
                  } as const;
                }
                return { allowed: true, approvedTotalFen: approvedRun.observedTotalFen } as const;
              } catch (error) {
                return submitDenial(error);
              }
            }
          })
        });
        const result = await runner.run({
          runId,
          plan,
          mode: args.mode,
          ...(args.targetUrl === undefined ? {} : { targetUrl: args.targetUrl })
        });
        console.log(JSON.stringify(result, null, 2));
        return runnerExitCode(result);
      } finally {
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
