import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { Page } from "playwright-core";

import { summarizeDurations, type DurationSummary } from "./metrics.js";
import {
  runBrowserSelectionStateMachine,
  type BrowserSelectionContract,
  type BrowserSelectionPlan,
  type BrowserSelectionResult
} from "../runner/browser-selection-state-machine.js";

export const STATE_MACHINE_BENCHMARK_HOST = "127.0.0.1";
export const STATE_MACHINE_BENCHMARK_PATH = "/state-machine-benchmark";
export const STATE_MACHINE_BENCHMARK_WARMUP_ITERATIONS = 50;
export const STATE_MACHINE_BENCHMARK_SAMPLE_ITERATIONS = 500;

const STATE_MACHINE_BENCHMARK_MAX_ITERATIONS = 500;
const FIXTURE_EVENT_ID = "state-machine-benchmark-v1";
const FIXTURE_EVENT_TITLE = "Local State Machine Fixture";
const FIXTURE_SESSION = "Session-A";
const FIXTURE_TIER = "Stand";
const FIXTURE_ATTENDEE = "Synthetic-A";
const FIXTURE_UNIT_PRICE_FEN = 5_800;
const FIXTURE_TOTAL_FEN = 5_800;

export interface StartedStateMachineBenchmarkServer {
  readonly server: Server;
  readonly url: string;
}

export interface StateMachineBenchmarkOptions {
  /** Test-only override. The CLI always uses the fixed constants above. */
  readonly warmupIterations?: number;
  /** Test-only override. The CLI always uses the fixed constants above. */
  readonly sampleIterations?: number;
}

export interface StateMachineBenchmarkSample {
  readonly iteration: number;
  readonly browserLatencyMs: number;
  readonly nodeEndToEndMs: number;
}

export type StateMachineBenchmarkMetric = "browserLatencyMs" | "nodeEndToEndMs";

export interface StateMachineBenchmarkSummary extends DurationSummary {
  readonly metric: StateMachineBenchmarkMetric;
}

export interface StateMachineBenchmarkReport {
  readonly schemaVersion: 1;
  readonly benchmark: "browser-selection-state-machine";
  readonly clock: "monotonic";
  readonly unit: "milliseconds";
  readonly warmupIterations: number;
  readonly sampleIterations: number;
  readonly samples: readonly StateMachineBenchmarkSample[];
  readonly summaries: readonly StateMachineBenchmarkSummary[];
}

const REPORT_KEYS = [
  "benchmark",
  "clock",
  "sampleIterations",
  "samples",
  "schemaVersion",
  "summaries",
  "unit",
  "warmupIterations"
] as const;
const SAMPLE_KEYS = ["browserLatencyMs", "iteration", "nodeEndToEndMs"] as const;
const SUMMARY_KEYS = ["count", "maxMs", "metric", "minMs", "p50Ms", "p95Ms", "p99Ms"] as const;

const STATE_MACHINE_BENCHMARK_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Browser Selection State Machine Benchmark</title>
</head>
<body>
  <main data-sm-root="v1" data-sale-state="waiting">
    <h1 data-sm-event-title>${FIXTURE_EVENT_TITLE}</h1>
    <section data-sm-event-id data-event-id="${FIXTURE_EVENT_ID}">
      <button type="button" data-sm-session data-visible-label="${FIXTURE_SESSION}" data-selected="false" hidden>
        <span data-sm-label>${FIXTURE_SESSION}</span>
      </button>
      <output data-sm-session-summary></output>

      <button type="button" data-sm-tier data-visible-label="VIP" data-selected="false" data-price-fen="12000">
        <span data-sm-label>VIP</span><span data-sm-price>¥120.00</span>
      </button>
      <button type="button" data-sm-tier data-visible-label="${FIXTURE_TIER}" data-selected="false" data-price-fen="${FIXTURE_UNIT_PRICE_FEN}">
        <span data-sm-label>${FIXTURE_TIER}</span><span data-sm-price>¥58.00</span>
      </button>
      <output data-sm-tier-summary></output>

      <button type="button" data-sm-quantity data-visible-label="1" data-selected="false">
        <span data-sm-label>1</span>
      </button>
      <output data-sm-quantity-summary></output>

      <button type="button" data-sm-attendee data-visible-label="${FIXTURE_ATTENDEE}" data-selected="false">
        <span data-sm-label>${FIXTURE_ATTENDEE}</span>
      </button>

      <strong data-sm-total data-order-total-fen="${FIXTURE_TOTAL_FEN}">¥58.00</strong>
      <button type="button" data-sm-real-submit data-click-count="0">Irreversible decoy</button>
      <button type="button" data-ticket-agent-test-sink="browser-selection-v1" data-ticket-agent-test-click-count="0">Fixed local fake sink</button>
    </section>
  </main>
  <script>
    (() => {
      "use strict";
      const one = (selector) => {
        const matches = document.querySelectorAll(selector);
        if (matches.length !== 1 || !(matches[0] instanceof HTMLElement)) throw new Error("FIXTURE_INVALID");
        return matches[0];
      };
      const all = (selector) => Array.from(document.querySelectorAll(selector));
      const root = one('[data-sm-root="v1"]');
      const session = one("[data-sm-session]");
      const sessionSummary = one("[data-sm-session-summary]");
      const stand = all("[data-sm-tier]").find((element) => element.getAttribute("data-visible-label") === "${FIXTURE_TIER}");
      const tierSummary = one("[data-sm-tier-summary]");
      const quantity = one("[data-sm-quantity]");
      const quantitySummary = one("[data-sm-quantity-summary]");
      const attendee = one("[data-sm-attendee]");
      const sink = one('[data-ticket-agent-test-sink="browser-selection-v1"]');
      const realSubmit = one("[data-sm-real-submit]");
      if (!(stand instanceof HTMLElement)) throw new Error("FIXTURE_INVALID");

      const selectOnly = (selector, selected) => {
        for (const option of all(selector)) option.setAttribute("data-selected", String(option === selected));
      };
      session.addEventListener("click", () => {
        selectOnly("[data-sm-session]", session);
        sessionSummary.innerText = "${FIXTURE_SESSION}";
      });
      stand.addEventListener("click", () => {
        selectOnly("[data-sm-tier]", stand);
        tierSummary.innerText = "${FIXTURE_TIER}";
      });
      quantity.addEventListener("click", () => {
        selectOnly("[data-sm-quantity]", quantity);
        quantitySummary.innerText = "1张";
      });
      attendee.addEventListener("click", () => selectOnly("[data-sm-attendee]", attendee));
      realSubmit.addEventListener("click", () => {
        const count = Number(realSubmit.getAttribute("data-click-count") ?? "0");
        realSubmit.setAttribute("data-click-count", String(count + 1));
      });
      sink.addEventListener("click", () => {
        if (root.getAttribute("data-sale-state") !== "open") throw new Error("FAKE_SINK_BLOCKED");
        if (
          session.getAttribute("data-selected") !== "true" ||
          stand.getAttribute("data-selected") !== "true" ||
          quantity.getAttribute("data-selected") !== "true" ||
          attendee.getAttribute("data-selected") !== "true"
        ) throw new Error("FAKE_SINK_BLOCKED");
        const count = Number(sink.getAttribute("data-ticket-agent-test-click-count") ?? "0");
        sink.setAttribute("data-ticket-agent-test-click-count", String(count + 1));
      });

      const reset = () => {
        root.setAttribute("data-sale-state", "waiting");
        session.hidden = true;
        for (const selector of ["[data-sm-session]", "[data-sm-tier]", "[data-sm-quantity]", "[data-sm-attendee]"]) {
          for (const option of all(selector)) option.setAttribute("data-selected", "false");
        }
        sessionSummary.innerText = "";
        tierSummary.innerText = "";
        quantitySummary.innerText = "";
        sink.setAttribute("data-ticket-agent-test-click-count", "0");
        realSubmit.setAttribute("data-click-count", "0");
      };
      const openSale = () => {
        if (!session.hidden || root.getAttribute("data-sale-state") !== "waiting") throw new Error("FIXTURE_NOT_WAITING");
        root.setAttribute("data-sale-state", "open");
        session.hidden = false;
      };
      Object.defineProperty(globalThis, "__ticketAgentStateMachineBenchmark_v1", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: Object.freeze({ reset, openSale })
      });
      reset();
    })();
  </script>
</body>
</html>`;

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'none'; img-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    "content-type": contentType,
    "cross-origin-opener-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  });
  response.end(body);
}

export function createStateMachineBenchmarkServer(): Server {
  return createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      send(response, 405, "application/json; charset=utf-8", '{"error":"METHOD_NOT_ALLOWED"}');
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "/", `http://${STATE_MACHINE_BENCHMARK_HOST}`);
    } catch {
      send(response, 400, "application/json; charset=utf-8", '{"error":"MALFORMED_URI"}');
      return;
    }
    if (url.search !== "" || url.hash !== "") {
      send(response, 404, "application/json; charset=utf-8", '{"error":"NOT_FOUND"}');
      return;
    }
    if (url.pathname === STATE_MACHINE_BENCHMARK_PATH) {
      send(response, 200, "text/html; charset=utf-8", request.method === "HEAD" ? "" : STATE_MACHINE_BENCHMARK_HTML);
      return;
    }
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }
    send(response, 404, "application/json; charset=utf-8", '{"error":"NOT_FOUND"}');
  });
}

export async function startStateMachineBenchmarkServer(): Promise<StartedStateMachineBenchmarkServer> {
  const server = createStateMachineBenchmarkServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, STATE_MACHINE_BENCHMARK_HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeStateMachineBenchmarkServer(server);
    throw new Error("STATE_MACHINE_BENCHMARK_BIND_FAILED");
  }
  return {
    server,
    url: `http://${STATE_MACHINE_BENCHMARK_HOST}:${(address as AddressInfo).port}${STATE_MACHINE_BENCHMARK_PATH}`
  };
}

export function closeStateMachineBenchmarkServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

export function assertStateMachineBenchmarkUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("STATE_MACHINE_BENCHMARK_TARGET_BLOCKED");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== STATE_MACHINE_BENCHMARK_HOST ||
    url.port === "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== STATE_MACHINE_BENCHMARK_PATH ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("STATE_MACHINE_BENCHMARK_TARGET_BLOCKED");
  }
  return url;
}

export function assertSameStateMachineBenchmarkOrigin(resourceValue: string, benchmarkValue: string): URL {
  const benchmark = assertStateMachineBenchmarkUrl(benchmarkValue);
  let resource: URL;
  try {
    resource = new URL(resourceValue);
  } catch {
    throw new Error("STATE_MACHINE_BENCHMARK_NETWORK_BLOCKED");
  }
  if (
    resource.protocol !== "http:" ||
    resource.hostname !== STATE_MACHINE_BENCHMARK_HOST ||
    resource.origin !== benchmark.origin ||
    resource.username !== "" ||
    resource.password !== ""
  ) {
    throw new Error("STATE_MACHINE_BENCHMARK_NETWORK_BLOCKED");
  }
  return resource;
}

function benchmarkContract(origin: string): BrowserSelectionContract {
  const choice = (optionSelector: string, withPrice = false) => ({
    optionSelector,
    labelSelector: "[data-sm-label]",
    labelAttribute: "data-visible-label",
    selectedSelector: '[data-selected="true"]',
    ...(withPrice ? { priceTextSelector: "[data-sm-price]", priceFenAttribute: "data-price-fen" } : {})
  });
  return {
    platform: "damai",
    allowedOrigins: [origin],
    blockingPredicates: [
      { key: "captcha-visible", selector: "[data-sm-block-captcha]" },
      { key: "login-required-visible", selector: "[data-sm-block-login]" },
      { key: "sold-out-visible", selector: "[data-sm-block-sold-out]" },
      { key: "official-queue-visible", selector: "[data-sm-block-queue]" }
    ],
    eventTitleSelector: "[data-sm-event-title]",
    eventIdSelector: "[data-sm-event-id]",
    eventIdAttribute: "data-event-id",
    session: choice("[data-sm-session]"),
    sessionSummarySelector: "[data-sm-session-summary]",
    tier: choice("[data-sm-tier]", true),
    tierSummarySelector: "[data-sm-tier-summary]",
    quantity: {
      summarySelector: "[data-sm-quantity-summary]",
      option: choice("[data-sm-quantity]")
    },
    attendee: choice("[data-sm-attendee]"),
    totalSelector: "[data-sm-total]",
    totalFenAttribute: "data-order-total-fen",
    forbiddenActionSelectors: ["[data-sm-real-submit]"]
  };
}

const BENCHMARK_PLAN: BrowserSelectionPlan = Object.freeze({
  eventId: FIXTURE_EVENT_ID,
  eventTitle: FIXTURE_EVENT_TITLE,
  sessionLabels: Object.freeze([FIXTURE_SESSION]),
  tierPreferences: Object.freeze([
    Object.freeze({ label: "VIP", maxUnitPriceFen: 10_000 }),
    Object.freeze({ label: FIXTURE_TIER, maxUnitPriceFen: 6_000 })
  ]),
  quantity: 1,
  attendeeLabels: Object.freeze([FIXTURE_ATTENDEE]),
  maxTotalFen: 6_000,
  requireAdjacent: false
});

function resetStateMachineBenchmarkPage(expectedHref: string): void {
  const scope = globalThis as typeof globalThis & {
    __ticketAgentStateMachineBenchmark_v1?: { reset: () => void };
  };
  if (location.href !== expectedHref || location.hostname !== "127.0.0.1" || location.protocol !== "http:") {
    throw new Error("STATE_MACHINE_BENCHMARK_PAGE_CHANGED");
  }
  const api = scope.__ticketAgentStateMachineBenchmark_v1;
  if (!api || typeof api.reset !== "function") throw new Error("STATE_MACHINE_BENCHMARK_FIXTURE_INVALID");
  api.reset();
}

async function triggerStateMachineSale(expectedHref: string): Promise<void> {
  const scope = globalThis as typeof globalThis & {
    __ticketAgentSelectionMachines_v1?: Record<string, () => void>;
    __ticketAgentStateMachineBenchmark_v1?: { openSale: () => void };
  };
  const deadline = performance.now() + 1_000;
  while (Object.keys(scope.__ticketAgentSelectionMachines_v1 ?? {}).length !== 1) {
    if (performance.now() >= deadline) throw new Error("STATE_MACHINE_BENCHMARK_MACHINE_NOT_READY");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  if (location.href !== expectedHref || location.hostname !== "127.0.0.1" || location.protocol !== "http:") {
    throw new Error("STATE_MACHINE_BENCHMARK_PAGE_CHANGED");
  }
  const api = scope.__ticketAgentStateMachineBenchmark_v1;
  if (!api || typeof api.openSale !== "function") throw new Error("STATE_MACHINE_BENCHMARK_FIXTURE_INVALID");
  api.openSale();
}

interface FixtureEvidence {
  fakeClickCount: number;
  realClickCount: number;
  saleOpen: boolean;
  selectedCount: number;
}

function collectStateMachineBenchmarkEvidence(expectedHref: string): FixtureEvidence {
  if (location.href !== expectedHref || location.hostname !== "127.0.0.1" || location.protocol !== "http:") {
    throw new Error("STATE_MACHINE_BENCHMARK_PAGE_CHANGED");
  }
  const sink = document.querySelector('[data-ticket-agent-test-sink="browser-selection-v1"]');
  const realSubmit = document.querySelector("[data-sm-real-submit]");
  const selectedCount = document.querySelectorAll('[data-selected="true"]').length;
  return {
    fakeClickCount: Number(sink?.getAttribute("data-ticket-agent-test-click-count") ?? "-1"),
    realClickCount: Number(realSubmit?.getAttribute("data-click-count") ?? "-1"),
    saleOpen: document.querySelector('[data-sm-root="v1"]')?.getAttribute("data-sale-state") === "open",
    selectedCount
  };
}

function boundedIterations(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > STATE_MACHINE_BENCHMARK_MAX_ITERATIONS) {
    throw new Error("STATE_MACHINE_BENCHMARK_ITERATIONS_INVALID");
  }
  return resolved;
}

function safeDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function assertSuccessfulIteration(result: BrowserSelectionResult): void {
  if (
    result.outcome !== "test-clicked" ||
    result.selectedSession !== FIXTURE_SESSION ||
    result.selectedTier !== FIXTURE_TIER ||
    result.selectedTierUnitPriceFen !== FIXTURE_UNIT_PRICE_FEN ||
    result.observedTotalFen !== FIXTURE_TOTAL_FEN ||
    result.quantity !== 1 ||
    result.attendeeCount !== 1 ||
    result.adjacentVerified !== true ||
    result.reversibleActionCount !== 4 ||
    result.fakeClickCount !== 1 ||
    !safeDuration(result.browserLatencyMs) ||
    !safeDuration(result.latencyMs) ||
    result.latencyMs < result.browserLatencyMs
  ) {
    throw new Error("STATE_MACHINE_BENCHMARK_RESULT_INVALID");
  }
}

async function runIteration(page: Page, benchmark: URL): Promise<StateMachineBenchmarkSample> {
  if (new URL(page.url()).href !== benchmark.href) throw new Error("STATE_MACHINE_BENCHMARK_PAGE_CHANGED");
  await page.evaluate(resetStateMachineBenchmarkPage, benchmark.href);
  const running = runBrowserSelectionStateMachine(page, {
    contract: benchmarkContract(benchmark.origin),
    plan: BENCHMARK_PLAN,
    timeoutMs: 2_000,
    fallbackIntervalMs: 16,
    testOnlyFakeSubmit: true
  });
  const [result] = await Promise.all([
    running,
    page.evaluate(triggerStateMachineSale, benchmark.href)
  ]);
  assertSuccessfulIteration(result);
  const evidence = await page.evaluate(collectStateMachineBenchmarkEvidence, benchmark.href);
  if (
    evidence.fakeClickCount !== 1 ||
    evidence.realClickCount !== 0 ||
    evidence.saleOpen !== true ||
    evidence.selectedCount !== 4 ||
    new URL(page.url()).href !== benchmark.href
  ) {
    throw new Error("STATE_MACHINE_BENCHMARK_EVIDENCE_INVALID");
  }
  return {
    iteration: 0,
    browserLatencyMs: result.browserLatencyMs,
    nodeEndToEndMs: result.latencyMs
  };
}

function summary(metric: StateMachineBenchmarkMetric, values: readonly number[]): StateMachineBenchmarkSummary {
  return { metric, ...summarizeDurations(values) };
}

export async function runStateMachineBenchmark(
  page: Page,
  benchmarkValue: string,
  options: StateMachineBenchmarkOptions = {}
): Promise<StateMachineBenchmarkReport> {
  const benchmark = assertStateMachineBenchmarkUrl(benchmarkValue);
  const warmupIterations = boundedIterations(
    options.warmupIterations,
    STATE_MACHINE_BENCHMARK_WARMUP_ITERATIONS
  );
  const sampleIterations = boundedIterations(
    options.sampleIterations,
    STATE_MACHINE_BENCHMARK_SAMPLE_ITERATIONS
  );
  if (sampleIterations < 1) throw new Error("STATE_MACHINE_BENCHMARK_ITERATIONS_INVALID");
  if (new URL(page.url()).href !== benchmark.href) throw new Error("STATE_MACHINE_BENCHMARK_PAGE_CHANGED");

  for (let iteration = 0; iteration < warmupIterations; iteration += 1) {
    await runIteration(page, benchmark);
  }
  const samples: StateMachineBenchmarkSample[] = [];
  for (let iteration = 0; iteration < sampleIterations; iteration += 1) {
    const sample = await runIteration(page, benchmark);
    samples.push({ ...sample, iteration });
  }
  return {
    schemaVersion: 1,
    benchmark: "browser-selection-state-machine",
    clock: "monotonic",
    unit: "milliseconds",
    warmupIterations,
    sampleIterations,
    samples,
    summaries: [
      summary("browserLatencyMs", samples.map((sample) => sample.browserLatencyMs)),
      summary("nodeEndToEndMs", samples.map((sample) => sample.nodeEndToEndMs))
    ]
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

function validateSummary(value: unknown, metric: StateMachineBenchmarkMetric, samples: readonly number[]): StateMachineBenchmarkSummary {
  if (!isRecord(value) || !hasExactKeys(value, SUMMARY_KEYS) || value.metric !== metric) {
    throw new Error("STATE_MACHINE_BENCHMARK_REPORT_INVALID");
  }
  const expected = summary(metric, samples);
  for (const key of ["count", "minMs", "maxMs", "p50Ms", "p95Ms", "p99Ms"] as const) {
    if (value[key] !== expected[key]) throw new Error("STATE_MACHINE_BENCHMARK_REPORT_INVALID");
  }
  return expected;
}

export function validateStateMachineBenchmarkReport(value: unknown): StateMachineBenchmarkReport {
  if (!isRecord(value) || !hasExactKeys(value, REPORT_KEYS)) throw new Error("STATE_MACHINE_BENCHMARK_REPORT_INVALID");
  if (
    value.schemaVersion !== 1 ||
    value.benchmark !== "browser-selection-state-machine" ||
    value.clock !== "monotonic" ||
    value.unit !== "milliseconds" ||
    !validIteration(value.warmupIterations) ||
    !validIteration(value.sampleIterations) ||
    (value.warmupIterations as number) > STATE_MACHINE_BENCHMARK_MAX_ITERATIONS ||
    (value.sampleIterations as number) < 1 ||
    (value.sampleIterations as number) > STATE_MACHINE_BENCHMARK_MAX_ITERATIONS ||
    !Array.isArray(value.samples) ||
    value.samples.length !== value.sampleIterations ||
    !Array.isArray(value.summaries) ||
    value.summaries.length !== 2
  ) {
    throw new Error("STATE_MACHINE_BENCHMARK_REPORT_INVALID");
  }
  const samples = value.samples.map((sample, index): StateMachineBenchmarkSample => {
    if (!isRecord(sample) || !hasExactKeys(sample, SAMPLE_KEYS)) {
      throw new Error("STATE_MACHINE_BENCHMARK_REPORT_INVALID");
    }
    if (
      sample.iteration !== index ||
      !safeDuration(sample.browserLatencyMs) ||
      !safeDuration(sample.nodeEndToEndMs) ||
      sample.nodeEndToEndMs < sample.browserLatencyMs
    ) {
      throw new Error("STATE_MACHINE_BENCHMARK_REPORT_INVALID");
    }
    return {
      iteration: index,
      browserLatencyMs: sample.browserLatencyMs,
      nodeEndToEndMs: sample.nodeEndToEndMs
    };
  });
  const summaries = [
    validateSummary(value.summaries[0], "browserLatencyMs", samples.map((sample) => sample.browserLatencyMs)),
    validateSummary(value.summaries[1], "nodeEndToEndMs", samples.map((sample) => sample.nodeEndToEndMs))
  ] as const;
  return {
    schemaVersion: 1,
    benchmark: "browser-selection-state-machine",
    clock: "monotonic",
    unit: "milliseconds",
    warmupIterations: value.warmupIterations as number,
    sampleIterations: value.sampleIterations as number,
    samples,
    summaries
  };
}

export function serializeStateMachineBenchmarkReport(report: unknown): string {
  return JSON.stringify(validateStateMachineBenchmarkReport(report));
}

