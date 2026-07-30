import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { Page } from "playwright-core";

import {
  PerformanceRecorder,
  type PerformanceReport,
  type StageDurationSummary
} from "./metrics.js";

export const LOOPBACK_BENCHMARK_HOST = "127.0.0.1";
export const LOOPBACK_BENCHMARK_PATH = "/benchmark";
export const LOOPBACK_BENCHMARK_ITERATIONS = 500;
export const LOOPBACK_BENCHMARK_WARMUP_ITERATIONS = 50;

export interface StartedLoopbackBenchmarkServer {
  server: Server;
  url: string;
}

export interface LoopbackBenchmarkOptions {
  iterations?: number;
  warmupIterations?: number;
}

interface BrowserIterationMetrics {
  detectMs: number;
  validateMs: number;
  actionMs: number;
  totalMs: number;
  fakeSubmitCount: number;
}

const BROWSER_METRIC_KEYS = ["detectMs", "validateMs", "actionMs", "totalMs", "fakeSubmitCount"] as const;

export const LOOPBACK_BENCHMARK_GATES = {
  sale_state_detection: { p95Ms: 75, p99Ms: 150 },
  page_inspection: { p95Ms: 100, p99Ms: 200 },
  atomic_submit: { p95Ms: 75, p99Ms: 100 },
  run_total: { p95Ms: 800, p99Ms: 1_000 }
} as const;

const BENCHMARK_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Ticket Agent Loopback Benchmark</title>
</head>
<body data-benchmark-contract="v1">
  <main id="benchmark-root" data-event-id="loopback-benchmark-v1">
    <div id="sale-state" data-state="waiting">等待本地放行</div>
    <button type="button" data-stage="session" data-selected="true">本地场次</button>
    <button type="button" data-stage="tier" data-selected="true" data-price-fen="5800">本地票档 ¥58</button>
    <output data-stage="quantity" data-value="1">1张</output>
    <div data-stage="attendee" data-ref-count="1" data-selected="true">本地非实名引用</div>
    <output id="order-total" data-order-total-fen="5800">合计 ¥58</output>
    <button id="fake-submit" type="button" data-benchmark-sink="true" disabled>本地假提交</button>
    <output id="fake-result" data-click-count="0"></output>
  </main>
  <script>
    (() => {
      "use strict";
      const sale = document.querySelector("#sale-state");
      const submit = document.querySelector("#fake-submit");
      const result = document.querySelector("#fake-result");
      if (!(sale instanceof HTMLElement) || !(submit instanceof HTMLButtonElement) || !(result instanceof HTMLOutputElement)) {
        throw new Error("BENCHMARK_BOOTSTRAP_INVALID");
      }
      submit.addEventListener("click", () => {
        if (submit.dataset.benchmarkSink !== "true" || submit.disabled || sale.dataset.state !== "open") {
          throw new Error("BENCHMARK_FAKE_SUBMIT_BLOCKED");
        }
        const previous = Number(result.dataset.clickCount ?? "0");
        result.dataset.clickCount = String(previous + 1);
        result.value = "FAKE_CLICK_RECORDED";
      });
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

export function createLoopbackBenchmarkServer(): Server {
  return createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      send(response, 405, "application/json; charset=utf-8", '{"error":"METHOD_NOT_ALLOWED"}');
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "/", `http://${LOOPBACK_BENCHMARK_HOST}`);
    } catch {
      send(response, 400, "application/json; charset=utf-8", '{"error":"MALFORMED_URI"}');
      return;
    }
    if (url.search || url.hash) {
      send(response, 404, "application/json; charset=utf-8", '{"error":"NOT_FOUND"}');
      return;
    }
    if (url.pathname === LOOPBACK_BENCHMARK_PATH) {
      send(response, 200, "text/html; charset=utf-8", request.method === "HEAD" ? "" : BENCHMARK_HTML);
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

export async function startLoopbackBenchmarkServer(): Promise<StartedLoopbackBenchmarkServer> {
  const server = createLoopbackBenchmarkServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, LOOPBACK_BENCHMARK_HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeLoopbackBenchmarkServer(server);
    throw new Error("BENCHMARK_BIND_FAILED");
  }
  return {
    server,
    url: `http://${LOOPBACK_BENCHMARK_HOST}:${(address as AddressInfo).port}${LOOPBACK_BENCHMARK_PATH}`
  };
}

export function closeLoopbackBenchmarkServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

/** Only the exact benchmark path on numeric IPv4 loopback is accepted. */
export function assertLoopbackBenchmarkUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("BENCHMARK_TARGET_BLOCKED");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== LOOPBACK_BENCHMARK_HOST ||
    url.port === "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== LOOPBACK_BENCHMARK_PATH ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("BENCHMARK_TARGET_BLOCKED");
  }
  return url;
}

/** Allows browser resources only from the exact ephemeral benchmark origin. */
export function assertSameBenchmarkOrigin(resourceValue: string, benchmarkValue: string): URL {
  const benchmark = assertLoopbackBenchmarkUrl(benchmarkValue);
  let resource: URL;
  try {
    resource = new URL(resourceValue);
  } catch {
    throw new Error("BENCHMARK_NETWORK_BLOCKED");
  }
  if (
    resource.protocol !== "http:" ||
    resource.origin !== benchmark.origin ||
    resource.username !== "" ||
    resource.password !== ""
  ) {
    throw new Error("BENCHMARK_NETWORK_BLOCKED");
  }
  return resource;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error("BENCHMARK_ITERATION_COUNT_INVALID");
  }
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validateBrowserMetric(value: unknown): BrowserIterationMetrics {
  if (!isRecord(value)) throw new Error("BENCHMARK_BROWSER_METRIC_INVALID");
  const keys = Object.keys(value).sort();
  const expected = [...BROWSER_METRIC_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("BENCHMARK_BROWSER_METRIC_INVALID");
  }
  if (
    !safeDuration(value.detectMs) ||
    !safeDuration(value.validateMs) ||
    !safeDuration(value.actionMs) ||
    !safeDuration(value.totalMs) ||
    value.fakeSubmitCount !== 1
  ) {
    throw new Error("BENCHMARK_BROWSER_METRIC_INVALID");
  }
  if (value.totalMs < Math.max(value.detectMs, value.validateMs, value.actionMs)) {
    throw new Error("BENCHMARK_BROWSER_METRIC_INVALID");
  }
  return {
    detectMs: value.detectMs,
    validateMs: value.validateMs,
    actionMs: value.actionMs,
    totalMs: value.totalMs,
    fakeSubmitCount: 1
  };
}

async function executeHotPathInPage(iterations: number): Promise<BrowserIterationMetrics[]> {
  const root = document.querySelector("#benchmark-root");
  const sale = document.querySelector("#sale-state");
  const submit = document.querySelector("#fake-submit");
  const result = document.querySelector("#fake-result");
  if (
    !(root instanceof HTMLElement) ||
    !(sale instanceof HTMLElement) ||
    !(submit instanceof HTMLButtonElement) ||
    !(result instanceof HTMLOutputElement) ||
    location.protocol !== "http:" ||
    location.hostname !== "127.0.0.1"
  ) {
    throw new Error("BENCHMARK_DOM_CONTRACT_INVALID");
  }

  const validate = (): boolean => {
    const sessions = document.querySelectorAll('[data-stage="session"][data-selected="true"]');
    const tiers = document.querySelectorAll('[data-stage="tier"][data-selected="true"][data-price-fen="5800"]');
    const quantities = document.querySelectorAll('[data-stage="quantity"][data-value="1"]');
    const attendees = document.querySelectorAll('[data-stage="attendee"][data-ref-count="1"][data-selected="true"]');
    const totals = document.querySelectorAll('#order-total[data-order-total-fen="5800"]');
    const sinks = document.querySelectorAll('#fake-submit[data-benchmark-sink="true"]');
    return (
      document.body.dataset.benchmarkContract === "v1" &&
      root.dataset.eventId === "loopback-benchmark-v1" &&
      sale.dataset.state === "open" &&
      sessions.length === 1 &&
      tiers.length === 1 &&
      quantities.length === 1 &&
      attendees.length === 1 &&
      totals.length === 1 &&
      (totals[0] as HTMLElement).innerText.trim() === "合计 ¥58" &&
      sinks.length === 1 &&
      !submit.disabled &&
      submit.type === "button" &&
      submit.form === null
    );
  };

  const measurements: BrowserIterationMetrics[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    sale.dataset.state = "waiting";
    submit.disabled = true;
    result.dataset.clickCount = "0";
    result.value = "";

    const totalStartedAt = performance.now();
    const detectStartedAt = performance.now();
    const detected = new Promise<number>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout>;
      const observer = new MutationObserver(() => {
        if (sale.dataset.state !== "open") return;
        observer.disconnect();
        clearTimeout(timeout);
        resolve(performance.now() - detectStartedAt);
      });
      observer.observe(sale, { attributes: true, attributeFilter: ["data-state"] });
      queueMicrotask(() => {
        sale.dataset.state = "open";
        submit.disabled = false;
      });
      timeout = setTimeout(() => {
        observer.disconnect();
        reject(new Error("BENCHMARK_DOM_DETECT_TIMEOUT"));
      }, 1_000);
    });
    const detectMs = await detected;

    const validateStartedAt = performance.now();
    if (!validate()) throw new Error("BENCHMARK_DOM_VALIDATION_FAILED");
    const validateMs = performance.now() - validateStartedAt;

    const actionStartedAt = performance.now();
    submit.click();
    const actionMs = performance.now() - actionStartedAt;
    const totalMs = performance.now() - totalStartedAt;
    const fakeSubmitCount = Number(result.dataset.clickCount ?? "0");
    if (fakeSubmitCount !== 1 || result.value !== "FAKE_CLICK_RECORDED") {
      throw new Error("BENCHMARK_FAKE_SUBMIT_COUNT_INVALID");
    }
    measurements.push({ detectMs, validateMs, actionMs, totalMs, fakeSubmitCount });
  }
  return measurements;
}

export async function runLoopbackHotPathBenchmark(
  page: Page,
  benchmarkValue: string,
  options: LoopbackBenchmarkOptions = {}
): Promise<PerformanceReport> {
  const benchmark = assertLoopbackBenchmarkUrl(benchmarkValue);
  const iterations = boundedInteger(options.iterations, LOOPBACK_BENCHMARK_ITERATIONS, 1, LOOPBACK_BENCHMARK_ITERATIONS);
  const warmupIterations = boundedInteger(
    options.warmupIterations,
    LOOPBACK_BENCHMARK_WARMUP_ITERATIONS,
    0,
    LOOPBACK_BENCHMARK_ITERATIONS
  );
  if (new URL(page.url()).href !== benchmark.href) throw new Error("BENCHMARK_PAGE_TARGET_MISMATCH");

  if (warmupIterations > 0) {
    const warmup = await page.evaluate(executeHotPathInPage, warmupIterations);
    if (!Array.isArray(warmup) || warmup.length !== warmupIterations) {
      throw new Error("BENCHMARK_WARMUP_INVALID");
    }
    for (const metric of warmup) validateBrowserMetric(metric);
  }

  const recorder = new PerformanceRecorder();
  // Keep one Playwright boundary per measured iteration. Component durations
  // come from the browser monotonic clock; run_total additionally includes the
  // page.evaluate round trip that the real local runner must pay.
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const total = recorder.start("run_total", iteration);
    const raw = await page.evaluate(executeHotPathInPage, 1);
    if (!Array.isArray(raw) || raw.length !== 1) throw new Error("BENCHMARK_SAMPLE_COUNT_INVALID");
    const metric = validateBrowserMetric(raw[0]);
    recorder.record("sale_state_detection", metric.detectMs, iteration);
    recorder.record("page_inspection", metric.validateMs, iteration);
    recorder.record("atomic_submit", metric.actionMs, iteration);
    total.stop();
  }
  if (new URL(page.url()).href !== benchmark.href) throw new Error("BENCHMARK_PAGE_TARGET_MISMATCH");
  return recorder.report();
}

function requireSummary(report: PerformanceReport, stage: keyof typeof LOOPBACK_BENCHMARK_GATES): StageDurationSummary {
  const matches = report.summaries.filter((summary) => summary.stage === stage);
  if (matches.length !== 1) throw new Error("BENCHMARK_SUMMARY_MISSING");
  return matches[0]!;
}

export function assertLoopbackBenchmarkGates(report: PerformanceReport): void {
  for (const stage of Object.keys(LOOPBACK_BENCHMARK_GATES) as (keyof typeof LOOPBACK_BENCHMARK_GATES)[]) {
    const summary = requireSummary(report, stage);
    const gate = LOOPBACK_BENCHMARK_GATES[stage];
    if (summary.p95Ms > gate.p95Ms || summary.p99Ms > gate.p99Ms) {
      throw new Error(`BENCHMARK_GATE_FAILED:${stage}`);
    }
  }
}
