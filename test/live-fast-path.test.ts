import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { Page } from "playwright-core";

import type { ClaimSubmitCapabilityInput } from "../src/controller/submit-capability-service.js";
import type {
  SubmitAttemptOutcome,
  SubmitCapabilityGrant,
  SubmitCapabilityGrantStatus
} from "../src/controller/store.js";
import type { PurchaseRun, WatchPlan } from "../src/core/types.js";
import { buildAttendeeRefAudit, parseAttendeeRef } from "../src/identity/attendee-ref.js";
import {
  InProcessSubmitCapabilityConsumer,
  issueSubmitCapability,
  type PreparedSubmitCapability,
  type RunnerSessionSecret
} from "../src/security/submit-capability.js";
import {
  ArmedFastPath,
  type ArmedFastPathOptions,
  type ArmedFastPathResult
} from "../src/runner/armed-fast-path.js";
import type {
  BrowserSelectionResidentTask,
  RunBrowserSelectionOptions
} from "../src/runner/browser-selection-state-machine.js";
import {
  runLiveFastPathLifecycle,
  type LiveFastPathController
} from "../src/runner/live-fast-path.js";
import { FAST_PATH_CONTRACT_VERSION, type FastPathContract } from "../src/runner/fast-path-contract.js";
import { startExactPageTopologyGuard } from "../src/runner/page-topology-guard.js";

const CAPABILITY_KEY_TEXT = "live-fast-path-test-key-at-least-thirty-two-bytes";
const ATTENDEE_REF = parseAttendeeRef("attendee:v1:550e8400-e29b-41d4-a716-446655440000");
const ATTENDEE_LABEL = "合成观演人-A";
const SHA256_A = `sha256:${"a".repeat(64)}` as const;

function plan(nowMs = Date.now()): WatchPlan {
  const timestamp = new Date(nowMs).toISOString();
  return {
    id: "plan-live-fast-path",
    platform: "damai",
    officialUrl: "https://detail.damai.cn/item.htm?id=event-1",
    eventId: "event-1",
    eventTitle: "合成极速演出",
    canonicalEventKey: "synthetic-live-fast-path-event",
    saleAt: new Date(nowMs + 60_000).toISOString(),
    quantity: 1,
    requireAdjacent: false,
    sessions: [{ label: "首场", priority: 10 }],
    tiers: [{ label: "看台", priority: 10, maxUnitPriceFen: 5_800 }],
    maxTotalFen: 6_000,
    priceStrategy: "PREFERRED_ORDER",
    attendeeRefs: [ATTENDEE_REF],
    attendeeAliases: [],
    autoSubmitOrder: true,
    status: "ARMED",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function contract(): FastPathContract {
  return {
    version: FAST_PATH_CONTRACT_VERSION,
    platform: "damai",
    finalOfficialOrigin: "https://buy.damai.cn",
    selection: {
      platform: "damai",
      allowedOrigins: ["https://detail.damai.cn", "https://buy.damai.cn"],
      blockingPredicates: [
        { key: "captcha-visible", selector: "[data-captcha]" },
        { key: "login-required-visible", selector: "[data-login]" },
        { key: "sold-out-visible", selector: "[data-sold-out]" },
        { key: "official-queue-visible", selector: "[data-queue]" }
      ],
      eventTitleSelector: "[data-event-title]",
      eventIdSelector: "[data-event-id]",
      eventIdAttribute: "data-event-id-value",
      session: {
        optionSelector: "[data-session]",
        labelSelector: "[data-label]",
        labelAttribute: "data-visible-label",
        selectedSelector: '[data-selected="true"]'
      },
      sessionSummarySelector: "[data-session-summary]",
      tier: {
        optionSelector: "[data-tier]",
        labelSelector: "[data-label]",
        labelAttribute: "data-visible-label",
        selectedSelector: '[data-selected="true"]',
        priceTextSelector: "[data-price]",
        priceFenAttribute: "data-price-fen"
      },
      tierSummarySelector: "[data-tier-summary]",
      quantity: {
        summarySelector: "[data-quantity-summary]",
        option: {
          optionSelector: "[data-quantity]",
          labelSelector: "[data-label]",
          labelAttribute: "data-visible-label",
          selectedSelector: '[data-selected="true"]'
        }
      },
      attendee: {
        optionSelector: "[data-attendee]",
        labelSelector: "[data-label]",
        labelAttribute: "data-visible-label",
        selectedSelector: '[data-selected="true"]'
      },
      totalSelector: "[data-total]",
      totalFenAttribute: "data-total-fen",
      forbiddenActionSelectors: ["[data-submit]"]
    },
    submitReadiness: {
      selector: "[data-submit]",
      labelSelector: "[data-submit-label]",
      allowedLabels: ["确认订单"]
    },
    postSubmitPredicates: [
      { key: "order-reference-visible", selector: "[data-order-reference]" },
      { key: "payment-visible", selector: "[data-payment]" }
    ]
  };
}

function fastPathResult(outcome: SubmitAttemptOutcome = "CLICK_DISPATCHED"): ArmedFastPathResult {
  return {
    outcome,
    reason: outcome === "CLICK_DISPATCHED" ? "TRUSTED_CLICK_DISPATCHED" : "FINAL_EVIDENCE_REJECTED",
    browserSelectionLatencyMs: 8,
    hotPathLatencyMs: 40,
    consumeLatencyMs: 0.04,
    finalEvidenceLatencyMs: 4,
    trustedClickLatencyMs: outcome === "CLICK_DISPATCHED" ? 35 : 0
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class FakeLivePage extends EventEmitter {
  closed = false;

  constructor(readonly ownerContext: FakeLiveContext) {
    super();
  }

  context(): FakeLiveContext {
    return this.ownerContext;
  }

  isClosed(): boolean {
    return this.closed;
  }

  asPage(): Page {
    return this as unknown as Page;
  }
}

class FakeLiveContext extends EventEmitter {
  closed = false;
  readonly openPages: FakeLivePage[] = [];

  pages(): Page[] {
    return [...this.openPages] as unknown as Page[];
  }

  isClosed(): boolean {
    return this.closed;
  }

  addPage(options: { emit?: boolean } = {}): FakeLivePage {
    const page = new FakeLivePage(this);
    this.openPages.push(page);
    if (options.emit !== false) this.emit("page", page);
    return page;
  }

  closePage(page: FakeLivePage): void {
    if (page.closed) return;
    page.closed = true;
    const index = this.openPages.indexOf(page);
    if (index >= 0) this.openPages.splice(index, 1);
    page.emit("close", page);
    this.emit("pageclose", page);
  }
}

function livePageFixture(): { context: FakeLiveContext; page: FakeLivePage } {
  const context = new FakeLiveContext();
  const page = context.addPage({ emit: false });
  return { context, page };
}

function grant(
  runId: string,
  deliveryId: string,
  runnerSessionSha256: `sha256:${string}`,
  status: SubmitCapabilityGrantStatus,
  nowMs: number,
  outcome?: SubmitAttemptOutcome
): SubmitCapabilityGrant {
  const now = new Date(nowMs).toISOString();
  return {
    runId,
    planId: "plan-live-fast-path",
    eventKey: "synthetic-live-fast-path-event",
    deliveryId,
    capabilityVersion: 2,
    capabilityNonceSha256: SHA256_A,
    runnerSessionSha256,
    claimsBodySha256: SHA256_A,
    issuedAtMs: nowMs,
    earliestSubmitAtMs: nowMs + 60_000,
    expiresAtMs: nowMs + 120_000,
    status,
    ...(status === "RUNNER_PREPARED" || outcome !== undefined ? { runnerPreparedAt: now } : {}),
    ...(outcome === undefined ? {} : { attemptOutcome: outcome, attemptedAt: now }),
    deliveryClaimedAt: now,
    updatedAt: now
  };
}

class FakeController implements LiveFastPathController {
  readonly events: string[];
  claimCount = 0;
  failClaim = false;
  failAck = false;
  failReport = false;
  afterAck: (() => void) | undefined;
  beforeReport: (() => void) | undefined;
  readonly reportedOutcomes: SubmitAttemptOutcome[] = [];
  readonly nowMs: number;
  readonly watchPlan: WatchPlan;

  constructor(events: string[], watchPlan: WatchPlan, nowMs: number) {
    this.events = events;
    this.watchPlan = watchPlan;
    this.nowMs = nowMs;
  }

  async claimSubmitCapability(runId: string, input: ClaimSubmitCapabilityInput) {
    this.events.push("claim");
    this.claimCount += 1;
    if (this.failClaim) throw new Error("synthetic response loss");
    const deliveryId = `delivery-${randomUUID()}`;
    const attendeeAudit = buildAttendeeRefAudit(this.watchPlan.attendeeRefs);
    const delivery = issueSubmitCapability({
      runId,
      planId: this.watchPlan.id,
      deliveryId,
      runnerSessionDigest: input.runnerSessionDigest,
      platform: "damai",
      canonicalEventKey: this.watchPlan.canonicalEventKey!,
      officialOrigin: new URL(this.watchPlan.officialUrl!).origin,
      finalOfficialOrigin: input.finalOfficialOrigin,
      fastPathContractDigest: input.fastPathContractDigest,
      eventId: this.watchPlan.eventId!,
      eventTitle: this.watchPlan.eventTitle!,
      quantity: 1,
      requireAdjacent: false,
      attendeeRefCount: attendeeAudit.count,
      attendeeRefFingerprint: attendeeAudit.fingerprint,
      attendeeSelectionFingerprint: input.attendeeSelectionFingerprint,
      sessionPreferences: this.watchPlan.sessions,
      tierPreferences: this.watchPlan.tiers,
      maxTotalFen: this.watchPlan.maxTotalFen!
    }, CAPABILITY_KEY_TEXT, {
      issuedAtMs: this.nowMs,
      earliestSubmitAtMs: this.nowMs + 60_000,
      expiresAtMs: this.nowMs + 120_000
    });
    const run: PurchaseRun = {
      id: runId,
      planId: this.watchPlan.id,
      state: "PREWARM",
      createdAt: new Date(this.nowMs).toISOString(),
      updatedAt: new Date(this.nowMs).toISOString()
    };
    return {
      delivery,
      grant: grant(runId, deliveryId, input.runnerSessionDigest, "DELIVERY_CLAIMED", this.nowMs),
      run
    };
  }

  async ackCapabilityPrepared(runId: string, deliveryId: string): Promise<SubmitCapabilityGrant> {
    this.events.push("ack");
    if (this.failAck) throw new Error("synthetic ACK loss");
    const prepared = grant(runId, deliveryId, SHA256_A, "RUNNER_PREPARED", this.nowMs);
    this.afterAck?.();
    return prepared;
  }

  async reportSubmitAttempt(
    runId: string,
    deliveryId: string,
    outcome: SubmitAttemptOutcome
  ): Promise<SubmitCapabilityGrant> {
    this.events.push("report");
    this.beforeReport?.();
    this.reportedOutcomes.push(outcome);
    if (this.failReport) throw new Error("synthetic report loss");
    return grant(runId, deliveryId, SHA256_A, outcome, this.nowMs, outcome);
  }
}

function harness(options: { armedImmediately?: boolean; realArmedFastPath?: boolean } = {}) {
  const nowMs = Date.now();
  const watchPlan = plan(nowMs);
  const events: string[] = [];
  const controller = new FakeController(events, watchPlan, nowMs);
  const livePage = livePageFixture();
  const topologyGuard = startExactPageTopologyGuard(livePage.page.asPage());
  const residency = deferred();
  if (options.armedImmediately === true) residency.resolve();
  const capabilityKey = new Uint8Array(Buffer.from(CAPABILITY_KEY_TEXT, "utf8"));
  const sessionSecret = new Uint8Array(32).fill(7) as RunnerSessionSecret;
  const consumer = new InProcessSubmitCapabilityConsumer();
  let armedFactoryCount = 0;
  let preparedCapability: PreparedSubmitCapability | undefined;
  let residentSignal: AbortSignal | undefined;
  let armedSignal: AbortSignal | undefined;
  const dependencies = {
    createSessionSecret: () => sessionSecret,
    createConsumer: () => consumer,
    startResidentSelection: (
      _page: Pick<Page, "evaluate">,
      selectionOptions: RunBrowserSelectionOptions
    ): BrowserSelectionResidentTask => {
      events.push("resident-start");
      residentSignal = selectionOptions.signal;
      return { armed: residency.promise, result: new Promise(() => undefined) };
    },
    createArmedFastPath: (armedOptions: ArmedFastPathOptions) => {
      events.push("armed-created");
      armedFactoryCount += 1;
      preparedCapability = armedOptions.preparedCapability;
      armedSignal = armedOptions.signal;
      if (options.realArmedFastPath === true) return new ArmedFastPath(armedOptions);
      return {
        run: async () => {
          events.push("click");
          return fastPathResult();
        }
      };
    }
  };
  const run = () => runLiveFastPathLifecycle({
    page: livePage.page.asPage(),
    topologyGuard,
    controller,
    runId: "run-live-fast-path",
    plan: watchPlan,
    contract: contract(),
    attendeeLabels: [ATTENDEE_LABEL],
    capabilityKey
  }, dependencies);
  return {
    run,
    events,
    controller,
    livePage,
    residency,
    capabilityKey,
    sessionSecret,
    consumer,
    get preparedCapability() { return preparedCapability; },
    get residentSignal() { return residentSignal; },
    get armedSignal() { return armedSignal; },
    get armedFactoryCount() { return armedFactoryCount; }
  };
}

test("live fast-path waits for resident ACK, claims once, clicks once, then reports", async () => {
  const current = harness();
  const running = current.run();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(current.events, ["resident-start"]);
  assert.equal(current.controller.claimCount, 0);

  current.residency.resolve();
  const result = await running;
  assert.equal(result.reportStatus, "RECORDED");
  assert.equal(result.fastPath.outcome, "CLICK_DISPATCHED");
  assert.deepEqual(current.events, ["resident-start", "claim", "ack", "armed-created", "click", "report"]);
  assert.equal(current.controller.claimCount, 1);
  assert.equal(current.armedFactoryCount, 1);
  assert.equal(current.livePage.context.listenerCount("page"), 0);
  assert.equal(current.livePage.page.listenerCount("close"), 0);
  assert.deepEqual([...current.capabilityKey], new Array(current.capabilityKey.length).fill(0));
  assert.deepEqual([...current.sessionSecret], new Array(32).fill(0));
});

test("delivery response loss is never retried and cannot reach ACK or click", async () => {
  const current = harness({ armedImmediately: true });
  current.controller.failClaim = true;
  await assert.rejects(current.run(), /LIVE_FAST_PATH_CAPABILITY_DELIVERY_FAILED/);
  assert.equal(current.controller.claimCount, 1);
  assert.deepEqual(current.events, ["resident-start", "claim"]);
  assert.equal(current.armedFactoryCount, 0);
  assert.deepEqual([...current.capabilityKey], new Array(current.capabilityKey.length).fill(0));
  assert.deepEqual([...current.sessionSecret], new Array(32).fill(0));
});

test("prepared ACK failure is zero-click and burns all local key material", async () => {
  const current = harness({ armedImmediately: true });
  current.controller.failAck = true;
  await assert.rejects(current.run(), /LIVE_FAST_PATH_PREPARED_ACK_FAILED/);
  assert.deepEqual(current.events, ["resident-start", "claim", "ack"]);
  assert.equal(current.armedFactoryCount, 0);
  assert.deepEqual([...current.capabilityKey], new Array(current.capabilityKey.length).fill(0));
  assert.deepEqual([...current.sessionSecret], new Array(32).fill(0));
});

test("post-click report failure returns UNKNOWN and never retries the click or report", async () => {
  const current = harness({ armedImmediately: true });
  current.controller.failReport = true;
  const result = await current.run();
  assert.equal(result.reportStatus, "UNKNOWN");
  assert.equal(result.fastPath.outcome, "CLICK_DISPATCHED");
  assert.deepEqual(current.events, ["resident-start", "claim", "ack", "armed-created", "click", "report"]);
  assert.equal(current.events.filter((event) => event === "click").length, 1);
  assert.equal(current.events.filter((event) => event === "report").length, 1);
});

test("a topology change after click is reported once for reconciliation and never retried", async () => {
  const current = harness({ armedImmediately: true });
  current.controller.beforeReport = () => { current.livePage.context.addPage(); };
  const result = await current.run();
  assert.equal(result.reportStatus, "RECORDED");
  assert.equal(result.fastPath.outcome, "CLICK_DISPATCHED");
  assert.deepEqual(current.controller.reportedOutcomes, ["CLICK_DISPATCHED"]);
  assert.equal(current.events.filter((event) => event === "click").length, 1);
  assert.equal(current.events.filter((event) => event === "report").length, 1);
  assert.equal(current.livePage.context.listenerCount("page"), 0);
});

test("missing explicit budget fails before residency or delivery and wipes the supplied key", async () => {
  const current = harness({ armedImmediately: true });
  delete current.controller.watchPlan.maxTotalFen;
  await assert.rejects(current.run(), /LIVE_FAST_PATH_PLAN_NOT_ARMED/);
  assert.deepEqual(current.events, []);
  assert.deepEqual([...current.capabilityKey], new Array(current.capabilityKey.length).fill(0));
});

test("a second page after resident ACK but before delivery is sticky zero-claim and zero-click", async () => {
  const current = harness();
  const running = current.run();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(current.events, ["resident-start"]);

  // Resolve the resident ACK first, then emit in the same turn before the
  // lifecycle's await continuation can claim a delivery.
  current.residency.resolve();
  const extra = current.livePage.context.addPage();
  current.livePage.context.closePage(extra);
  assert.deepEqual(current.livePage.context.pages(), [current.livePage.page]);

  await assert.rejects(running, /LIVE_FAST_PATH_PAGE_TOPOLOGY_INVALID/);
  assert.equal(current.controller.claimCount, 0);
  assert.equal(current.armedFactoryCount, 0);
  assert.equal(current.residentSignal?.aborted, true);
  assert.equal(current.events.includes("click"), false);
  assert.deepEqual(current.controller.reportedOutcomes, []);
  assert.deepEqual([...current.capabilityKey], new Array(current.capabilityKey.length).fill(0));
  assert.deepEqual([...current.sessionSecret], new Array(32).fill(0));
  assert.equal(current.livePage.context.listenerCount("page"), 0);
  assert.equal(current.livePage.page.listenerCount("close"), 0);
});

test("closing the original page after resident ACK is zero-claim and zero-click", async () => {
  const current = harness();
  const running = current.run();
  await new Promise<void>((resolve) => setImmediate(resolve));

  current.residency.resolve();
  current.livePage.context.closePage(current.livePage.page);

  await assert.rejects(running, /LIVE_FAST_PATH_PAGE_TOPOLOGY_INVALID/);
  assert.equal(current.controller.claimCount, 0);
  assert.equal(current.armedFactoryCount, 0);
  assert.equal(current.events.includes("click"), false);
  assert.deepEqual(current.controller.reportedOutcomes, []);
  assert.equal(current.livePage.context.listenerCount("page"), 0);
  assert.equal(current.livePage.page.listenerCount("close"), 0);
});

test("a second page after truthful prepared ACK burns capability, records zero-click, and never clicks", async () => {
  const current = harness({ armedImmediately: true, realArmedFastPath: true });
  current.controller.afterAck = () => { current.livePage.context.addPage(); };

  const result = await current.run();
  assert.equal(result.reportStatus, "RECORDED");
  assert.equal(result.fastPath.outcome, "ZERO_CLICK_BLOCKED");
  assert.equal(result.fastPath.reason, "RUN_ABORTED");
  assert.equal(current.controller.claimCount, 1);
  assert.equal(current.armedFactoryCount, 1);
  assert.equal(current.residentSignal, current.armedSignal);
  assert.equal(current.armedSignal?.aborted, true);
  assert.deepEqual(current.controller.reportedOutcomes, ["ZERO_CLICK_BLOCKED"]);
  assert.deepEqual(current.events, ["resident-start", "claim", "ack", "armed-created", "report"]);
  assert.equal(current.events.includes("click"), false);
  assert.ok(current.preparedCapability !== undefined);
  assert.throws(
    () => current.consumer.consume(current.preparedCapability!, {}),
    /SUBMIT_CAPABILITY_REPLAYED/
  );
  assert.deepEqual([...current.capabilityKey], new Array(current.capabilityKey.length).fill(0));
  assert.deepEqual([...current.sessionSecret], new Array(32).fill(0));
});
