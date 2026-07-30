import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Page } from "playwright-core";

import { guardPage } from "../src/adapters/signals.js";
import type {
  AdapterContext,
  AdapterDomPredicate,
  AdapterDomWaitPhase,
  AdapterPhase,
  AdapterStepResult,
  ApprovedSubmitContext,
  GuardDecision,
  PageSignals,
  TicketPlatformAdapter
} from "../src/adapters/types.js";
import type { WatchPlan } from "../src/core/types.js";
import { parseAttendeeRef } from "../src/identity/attendee-ref.js";
import { DEFAULT_MAC_CHROME_PATH, macChromeLaunchOptions, resolveMacProfileDir } from "../src/runner/browser.js";
import { assertRehearsalPlanBinding, parseRunnerArgs, waitForPrewarmWindow } from "../src/runner/cli.js";
import { LocalRunner, prewarmDelayMs } from "../src/runner/executor.js";
import type { LocalRunnerResult } from "../src/runner/types.js";
import { checkObservedTarget, checkRunTarget, runnerSafetyPolicy } from "../src/runner/safety.js";

const TEST_ATTENDEE_REF = parseAttendeeRef("attendee:v1:123e4567-e89b-42d3-a456-426614174000");

function plan(overrides: Partial<WatchPlan> = {}): WatchPlan {
  const now = "2026-07-28T00:00:00.000Z";
  return {
    id: "plan-runner-1",
    platform: "damai",
    quantity: 1,
    requireAdjacent: false,
    sessions: [],
    tiers: [],
    priceStrategy: "CHEAPEST_FIRST",
    attendeeRefs: [],
    attendeeAliases: [],
    autoSubmitOrder: false,
    status: "ARMED",
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function autoLivePlan(overrides: Partial<WatchPlan> = {}): WatchPlan {
  return plan({
    officialUrl: "https://detail.damai.cn/item.htm?id=123",
    eventId: "123",
    eventTitle: "Mock event",
    canonicalEventKey: "mock-event-123",
    saleAt: "2026-07-30T00:00:00.000Z",
    maxTotalFen: 50_000,
    attendeeRefs: [TEST_ATTENDEE_REF],
    attendeeAliases: ["本人"],
    autoSubmitOrder: true,
    ...overrides
  });
}

function signals(overrides: Partial<PageSignals> = {}): PageSignals {
  return {
    url: "https://detail.damai.cn/item.htm?id=123",
    title: "Mock event",
    eventId: "123",
    eventTitle: "Mock event",
    readable: true,
    captchaRequired: false,
    loginRequired: false,
    soldOut: false,
    inOfficialQueue: false,
    price: { kind: "unique", valuesFen: [38_000], totalFen: 38_000 },
    evidence: [],
    ...overrides
  };
}

type MutableFakePage = Page & { setUrl(url: string): void };

type EventDrivenFakePage = MutableFakePage & { readonly evaluateCount: number };

function fakePage(initialUrl = "about:blank"): MutableFakePage {
  let currentUrl = initialUrl;
  return {
    url: () => currentUrl,
    setUrl: (url: string) => { currentUrl = url; }
  } as unknown as MutableFakePage;
}

function eventDrivenFakePage(
  onEvaluate: () => unknown,
  initialUrl = "about:blank"
): EventDrivenFakePage {
  let currentUrl = initialUrl;
  let evaluateCount = 0;
  return {
    url: () => currentUrl,
    setUrl: (url: string) => { currentUrl = url; },
    get evaluateCount() { return evaluateCount; },
    evaluate: async () => {
      evaluateCount += 1;
      return onEvaluate();
    }
  } as unknown as EventDrivenFakePage;
}

function assertResultConsistent(result: LocalRunnerResult): void {
  assert.equal(result.events.at(-1)?.state, result.state);
}

class FakeDamaiAdapter implements TicketPlatformAdapter {
  readonly platform = "damai" as const;
  readonly implemented = true;
  readonly liveReady: boolean;
  navigateCount = 0;
  actionCount = 0;
  submitCount = 0;
  inspectCount = 0;
  currentSignals = signals();
  navigateUrlOverride: string | undefined;
  signalUrlOverride: string | undefined;
  submitResult: AdapterStepResult = {
    ok: true,
    message: "visible order confirmation",
    paymentRequired: true,
    orderReference: "order-test-1"
  };
  actionResults: Partial<Record<Extract<AdapterPhase, "session" | "tier" | "quantity" | "attendee">, AdapterStepResult>> = {};
  onInspect: ((context: AdapterContext, phase: AdapterPhase, count: number) => void) | undefined;
  onAction: ((context: AdapterContext, phase: Extract<AdapterPhase, "session" | "tier" | "quantity" | "attendee">) => void) | undefined;
  onSubmit: ((context: ApprovedSubmitContext) => void) | undefined;

  constructor(liveReady = true) {
    this.liveReady = liveReady;
  }

  supportsOfficialUrl(url: URL): boolean {
    return url.hostname.endsWith("damai.cn");
  }

  async navigate(page: Page, url: string): Promise<void> {
    this.navigateCount += 1;
    (page as MutableFakePage).setUrl(this.navigateUrlOverride ?? url);
  }

  async inspect(context: AdapterContext, phase: AdapterPhase): Promise<PageSignals> {
    this.inspectCount += 1;
    this.onInspect?.(context, phase, this.inspectCount);
    return {
      ...this.currentSignals,
      url: this.signalUrlOverride ?? context.page.url()
    };
  }

  guard(pageSignals: PageSignals, phase: AdapterPhase, watchPlan: WatchPlan): GuardDecision {
    return guardPage(pageSignals, phase, watchPlan);
  }

  domWaitPredicates(_phase: AdapterDomWaitPhase): readonly AdapterDomPredicate[] {
    return [];
  }

  private action(
    context: AdapterContext,
    phase: Extract<AdapterPhase, "session" | "tier" | "quantity" | "attendee">
  ): AdapterStepResult {
    this.actionCount += 1;
    this.onAction?.(context, phase);
    return this.actionResults[phase] ?? (
      phase === "session"
        ? { ok: true, message: "fake action", selectedLabel: "默认场次" }
        : phase === "tier"
          ? { ok: true, message: "fake action", selectedLabel: "最低票档" }
          : phase === "quantity"
            ? { ok: true, message: "fake action", selectedLabel: "1", adjacentVerified: true }
            : { ok: true, message: "fake action" }
    );
  }

  async selectSession(context: AdapterContext): Promise<AdapterStepResult> { return this.action(context, "session"); }
  async selectTier(context: AdapterContext): Promise<AdapterStepResult> { return this.action(context, "tier"); }
  async selectQuantity(context: AdapterContext): Promise<AdapterStepResult> { return this.action(context, "quantity"); }
  async selectAttendees(context: AdapterContext): Promise<AdapterStepResult> { return this.action(context, "attendee"); }
  async submitOrder(context: ApprovedSubmitContext): Promise<AdapterStepResult> {
    this.submitCount += 1;
    this.onSubmit?.(context);
    return this.submitResult;
  }
}

class EventDrivenFakeDamaiAdapter extends FakeDamaiAdapter {
  override domWaitPredicates(_phase: AdapterDomWaitPhase): readonly AdapterDomPredicate[] {
    return [{ key: "visible-state-change", selector: "[data-visible-state-change]" }];
  }
}

test("runner mode is explicit and live mode requires a second confirmation", () => {
  assert.throws(() => parseRunnerArgs([]), /explicit/);
  assert.throws(() => parseRunnerArgs(["--live"]), /confirm-live/);
  assert.equal(parseRunnerArgs(["--dry-run"]).mode, "dry-run");
  assert.equal(parseRunnerArgs(["--live", "--confirm-live"]).mode, "live");
});

test("rehearsal requires its own confirmation and excludes live/controller capabilities", () => {
  const planPath = "examples/damai-iwwf-readonly-plan.json";
  assert.throws(() => parseRunnerArgs(["--rehearsal", "--plan", planPath]), /confirm-rehearsal/);
  assert.equal(
    parseRunnerArgs(["--rehearsal", "--confirm-rehearsal", "--plan", planPath]).mode,
    "rehearsal"
  );
  assert.throws(
    () => parseRunnerArgs(["--rehearsal", "--confirm-rehearsal", "--confirm-live", "--plan", planPath]),
    /cannot be combined with --confirm-live/
  );
  assert.throws(
    () => parseRunnerArgs([
      "--rehearsal",
      "--confirm-rehearsal",
      "--plan",
      planPath,
      "--controller-url",
      "http://127.0.0.1:4317"
    ]),
    /cannot be combined with controller/
  );
  assert.throws(
    () => parseRunnerArgs(["--rehearsal", "--live", "--confirm-rehearsal", "--plan", planPath]),
    /Choose exactly one runner mode/
  );
});

test("rehearsal requires a plan-bound event ID and exact official URL", () => {
  const bound = plan({ officialUrl: "https://detail.damai.cn/item.htm?id=123", eventId: "123" });
  assert.doesNotThrow(() => assertRehearsalPlanBinding(bound));
  assert.doesNotThrow(() => assertRehearsalPlanBinding(bound, bound.officialUrl));
  assert.throws(
    () => assertRehearsalPlanBinding(plan({ eventId: "123" })),
    /REHEARSAL_EVENT_BINDING_REQUIRED/
  );
  assert.throws(
    () => assertRehearsalPlanBinding(plan({ officialUrl: bound.officialUrl! })),
    /REHEARSAL_EVENT_BINDING_REQUIRED/
  );
  assert.throws(
    () => assertRehearsalPlanBinding(bound, "https://detail.damai.cn/item.htm?id=456"),
    /REHEARSAL_TARGET_MISMATCH/
  );
});

test("target policy permits only loopback mocks and matching official live URLs", () => {
  const p = plan({ officialUrl: "https://detail.damai.cn/item.htm?id=123" });
  assert.equal(checkRunTarget(p, "dry-run", undefined).ok, true);
  assert.equal(checkRunTarget(p, "mock", "http://127.0.0.1:48732/damai/normal").ok, true);
  assert.equal(checkRunTarget(p, "mock", "https://example.com/damai/normal").ok, false);
  assert.equal(checkRunTarget(p, "live", "https://damai.cn.example.com/item/123").ok, false);
  assert.equal(checkRunTarget(p, "live", p.officialUrl).ok, true);
  assert.equal(checkRunTarget(p, "live", "https://www.damai.cn/other").ok, false);
  assert.equal(checkObservedTarget(p, "live", "https://buy.damai.cn/order/1").ok, true);
  assert.equal(checkObservedTarget(p, "live", "https://damai.cn.example.com/order/1").ok, false);
  assert.equal(checkObservedTarget(p, "mock", "http://localhost:4173/damai/normal").ok, true);
  assert.equal(checkObservedTarget(p, "mock", "https://detail.damai.cn/item.htm?id=123").ok, false);
});

test("rehearsal policy uses the live profile and official host without submit or controller capabilities", () => {
  const p = plan({ officialUrl: "https://detail.damai.cn/item.htm?id=123" });
  const policy = runnerSafetyPolicy("rehearsal");
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(policy.profileScope, "live");
  assert.equal(policy.allowSelection, true);
  assert.equal(policy.allowController, false);
  assert.equal(policy.allowSubmitAuthorization, false);
  assert.equal(policy.allowSubmitOrder, false);
  assert.equal(policy.requireLiveReady, false);

  assert.equal(checkRunTarget(p, "rehearsal", p.officialUrl).ok, true);
  assert.equal(checkRunTarget(p, "rehearsal", "http://127.0.0.1:4173/damai/normal").ok, false);
  assert.equal(checkRunTarget(p, "rehearsal", "https://www.damai.cn/other").ok, false);
  assert.equal(checkRunTarget(p, "rehearsal", "https://damai.cn.example.com/item/123").ok, false);
  assert.equal(checkObservedTarget(p, "rehearsal", "https://buy.damai.cn/order/1").ok, true);
  assert.equal(checkObservedTarget(p, "rehearsal", "https://example.com/phish").ok, false);
});

test("mac runner defaults to Chrome and a dedicated TicketAgent profile", () => {
  const launch = macChromeLaunchOptions({ profileDir: "~/Library/Application Support/TicketAgent/TestProfile" });
  assert.equal(launch.executablePath, DEFAULT_MAC_CHROME_PATH);
  assert.equal(launch.headless, false);
  assert.match(launch.userDataDir, /TicketAgent\/TestProfile$/);
  assert.throws(
    () => resolveMacProfileDir(path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome", "Default")),
    /PROFILE_BLOCKED/
  );
});

test("a no-link dry-run validates policy without a browser or network target", async () => {
  const result = await new LocalRunner().run({ runId: "run-no-url", plan: plan(), mode: "dry-run" });
  assert.equal(result.state, "REVIEW_REQUIRED");
  assert.equal(result.events.length, 1);
  assertResultConsistent(result);
});

test("a distant live sale remains SCHEDULED before opening a browser", async () => {
  const adapter = new FakeDamaiAdapter();
  const now = new Date("2026-07-30T00:00:00.000Z");
  const futurePlan = plan({
    officialUrl: "https://detail.damai.cn/item.htm?id=123",
    saleAt: "2026-07-30T00:30:00.000Z"
  });
  assert.equal(prewarmDelayMs(futurePlan, "live", now), 20 * 60 * 1_000);

  const result = await new LocalRunner({ adapter, now: () => now }).run({
    runId: "run-future-sale",
    plan: futurePlan,
    mode: "live"
  });

  assert.equal(result.state, "SCHEDULED");
  assert.match(result.message, /^SCHEDULED_UNTIL_PREWARM:/);
  assert.equal(result.events.length, 0, "the controller must remain in its original SCHEDULED state");
  assert.equal(adapter.navigateCount, 0);
  assert.equal(adapter.inspectCount, 0);
});

test("a live run inside prewarm keeps the visible page open until saleAt", async () => {
  const adapter = new FakeDamaiAdapter();
  let nowMs = Date.parse("2026-07-30T00:00:00.000Z");
  const sleeps: number[] = [];
  const result = await new LocalRunner({
    page: fakePage(),
    adapter,
    now: () => new Date(nowMs),
    sleep: (milliseconds) => {
      sleeps.push(milliseconds);
      nowMs += milliseconds;
    }
  }).run({
    runId: "run-prewarm-wait",
    plan: plan({
      officialUrl: "https://detail.damai.cn/item.htm?id=123",
      saleAt: "2026-07-30T00:00:05.000Z"
    }),
    mode: "live"
  });

  assert.deepEqual(sleeps, [2_000, 2_000, 1_000]);
  assert.equal(result.state, "REVIEW_REQUIRED");
  assert.ok(result.events.some((event) => event.state === "WAIT_FOR_SALE"));
  assert.ok(result.events.some((event) => event.state === "OFFICIAL_QUEUE"));
  assertResultConsistent(result);
});

test("sale waiting aborts promptly and persists a recoverable FAILED state", async () => {
  const adapter = new FakeDamaiAdapter();
  const abortController = new AbortController();
  const result = await new LocalRunner({
    page: fakePage(),
    adapter,
    now: () => new Date("2026-07-30T00:00:00.000Z"),
    signal: abortController.signal,
    sleep: () => { abortController.abort(); }
  }).run({
    runId: "run-prewarm-abort",
    plan: plan({
      officialUrl: "https://detail.damai.cn/item.htm?id=123",
      saleAt: "2026-07-30T00:00:05.000Z"
    }),
    mode: "live"
  });

  assert.equal(result.state, "FAILED");
  assert.match(result.message, /RUN_ABORTED/);
  assert.equal(adapter.actionCount, 0);
  assertResultConsistent(result);
});

test("controller event delivery is retried before local state advances", async () => {
  let attempts = 0;
  const result = await new LocalRunner({
    onEvent: () => {
      attempts += 1;
      if (attempts < 3) throw new Error("temporary controller outage");
    }
  }).run({ runId: "run-event-retry", plan: plan(), mode: "dry-run" });

  assert.equal(attempts, 3);
  assert.equal(result.state, "REVIEW_REQUIRED");
  assertResultConsistent(result);
});

test("the CLI prewarm coordinator waits in slices and is cancellable", async () => {
  let nowMs = Date.parse("2026-07-30T00:00:00.000Z");
  let checks = 0;
  const sleeps: number[] = [];
  const signal = new AbortController().signal;
  await waitForPrewarmWindow(
    { saleAt: "2026-07-30T00:10:03.000Z" },
    {
      signal,
      now: () => new Date(nowMs),
      checkIntervalMs: 2_000,
      checkScheduled: () => { checks += 1; },
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        nowMs += milliseconds;
      }
    }
  );
  assert.deepEqual(sleeps, [2_000, 1_000]);
  assert.equal(checks, 2);

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    () => waitForPrewarmWindow({ saleAt: "2026-07-30T01:00:00.000Z" }, { signal: aborted.signal }),
    /RUN_ABORTED/
  );
});

test("a live official queue is polled serially without navigation or refresh", async () => {
  const adapter = new FakeDamaiAdapter();
  adapter.currentSignals = signals({ inOfficialQueue: true });
  let queueInspects = 0;
  adapter.onInspect = (_context, phase) => {
    if (phase === "queue") queueInspects += 1;
  };
  const sleeps: number[] = [];
  const result = await new LocalRunner({
    page: fakePage(),
    adapter,
    queuePollIntervalMs: 1_234,
    sleep: (milliseconds) => {
      sleeps.push(milliseconds);
      adapter.currentSignals = signals({ inOfficialQueue: false });
    }
  }).run({
    runId: "run-visible-queue",
    plan: plan({ officialUrl: "https://detail.damai.cn/item.htm?id=123" }),
    mode: "live"
  });

  assert.deepEqual(sleeps, [1_234]);
  assert.equal(queueInspects, 2);
  assert.equal(adapter.navigateCount, 1, "the queue loop must not navigate or refresh");
  assert.equal(result.state, "REVIEW_REQUIRED");
  assertResultConsistent(result);
});

test("an adapter DOM event exits the queue without fixed-delay sleep or refresh", async () => {
  const adapter = new EventDrivenFakeDamaiAdapter();
  adapter.currentSignals = signals({ inOfficialQueue: true });
  let queueInspects = 0;
  adapter.onInspect = (_context, phase) => {
    if (phase === "queue") queueInspects += 1;
  };
  const page = eventDrivenFakePage(() => {
    adapter.currentSignals = signals({ inOfficialQueue: false });
    return {
      outcome: "matched",
      key: "visible-state-change",
      visibility: "visible",
      source: "mutation"
    };
  });
  let fixedSleeps = 0;
  const result = await new LocalRunner({
    page,
    adapter,
    sleep: () => { fixedSleeps += 1; }
  }).run({
    runId: "run-event-driven-queue",
    plan: plan({ officialUrl: "https://detail.damai.cn/item.htm?id=123" }),
    mode: "live"
  });

  assert.equal(page.evaluateCount, 1);
  assert.equal(fixedSleeps, 0);
  assert.equal(queueInspects, 2);
  assert.equal(adapter.navigateCount, 1, "event-driven waiting must not navigate or refresh");
  assert.equal(result.state, "REVIEW_REQUIRED");
  assertResultConsistent(result);
});

test("an uncorroborated adapter DOM event fails closed instead of spinning", async () => {
  const adapter = new EventDrivenFakeDamaiAdapter();
  adapter.currentSignals = signals({ inOfficialQueue: true });
  const page = eventDrivenFakePage(() => ({
    outcome: "matched",
    key: "visible-state-change",
    visibility: "visible",
    source: "mutation"
  }));
  const result = await new LocalRunner({ page, adapter }).run({
    runId: "run-uncorroborated-dom-event",
    plan: plan({ officialUrl: "https://detail.damai.cn/item.htm?id=123" }),
    mode: "live"
  });

  assert.equal(page.evaluateCount, 1);
  assert.equal(result.state, "PAGE_CHANGED");
  assert.match(result.message, /DOM_EVENT_UNCORROBORATED:visible-state-change/);
  assert.equal(adapter.actionCount, 0);
  assertResultConsistent(result);
});

test("event-driven sale deadline avoids repeated pre-sale DOM inspection", async () => {
  const adapter = new EventDrivenFakeDamaiAdapter();
  const saleAt = Date.parse("2026-07-30T00:00:05.000Z");
  let nowMs = Date.parse("2026-07-30T00:00:00.000Z");
  let prewarmInspects = 0;
  adapter.onInspect = (_context, phase) => {
    if (phase === "prewarm") prewarmInspects += 1;
  };
  const page = eventDrivenFakePage(() => {
    nowMs = saleAt;
    return { outcome: "timeout", source: "timeout" };
  });
  let fixedSleeps = 0;
  const result = await new LocalRunner({
    page,
    adapter,
    now: () => new Date(nowMs),
    sleep: () => { fixedSleeps += 1; }
  }).run({
    runId: "run-event-driven-sale-deadline",
    plan: plan({
      officialUrl: "https://detail.damai.cn/item.htm?id=123",
      saleAt: new Date(saleAt).toISOString()
    }),
    mode: "live"
  });

  assert.equal(page.evaluateCount, 1);
  assert.equal(fixedSleeps, 0);
  assert.equal(prewarmInspects, 1, "deadline timeout must not trigger 2-second full-page scans");
  assert.equal(result.state, "REVIEW_REQUIRED");
  assertResultConsistent(result);
});

test("controller-side cancellation stops an otherwise permanent queue", async () => {
  const adapter = new FakeDamaiAdapter();
  adapter.currentSignals = signals({ inOfficialQueue: true });
  let checks = 0;
  const result = await new LocalRunner({
    page: fakePage(),
    adapter,
    sleep: () => undefined,
    checkRunActive: () => {
      checks += 1;
      return checks < 3
        ? { active: true }
        : { active: false, message: "controller state is FAILED" };
    }
  }).run({
    runId: "run-queue-cancelled",
    plan: plan({ officialUrl: "https://detail.damai.cn/item.htm?id=123" }),
    mode: "live"
  });

  assert.equal(result.state, "FAILED");
  assert.match(result.message, /RUN_NO_LONGER_ACTIVE/);
  assert.equal(adapter.actionCount, 0);
  assertResultConsistent(result);
});

test("an inspection-only run never exits in an active official queue state", async () => {
  const adapter = new FakeDamaiAdapter();
  adapter.currentSignals = signals({ inOfficialQueue: true });
  let slept = false;
  const result = await new LocalRunner({
    page: fakePage(),
    adapter,
    sleep: () => { slept = true; }
  }).run({
    runId: "run-mock-queue",
    plan: plan({ officialUrl: "https://detail.damai.cn/item.htm?id=123" }),
    mode: "mock",
    targetUrl: "http://127.0.0.1:4173/damai/queue"
  });

  assert.equal(result.state, "HUMAN_TAKEOVER");
  assert.equal(slept, false);
  assert.equal(adapter.actionCount, 0);
  assertResultConsistent(result);
});

test("dry-run may inspect a page but never performs selection or submit actions", async () => {
  const adapter = new FakeDamaiAdapter();
  const result = await new LocalRunner({ page: fakePage(), adapter }).run({
    runId: "run-dry",
    plan: plan({ officialUrl: "https://detail.damai.cn/item.htm?id=123" }),
    mode: "dry-run"
  });
  assert.equal(result.state, "REVIEW_REQUIRED");
  assert.equal(result.observedTotalFen, 38_000);
  assert.equal(adapter.navigateCount, 1);
  assert.equal(adapter.actionCount, 0);
  assert.equal(adapter.submitCount, 0);
  assert.equal(result.events.some((event) => event.state === "SUBMIT_ORDER"), false);
  assertResultConsistent(result);
});

test("prewarm captcha stops immediately without entering login or queue states", async () => {
  const adapter = new FakeDamaiAdapter();
  adapter.currentSignals = signals({ captchaRequired: true });
  const result = await new LocalRunner({ page: fakePage(), adapter }).run({
    runId: "run-captcha",
    plan: plan({ officialUrl: "https://detail.damai.cn/item.htm?id=123" }),
    mode: "mock",
    targetUrl: "http://127.0.0.1:4173/damai/captcha"
  });
  assert.equal(result.state, "CAPTCHA_REQUIRED");
  assert.equal(result.events.at(-1)?.state, "CAPTCHA_REQUIRED");
  assert.equal(adapter.inspectCount, 1);
  assert.equal(adapter.actionCount, 0);
  assert.equal(result.events.some((event) => event.state === "LOGIN_READY"), false);
  assert.equal(result.events.some((event) => event.state === "OFFICIAL_QUEUE"), false);
  assertResultConsistent(result);
});

test("prewarm sold-out also stops immediately", async () => {
  const adapter = new FakeDamaiAdapter();
  adapter.currentSignals = signals({ soldOut: true });
  const result = await new LocalRunner({ page: fakePage(), adapter }).run({
    runId: "run-sold-out",
    plan: plan({ officialUrl: "https://detail.damai.cn/item.htm?id=123" }),
    mode: "mock",
    targetUrl: "http://127.0.0.1:4173/damai/sold-out"
  });
  assert.equal(result.state, "SOLD_OUT");
  assert.equal(adapter.inspectCount, 1);
  assert.equal(adapter.actionCount, 0);
  assertResultConsistent(result);
});

test("LocalRunner itself rejects a live adapter that has not been reviewed", async () => {
  const adapter = new FakeDamaiAdapter(false);
  const result = await new LocalRunner({ page: fakePage(), adapter }).run({
    runId: "run-live-not-ready",
    plan: plan({ officialUrl: "https://detail.damai.cn/item.htm?id=123" }),
    mode: "live"
  });
  assert.equal(result.state, "FAILED");
  assert.match(result.message, /LIVE_ADAPTER_NOT_READY/);
  assert.equal(adapter.navigateCount, 0);
  assertResultConsistent(result);
});

test("rehearsal permits visible selections with liveReady false but has zero authorization and submit capability", async () => {
  const adapter = new FakeDamaiAdapter(false);
  let authorizeCount = 0;
  const result = await new LocalRunner({
    page: fakePage(),
    adapter,
    authorizeSubmit: (input) => {
      authorizeCount += 1;
      return { allowed: true, approvedTotalFen: input.observedTotalFen };
    }
  }).run({
    runId: "run-rehearsal-no-submit",
    plan: autoLivePlan(),
    mode: "rehearsal"
  });

  assert.equal(result.state, "REVIEW_REQUIRED");
  assert.match(result.message, /Rehearsal complete/);
  assert.equal(adapter.navigateCount, 1);
  assert.equal(adapter.actionCount, 4);
  assert.equal(authorizeCount, 0, "rehearsal must never call the controller authorization hook");
  assert.equal(adapter.submitCount, 0, "rehearsal must never call adapter.submitOrder");
  assert.equal(result.events.some((event) => event.state === "SUBMIT_ORDER"), false);
  assert.equal(result.events.some((event) => event.state === "PAY_REQUIRED"), false);
  assertResultConsistent(result);
});

test("rehearsal fails closed on a cross-origin redirect before authorization or submit", async () => {
  const adapter = new FakeDamaiAdapter(false);
  let authorizeCount = 0;
  adapter.onAction = (context, phase) => {
    if (phase === "session") (context.page as MutableFakePage).setUrl("https://example.com/phish");
  };
  const result = await new LocalRunner({
    page: fakePage(),
    adapter,
    authorizeSubmit: (input) => {
      authorizeCount += 1;
      return { allowed: true, approvedTotalFen: input.observedTotalFen };
    }
  }).run({
    runId: "run-rehearsal-redirect",
    plan: autoLivePlan(),
    mode: "rehearsal"
  });

  assert.equal(result.state, "PAGE_CHANGED");
  assert.match(result.message, /TARGET_BLOCKED/);
  assert.equal(adapter.actionCount, 1);
  assert.equal(authorizeCount, 0);
  assert.equal(adapter.submitCount, 0);
  assert.equal(result.events.some((event) => event.state === "SUBMIT_ORDER"), false);
  assertResultConsistent(result);
});

test("mock mode cannot submit even when the plan and authorization hook request it", async () => {
  const adapter = new FakeDamaiAdapter();
  let authorizeCount = 0;
  const result = await new LocalRunner({
    page: fakePage(),
    adapter,
    authorizeSubmit: (input) => {
      authorizeCount += 1;
      return { allowed: true, approvedTotalFen: input.observedTotalFen };
    }
  }).run({
    runId: "run-mock-never-submit",
    plan: autoLivePlan(),
    mode: "mock",
    targetUrl: "http://127.0.0.1:4173/damai/normal"
  });
  assert.equal(result.state, "REVIEW_REQUIRED");
  assert.equal(adapter.actionCount, 4);
  assert.equal(adapter.submitCount, 0);
  assert.equal(authorizeCount, 0);
  assert.equal(result.events.some((event) => event.state === "SUBMIT_ORDER"), false);
  assertResultConsistent(result);
});

test("selection audit binds session, tier and adjacency without attendee names", async () => {
  const adapter = new FakeDamaiAdapter();
  adapter.actionResults = {
    session: { ok: true, message: "selected", selectedLabel: "2026-08-08 晚场" },
    tier: { ok: true, message: "selected", selectedLabel: "看台 380" },
    quantity: { ok: true, message: "selected", selectedLabel: "2", adjacentVerified: true },
    attendee: { ok: true, message: "selected", selectedLabel: "敏感真实姓名" }
  };
  const result = await new LocalRunner({ page: fakePage(), adapter }).run({
    runId: "run-selection-audit",
    plan: plan({ officialUrl: "https://detail.damai.cn/item.htm?id=123" }),
    mode: "mock",
    targetUrl: "http://127.0.0.1:4173/damai/normal"
  });

  const snapshot = result.events.find(
    (event) => event.state === "VERIFY_PRICE" && event.observedTotalFen === 38_000
  );
  assert.equal(snapshot?.selectedSession, "2026-08-08 晚场");
  assert.equal(snapshot?.selectedTier, "看台 380");
  assert.equal(snapshot?.adjacentVerified, true);
  assert.equal(result.selectedSession, "2026-08-08 晚场");
  assert.equal(result.selectedTier, "看台 380");
  assert.equal(result.adjacentVerified, true);
  assert.equal(JSON.stringify(result.events).includes("敏感真实姓名"), false);
  assertResultConsistent(result);
});

test("attendee adapter failures cannot leak an attendee name into audit events", async () => {
  const adapter = new FakeDamaiAdapter();
  adapter.actionResults.attendee = {
    ok: false,
    message: "Attendee option is missing: 敏感真实姓名",
    blockedState: "PAGE_CHANGED"
  };
  const result = await new LocalRunner({ page: fakePage(), adapter }).run({
    runId: "run-attendee-error-redacted",
    plan: plan({ officialUrl: "https://detail.damai.cn/item.htm?id=123" }),
    mode: "mock",
    targetUrl: "http://127.0.0.1:4173/damai/normal"
  });

  assert.equal(result.state, "PAGE_CHANGED");
  assert.equal(JSON.stringify(result).includes("敏感真实姓名"), false);
  assert.match(result.message, /sensitive attendee details were suppressed/i);
  assertResultConsistent(result);
});

test("redirects after navigation, inspection, and selection fail closed", async (t) => {
  await t.test("after navigation", async () => {
    const adapter = new FakeDamaiAdapter();
    adapter.navigateUrlOverride = "https://example.com/phish";
    const result = await new LocalRunner({ page: fakePage(), adapter }).run({
      runId: "run-redirect-navigation",
      plan: plan({ officialUrl: "https://detail.damai.cn/item.htm?id=123" }),
      mode: "mock",
      targetUrl: "http://127.0.0.1:4173/damai/normal"
    });
    assert.equal(result.state, "PAGE_CHANGED");
    assert.equal(adapter.inspectCount, 0);
    assertResultConsistent(result);
  });

  await t.test("adapter inspection signal", async () => {
    const adapter = new FakeDamaiAdapter();
    adapter.signalUrlOverride = "https://example.com/phish";
    const result = await new LocalRunner({ page: fakePage(), adapter }).run({
      runId: "run-redirect-inspect",
      plan: plan({ officialUrl: "https://detail.damai.cn/item.htm?id=123" }),
      mode: "mock",
      targetUrl: "http://127.0.0.1:4173/damai/normal"
    });
    assert.equal(result.state, "PAGE_CHANGED");
    assert.equal(adapter.actionCount, 0);
    assertResultConsistent(result);
  });

  await t.test("after selection action", async () => {
    const adapter = new FakeDamaiAdapter();
    adapter.onAction = (context, phase) => {
      if (phase === "session") (context.page as MutableFakePage).setUrl("https://example.com/phish");
    };
    const result = await new LocalRunner({ page: fakePage(), adapter }).run({
      runId: "run-redirect-action",
      plan: plan({ officialUrl: "https://detail.damai.cn/item.htm?id=123" }),
      mode: "mock",
      targetUrl: "http://127.0.0.1:4173/damai/normal"
    });
    assert.equal(result.state, "PAGE_CHANGED");
    assert.equal(adapter.actionCount, 1);
    assert.equal(adapter.submitCount, 0);
    assertResultConsistent(result);
  });
});

test("live submit fails closed when controller approval is unavailable", async () => {
  const adapter = new FakeDamaiAdapter();
  const autoPlan = autoLivePlan();
  const result = await new LocalRunner({ page: fakePage(), adapter }).run({
    runId: "run-live-gated",
    plan: autoPlan,
    mode: "live"
  });
  assert.equal(result.state, "HUMAN_TAKEOVER");
  assert.match(result.message, /controller approval/i);
  assert.equal(adapter.actionCount, 4);
  assert.equal(adapter.submitCount, 0, "submitOrder itself must not be called");
  assert.equal(result.events.some((event) => event.state === "SUBMIT_ORDER"), false);
  assertResultConsistent(result);
});

test("a price change between snapshot and submit recheck blocks authorization", async () => {
  const adapter = new FakeDamaiAdapter();
  adapter.onInspect = (_context, phase) => {
    if (phase === "submit") {
      adapter.currentSignals = signals({
        price: { kind: "unique", valuesFen: [37_000], totalFen: 37_000 }
      });
    }
  };
  let authorizeCount = 0;
  const result = await new LocalRunner({
    page: fakePage(),
    adapter,
    authorizeSubmit: (input) => {
      authorizeCount += 1;
      return { allowed: true, approvedTotalFen: input.observedTotalFen };
    }
  }).run({ runId: "run-price-changed", plan: autoLivePlan(), mode: "live" });

  assert.equal(result.state, "PAGE_CHANGED");
  assert.match(result.message, /PRICE_SNAPSHOT_CHANGED:38000->37000/);
  assert.equal(result.observedTotalFen, 38_000, "the first snapshot must remain immutable");
  assert.equal(authorizeCount, 0);
  assert.equal(adapter.submitCount, 0);
  assert.deepEqual(
    result.events.filter((event) => event.state === "VERIFY_PRICE" && event.observedTotalFen !== undefined)
      .map((event) => event.observedTotalFen),
    [38_000]
  );
  assertResultConsistent(result);
});

test("controller denial occurs before any SUBMIT_ORDER event or DOM submit", async () => {
  const adapter = new FakeDamaiAdapter();
  const deliveredStates: string[] = [];
  const result = await new LocalRunner({
    page: fakePage(),
    adapter,
    onEvent: (event) => { deliveredStates.push(event.state); },
    authorizeSubmit: () => ({ allowed: false, state: "DUPLICATE_BLOCKED", message: "duplicate lock held" })
  }).run({ runId: "run-submit-denied", plan: autoLivePlan(), mode: "live" });

  assert.equal(result.state, "DUPLICATE_BLOCKED");
  assert.equal(adapter.submitCount, 0);
  assert.equal(result.events.some((event) => event.state === "SUBMIT_ORDER"), false);
  assert.equal(deliveredStates.includes("SUBMIT_ORDER"), false);
  assertResultConsistent(result);
});

test("authorization is followed by a fresh price inspection before clicking", async () => {
  const adapter = new FakeDamaiAdapter();
  let authorizeCount = 0;
  const result = await new LocalRunner({
    page: fakePage(),
    adapter,
    authorizeSubmit: (input) => {
      authorizeCount += 1;
      adapter.currentSignals = signals({
        price: { kind: "unique", valuesFen: [39_000], totalFen: 39_000 }
      });
      return { allowed: true, approvedTotalFen: input.observedTotalFen };
    }
  }).run({ runId: "run-post-auth-price-change", plan: autoLivePlan(), mode: "live" });

  assert.equal(authorizeCount, 1);
  assert.equal(result.state, "PAGE_CHANGED");
  assert.match(result.message, /POST_AUTH_PRICE_SNAPSHOT_CHANGED:38000->39000/);
  assert.equal(result.observedTotalFen, 38_000);
  assert.equal(adapter.submitCount, 0);
  assert.equal(result.events.some((event) => event.state === "SUBMIT_ORDER"), false);
  assertResultConsistent(result);
});

test("an abort immediately after authorization performs zero submit clicks", async () => {
  const adapter = new FakeDamaiAdapter();
  const abortController = new AbortController();
  let authorizeCount = 0;
  const result = await new LocalRunner({
    page: fakePage(),
    adapter,
    signal: abortController.signal,
    authorizeSubmit: (input) => {
      authorizeCount += 1;
      abortController.abort();
      return { allowed: true, approvedTotalFen: input.observedTotalFen };
    }
  }).run({ runId: "run-post-auth-abort", plan: autoLivePlan(), mode: "live" });

  assert.equal(authorizeCount, 1);
  assert.equal(result.state, "FAILED");
  assert.match(result.message, /RUN_ABORTED/);
  assert.equal(adapter.submitCount, 0);
  assert.equal(result.events.some((event) => event.state === "SUBMIT_ORDER"), false);
  assertResultConsistent(result);
});

test("runner rejects an approval response that does not explicitly echo the verified total", async () => {
  const adapter = new FakeDamaiAdapter();
  const result = await new LocalRunner({
    page: fakePage(),
    adapter,
    authorizeSubmit: () => ({ allowed: true, approvedTotalFen: 37_999 })
  }).run({ runId: "run-approval-total-mismatch", plan: autoLivePlan(), mode: "live" });

  assert.equal(result.state, "HUMAN_TAKEOVER");
  assert.match(result.message, /CONTROLLER_APPROVAL_TOTAL_MISMATCH:38000->37999/);
  assert.equal(adapter.submitCount, 0);
  assert.equal(result.events.some((event) => event.state === "SUBMIT_ORDER"), false);
  assertResultConsistent(result);
});

test("approved live submit reaches PAY_REQUIRED only with explicit order evidence", async () => {
  const adapter = new FakeDamaiAdapter();
  let authorized = false;
  const deliveredStates: string[] = [];
  adapter.onSubmit = (context) => {
    assert.equal(authorized, true, "authorization must precede the DOM submit");
    assert.equal(context.approvedTotalFen, 38_000, "the adapter receives the controller-approved total explicitly");
    assert.equal(context.selectedSession, "默认场次");
    assert.equal(context.selectedTier, "最低票档");
    assert.equal(context.adjacentVerified, true);
  };
  const result = await new LocalRunner({
    page: fakePage(),
    adapter,
    onEvent: (event) => { deliveredStates.push(event.state); },
    authorizeSubmit: (input) => {
      authorized = true;
      return { allowed: true, approvedTotalFen: input.observedTotalFen };
    }
  }).run({ runId: "run-submit-confirmed", plan: autoLivePlan(), mode: "live" });

  assert.equal(result.state, "PAY_REQUIRED");
  assert.equal(result.orderReference, "order-test-1");
  assert.equal(adapter.submitCount, 1);
  assert.equal(result.events.filter((event) => event.state === "SUBMIT_ORDER").length, 1);
  assert.equal(deliveredStates.includes("SUBMIT_ORDER"), false, "approve-submit already records controller state");
  assert.equal(result.events.at(-1)?.orderReference, "order-test-1");
  assertResultConsistent(result);
});

test("a successful click without payment state and order reference requires takeover", async () => {
  const adapter = new FakeDamaiAdapter();
  adapter.submitResult = { ok: true, message: "clicked but outcome unknown" };
  const result = await new LocalRunner({
    page: fakePage(),
    adapter,
    authorizeSubmit: (input) => ({ allowed: true, approvedTotalFen: input.observedTotalFen })
  }).run({ runId: "run-submit-unconfirmed", plan: autoLivePlan(), mode: "live" });

  assert.equal(result.state, "HUMAN_TAKEOVER");
  assert.match(result.message, /SUBMIT_OUTCOME_UNCONFIRMED/);
  assert.equal(adapter.submitCount, 1);
  assert.equal(result.events.some((event) => event.state === "PAY_REQUIRED"), false);
  assertResultConsistent(result);
});

test("a redirect caused by submit is caught before payment state is accepted", async () => {
  const adapter = new FakeDamaiAdapter();
  adapter.onSubmit = (context) => {
    (context.page as MutableFakePage).setUrl("https://example.com/fake-payment");
  };
  const result = await new LocalRunner({
    page: fakePage(),
    adapter,
    authorizeSubmit: (input) => ({ allowed: true, approvedTotalFen: input.observedTotalFen })
  }).run({ runId: "run-submit-redirect", plan: autoLivePlan(), mode: "live" });

  assert.equal(result.state, "PAGE_CHANGED");
  assert.equal(adapter.submitCount, 1);
  assert.equal(result.events.some((event) => event.state === "PAY_REQUIRED"), false);
  assertResultConsistent(result);
});

test("guards fail closed for captcha, login, sold-out, ambiguous price and over-budget total", () => {
  const p = plan({ maxTotalFen: 30_000 });
  assert.equal(guardPage(signals({ captchaRequired: true }), "queue", p).state, "CAPTCHA_REQUIRED");
  assert.equal(guardPage(signals({ loginRequired: true }), "queue", p).state, "LOGIN_EXPIRED");
  assert.equal(guardPage(signals({ soldOut: true }), "queue", p).state, "SOLD_OUT");
  assert.equal(
    guardPage(signals({ price: { kind: "ambiguous", valuesFen: [28_000, 38_000] } }), "verify", p).state,
    "PAGE_CHANGED"
  );
  assert.equal(guardPage(signals(), "verify", p).state, "PRICE_LIMIT_EXCEEDED");
});
