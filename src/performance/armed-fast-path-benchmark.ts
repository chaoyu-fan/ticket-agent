import { randomBytes, randomUUID } from "node:crypto";

import type { Page } from "playwright-core";

import { buildAttendeeRefAudit, parseAttendeeRef } from "../identity/attendee-ref.js";
import {
  InProcessSubmitCapabilityConsumer,
  createRunnerSessionSecret,
  digestRunnerSessionSecret,
  issueSubmitCapability
} from "../security/submit-capability.js";
import {
  ArmedFastPath,
  buildRuntimeAttendeeSelectionFingerprint,
  type ArmedFastPathResult
} from "../runner/armed-fast-path.js";
import {
  FAST_PATH_CONTRACT_VERSION,
  digestFastPathContract,
  type FastPathContract
} from "../runner/fast-path-contract.js";
import { summarizeDurations, type DurationSummary } from "./metrics.js";

export const ARMED_FAST_PATH_BENCHMARK_URL = "https://buy.damai.cn/__ticket_agent_armed_fast_path_benchmark_v1__";
export const ARMED_FAST_PATH_BENCHMARK_WARMUP_ITERATIONS = 50;
export const ARMED_FAST_PATH_BENCHMARK_SAMPLE_ITERATIONS = 500;

const MAX_ITERATIONS = 500;
const FIXTURE_EVENT_ID = "synthetic-fast-path-event-1";
const FIXTURE_EVENT_TITLE = "合成极速链路演出";
const FIXTURE_SESSION = "首场";
const FIXTURE_TIER = "看台";
const FIXTURE_ATTENDEE = "合成观演人-A";
const FIXTURE_UNIT_PRICE_FEN = 5_800;
const FIXTURE_TOTAL_FEN = 5_800;
const ATTENDEE_REF = parseAttendeeRef("attendee:v1:550e8400-e29b-41d4-a716-446655440000");

export const ARMED_FAST_PATH_BENCHMARK_GATES = Object.freeze({
  hotPathP95Ms: 100,
  hotPathP99Ms: 125,
  trustedClickP95Ms: 75,
  trustedClickP99Ms: 100,
  t0ToTrustedClickP95Ms: 125,
  t0ToTrustedClickP99Ms: 150
});

export const ARMED_FAST_PATH_BENCHMARK_METRICS = [
  "browserSelectionLatencyMs",
  "hotPathLatencyMs",
  "consumeLatencyMs",
  "finalEvidenceLatencyMs",
  "trustedClickLatencyMs",
  "t0ToTrustedClickLatencyMs"
] as const;

export type ArmedFastPathBenchmarkMetric = (typeof ARMED_FAST_PATH_BENCHMARK_METRICS)[number];

export interface ArmedFastPathBenchmarkSample {
  readonly iteration: number;
  readonly browserSelectionLatencyMs: number;
  readonly hotPathLatencyMs: number;
  readonly consumeLatencyMs: number;
  readonly finalEvidenceLatencyMs: number;
  readonly trustedClickLatencyMs: number;
  /** Browser monotonic time from synthetic sale DOM release to the trusted submit event. */
  readonly t0ToTrustedClickLatencyMs: number;
  readonly trustedClickCount: 1;
  readonly untrustedClickCount: 0;
}

export interface ArmedFastPathBenchmarkFaultChecks {
  readonly exactTargetBound: 1;
  readonly evidenceChangedAfterHandle: 1;
  readonly priceChanged: 1;
  readonly detachedHandle: 1;
  readonly obscuredTarget: 1;
  readonly disabledTarget: 1;
}

export interface ArmedFastPathBenchmarkSummary extends DurationSummary {
  readonly metric: ArmedFastPathBenchmarkMetric;
}

export interface ArmedFastPathBenchmarkReport {
  readonly schemaVersion: 1;
  readonly benchmark: "armed-fast-path";
  readonly clock: "monotonic";
  readonly unit: "milliseconds";
  readonly warmupIterations: number;
  readonly sampleIterations: number;
  readonly faultChecks: ArmedFastPathBenchmarkFaultChecks;
  readonly samples: readonly ArmedFastPathBenchmarkSample[];
  readonly summaries: readonly ArmedFastPathBenchmarkSummary[];
}

const REPORT_KEYS = [
  "benchmark",
  "clock",
  "faultChecks",
  "sampleIterations",
  "samples",
  "schemaVersion",
  "summaries",
  "unit",
  "warmupIterations"
] as const;
const FAULT_KEYS = [
  "detachedHandle",
  "disabledTarget",
  "evidenceChangedAfterHandle",
  "exactTargetBound",
  "obscuredTarget",
  "priceChanged"
] as const;
const SAMPLE_KEYS = [
  "browserSelectionLatencyMs",
  "consumeLatencyMs",
  "finalEvidenceLatencyMs",
  "hotPathLatencyMs",
  "iteration",
  "t0ToTrustedClickLatencyMs",
  "trustedClickCount",
  "trustedClickLatencyMs",
  "untrustedClickCount"
] as const;
const SUMMARY_KEYS = ["count", "maxMs", "metric", "minMs", "p50Ms", "p95Ms", "p99Ms"] as const;

/** Closed, numeric-only report schema; runtime validation below also recomputes every summary. */
export const ARMED_FAST_PATH_BENCHMARK_REPORT_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://ticket-agent.local/schemas/armed-fast-path-benchmark-report-v1.json",
  type: "object",
  additionalProperties: false,
  required: REPORT_KEYS,
  properties: {
    schemaVersion: { const: 1 },
    benchmark: { const: "armed-fast-path" },
    clock: { const: "monotonic" },
    unit: { const: "milliseconds" },
    warmupIterations: { type: "integer", minimum: 0, maximum: MAX_ITERATIONS },
    sampleIterations: { type: "integer", minimum: 1, maximum: MAX_ITERATIONS },
    faultChecks: {
      type: "object",
      additionalProperties: false,
      required: FAULT_KEYS,
      properties: {
        exactTargetBound: { const: 1 },
        evidenceChangedAfterHandle: { const: 1 },
        priceChanged: { const: 1 },
        detachedHandle: { const: 1 },
        obscuredTarget: { const: 1 },
        disabledTarget: { const: 1 }
      }
    },
    samples: {
      type: "array",
      minItems: 1,
      maxItems: MAX_ITERATIONS,
      items: {
        type: "object",
        additionalProperties: false,
        required: SAMPLE_KEYS,
        properties: {
          iteration: { type: "integer", minimum: 0, maximum: MAX_ITERATIONS - 1 },
          browserSelectionLatencyMs: { type: "number", minimum: 0 },
          hotPathLatencyMs: { type: "number", minimum: 0 },
          consumeLatencyMs: { type: "number", minimum: 0 },
          finalEvidenceLatencyMs: { type: "number", minimum: 0 },
          trustedClickLatencyMs: { type: "number", minimum: 0 },
          t0ToTrustedClickLatencyMs: { type: "number", minimum: 0 },
          trustedClickCount: { const: 1 },
          untrustedClickCount: { const: 0 }
        }
      }
    },
    summaries: {
      type: "array",
      minItems: ARMED_FAST_PATH_BENCHMARK_METRICS.length,
      maxItems: ARMED_FAST_PATH_BENCHMARK_METRICS.length,
      items: {
        type: "object",
        additionalProperties: false,
        required: SUMMARY_KEYS,
        properties: {
          metric: { type: "string", enum: ARMED_FAST_PATH_BENCHMARK_METRICS },
          count: { type: "integer", minimum: 1, maximum: MAX_ITERATIONS },
          minMs: { type: "number", minimum: 0 },
          maxMs: { type: "number", minimum: 0 },
          p50Ms: { type: "number", minimum: 0 },
          p95Ms: { type: "number", minimum: 0 },
          p99Ms: { type: "number", minimum: 0 }
        }
      }
    }
  }
} as const;

export const ARMED_FAST_PATH_BENCHMARK_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Armed Fast Path Benchmark</title>
  <style>
    html, body { margin: 0; padding: 0; }
    body { font-family: sans-serif; }
    main { width: 420px; padding: 16px; }
    button, output, strong { display: block; width: 280px; min-height: 36px; margin: 6px 0; }
    .zone { position: relative; width: 280px; min-height: 44px; }
    [data-afp-overlay] { position: absolute; inset: 0; z-index: 10; background: #ddd; }
  </style>
</head>
<body>
  <main data-afp-root="v1"
    data-trusted-click-count="0"
    data-untrusted-click-count="0"
    data-decoy-click-count="0"
    data-submit-child-target-count="0"
    data-replacement-click-count="0">
    <h1 data-event-title>${FIXTURE_EVENT_TITLE}</h1>
    <div data-event-id data-event-id-value="${FIXTURE_EVENT_ID}"></div>

    <div data-captcha hidden></div>
    <div data-login hidden></div>
    <div data-sold-out hidden></div>
    <div data-queue hidden></div>
    <div data-payment hidden></div>
    <div data-order-reference hidden></div>

    <button type="button" data-session data-visible-label="${FIXTURE_SESSION}" data-selected="false" hidden>
      <span data-label>${FIXTURE_SESSION}</span>
    </button>
    <output data-session-summary></output>

    <button type="button" data-tier data-visible-label="VIP" data-selected="false" data-price-fen="12000">
      <span data-label>VIP</span><span data-price>¥120.00</span>
    </button>
    <button type="button" data-tier data-visible-label="${FIXTURE_TIER}" data-selected="false" data-price-fen="${FIXTURE_UNIT_PRICE_FEN}">
      <span data-label>${FIXTURE_TIER}</span><span data-price>¥58.00</span>
    </button>
    <output data-tier-summary></output>

    <button type="button" data-quantity data-visible-label="1" data-selected="false">
      <span data-label>1</span>
    </button>
    <output data-quantity-summary></output>

    <button type="button" data-attendee data-visible-label="${FIXTURE_ATTENDEE}" data-selected="false">
      <span data-label>${FIXTURE_ATTENDEE}</span>
    </button>

    <strong data-total data-total-fen="${FIXTURE_TOTAL_FEN}">¥58.00</strong>
    <button type="button" data-decoy>无关可信点击</button>
    <div class="zone">
      <button type="button" data-submit disabled><span data-submit-label>确认订单</span></button>
      <div data-afp-overlay hidden></div>
    </div>
  </main>
  <script>
    (() => {
      "use strict";
      const one = (selector) => {
        const values = document.querySelectorAll(selector);
        if (values.length !== 1 || !(values[0] instanceof HTMLElement)) throw new Error("AFP_FIXTURE_INVALID");
        return values[0];
      };
      const root = one('[data-afp-root="v1"]');
      const session = one('[data-session]');
      const sessionSummary = one('[data-session-summary]');
      const tiers = Array.from(document.querySelectorAll('[data-tier]'));
      const stand = tiers.find((value) => value.getAttribute('data-visible-label') === '${FIXTURE_TIER}');
      const tierSummary = one('[data-tier-summary]');
      const quantity = one('[data-quantity]');
      const quantitySummary = one('[data-quantity-summary]');
      const attendee = one('[data-attendee]');
      const total = one('[data-total]');
      const decoy = one('[data-decoy]');
      let submit = one('[data-submit]');
      const overlay = one('[data-afp-overlay]');
      let saleOpenedAtMs = -1;
      let trustedSubmitAtMs = -1;
      if (!(submit instanceof HTMLButtonElement) || !(stand instanceof HTMLElement)) throw new Error("AFP_FIXTURE_INVALID");

      const selectedOnly = (values, selected) => {
        for (const value of values) value.setAttribute('data-selected', String(value === selected));
      };
      session.addEventListener('click', () => {
        session.setAttribute('data-selected', 'true');
        sessionSummary.innerText = '${FIXTURE_SESSION}';
      });
      for (const tier of tiers) tier.addEventListener('click', () => {
        selectedOnly(tiers, tier);
        tierSummary.innerText = tier.getAttribute('data-visible-label') ?? '';
      });
      quantity.addEventListener('click', () => {
        quantity.setAttribute('data-selected', 'true');
        quantitySummary.innerText = '1张';
      });
      attendee.addEventListener('click', () => attendee.setAttribute('data-selected', 'true'));

      const attachSubmitCounter = (element) => {
        const label = element.querySelector('[data-submit-label]');
        if (!(label instanceof HTMLElement)) throw new Error('AFP_FIXTURE_INVALID');
        label.style.display = 'block';
        label.style.width = '100%';
        label.style.minHeight = '36px';
        label.style.lineHeight = '36px';
        element.addEventListener('click', (event) => {
          const key = event.isTrusted ? 'data-trusted-click-count' : 'data-untrusted-click-count';
          root.setAttribute(key, String(Number(root.getAttribute(key) ?? '-1') + 1));
          if (event.isTrusted) trustedSubmitAtMs = performance.now();
          if (event.target === label && event.composedPath().includes(element)) {
            root.setAttribute(
              'data-submit-child-target-count',
              String(Number(root.getAttribute('data-submit-child-target-count') ?? '-1') + 1)
            );
          }
        });
      };
      attachSubmitCounter(submit);
      decoy.addEventListener('click', () => root.setAttribute(
        'data-decoy-click-count',
        String(Number(root.getAttribute('data-decoy-click-count') ?? '-1') + 1)
      ));

      const reset = () => {
        session.hidden = true;
        session.setAttribute('data-selected', 'false');
        for (const tier of tiers) tier.setAttribute('data-selected', 'false');
        quantity.setAttribute('data-selected', 'false');
        attendee.setAttribute('data-selected', 'false');
        sessionSummary.innerText = '';
        tierSummary.innerText = '';
        quantitySummary.innerText = '';
        total.setAttribute('data-total-fen', '${FIXTURE_TOTAL_FEN}');
        total.innerText = '¥58.00';
        submit.disabled = true;
        overlay.hidden = true;
        root.setAttribute('data-trusted-click-count', '0');
        root.setAttribute('data-untrusted-click-count', '0');
        root.setAttribute('data-decoy-click-count', '0');
        root.setAttribute('data-submit-child-target-count', '0');
        root.setAttribute('data-replacement-click-count', '0');
        saleOpenedAtMs = -1;
        trustedSubmitAtMs = -1;
      };
      const openSale = () => {
        saleOpenedAtMs = performance.now();
        session.hidden = false;
        submit.disabled = false;
      };
      const changePrice = () => {
        total.setAttribute('data-total-fen', '5900');
        total.innerText = '¥59.00';
      };
      const detachSubmit = () => {
        const replacement = submit.cloneNode(true);
        replacement.disabled = false;
        replacement.addEventListener('click', () => root.setAttribute(
          'data-replacement-click-count',
          String(Number(root.getAttribute('data-replacement-click-count') ?? '-1') + 1)
        ));
        submit.replaceWith(replacement);
        submit = replacement;
      };
      const obscureSubmit = () => { overlay.hidden = false; };
      const disableSubmit = () => { submit.disabled = true; };
      Object.defineProperty(globalThis, '__ticketAgentArmedFastPathBenchmark_v1', {
        configurable: false,
        enumerable: false,
        writable: false,
        value: Object.freeze({
          reset,
          openSale,
          changePrice,
          detachSubmit,
          obscureSubmit,
          disableSubmit,
          t0ToTrustedClickLatency: () => (
            saleOpenedAtMs >= 0 && trustedSubmitAtMs >= saleOpenedAtMs
              ? trustedSubmitAtMs - saleOpenedAtMs
              : -1
          )
        })
      });
      reset();
    })();
  </script>
</body>
</html>`;

function choice(optionSelector: string, priced = false) {
  return {
    optionSelector,
    labelSelector: "[data-label]",
    labelAttribute: "data-visible-label",
    selectedSelector: '[data-selected="true"]',
    ...(priced ? { priceTextSelector: "[data-price]", priceFenAttribute: "data-price-fen" } : {})
  };
}

export function armedFastPathBenchmarkContract(): FastPathContract {
  return {
    version: FAST_PATH_CONTRACT_VERSION,
    platform: "damai",
    finalOfficialOrigin: new URL(ARMED_FAST_PATH_BENCHMARK_URL).origin,
    selection: {
      platform: "damai",
      allowedOrigins: [new URL(ARMED_FAST_PATH_BENCHMARK_URL).origin],
      blockingPredicates: [
        { key: "captcha-visible", selector: "[data-captcha]" },
        { key: "login-required-visible", selector: "[data-login]" },
        { key: "sold-out-visible", selector: "[data-sold-out]" },
        { key: "official-queue-visible", selector: "[data-queue]" }
      ],
      eventTitleSelector: "[data-event-title]",
      eventIdSelector: "[data-event-id]",
      eventIdAttribute: "data-event-id-value",
      session: choice("[data-session]"),
      sessionSummarySelector: "[data-session-summary]",
      tier: choice("[data-tier]", true),
      tierSummarySelector: "[data-tier-summary]",
      quantity: { summarySelector: "[data-quantity-summary]", option: choice("[data-quantity]") },
      attendee: choice("[data-attendee]"),
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
      { key: "payment-visible", selector: "[data-payment]" },
      { key: "order-reference-visible", selector: "[data-order-reference]" }
    ]
  };
}

function benchmarkCapability(contract: FastPathContract): {
  armedOptions: ConstructorParameters<typeof ArmedFastPath>[0];
} {
  const runnerSessionSecret = createRunnerSessionSecret();
  const attendeeFingerprint = buildRuntimeAttendeeSelectionFingerprint(
    runnerSessionSecret,
    [ATTENDEE_REF],
    [FIXTURE_ATTENDEE]
  );
  const attendeeAudit = buildAttendeeRefAudit([ATTENDEE_REF]);
  const capabilityKey = randomBytes(32);
  const nowMs = Date.now();
  const delivery = issueSubmitCapability({
    runId: randomUUID(),
    planId: randomUUID(),
    deliveryId: randomUUID(),
    runnerSessionDigest: digestRunnerSessionSecret(runnerSessionSecret),
    platform: "damai",
    canonicalEventKey: "synthetic-armed-fast-path-benchmark",
    officialOrigin: contract.finalOfficialOrigin,
    finalOfficialOrigin: contract.finalOfficialOrigin,
    fastPathContractDigest: digestFastPathContract(contract),
    eventId: FIXTURE_EVENT_ID,
    eventTitle: FIXTURE_EVENT_TITLE,
    quantity: 1,
    requireAdjacent: false,
    attendeeRefCount: attendeeAudit.count,
    attendeeRefFingerprint: attendeeAudit.fingerprint,
    attendeeSelectionFingerprint: attendeeFingerprint,
    sessionPreferences: [{ label: FIXTURE_SESSION, priority: 10 }],
    tierPreferences: [{ label: FIXTURE_TIER, priority: 10, maxUnitPriceFen: 6_000 }],
    maxTotalFen: 6_000
  }, capabilityKey, {
    issuedAtMs: nowMs,
    earliestSubmitAtMs: nowMs,
    expiresAtMs: nowMs + 60_000
  });
  const consumer = new InProcessSubmitCapabilityConsumer();
  const preparedCapability = consumer.prepare(delivery, capabilityKey, runnerSessionSecret);
  capabilityKey.fill(0);
  return {
    armedOptions: {
      page: undefined as unknown as Page,
      consumer,
      preparedCapability,
      contract,
      attendeeRefs: [ATTENDEE_REF],
      attendeeLabels: [FIXTURE_ATTENDEE],
      runnerSessionSecret
    }
  };
}

function invokeFixtureAction(action: string): void {
  if (!new Set(["reset", "openSale", "changePrice", "detachSubmit", "obscureSubmit", "disableSubmit"]).has(action)) {
    throw new Error("ARMED_FAST_PATH_BENCHMARK_ACTION_BLOCKED");
  }
  if (location.href !== "https://buy.damai.cn/__ticket_agent_armed_fast_path_benchmark_v1__") {
    throw new Error("ARMED_FAST_PATH_BENCHMARK_PAGE_CHANGED");
  }
  const scope = globalThis as typeof globalThis & {
    __ticketAgentArmedFastPathBenchmark_v1?: Record<string, () => void>;
  };
  const callback = scope.__ticketAgentArmedFastPathBenchmark_v1?.[action];
  if (typeof callback !== "function") throw new Error("ARMED_FAST_PATH_BENCHMARK_FIXTURE_INVALID");
  callback();
}

async function openSaleWhenResident(): Promise<void> {
  const scope = globalThis as typeof globalThis & {
    __ticketAgentSelectionMachines_v1?: Record<string, unknown>;
    __ticketAgentArmedFastPathBenchmark_v1?: { openSale?: () => void };
  };
  const deadline = performance.now() + 1_000;
  while (Object.keys(scope.__ticketAgentSelectionMachines_v1 ?? {}).length !== 1) {
    if (performance.now() >= deadline) throw new Error("ARMED_FAST_PATH_BENCHMARK_MACHINE_NOT_READY");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  const callback = scope.__ticketAgentArmedFastPathBenchmark_v1?.openSale;
  if (typeof callback !== "function") throw new Error("ARMED_FAST_PATH_BENCHMARK_FIXTURE_INVALID");
  callback();
}

interface FixtureEvidence {
  trustedClickCount: number;
  untrustedClickCount: number;
  decoyClickCount: number;
  submitChildTargetCount: number;
  replacementClickCount: number;
  t0ToTrustedClickLatencyMs: number;
}

function collectEvidence(): FixtureEvidence {
  const root = document.querySelector('[data-afp-root="v1"]');
  if (!(root instanceof HTMLElement)) throw new Error("ARMED_FAST_PATH_BENCHMARK_FIXTURE_INVALID");
  const scope = globalThis as typeof globalThis & {
    __ticketAgentArmedFastPathBenchmark_v1?: { t0ToTrustedClickLatency?: () => number };
  };
  const t0ToTrustedClickLatencyMs = scope
    .__ticketAgentArmedFastPathBenchmark_v1
    ?.t0ToTrustedClickLatency?.() ?? -1;
  return {
    trustedClickCount: Number(root.getAttribute("data-trusted-click-count") ?? "-1"),
    untrustedClickCount: Number(root.getAttribute("data-untrusted-click-count") ?? "-1"),
    decoyClickCount: Number(root.getAttribute("data-decoy-click-count") ?? "-1"),
    submitChildTargetCount: Number(root.getAttribute("data-submit-child-target-count") ?? "-1"),
    replacementClickCount: Number(root.getAttribute("data-replacement-click-count") ?? "-1"),
    t0ToTrustedClickLatencyMs
  };
}

function safeDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function assertDispatchResult(result: ArmedFastPathResult): void {
  if (
    result.outcome !== "CLICK_DISPATCHED" ||
    result.reason !== "TRUSTED_CLICK_DISPATCHED" ||
    !safeDuration(result.browserSelectionLatencyMs) ||
    !safeDuration(result.hotPathLatencyMs) ||
    !safeDuration(result.consumeLatencyMs) ||
    !safeDuration(result.finalEvidenceLatencyMs) ||
    !safeDuration(result.trustedClickLatencyMs)
  ) throw new Error("ARMED_FAST_PATH_BENCHMARK_RESULT_INVALID");
}

async function runIteration(page: Page, contract: FastPathContract): Promise<Omit<ArmedFastPathBenchmarkSample, "iteration">> {
  await page.evaluate(invokeFixtureAction, "reset");
  const prepared = benchmarkCapability(contract);
  const armed = new ArmedFastPath({ ...prepared.armedOptions, page });
  const running = armed.run();
  const [result] = await Promise.all([running, page.evaluate(openSaleWhenResident)]);
  assertDispatchResult(result);
  const evidence = await page.evaluate(collectEvidence);
  if (
    evidence.trustedClickCount !== 1 ||
    evidence.untrustedClickCount !== 0 ||
    evidence.decoyClickCount !== 0 ||
    evidence.submitChildTargetCount !== 1 ||
    evidence.replacementClickCount !== 0 ||
    !safeDuration(evidence.t0ToTrustedClickLatencyMs) ||
    page.url() !== ARMED_FAST_PATH_BENCHMARK_URL
  ) throw new Error("ARMED_FAST_PATH_BENCHMARK_EVIDENCE_INVALID");
  return {
    browserSelectionLatencyMs: result.browserSelectionLatencyMs,
    hotPathLatencyMs: result.hotPathLatencyMs,
    consumeLatencyMs: result.consumeLatencyMs,
    finalEvidenceLatencyMs: result.finalEvidenceLatencyMs,
    trustedClickLatencyMs: result.trustedClickLatencyMs,
    t0ToTrustedClickLatencyMs: evidence.t0ToTrustedClickLatencyMs,
    trustedClickCount: 1,
    untrustedClickCount: 0
  };
}

type FaultAction =
  | "priceChanged"
  | "evidenceChangedAfterHandle"
  | "detachedHandle"
  | "obscuredTarget"
  | "disabledTarget";

function pageWithUnrelatedTrustedClick(page: Page): Page {
  return {
    evaluate: page.evaluate.bind(page),
    evaluateHandle: async (pageFunction: never, argument: never) => {
      const handle = await page.evaluateHandle(pageFunction, argument);
      await page.locator("[data-decoy]").click({ force: false, timeout: 1_000 });
      return handle;
    }
  } as unknown as Page;
}

async function runExactTargetCheck(page: Page, contract: FastPathContract): Promise<void> {
  await page.evaluate(invokeFixtureAction, "reset");
  const prepared = benchmarkCapability(contract);
  const armed = new ArmedFastPath({
    ...prepared.armedOptions,
    page: pageWithUnrelatedTrustedClick(page)
  });
  const running = armed.run();
  const [result] = await Promise.all([running, page.evaluate(openSaleWhenResident)]);
  assertDispatchResult(result);
  // The guard is removed after the exact submit dispatch, so an ordinary
  // trusted click must propagate again instead of leaving the page trapped.
  await page.locator("[data-decoy]").click({ force: false, timeout: 1_000 });
  const evidence = await page.evaluate(collectEvidence);
  if (
    evidence.trustedClickCount !== 1 ||
    evidence.untrustedClickCount !== 0 ||
    evidence.decoyClickCount !== 1 ||
    evidence.submitChildTargetCount !== 1 ||
    evidence.replacementClickCount !== 0
  ) throw new Error("ARMED_FAST_PATH_BENCHMARK_EXACT_TARGET_INVALID");
}

function pageWithFault(page: Page, fault: FaultAction): Page {
  return {
    evaluate: page.evaluate.bind(page),
    evaluateHandle: async (pageFunction: never, argument: never) => {
      if (fault === "priceChanged") await page.evaluate(invokeFixtureAction, "changePrice");
      const handle = await page.evaluateHandle(pageFunction, argument);
      if (fault === "evidenceChangedAfterHandle") await page.evaluate(invokeFixtureAction, "changePrice");
      if (fault === "detachedHandle") await page.evaluate(invokeFixtureAction, "detachSubmit");
      if (fault === "obscuredTarget") await page.evaluate(invokeFixtureAction, "obscureSubmit");
      if (fault === "disabledTarget") await page.evaluate(invokeFixtureAction, "disableSubmit");
      return handle;
    }
  } as unknown as Page;
}

async function runFaultCheck(page: Page, contract: FastPathContract, fault: FaultAction): Promise<void> {
  await page.evaluate(invokeFixtureAction, "reset");
  const prepared = benchmarkCapability(contract);
  const armed = new ArmedFastPath({ ...prepared.armedOptions, page: pageWithFault(page, fault) });
  const running = armed.run();
  const [result] = await Promise.all([running, page.evaluate(openSaleWhenResident)]);
  if (
    ((fault === "priceChanged" || fault === "evidenceChangedAfterHandle") &&
      result.outcome !== "ZERO_CLICK_BLOCKED") ||
    (fault !== "priceChanged" && fault !== "evidenceChangedAfterHandle" &&
      result.outcome !== "OUTCOME_UNKNOWN")
  ) throw new Error("ARMED_FAST_PATH_BENCHMARK_FAULT_RESULT_INVALID");
  const evidence = await page.evaluate(collectEvidence);
  if (
    evidence.trustedClickCount !== 0 ||
    evidence.untrustedClickCount !== 0 ||
    evidence.decoyClickCount !== 0 ||
    evidence.submitChildTargetCount !== 0 ||
    evidence.replacementClickCount !== 0
  ) throw new Error("ARMED_FAST_PATH_BENCHMARK_FAULT_CLICKED");
}

async function runFaultChecks(page: Page, contract: FastPathContract): Promise<ArmedFastPathBenchmarkFaultChecks> {
  await runExactTargetCheck(page, contract);
  await page.reload({ waitUntil: "domcontentloaded" });
  await runFaultCheck(page, contract, "priceChanged");
  await page.reload({ waitUntil: "domcontentloaded" });
  await runFaultCheck(page, contract, "evidenceChangedAfterHandle");
  await page.reload({ waitUntil: "domcontentloaded" });
  await runFaultCheck(page, contract, "detachedHandle");
  await page.reload({ waitUntil: "domcontentloaded" });
  await runFaultCheck(page, contract, "obscuredTarget");
  await page.reload({ waitUntil: "domcontentloaded" });
  await runFaultCheck(page, contract, "disabledTarget");
  await page.reload({ waitUntil: "domcontentloaded" });
  return {
    exactTargetBound: 1,
    evidenceChangedAfterHandle: 1,
    priceChanged: 1,
    detachedHandle: 1,
    obscuredTarget: 1,
    disabledTarget: 1
  };
}

function boundedIterations(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > MAX_ITERATIONS) {
    throw new Error("ARMED_FAST_PATH_BENCHMARK_ITERATIONS_INVALID");
  }
  return resolved;
}

function summary(metric: ArmedFastPathBenchmarkMetric, values: readonly number[]): ArmedFastPathBenchmarkSummary {
  return { metric, ...summarizeDurations(values) };
}

export async function runArmedFastPathBenchmark(
  page: Page,
  options: { warmupIterations?: number; sampleIterations?: number } = {}
): Promise<ArmedFastPathBenchmarkReport> {
  if (page.url() !== ARMED_FAST_PATH_BENCHMARK_URL) throw new Error("ARMED_FAST_PATH_BENCHMARK_PAGE_CHANGED");
  const contract = armedFastPathBenchmarkContract();
  const warmupIterations = boundedIterations(options.warmupIterations, ARMED_FAST_PATH_BENCHMARK_WARMUP_ITERATIONS);
  const sampleIterations = boundedIterations(options.sampleIterations, ARMED_FAST_PATH_BENCHMARK_SAMPLE_ITERATIONS);
  if (sampleIterations < 1) throw new Error("ARMED_FAST_PATH_BENCHMARK_ITERATIONS_INVALID");
  const faultChecks = await runFaultChecks(page, contract);
  for (let iteration = 0; iteration < warmupIterations; iteration += 1) await runIteration(page, contract);
  const samples: ArmedFastPathBenchmarkSample[] = [];
  for (let iteration = 0; iteration < sampleIterations; iteration += 1) {
    samples.push({ iteration, ...(await runIteration(page, contract)) });
  }
  return {
    schemaVersion: 1,
    benchmark: "armed-fast-path",
    clock: "monotonic",
    unit: "milliseconds",
    warmupIterations,
    sampleIterations,
    faultChecks,
    samples,
    summaries: ARMED_FAST_PATH_BENCHMARK_METRICS.map((metric) => (
      summary(metric, samples.map((sample) => sample[metric]))
    ))
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validIteration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function normalizedDuration(value: unknown): number {
  if (!safeDuration(value)) throw new Error("ARMED_FAST_PATH_BENCHMARK_REPORT_INVALID");
  return Object.is(value, -0) ? 0 : value;
}

function validateFaultChecks(value: unknown): ArmedFastPathBenchmarkFaultChecks {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, FAULT_KEYS) ||
    value.exactTargetBound !== 1 ||
    value.evidenceChangedAfterHandle !== 1 ||
    value.priceChanged !== 1 ||
    value.detachedHandle !== 1 ||
    value.obscuredTarget !== 1 ||
    value.disabledTarget !== 1
  ) throw new Error("ARMED_FAST_PATH_BENCHMARK_REPORT_INVALID");
  return {
    exactTargetBound: 1,
    evidenceChangedAfterHandle: 1,
    priceChanged: 1,
    detachedHandle: 1,
    obscuredTarget: 1,
    disabledTarget: 1
  };
}

function validateSummary(
  value: unknown,
  metric: ArmedFastPathBenchmarkMetric,
  values: readonly number[]
): ArmedFastPathBenchmarkSummary {
  if (!isRecord(value) || !hasExactKeys(value, SUMMARY_KEYS) || value.metric !== metric) {
    throw new Error("ARMED_FAST_PATH_BENCHMARK_REPORT_INVALID");
  }
  const expected = summary(metric, values);
  for (const key of ["count", "minMs", "maxMs", "p50Ms", "p95Ms", "p99Ms"] as const) {
    if (value[key] !== expected[key]) throw new Error("ARMED_FAST_PATH_BENCHMARK_REPORT_INVALID");
  }
  return expected;
}

/** Validates untrusted output, rejects extra fields, and recomputes all percentiles from raw samples. */
export function validateArmedFastPathBenchmarkReport(value: unknown): ArmedFastPathBenchmarkReport {
  if (!isRecord(value) || !hasExactKeys(value, REPORT_KEYS)) {
    throw new Error("ARMED_FAST_PATH_BENCHMARK_REPORT_INVALID");
  }
  if (
    value.schemaVersion !== 1 ||
    value.benchmark !== "armed-fast-path" ||
    value.clock !== "monotonic" ||
    value.unit !== "milliseconds" ||
    !validIteration(value.warmupIterations) ||
    !validIteration(value.sampleIterations) ||
    value.warmupIterations > MAX_ITERATIONS ||
    value.sampleIterations < 1 ||
    value.sampleIterations > MAX_ITERATIONS ||
    !Array.isArray(value.samples) ||
    value.samples.length !== value.sampleIterations ||
    !Array.isArray(value.summaries) ||
    value.summaries.length !== ARMED_FAST_PATH_BENCHMARK_METRICS.length
  ) throw new Error("ARMED_FAST_PATH_BENCHMARK_REPORT_INVALID");

  const samples = value.samples.map((sample, index): ArmedFastPathBenchmarkSample => {
    if (
      !isRecord(sample) ||
      !hasExactKeys(sample, SAMPLE_KEYS) ||
      sample.iteration !== index ||
      !safeDuration(sample.browserSelectionLatencyMs) ||
      !safeDuration(sample.hotPathLatencyMs) ||
      !safeDuration(sample.consumeLatencyMs) ||
      !safeDuration(sample.finalEvidenceLatencyMs) ||
      !safeDuration(sample.trustedClickLatencyMs) ||
      !safeDuration(sample.t0ToTrustedClickLatencyMs) ||
      sample.hotPathLatencyMs < sample.consumeLatencyMs ||
      sample.hotPathLatencyMs < sample.finalEvidenceLatencyMs ||
      sample.hotPathLatencyMs < sample.trustedClickLatencyMs ||
      sample.trustedClickCount !== 1 ||
      sample.untrustedClickCount !== 0
    ) throw new Error("ARMED_FAST_PATH_BENCHMARK_REPORT_INVALID");
    return {
      iteration: index,
      browserSelectionLatencyMs: normalizedDuration(sample.browserSelectionLatencyMs),
      hotPathLatencyMs: normalizedDuration(sample.hotPathLatencyMs),
      consumeLatencyMs: normalizedDuration(sample.consumeLatencyMs),
      finalEvidenceLatencyMs: normalizedDuration(sample.finalEvidenceLatencyMs),
      trustedClickLatencyMs: normalizedDuration(sample.trustedClickLatencyMs),
      t0ToTrustedClickLatencyMs: normalizedDuration(sample.t0ToTrustedClickLatencyMs),
      trustedClickCount: 1,
      untrustedClickCount: 0
    };
  });
  const suppliedSummaries = value.summaries as unknown[];
  const summaries = ARMED_FAST_PATH_BENCHMARK_METRICS.map((metric, index) => (
    validateSummary(suppliedSummaries[index], metric, samples.map((sample) => sample[metric]))
  ));
  return {
    schemaVersion: 1,
    benchmark: "armed-fast-path",
    clock: "monotonic",
    unit: "milliseconds",
    warmupIterations: value.warmupIterations,
    sampleIterations: value.sampleIterations,
    faultChecks: validateFaultChecks(value.faultChecks),
    samples,
    summaries
  };
}

export function assertArmedFastPathBenchmarkGates(report: unknown): void {
  const validated = validateArmedFastPathBenchmarkReport(report);
  const byMetric = new Map(validated.summaries.map((entry) => [entry.metric, entry]));
  const hot = byMetric.get("hotPathLatencyMs");
  const click = byMetric.get("trustedClickLatencyMs");
  const t0ToClick = byMetric.get("t0ToTrustedClickLatencyMs");
  if (
    hot === undefined ||
    click === undefined ||
    t0ToClick === undefined ||
    hot.p95Ms > ARMED_FAST_PATH_BENCHMARK_GATES.hotPathP95Ms ||
    hot.p99Ms > ARMED_FAST_PATH_BENCHMARK_GATES.hotPathP99Ms ||
    click.p95Ms > ARMED_FAST_PATH_BENCHMARK_GATES.trustedClickP95Ms ||
    click.p99Ms > ARMED_FAST_PATH_BENCHMARK_GATES.trustedClickP99Ms ||
    t0ToClick.p95Ms > ARMED_FAST_PATH_BENCHMARK_GATES.t0ToTrustedClickP95Ms ||
    t0ToClick.p99Ms > ARMED_FAST_PATH_BENCHMARK_GATES.t0ToTrustedClickP99Ms
  ) throw new Error("ARMED_FAST_PATH_BENCHMARK_GATE_FAILED");
}

export function serializeArmedFastPathBenchmarkReport(report: unknown): string {
  return JSON.stringify(validateArmedFastPathBenchmarkReport(report));
}
