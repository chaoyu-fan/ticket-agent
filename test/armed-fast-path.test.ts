import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import type { ElementHandle, Page } from "playwright-core";

import { buildAttendeeRefAudit, parseAttendeeRef } from "../src/identity/attendee-ref.js";
import {
  InProcessSubmitCapabilityConsumer,
  createRunnerSessionSecret,
  digestRunnerSessionSecret,
  issueSubmitCapability,
  type PreparedSubmitCapability,
  type RunnerSessionSecret
} from "../src/security/submit-capability.js";
import {
  ArmedFastPath,
  buildRuntimeAttendeeSelectionFingerprint
} from "../src/runner/armed-fast-path.js";
import type { BrowserSelectionResult } from "../src/runner/browser-selection-state-machine.js";
import {
  FAST_PATH_CONTRACT_VERSION,
  digestFastPathContract,
  type FastPathContract
} from "../src/runner/fast-path-contract.js";

const CAPABILITY_KEY = "armed-fast-path-capability-key-at-least-thirty-two-bytes";
const ATTENDEE_REF = parseAttendeeRef("attendee:v1:550e8400-e29b-41d4-a716-446655440000");
const ATTENDEE_LABEL = "合成观演人-A";

function choice(optionSelector: string, priced = false) {
  return {
    optionSelector,
    labelSelector: "[data-label]",
    labelAttribute: "data-visible-label",
    selectedSelector: '[data-selected="true"]',
    ...(priced
      ? { priceTextSelector: "[data-price]", priceFenAttribute: "data-price-fen" }
      : {})
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
      eventIdAttribute: "data-event-id",
      session: choice("[data-session]"),
      sessionSummarySelector: "[data-session-summary]",
      tier: choice("[data-tier]", true),
      tierSummarySelector: "[data-tier-summary]",
      quantity: {
        summarySelector: "[data-quantity-summary]",
        option: choice("[data-quantity]")
      },
      attendee: choice("[data-attendee]"),
      adjacencySelector: "[data-adjacent]",
      totalSelector: "[data-total]",
      totalFenAttribute: "data-total-fen",
      forbiddenActionSelectors: ["[data-submit]"]
    },
    submitReadiness: {
      selector: "[data-submit]",
      allowedLabels: ["确认订单"]
    },
    postSubmitPredicates: [
      { key: "payment-visible", selector: "[data-payment]" },
      { key: "order-reference-visible", selector: "[data-order-reference]" }
    ]
  };
}

const READY_SELECTION: BrowserSelectionResult = {
  outcome: "ready",
  stage: "verify",
  source: "mutation",
  selectedSession: "首场",
  selectedTier: "看台",
  selectedTierUnitPriceFen: 5_800,
  observedTotalFen: 5_800,
  quantity: 1,
  attendeeCount: 1,
  adjacentVerified: true,
  reversibleActionCount: 4,
  fakeClickCount: 0,
  browserLatencyMs: 2,
  latencyMs: 8
};

class FakeSubmitHandle {
  readonly clickOptions: unknown[] = [];
  disposeCount = 0;
  throwOnClick = false;
  throwOnEvaluate = false;
  guardResult: "ACCEPTED" | "REJECTED" | "MISSING" = "ACCEPTED";

  async click(options: unknown): Promise<void> {
    this.clickOptions.push(options);
    if (this.throwOnClick) throw new Error("synthetic click uncertainty");
  }

  async evaluate(): Promise<"ACCEPTED" | "REJECTED" | "MISSING"> {
    if (this.throwOnEvaluate) throw new Error("synthetic guard read uncertainty");
    return this.guardResult;
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1;
  }
}

class FakeJsHandle {
  disposeCount = 0;

  constructor(readonly element: FakeSubmitHandle | null) {}

  asElement(): ElementHandle<HTMLElement> | null {
    return this.element as unknown as ElementHandle<HTMLElement> | null;
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1;
  }
}

class FastPathPage {
  readonly submit = new FakeSubmitHandle();
  readonly finalInputs: unknown[] = [];
  selectionResult: BrowserSelectionResult = READY_SELECTION;
  returnNullHandle = false;
  evaluateCount = 0;
  onEvaluateHandle: (() => void) | undefined;

  async evaluate(): Promise<BrowserSelectionResult> {
    this.evaluateCount += 1;
    return this.selectionResult;
  }

  async evaluateHandle(_pageFunction: unknown, input: unknown): Promise<FakeJsHandle> {
    this.finalInputs.push(input);
    this.onEvaluateHandle?.();
    return new FakeJsHandle(this.returnNullHandle ? null : this.submit);
  }

  asPage(): Page {
    return this as unknown as Page;
  }
}

interface ArmedFixture {
  armed: ArmedFastPath;
  consumer: InProcessSubmitCapabilityConsumer;
  prepared: PreparedSubmitCapability;
  page: FastPathPage;
  runnerSessionSecret: RunnerSessionSecret;
}

function fixture(
  page = new FastPathPage(),
  residentSelection?: ConstructorParameters<typeof ArmedFastPath>[0]["residentSelection"],
  signal?: AbortSignal
): ArmedFixture {
  const reviewedContract = contract();
  const runnerSessionSecret = createRunnerSessionSecret();
  const attendeeSelectionFingerprint = buildRuntimeAttendeeSelectionFingerprint(
    runnerSessionSecret,
    [ATTENDEE_REF],
    [ATTENDEE_LABEL]
  );
  const attendeeAudit = buildAttendeeRefAudit([ATTENDEE_REF]);
  const nowMs = Date.now();
  const delivery = issueSubmitCapability({
    runId: `run-${randomUUID()}`,
    planId: `plan-${randomUUID()}`,
    deliveryId: `delivery-${randomUUID()}`,
    runnerSessionDigest: digestRunnerSessionSecret(runnerSessionSecret),
    platform: "damai",
    canonicalEventKey: "synthetic-fast-path-event",
    officialOrigin: "https://detail.damai.cn",
    finalOfficialOrigin: reviewedContract.finalOfficialOrigin,
    fastPathContractDigest: digestFastPathContract(reviewedContract),
    eventId: "event-1",
    eventTitle: "合成极速演出",
    quantity: 1,
    requireAdjacent: false,
    attendeeRefCount: attendeeAudit.count,
    attendeeRefFingerprint: attendeeAudit.fingerprint,
    attendeeSelectionFingerprint,
    sessionPreferences: [{ label: "首场", priority: 10 }],
    tierPreferences: [{ label: "看台", priority: 10, maxUnitPriceFen: 5_800 }],
    maxTotalFen: 6_000
  }, CAPABILITY_KEY, {
    issuedAtMs: nowMs,
    earliestSubmitAtMs: nowMs,
    expiresAtMs: nowMs + 60_000
  });
  const consumer = new InProcessSubmitCapabilityConsumer();
  const prepared = consumer.prepare(delivery, CAPABILITY_KEY, runnerSessionSecret);
  const armed = new ArmedFastPath({
    page: page.asPage(),
    consumer,
    preparedCapability: prepared,
    contract: reviewedContract,
    attendeeRefs: [ATTENDEE_REF],
    attendeeLabels: [ATTENDEE_LABEL],
    runnerSessionSecret,
    ...(residentSelection === undefined ? {} : { residentSelection }),
    ...(signal === undefined ? {} : { signal })
  });
  return { armed, consumer, prepared, page, runnerSessionSecret };
}

test("armed fast path consumes once, returns one exact handle, and dispatches one trusted actionability click", async () => {
  const current = fixture();
  assert.deepEqual([...current.runnerSessionSecret], new Array(32).fill(0), "constructor owns and wipes session secret");
  const result = await current.armed.run();
  assert.equal(result.outcome, "CLICK_DISPATCHED");
  assert.equal(result.reason, "TRUSTED_CLICK_DISPATCHED");
  assert.equal(current.page.evaluateCount, 1);
  assert.equal(current.page.finalInputs.length, 1);
  assert.deepEqual(current.page.submit.clickOptions, [{
    force: false,
    noWaitAfter: true,
    scroll: "none",
    timeout: 1_000
  }]);
  assert.equal(current.page.submit.disposeCount, 1);
  assert.throws(() => current.consumer.consume(current.prepared, {}), /SUBMIT_CAPABILITY_REPLAYED/);
  await assert.rejects(() => current.armed.run(), /FAST_PATH_ALREADY_USED/);
  assert.doesNotMatch(JSON.stringify(current.page.finalInputs), new RegExp(ATTENDEE_REF));
});

test("armed fast path reuses a pre-capability resident task without starting a second selector", async () => {
  const page = new FastPathPage();
  const current = fixture(page, {
    armed: Promise.resolve(),
    result: Promise.resolve(READY_SELECTION)
  });
  const result = await current.armed.run();
  assert.equal(result.outcome, "CLICK_DISPATCHED");
  assert.equal(page.evaluateCount, 0);
  assert.equal(page.submit.clickOptions.length, 1);
});

test("abort wins before consume and again after final handle acquisition", async () => {
  const before = new AbortController();
  before.abort();
  const beforePage = new FastPathPage();
  const stoppedBefore = fixture(beforePage, undefined, before.signal);
  const beforeResult = await stoppedBefore.armed.run();
  assert.equal(beforeResult.outcome, "ZERO_CLICK_BLOCKED");
  assert.equal(beforeResult.reason, "RUN_ABORTED");
  assert.equal(beforePage.evaluateCount, 0);
  assert.equal(beforePage.submit.clickOptions.length, 0);
  assert.throws(() => stoppedBefore.consumer.consume(stoppedBefore.prepared, {}), /SUBMIT_CAPABILITY_REPLAYED/);

  const after = new AbortController();
  const afterPage = new FastPathPage();
  afterPage.onEvaluateHandle = () => after.abort();
  const stoppedAfter = fixture(afterPage, undefined, after.signal);
  const afterResult = await stoppedAfter.armed.run();
  assert.equal(afterResult.outcome, "ZERO_CLICK_BLOCKED");
  assert.equal(afterResult.reason, "RUN_ABORTED");
  assert.equal(afterPage.finalInputs.length, 1);
  assert.equal(afterPage.submit.clickOptions.length, 0);
  assert.equal(afterPage.submit.disposeCount, 1);
});

test("missing final handle is zero-click and a click exception is outcome-unknown with no retry", async () => {
  const missingPage = new FastPathPage();
  missingPage.returnNullHandle = true;
  const missing = fixture(missingPage);
  const blocked = await missing.armed.run();
  assert.equal(blocked.outcome, "ZERO_CLICK_BLOCKED");
  assert.equal(missingPage.submit.clickOptions.length, 0);
  assert.throws(() => missing.consumer.consume(missing.prepared, {}), /SUBMIT_CAPABILITY_REPLAYED/);

  const uncertainPage = new FastPathPage();
  uncertainPage.submit.throwOnClick = true;
  const uncertain = fixture(uncertainPage);
  const unknown = await uncertain.armed.run();
  assert.equal(unknown.outcome, "OUTCOME_UNKNOWN");
  assert.equal(uncertainPage.submit.clickOptions.length, 1);
  assert.equal(uncertainPage.submit.disposeCount, 1);
});

test("post-actionability guard rejection is zero-click while missing guard evidence is unknown", async () => {
  const rejectedPage = new FastPathPage();
  rejectedPage.submit.guardResult = "REJECTED";
  const rejected = fixture(rejectedPage);
  const blocked = await rejected.armed.run();
  assert.equal(blocked.outcome, "ZERO_CLICK_BLOCKED");
  assert.equal(blocked.reason, "FINAL_GUARD_REJECTED");
  assert.equal(rejectedPage.submit.clickOptions.length, 1);

  const missingPage = new FastPathPage();
  missingPage.submit.guardResult = "MISSING";
  const missing = fixture(missingPage);
  const unknown = await missing.armed.run();
  assert.equal(unknown.outcome, "OUTCOME_UNKNOWN");
  assert.equal(unknown.reason, "TRUSTED_CLICK_OUTCOME_UNKNOWN");
  assert.equal(missingPage.submit.clickOptions.length, 1);

  const unreadablePage = new FastPathPage();
  unreadablePage.submit.throwOnEvaluate = true;
  const unreadable = fixture(unreadablePage);
  const unreadableResult = await unreadable.armed.run();
  assert.equal(unreadableResult.outcome, "OUTCOME_UNKNOWN");
  assert.equal(unreadablePage.submit.clickOptions.length, 1);
});

test("a resident selection block burns the local one-shot before any final verifier or click", async () => {
  const page = new FastPathPage();
  page.selectionResult = {
    outcome: "blocked",
    stage: "verify",
    source: "mutation",
    reason: "PRICE_LIMIT_EXCEEDED",
    reversibleActionCount: 0,
    fakeClickCount: 0,
    browserLatencyMs: 1,
    latencyMs: 3
  };
  const current = fixture(page);
  const result = await current.armed.run();
  assert.equal(result.outcome, "ZERO_CLICK_BLOCKED");
  assert.equal(page.finalInputs.length, 0);
  assert.equal(page.submit.clickOptions.length, 0);
  assert.throws(() => current.consumer.consume(current.prepared, {}), /SUBMIT_CAPABILITY_REPLAYED/);
});

test("marked T0 path contains no controller, persistence, Keychain, hashing, JSON, or synchronous logging", () => {
  const source = readFileSync(path.resolve("src/runner/armed-fast-path.ts"), "utf8");
  const start = source.indexOf("/* HOT_PATH_BEGIN");
  const end = source.indexOf("/* HOT_PATH_END */");
  assert.ok(start >= 0 && end > start);
  const hot = source.slice(start, end);
  for (const forbidden of [
    /\bfetch\b/u,
    /\breadFile/u,
    /\bexecFile/u,
    /createHash/u,
    /createHmac/u,
    /digestFastPathContract/u,
    /buildAttendeeRefAudit/u,
    /ControllerClient/u,
    /MacOsKeychain/u,
    /JSON\.stringify/u,
    /console\./u
  ]) {
    assert.doesNotMatch(hot, forbidden);
  }
  assert.match(source, /event\.target === submit \|\| event\.composedPath\(\)\.includes\(submit\)/u);
});
