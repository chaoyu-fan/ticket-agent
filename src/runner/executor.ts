import { adapterFor } from "../adapters/index.js";
import type {
  AdapterDomWaitPhase,
  AdapterPhase,
  AdapterStepResult,
  PageSignals,
  TicketPlatformAdapter
} from "../adapters/types.js";
import { validatePlan } from "../core/policy.js";
import { canTransition } from "../core/state.js";
import type { RunnerEvent, RunState, WatchPlan } from "../core/types.js";

import { checkObservedTarget, checkRunTarget, runnerSafetyPolicy } from "./safety.js";
import { waitForDomPredicate } from "./dom-event.js";
import type { LocalRunnerOptions, LocalRunnerRequest, LocalRunnerResult } from "./types.js";

const ACTION_PHASES: readonly {
  state: Extract<RunState, "SELECT_SESSION" | "SELECT_TIER" | "SELECT_QUANTITY" | "SELECT_ATTENDEE">;
  phase: Extract<AdapterPhase, "session" | "tier" | "quantity" | "attendee">;
  action: keyof Pick<TicketPlatformAdapter, "selectSession" | "selectTier" | "selectQuantity" | "selectAttendees">;
}[] = [
  { state: "SELECT_SESSION", phase: "session", action: "selectSession" },
  { state: "SELECT_TIER", phase: "tier", action: "selectTier" },
  { state: "SELECT_QUANTITY", phase: "quantity", action: "selectQuantity" },
  { state: "SELECT_ATTENDEE", phase: "attendee", action: "selectAttendees" }
];

export const DEFAULT_PREWARM_WINDOW_MS = 10 * 60 * 1_000;
export const DEFAULT_QUEUE_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_QUEUE_DOM_WATCHDOG_MS = 30_000;

function isNavigationContextChange(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:execution context was destroyed|cannot find context|frame was detached).*(?:navigation|navigat)/i.test(message) ||
    /most likely because of a navigation/i.test(message);
}

function isPageClosedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:target page, context or browser has been closed|target closed|page has been closed)/i.test(message);
}

function pageIsClosed(page: LocalRunnerOptions["page"]): boolean {
  if (page === undefined || typeof page.isClosed !== "function") return false;
  try {
    return page.isClosed();
  } catch {
    return true;
  }
}

function browserContextClosedMessage(
  page: LocalRunnerOptions["page"],
  error: unknown,
  phase: string
): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("BROWSER_CONTEXT_CLOSED:")) return message;
  return pageIsClosed(page) || isPageClosedError(error)
    ? `BROWSER_CONTEXT_CLOSED:${phase}`
    : undefined;
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("RUN_ABORTED"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    function finish(): void {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new Error("RUN_ABORTED"));
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Milliseconds until a live run may enter PREWARM; zero means run now. */
export function prewarmDelayMs(
  plan: Pick<WatchPlan, "saleAt">,
  mode: LocalRunnerRequest["mode"],
  now: Date,
  prewarmWindowMs = DEFAULT_PREWARM_WINDOW_MS
): number {
  if (mode !== "live" || plan.saleAt === undefined) return 0;
  const saleTime = Date.parse(plan.saleAt);
  if (!Number.isFinite(saleTime)) return 0;
  return Math.max(0, saleTime - now.getTime() - prewarmWindowMs);
}

function isoNow(now: () => Date): string {
  return now().toISOString();
}

function totalEvent(value: number | undefined): Partial<RunnerEvent> {
  return value === undefined ? {} : { observedTotalFen: value };
}

type InspectionOutcome = { signals: PageSignals } | { stopped: LocalRunnerResult };

export class LocalRunner {
  private readonly page;
  private readonly adapterOverride;
  private readonly onEvent;
  private readonly authorizeSubmit;
  private readonly now;
  private readonly sleep;
  private readonly prewarmWindowMs;
  private readonly queuePollIntervalMs;
  private readonly signal;
  private readonly checkRunActive;

  constructor(options: LocalRunnerOptions = {}) {
    this.page = options.page;
    this.adapterOverride = options.adapter;
    this.onEvent = options.onEvent;
    this.authorizeSubmit = options.authorizeSubmit;
    this.now = options.now ?? (() => new Date());
    this.signal = options.signal;
    this.checkRunActive = options.checkRunActive;
    this.sleep = options.sleep ?? ((milliseconds: number) => defaultSleep(milliseconds, this.signal));
    this.prewarmWindowMs = options.prewarmWindowMs ?? DEFAULT_PREWARM_WINDOW_MS;
    this.queuePollIntervalMs = options.queuePollIntervalMs ?? DEFAULT_QUEUE_POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(this.prewarmWindowMs) || this.prewarmWindowMs < 0) {
      throw new Error("PREWARM_WINDOW_INVALID:must be a non-negative integer in milliseconds");
    }
    if (!Number.isSafeInteger(this.queuePollIntervalMs) || this.queuePollIntervalMs < 1) {
      throw new Error("QUEUE_POLL_INTERVAL_INVALID:must be a positive integer in milliseconds");
    }
  }

  async run(request: LocalRunnerRequest): Promise<LocalRunnerResult> {
    const safetyPolicy = runnerSafetyPolicy(request.mode);
    const events: RunnerEvent[] = [];
    let current: RunState = "SCHEDULED";
    let observedTotalFen: number | undefined;
    let selectedSession: string | undefined;
    let selectedTier: string | undefined;
    let adjacentVerified: boolean | undefined;
    let orderReference: string | undefined;

    const emit = async (
      state: RunState,
      message: string,
      extra: Partial<RunnerEvent> = {},
      notifyController = true
    ): Promise<void> => {
      if (!safetyPolicy.allowSubmitOrder && (state === "SUBMIT_ORDER" || state === "PAY_REQUIRED")) {
        throw new Error(`MODE_CAPABILITY_BLOCKED:${request.mode}:${state}`);
      }
      if (!canTransition(current, state)) throw new Error(`INVALID_RUNNER_TRANSITION:${current}->${state}`);
      const event: RunnerEvent = {
        runId: request.runId,
        state,
        message,
        at: isoNow(this.now),
        ...(extra.observedTotalFen === undefined ? {} : { observedTotalFen: extra.observedTotalFen }),
        ...(extra.selectionFingerprint === undefined ? {} : { selectionFingerprint: extra.selectionFingerprint }),
        ...(extra.adjacentVerified === undefined ? {} : { adjacentVerified: extra.adjacentVerified }),
        ...(extra.selectedSession === undefined ? {} : { selectedSession: extra.selectedSession }),
        ...(extra.selectedTier === undefined ? {} : { selectedTier: extra.selectedTier }),
        ...(extra.orderReference === undefined ? {} : { orderReference: extra.orderReference })
      };
      if (notifyController && this.onEvent) {
        let lastError: unknown;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            await this.onEvent(event);
            lastError = undefined;
            break;
          } catch (error) {
            lastError = error;
            if (attempt < 2) await defaultSleep(100 * (attempt + 1));
          }
        }
        if (lastError !== undefined) throw lastError;
      }
      current = state;
      events.push(event);
    };

    const result = (message: string): LocalRunnerResult => ({
      runId: request.runId,
      state: current,
      message,
      ...(observedTotalFen === undefined ? {} : { observedTotalFen }),
      ...(selectedSession === undefined ? {} : { selectedSession }),
      ...(selectedTier === undefined ? {} : { selectedTier }),
      ...(adjacentVerified === undefined ? {} : { adjacentVerified }),
      ...(orderReference === undefined ? {} : { orderReference }),
      events
    });

    const stopIfExternallyInactive = async (): Promise<LocalRunnerResult | undefined> => {
      if (!this.checkRunActive) return undefined;
      const status = await this.checkRunActive({ runId: request.runId, expectedState: current });
      if (status.active) return undefined;
      const message = `RUN_NO_LONGER_ACTIVE:${status.message ?? "controller stopped or replaced this run"}`;
      await emit("FAILED", message, totalEvent(observedTotalFen), false);
      return result(message);
    };

    const stopForGuard = async (
      requestedState: RunState,
      message: string,
      total: number | undefined
    ): Promise<LocalRunnerResult> => {
      const safeState: RunState = canTransition(current, requestedState)
        ? requestedState
        : canTransition(current, "HUMAN_TAKEOVER")
          ? "HUMAN_TAKEOVER"
          : "FAILED";
      const labelledMessage = safeState === requestedState ? message : `${requestedState}:${message}`;
      await emit(safeState, labelledMessage, totalEvent(total));
      return result(labelledMessage);
    };

    const validation = validatePlan(request.plan);
    if (!validation.ok) {
      const message = `PLAN_INVALID:${validation.errors.join("; ")}`;
      await emit("FAILED", message);
      return result(message);
    }

    const target = request.targetUrl ?? request.plan.officialUrl;
    const targetCheck = checkRunTarget(request.plan, request.mode, target);
    if (!targetCheck.ok) {
      const message = `TARGET_BLOCKED:${targetCheck.message}`;
      await emit("FAILED", message);
      return result(message);
    }

    // A no-target dry-run is a pure policy check: it performs no browser or
    // network work, but still records a state consistent with its result.
    if (!targetCheck.url) {
      const message = "Dry-run validated without a target; supply an official URL before browsing";
      await emit("REVIEW_REQUIRED", message);
      return result(message);
    }

    const adapter = this.adapterOverride ?? adapterFor(request.plan.platform);
    if (!adapter.implemented) {
      const message = `ADAPTER_NOT_IMPLEMENTED:${request.plan.platform}`;
      await emit("FAILED", message);
      return result(message);
    }
    if (
      safetyPolicy.requireLiveReady &&
      (
        !adapter.liveReady ||
        !adapter.fastPathReady ||
        adapter.fastPathContractDigest === undefined ||
        adapter.fastPathContract === undefined ||
        !/^sha256:[0-9a-f]{64}$/u.test(adapter.fastPathContractDigest)
      )
    ) {
      const message = `LIVE_FAST_PATH_NOT_READY:${request.plan.platform}:use rehearsal until the reviewed contract is bound`;
      await emit("FAILED", message);
      return result(message);
    }
    if (safetyPolicy.targetScope === "official" && !adapter.supportsOfficialUrl(targetCheck.url)) {
      const message = `PLATFORM_URL_MISMATCH:${request.plan.platform}`;
      await emit("FAILED", message);
      return result(message);
    }

    const deferFor = prewarmDelayMs(request.plan, request.mode, this.now(), this.prewarmWindowMs);
    if (deferFor > 0) {
      const saleTime = Date.parse(request.plan.saleAt!);
      const prewarmAt = new Date(saleTime - this.prewarmWindowMs).toISOString();
      return result(`SCHEDULED_UNTIL_PREWARM:${prewarmAt}`);
    }

    const page = this.page;
    if (!page) {
      const message = "BROWSER_PAGE_REQUIRED:construct LocalRunner with a local Playwright page";
      await emit("FAILED", message);
      return result(message);
    }

    const checkTargetBoundary = async (
      label: string,
      explicitUrl?: string
    ): Promise<LocalRunnerResult | undefined> => {
      if (this.signal?.aborted) {
        return stopForGuard("FAILED", `RUN_ABORTED:${label}`, observedTotalFen);
      }
      if (pageIsClosed(page)) {
        return stopForGuard("PAGE_CHANGED", `BROWSER_CONTEXT_CLOSED:${label}`, observedTotalFen);
      }
      let observedUrl: string;
      try {
        observedUrl = explicitUrl ?? page.url();
      } catch (error) {
        const closed = browserContextClosedMessage(page, error, label);
        if (closed !== undefined) {
          return stopForGuard("PAGE_CHANGED", closed, observedTotalFen);
        }
        return stopForGuard("PAGE_CHANGED", `TARGET_BLOCKED:${label}:page URL is unreadable`, observedTotalFen);
      }
      const check = checkObservedTarget(request.plan, request.mode, observedUrl);
      if (check.ok) return undefined;
      return stopForGuard("PAGE_CHANGED", `TARGET_BLOCKED:${label}:${check.message}`, observedTotalFen);
    };

    const inspect = async (
      adapterPhase: AdapterPhase,
      label: string
    ): Promise<InspectionOutcome> => {
      const before = await checkTargetBoundary(`before ${label} inspect`);
      if (before) return { stopped: before };

      let signals: PageSignals | undefined;
      let inspectionFailed = false;
      let inspectionError: unknown;
      try {
        signals = await adapter.inspect({ page, plan: request.plan }, adapterPhase);
      } catch (error) {
        if (pageIsClosed(page) || isPageClosedError(error)) {
          return {
            stopped: await stopForGuard(
              "PAGE_CHANGED",
              `BROWSER_CONTEXT_CLOSED:${label}`,
              observedTotalFen
            )
          };
        }
        inspectionFailed = true;
        inspectionError = error;
      }

      const afterPage = await checkTargetBoundary(`after ${label} inspect`);
      if (afterPage) return { stopped: afterPage };
      if (inspectionFailed || signals === undefined) throw inspectionError ?? new Error("ADAPTER_INSPECT_FAILED");
      const afterSignals = await checkTargetBoundary(`after ${label} inspect signal`, signals.url);
      if (afterSignals) return { stopped: afterSignals };

      // Signals must describe the same page the user can see. A stale or
      // fabricated adapter snapshot is not safe enough for any action.
      if (new URL(page.url()).href !== new URL(signals.url).href) {
        return {
          stopped: await stopForGuard(
            "PAGE_CHANGED",
            `TARGET_MISMATCH:${label}:adapter signals do not match the visible page URL`,
            observedTotalFen
          )
        };
      }
      return { signals };
    };

    const waitForAdapterDomWake = async (
      phase: AdapterDomWaitPhase,
      timeoutMs: number,
      label: string
    ) => {
      const predicates = adapter.domWaitPredicates?.(phase) ?? [];
      if (predicates.length === 0) return { kind: "unsupported" as const };

      const cancellation = new AbortController();
      const abortForRunner = (): void => cancellation.abort();
      this.signal?.addEventListener("abort", abortForRunner, { once: true });
      if (this.signal?.aborted) cancellation.abort();

      const domWait = waitForDomPredicate(page, {
        predicates,
        timeoutMs,
        signal: cancellation.signal
      }).then((result) => ({ kind: "dom" as const, result })).catch((error: unknown) => {
        if (isNavigationContextChange(error)) return { kind: "context-changed" as const };
        const closed = browserContextClosedMessage(page, error, label);
        if (closed !== undefined) throw new Error(closed);
        throw error;
      });

      // Keep controller cancellation and the official-host boundary responsive
      // while one MutationObserver remains resident in the browser. This loop
      // never inspects DOM, refreshes, navigates, or opens another page.
      const monitor = (async () => {
        for (;;) {
          try {
            await defaultSleep(this.queuePollIntervalMs, cancellation.signal);
          } catch (error) {
            if (cancellation.signal.aborted) return { kind: "monitor-cancelled" as const };
            throw error;
          }
          if (this.checkRunActive) {
            const status = await this.checkRunActive({ runId: request.runId, expectedState: current });
            // The DOM event may have won while the controller request was in
            // flight. Never let a stale liveness response mutate the run.
            if (cancellation.signal.aborted) return { kind: "monitor-cancelled" as const };
            if (!status.active) {
              const message = `RUN_NO_LONGER_ACTIVE:${status.message ?? "controller stopped or replaced this run"}`;
              await emit("FAILED", message, totalEvent(observedTotalFen), false);
              return { kind: "stopped" as const, stopped: result(message) };
            }
          }
          if (cancellation.signal.aborted) return { kind: "monitor-cancelled" as const };
          const boundary = await checkTargetBoundary(`during ${label} DOM wait`);
          if (boundary) return { kind: "stopped" as const, stopped: boundary };
        }
      })();

      try {
        const winner = await Promise.race([domWait, monitor]);
        if (winner.kind === "monitor-cancelled") return await domWait;
        return winner;
      } finally {
        cancellation.abort();
        this.signal?.removeEventListener("abort", abortForRunner);
        void domWait.catch(() => undefined);
        void monitor.catch(() => undefined);
      }
    };

    try {
      await emit("PREWARM", "Opening the official visible page");
      let stopped = await checkTargetBoundary("before navigation", targetCheck.url.href);
      if (stopped) return stopped;
      let navigationFailed = false;
      let navigationError: unknown;
      try {
        await adapter.navigate(page, targetCheck.url.href);
      } catch (error) {
        navigationFailed = true;
        navigationError = error;
      }
      stopped = await checkTargetBoundary("after navigation");
      if (stopped) return stopped;
      if (navigationFailed) {
        const closed = browserContextClosedMessage(page, navigationError, "navigation");
        if (closed !== undefined) {
          return stopForGuard("PAGE_CHANGED", closed, observedTotalFen);
        }
        throw navigationError;
      }

      let inspection = await inspect("prewarm", "prewarm");
      if ("stopped" in inspection) return inspection.stopped;
      let signals = inspection.signals;
      let guard = adapter.guard(signals, "prewarm", request.plan);
      if (guard.blocked && guard.state) {
        // CAPTCHA and SOLD_OUT are legal PREWARM transitions and must stop
        // immediately; entering login/queue states would misreport reality.
        return stopForGuard(guard.state, guard.message ?? "Page guard stopped the run", guard.observedTotalFen);
      }

      await emit("LOGIN_READY", "Visible page is ready for the saved local session");
      await emit("WAIT_FOR_SALE", "Waiting for the sale window or an already-open event");
      stopped = await stopIfExternallyInactive();
      if (stopped) return stopped;
      if (request.mode === "live" && request.plan.saleAt && !signals.inOfficialQueue) {
        const saleTime = Date.parse(request.plan.saleAt);
        let waitFor = saleTime - this.now().getTime();
        while (Number.isFinite(saleTime) && waitFor > 0 && !signals.inOfficialQueue) {
          const wake = await waitForAdapterDomWake("sale", Math.max(1, waitFor), "sale");
          if (wake.kind === "unsupported") {
            // Unreviewed/legacy adapters retain the original serial fallback.
            await this.sleep(Math.min(waitFor, this.queuePollIntervalMs));
            stopped = await stopIfExternallyInactive();
            if (stopped) return stopped;
            stopped = await checkTargetBoundary("after waiting for sale time");
            if (stopped) return stopped;
          } else {
            if (wake.kind === "stopped") return wake.stopped;
            if (wake.kind === "dom" && wake.result.outcome === "aborted") throw new Error("RUN_ABORTED");
            stopped = await checkTargetBoundary("after event-driven sale wait");
            if (stopped) return stopped;
            if (wake.kind === "dom" && wake.result.outcome === "timeout") {
              waitFor = saleTime - this.now().getTime();
              continue;
            }
          }

          inspection = await inspect("prewarm", "sale wait");
          if ("stopped" in inspection) return inspection.stopped;
          signals = inspection.signals;
          guard = adapter.guard(signals, "prewarm", request.plan);
          if (guard.blocked && guard.state) {
            return stopForGuard(
              guard.state,
              guard.message ?? "Sale-wait guard stopped the run",
              guard.observedTotalFen
            );
          }
          if (
            wake.kind === "dom" &&
            wake.result.outcome === "matched" &&
            !signals.inOfficialQueue
          ) {
            return stopForGuard(
              "PAGE_CHANGED",
              `DOM_EVENT_UNCORROBORATED:${wake.result.key}`,
              guard.observedTotalFen
            );
          }
          waitFor = saleTime - this.now().getTime();
        }
      }

      await emit("OFFICIAL_QUEUE", "Following the visible official queue");
      let pendingQueueWakeKey: string | undefined;
      for (;;) {
        stopped = await stopIfExternallyInactive();
        if (stopped) return stopped;
        inspection = await inspect("queue", "queue");
        if ("stopped" in inspection) return inspection.stopped;
        signals = inspection.signals;
        guard = adapter.guard(signals, "queue", request.plan);
        if (guard.blocked && guard.state) {
          return stopForGuard(guard.state, guard.message ?? "Queue guard stopped the run", guard.observedTotalFen);
        }
        if (!signals.inOfficialQueue) break;
        if (pendingQueueWakeKey !== undefined) {
          return stopForGuard(
            "PAGE_CHANGED",
            `DOM_EVENT_UNCORROBORATED:${pendingQueueWakeKey}`,
            guard.observedTotalFen
          );
        }
        if (!safetyPolicy.allowOfficialQueueWait) {
          return stopForGuard(
            "HUMAN_TAKEOVER",
            "Official queue is active; only an explicitly confirmed live run may wait",
            guard.observedTotalFen
          );
        }
        const wake = await waitForAdapterDomWake(
          "queue",
          DEFAULT_QUEUE_DOM_WATCHDOG_MS,
          "official queue"
        );
        if (wake.kind === "unsupported") {
          await this.sleep(this.queuePollIntervalMs);
          stopped = await stopIfExternallyInactive();
          if (stopped) return stopped;
          stopped = await checkTargetBoundary("during official queue wait");
          if (stopped) return stopped;
          continue;
        }
        if (wake.kind === "stopped") return wake.stopped;
        if (wake.kind === "dom") {
          if (wake.result.outcome === "aborted") throw new Error("RUN_ABORTED");
          if (wake.result.outcome === "matched") pendingQueueWakeKey = wake.result.key;
        }
        stopped = await checkTargetBoundary("after event-driven official queue wait");
        if (stopped) return stopped;
      }

      // Dry-run is inspection-only. It records planned checkpoints while
      // guaranteeing that no selection or submit adapter method is called.
      if (!safetyPolicy.allowSelection) {
        for (const item of ACTION_PHASES) {
          await emit(item.state, `Dry-run checkpoint: ${item.phase}; no control was clicked`);
        }
        await emit("VERIFY_PRICE", "Dry-run ends at price verification; no order can be submitted");
        inspection = await inspect("verify", "dry-run price");
        if ("stopped" in inspection) return inspection.stopped;
        signals = inspection.signals;
        guard = adapter.guard(signals, "verify", request.plan);
        if (guard.blocked && guard.state) {
          return stopForGuard(guard.state, guard.message ?? "Price guard stopped the dry-run", guard.observedTotalFen);
        }
        observedTotalFen = guard.observedTotalFen;
        if (observedTotalFen === undefined) {
          return stopForGuard("PAGE_CHANGED", "A verified visible total was not returned", undefined);
        }
        await emit("VERIFY_PRICE", "Immutable dry-run price snapshot recorded", totalEvent(observedTotalFen));
        const message = "Dry-run complete; human review is required before any submission";
        await emit("REVIEW_REQUIRED", message, totalEvent(observedTotalFen));
        return result(message);
      }

      const context = { page, plan: request.plan };
      for (const item of ACTION_PHASES) {
        await emit(item.state, `Entering ${item.phase} selection`);
        inspection = await inspect(item.phase, item.phase);
        if ("stopped" in inspection) return inspection.stopped;
        signals = inspection.signals;
        guard = adapter.guard(signals, item.phase, request.plan);
        if (guard.blocked && guard.state) {
          return stopForGuard(guard.state, guard.message ?? `${item.phase} guard stopped the run`, guard.observedTotalFen);
        }

        stopped = await checkTargetBoundary(`before ${item.phase} action`);
        if (stopped) return stopped;
        const action = adapter[item.action] as (ctx: typeof context) => Promise<AdapterStepResult>;
        let actionResult: AdapterStepResult | undefined;
        let actionError: unknown;
        try {
          actionResult = await action.call(adapter, context);
        } catch (error) {
          actionError = error;
        }
        stopped = await checkTargetBoundary(`after ${item.phase} action`);
        if (stopped) return stopped;
        if (actionResult === undefined) {
          const closed = browserContextClosedMessage(page, actionError, `${item.phase} action`);
          if (closed !== undefined) {
            return stopForGuard("PAGE_CHANGED", closed, observedTotalFen);
          }
          const actionMessage = item.phase === "attendee"
            ? "Attendee selection failed; sensitive attendee details were suppressed"
            : `Action failed:${actionError instanceof Error ? actionError.message : "unexpected adapter error"}`;
          return stopForGuard("FAILED", actionMessage, observedTotalFen);
        }
        if (!actionResult.ok) {
          return stopForGuard(
            actionResult.blockedState ?? "PAGE_CHANGED",
            item.phase === "attendee"
              ? "Attendee selection was not verified; sensitive attendee details were suppressed"
              : actionResult.message,
            observedTotalFen
          );
        }
        if (item.state === "SELECT_SESSION" && actionResult.selectedLabel) selectedSession = actionResult.selectedLabel;
        if (item.state === "SELECT_TIER" && actionResult.selectedLabel) selectedTier = actionResult.selectedLabel;
        if (item.state === "SELECT_QUANTITY" && actionResult.adjacentVerified !== undefined) {
          adjacentVerified = actionResult.adjacentVerified;
        }

        // Record only non-sensitive selection evidence. In particular, the
        // attendee action's selectedLabel may contain a real name and must
        // never be copied into runner events or audit storage.
        await emit(item.state, `${item.phase} selection evidence recorded`, {
          ...(selectedSession === undefined ? {} : { selectedSession }),
          ...(selectedTier === undefined ? {} : { selectedTier }),
          ...(adjacentVerified === undefined ? {} : { adjacentVerified }),
          ...(actionResult.selectionFingerprint === undefined
            ? {}
            : { selectionFingerprint: actionResult.selectionFingerprint })
        });
      }

      await emit("VERIFY_PRICE", "Verifying one unambiguous visible order total", {
        ...(selectedSession === undefined ? {} : { selectedSession }),
        ...(selectedTier === undefined ? {} : { selectedTier }),
        ...(adjacentVerified === undefined ? {} : { adjacentVerified })
      });
      inspection = await inspect("verify", "initial price");
      if ("stopped" in inspection) return inspection.stopped;
      signals = inspection.signals;
      guard = adapter.guard(signals, "verify", request.plan);
      if (guard.blocked && guard.state) {
        return stopForGuard(guard.state, guard.message ?? "Price guard stopped the run", guard.observedTotalFen);
      }
      observedTotalFen = guard.observedTotalFen;
      if (observedTotalFen === undefined) {
        return stopForGuard("PAGE_CHANGED", "A verified visible total was not returned", undefined);
      }
      await emit("VERIFY_PRICE", "Immutable price snapshot recorded", {
        observedTotalFen,
        ...(selectedSession === undefined ? {} : { selectedSession }),
        ...(selectedTier === undefined ? {} : { selectedTier }),
        ...(adjacentVerified === undefined ? {} : { adjacentVerified })
      });

      // Mock and rehearsal modes can never authorize or submit, regardless of
      // plan.autoSubmitOrder or a supplied authorization hook. Rehearsal is
      // deliberately allowed to reach this point using the visible live
      // profile so selectors and checkout evidence can be reviewed safely.
      if (!safetyPolicy.allowSubmitAuthorization || !safetyPolicy.allowSubmitOrder) {
        const message = request.mode === "rehearsal"
          ? "Rehearsal complete; submit authorization and order submission are unavailable"
          : "Mock mode complete; live submission is unconditionally disabled";
        await emit("REVIEW_REQUIRED", message, totalEvent(observedTotalFen));
        return result(message);
      }
      if (!request.plan.autoSubmitOrder) {
        const message = "Automatic submission is disabled by plan policy";
        await emit("REVIEW_REQUIRED", message, totalEvent(observedTotalFen));
        return result(message);
      }
      const approvedSession = selectedSession?.trim();
      const approvedTier = selectedTier?.trim();
      if (!approvedSession || !approvedTier || adjacentVerified !== true) {
        return stopForGuard(
          "PAGE_CHANGED",
          "SUBMIT_SELECTION_EVIDENCE_MISSING:session, tier and quantity evidence are required",
          observedTotalFen
        );
      }

      // Re-read the visible checkout state immediately before authorization.
      // Any price change, even a decrease, invalidates the immutable snapshot.
      inspection = await inspect("submit", "final price");
      if ("stopped" in inspection) return inspection.stopped;
      signals = inspection.signals;
      guard = adapter.guard(signals, "submit", request.plan);
      if (guard.blocked && guard.state) {
        return stopForGuard(guard.state, guard.message ?? "Final price guard stopped the run", guard.observedTotalFen);
      }
      if (guard.observedTotalFen === undefined || guard.observedTotalFen !== observedTotalFen) {
        return stopForGuard(
          "PAGE_CHANGED",
          `PRICE_SNAPSHOT_CHANGED:${observedTotalFen}->${guard.observedTotalFen ?? "missing"}`,
          guard.observedTotalFen
        );
      }

      if (!this.authorizeSubmit) {
        return stopForGuard(
          "HUMAN_TAKEOVER",
          "SUBMIT_GATE_MISSING:controller approval is required before a live click",
          observedTotalFen
        );
      }
      const approval = await this.authorizeSubmit({
        runId: request.runId,
        plan: request.plan,
        observedTotalFen
      });
      if (!approval.allowed) {
        return stopForGuard(
          approval.state ?? "HUMAN_TAKEOVER",
          approval.message ?? "Controller denied the live submit",
          observedTotalFen
        );
      }
      const approvedTotalFen = approval.approvedTotalFen;
      if (
        !Number.isSafeInteger(approvedTotalFen) ||
        approvedTotalFen < 0 ||
        approvedTotalFen !== observedTotalFen
      ) {
        return stopForGuard(
          "HUMAN_TAKEOVER",
          `CONTROLLER_APPROVAL_TOTAL_MISMATCH:${observedTotalFen}->${approvedTotalFen}`,
          observedTotalFen
        );
      }

      // Authorization is an asynchronous boundary. Re-inspect after the
      // controller has acquired its lock so that no DOM or price change in
      // that window can inherit a stale approval.
      inspection = await inspect("submit", "post-authorization final price");
      if ("stopped" in inspection) return inspection.stopped;
      signals = inspection.signals;
      guard = adapter.guard(signals, "submit", request.plan);
      if (guard.blocked && guard.state) {
        return stopForGuard(
          guard.state,
          guard.message ?? "Post-authorization price guard stopped the run",
          guard.observedTotalFen
        );
      }
      if (guard.observedTotalFen === undefined || guard.observedTotalFen !== approvedTotalFen) {
        return stopForGuard(
          "PAGE_CHANGED",
          `POST_AUTH_PRICE_SNAPSHOT_CHANGED:${approvedTotalFen}->${guard.observedTotalFen ?? "missing"}`,
          guard.observedTotalFen
        );
      }

      // Authorization happens before both the local SUBMIT_ORDER event and DOM call.
      // The authorize endpoint already records SUBMIT_ORDER and acquires the
      // controller lock, so this local event must not be replayed as an
      // ordinary runner event.
      // Re-check once after the potentially asynchronous controller round trip,
      // and again after onEvent has observed SUBMIT_ORDER.
      stopped = await checkTargetBoundary("after submit authorization");
      if (stopped) return stopped;
      await emit(
        "SUBMIT_ORDER",
        "Submitting exactly once through the visible official page",
        {
          observedTotalFen: approvedTotalFen,
          ...(selectedSession === undefined ? {} : { selectedSession }),
          ...(selectedTier === undefined ? {} : { selectedTier }),
          ...(adjacentVerified === undefined ? {} : { adjacentVerified })
        },
        false
      );
      stopped = await checkTargetBoundary("before submit action");
      if (stopped) return stopped;
      let submitted: AdapterStepResult | undefined;
      try {
        submitted = await adapter.submitOrder({
          ...context,
          approvedTotalFen,
          selectedSession: approvedSession,
          selectedTier: approvedTier,
          adjacentVerified
        });
      } catch {
        // The click may already have happened. Its outcome must be treated as
        // uncertain without copying arbitrary adapter errors into audit logs.
      }
      stopped = await checkTargetBoundary("after submit action");
      if (stopped) return stopped;
      if (submitted === undefined) {
        return stopForGuard(
          "HUMAN_TAKEOVER",
          "SUBMIT_ACTION_FAILED:order outcome is uncertain; inspect the visible official page",
          observedTotalFen
        );
      }
      if (!submitted.ok) {
        return stopForGuard(
          submitted.blockedState ?? "PAGE_CHANGED",
          submitted.message,
          observedTotalFen
        );
      }

      const confirmedReference = submitted.orderReference?.trim();
      if (submitted.paymentRequired !== true || !confirmedReference) {
        return stopForGuard(
          "HUMAN_TAKEOVER",
          "SUBMIT_OUTCOME_UNCONFIRMED:visible payment state and order reference are both required",
          observedTotalFen
        );
      }
      orderReference = confirmedReference;
      const message = "Order submitted; payment remains a human action";
      await emit("PAY_REQUIRED", message, { observedTotalFen, orderReference });
      return result(message);
    } catch (error) {
      const closed = browserContextClosedMessage(page, error, "runner");
      if (closed !== undefined) {
        try {
          return await stopForGuard("PAGE_CHANGED", closed, observedTotalFen);
        } catch {
          return result(closed);
        }
      }
      const message = `RUNNER_FAILED:${error instanceof Error ? error.message : "RUNNER_UNEXPECTED_ERROR"}`;
      if (canTransition(current, "FAILED")) {
        try {
          await emit("FAILED", message);
        } catch {
          // If the event sink itself is unavailable, keep the last locally
          // recorded state rather than returning a contradictory state.
        }
      }
      return result(message);
    }
  }
}

export async function runLocal(
  request: LocalRunnerRequest,
  options: LocalRunnerOptions = {}
): Promise<LocalRunnerResult> {
  return new LocalRunner(options).run(request);
}
