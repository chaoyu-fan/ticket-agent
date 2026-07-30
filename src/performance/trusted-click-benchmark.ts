import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";

import type { ElementHandle, Page } from "playwright-core";

import { summarizeDurations, type DurationSummary } from "./metrics.js";

export const TRUSTED_CLICK_BENCHMARK_HOST = "127.0.0.1";
export const TRUSTED_CLICK_BENCHMARK_PATH = "/trusted-click-benchmark";
export const TRUSTED_CLICK_BENCHMARK_WARMUP_ITERATIONS = 50;
export const TRUSTED_CLICK_BENCHMARK_SAMPLE_ITERATIONS = 500;

const TRUSTED_CLICK_BENCHMARK_MAX_ITERATIONS = 500;
const TRUSTED_CLICK_TIMEOUT_MS = 1_000;
const FAIL_CLOSED_CLICK_TIMEOUT_MS = 100;
const PRIMARY_SELECTOR = '[data-tc-primary="v1"]';
const DETACHED_SELECTOR = '[data-tc-detached="v1"]';
const OBSCURED_SELECTOR = '[data-tc-obscured="v1"]';
const DISABLED_SELECTOR = '[data-tc-disabled="v1"]';

export const TRUSTED_CLICK_BENCHMARK_GATES = Object.freeze({
  p95Ms: 75,
  p99Ms: 100
});

export interface StartedTrustedClickBenchmarkServer {
  readonly server: Server;
  readonly url: string;
}

export interface TrustedClickBenchmarkOptions {
  /** Test-only override. The CLI always uses the fixed constants above. */
  readonly warmupIterations?: number;
  /** Test-only override. The CLI always uses the fixed constants above. */
  readonly sampleIterations?: number;
}

export interface TrustedClickBenchmarkSample {
  readonly iteration: number;
  readonly trustedElementHandleClickMs: number;
  readonly clickCount: 1;
  readonly trustedEventCount: 1;
  readonly untrustedEventCount: 0;
}

export interface TrustedClickBenchmarkFaultChecks {
  readonly detachedHandle: 1;
  readonly obscuredTarget: 1;
  readonly disabledTarget: 1;
}

export interface TrustedClickBenchmarkSummary extends DurationSummary {
  readonly metric: "trustedElementHandleClickMs";
}

export interface TrustedClickBenchmarkReport {
  readonly schemaVersion: 1;
  readonly benchmark: "trusted-element-handle-click";
  readonly clock: "monotonic";
  readonly unit: "milliseconds";
  readonly warmupIterations: number;
  readonly sampleIterations: number;
  readonly faultChecks: TrustedClickBenchmarkFaultChecks;
  readonly samples: readonly TrustedClickBenchmarkSample[];
  readonly summaries: readonly [TrustedClickBenchmarkSummary];
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
const FAULT_KEYS = ["detachedHandle", "disabledTarget", "obscuredTarget"] as const;
const SAMPLE_KEYS = [
  "clickCount",
  "iteration",
  "trustedElementHandleClickMs",
  "trustedEventCount",
  "untrustedEventCount"
] as const;
const SUMMARY_KEYS = ["count", "maxMs", "metric", "minMs", "p50Ms", "p95Ms", "p99Ms"] as const;

const TRUSTED_CLICK_BENCHMARK_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Trusted ElementHandle Click Benchmark</title>
  <style>
    html, body { margin: 0; padding: 0; }
    body { font-family: sans-serif; }
    main { width: 320px; padding: 12px; }
    button, .overlay { width: 240px; height: 44px; }
    .zone { position: relative; width: 240px; height: 44px; margin: 8px 0; }
    .overlay { position: absolute; inset: 0; z-index: 2; background: #ddd; }
  </style>
</head>
<body>
  <main data-tc-root="v1"
    data-primary-click-count="0"
    data-primary-trusted-count="0"
    data-primary-untrusted-count="0"
    data-detached-original-count="0"
    data-detached-replacement-count="0"
    data-obscured-target-count="0"
    data-obscured-overlay-count="0"
    data-disabled-target-count="0">
    <button type="button" data-tc-primary="v1">Trusted target</button>

    <div class="zone">
      <button type="button" data-tc-detached="v1">Detached target</button>
      <button type="button" data-tc-detached-replacement="v1" hidden>Detached replacement</button>
    </div>

    <div class="zone">
      <button type="button" data-tc-obscured="v1">Obscured target</button>
      <div class="overlay" data-tc-overlay="v1" hidden>Blocking overlay</div>
    </div>

    <div class="zone">
      <button type="button" data-tc-disabled="v1">Disabled target</button>
    </div>
  </main>
  <script>
    (() => {
      "use strict";
      const one = (selector) => {
        const matches = document.querySelectorAll(selector);
        if (matches.length !== 1 || !(matches[0] instanceof HTMLElement)) throw new Error("FIXTURE_INVALID");
        return matches[0];
      };
      const root = one('[data-tc-root="v1"]');
      const primary = one('${PRIMARY_SELECTOR}');
      const detached = one('${DETACHED_SELECTOR}');
      const replacement = one('[data-tc-detached-replacement="v1"]');
      const obscured = one('${OBSCURED_SELECTOR}');
      const overlay = one('[data-tc-overlay="v1"]');
      const disabled = one('${DISABLED_SELECTOR}');

      const increment = (name) => {
        const previous = Number(root.getAttribute(name) ?? "-1");
        if (!Number.isSafeInteger(previous) || previous < 0) throw new Error("FIXTURE_INVALID");
        root.setAttribute(name, String(previous + 1));
      };
      primary.addEventListener("click", (event) => {
        increment("data-primary-click-count");
        increment(event.isTrusted ? "data-primary-trusted-count" : "data-primary-untrusted-count");
      });
      detached.addEventListener("click", () => increment("data-detached-original-count"));
      replacement.addEventListener("click", () => increment("data-detached-replacement-count"));
      obscured.addEventListener("click", () => increment("data-obscured-target-count"));
      overlay.addEventListener("click", () => increment("data-obscured-overlay-count"));
      disabled.addEventListener("click", () => increment("data-disabled-target-count"));

      const resetPrimary = () => {
        root.setAttribute("data-primary-click-count", "0");
        root.setAttribute("data-primary-trusted-count", "0");
        root.setAttribute("data-primary-untrusted-count", "0");
      };
      const detachTarget = () => {
        if (!detached.isConnected || !replacement.hidden) throw new Error("FIXTURE_INVALID");
        detached.remove();
        replacement.hidden = false;
      };
      const obscureTarget = () => {
        if (!obscured.isConnected || !overlay.hidden) throw new Error("FIXTURE_INVALID");
        overlay.hidden = false;
      };
      const disableTarget = () => {
        if (!(disabled instanceof HTMLButtonElement) || disabled.disabled) throw new Error("FIXTURE_INVALID");
        disabled.disabled = true;
      };
      Object.defineProperty(globalThis, "__ticketAgentTrustedClickBenchmark_v1", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: Object.freeze({ resetPrimary, detachTarget, obscureTarget, disableTarget })
      });
    })();
  </script>
</body>
</html>`;

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    "content-type": contentType,
    "cross-origin-opener-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  });
  response.end(body);
}

export function createTrustedClickBenchmarkServer(): Server {
  return createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      send(response, 405, "application/json; charset=utf-8", '{"error":"METHOD_NOT_ALLOWED"}');
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "/", `http://${TRUSTED_CLICK_BENCHMARK_HOST}`);
    } catch {
      send(response, 400, "application/json; charset=utf-8", '{"error":"MALFORMED_URI"}');
      return;
    }
    if (url.search !== "" || url.hash !== "") {
      send(response, 404, "application/json; charset=utf-8", '{"error":"NOT_FOUND"}');
      return;
    }
    if (url.pathname === TRUSTED_CLICK_BENCHMARK_PATH) {
      send(response, 200, "text/html; charset=utf-8", request.method === "HEAD" ? "" : TRUSTED_CLICK_BENCHMARK_HTML);
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

export async function startTrustedClickBenchmarkServer(): Promise<StartedTrustedClickBenchmarkServer> {
  const server = createTrustedClickBenchmarkServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, TRUSTED_CLICK_BENCHMARK_HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeTrustedClickBenchmarkServer(server);
    throw new Error("TRUSTED_CLICK_BENCHMARK_BIND_FAILED");
  }
  return {
    server,
    url: `http://${TRUSTED_CLICK_BENCHMARK_HOST}:${(address as AddressInfo).port}${TRUSTED_CLICK_BENCHMARK_PATH}`
  };
}

export function closeTrustedClickBenchmarkServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

export function assertTrustedClickBenchmarkUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("TRUSTED_CLICK_BENCHMARK_TARGET_BLOCKED");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== TRUSTED_CLICK_BENCHMARK_HOST ||
    url.port === "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== TRUSTED_CLICK_BENCHMARK_PATH ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("TRUSTED_CLICK_BENCHMARK_TARGET_BLOCKED");
  }
  return url;
}

export function assertSameTrustedClickBenchmarkOrigin(resourceValue: string, benchmarkValue: string): URL {
  const benchmark = assertTrustedClickBenchmarkUrl(benchmarkValue);
  let resource: URL;
  try {
    resource = new URL(resourceValue);
  } catch {
    throw new Error("TRUSTED_CLICK_BENCHMARK_NETWORK_BLOCKED");
  }
  if (
    resource.protocol !== "http:" ||
    resource.hostname !== TRUSTED_CLICK_BENCHMARK_HOST ||
    resource.origin !== benchmark.origin ||
    resource.username !== "" ||
    resource.password !== ""
  ) {
    throw new Error("TRUSTED_CLICK_BENCHMARK_NETWORK_BLOCKED");
  }
  return resource;
}

/**
 * Benchmark-only trusted input primitive. It deliberately uses an exact
 * ElementHandle, keeps Playwright actionability enabled, and never falls back
 * to HTMLElement.click(), coordinates, force, or a replacement locator.
 */
export async function performTrustedBenchmarkHandleClick(
  handle: Pick<ElementHandle<HTMLElement>, "click">,
  timeoutMs = TRUSTED_CLICK_TIMEOUT_MS
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    throw new Error("TRUSTED_CLICK_BENCHMARK_TIMEOUT_INVALID");
  }
  await handle.click({
    force: false,
    noWaitAfter: true,
    scroll: "none",
    timeout: timeoutMs
  });
}

function invokeFaultAction(input: {
  expectedHref: string;
  action: "detachTarget" | "obscureTarget" | "disableTarget";
}): void {
  if (
    location.href !== input.expectedHref ||
    location.hostname !== "127.0.0.1" ||
    location.protocol !== "http:"
  ) {
    throw new Error("TRUSTED_CLICK_BENCHMARK_PAGE_CHANGED");
  }
  const scope = globalThis as typeof globalThis & {
    __ticketAgentTrustedClickBenchmark_v1?: Record<typeof input.action, () => void>;
  };
  const api = scope.__ticketAgentTrustedClickBenchmark_v1;
  const action = api?.[input.action];
  if (typeof action !== "function") throw new Error("TRUSTED_CLICK_BENCHMARK_FIXTURE_INVALID");
  action();
}

function resetExactPrimaryTarget(target: HTMLElement, expectedHref: string): void {
  if (
    location.href !== expectedHref ||
    location.hostname !== "127.0.0.1" ||
    location.protocol !== "http:"
  ) {
    throw new Error("TRUSTED_CLICK_BENCHMARK_PAGE_CHANGED");
  }
  const matches = document.querySelectorAll('[data-tc-primary="v1"]');
  if (
    matches.length !== 1 ||
    matches[0] !== target ||
    !target.isConnected ||
    !(target instanceof HTMLButtonElement) ||
    target.type !== "button" ||
    target.form !== null ||
    target.disabled
  ) {
    throw new Error("TRUSTED_CLICK_BENCHMARK_TARGET_CHANGED");
  }
  const scope = globalThis as typeof globalThis & {
    __ticketAgentTrustedClickBenchmark_v1?: { resetPrimary?: () => void };
  };
  const reset = scope.__ticketAgentTrustedClickBenchmark_v1?.resetPrimary;
  if (typeof reset !== "function") throw new Error("TRUSTED_CLICK_BENCHMARK_FIXTURE_INVALID");
  reset();
}

interface PrimaryEvidence {
  readonly clickCount: number;
  readonly trustedEventCount: number;
  readonly untrustedEventCount: number;
}

function collectExactPrimaryEvidence(target: HTMLElement, expectedHref: string): PrimaryEvidence {
  if (
    location.href !== expectedHref ||
    location.hostname !== "127.0.0.1" ||
    location.protocol !== "http:"
  ) {
    throw new Error("TRUSTED_CLICK_BENCHMARK_PAGE_CHANGED");
  }
  const root = document.querySelector('[data-tc-root="v1"]');
  const matches = document.querySelectorAll('[data-tc-primary="v1"]');
  if (!(root instanceof HTMLElement) || matches.length !== 1 || matches[0] !== target || !target.isConnected) {
    throw new Error("TRUSTED_CLICK_BENCHMARK_TARGET_CHANGED");
  }
  const numericAttribute = (name: string): number => {
    const raw = root.getAttribute(name);
    if (raw === null || !/^(?:0|[1-9][0-9]*)$/.test(raw)) {
      throw new Error("TRUSTED_CLICK_BENCHMARK_FIXTURE_INVALID");
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("TRUSTED_CLICK_BENCHMARK_FIXTURE_INVALID");
    }
    return value;
  };
  return {
    clickCount: numericAttribute("data-primary-click-count"),
    trustedEventCount: numericAttribute("data-primary-trusted-count"),
    untrustedEventCount: numericAttribute("data-primary-untrusted-count")
  };
}

interface FaultEvidence {
  readonly detachedOriginalCount: number;
  readonly detachedReplacementCount: number;
  readonly obscuredTargetCount: number;
  readonly obscuredOverlayCount: number;
  readonly disabledTargetCount: number;
}

function collectFaultEvidence(expectedHref: string): FaultEvidence {
  if (
    location.href !== expectedHref ||
    location.hostname !== "127.0.0.1" ||
    location.protocol !== "http:"
  ) {
    throw new Error("TRUSTED_CLICK_BENCHMARK_PAGE_CHANGED");
  }
  const root = document.querySelector('[data-tc-root="v1"]');
  if (!(root instanceof HTMLElement)) throw new Error("TRUSTED_CLICK_BENCHMARK_FIXTURE_INVALID");
  const numericAttribute = (name: string): number => {
    const raw = root.getAttribute(name);
    if (raw === null || !/^(?:0|[1-9][0-9]*)$/.test(raw)) {
      throw new Error("TRUSTED_CLICK_BENCHMARK_FIXTURE_INVALID");
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("TRUSTED_CLICK_BENCHMARK_FIXTURE_INVALID");
    }
    return value;
  };
  return {
    detachedOriginalCount: numericAttribute("data-detached-original-count"),
    detachedReplacementCount: numericAttribute("data-detached-replacement-count"),
    obscuredTargetCount: numericAttribute("data-obscured-target-count"),
    obscuredOverlayCount: numericAttribute("data-obscured-overlay-count"),
    disabledTargetCount: numericAttribute("data-disabled-target-count")
  };
}

async function exactHandle(page: Page, selector: string): Promise<ElementHandle<HTMLElement>> {
  const locator = page.locator(selector);
  if ((await locator.count()) !== 1) throw new Error("TRUSTED_CLICK_BENCHMARK_FIXTURE_INVALID");
  const handle = await locator.elementHandle();
  if (handle === null) throw new Error("TRUSTED_CLICK_BENCHMARK_FIXTURE_INVALID");
  return handle as ElementHandle<HTMLElement>;
}

async function requireRejectedClick(handle: ElementHandle<HTMLElement>): Promise<void> {
  let rejected = false;
  try {
    await performTrustedBenchmarkHandleClick(handle, FAIL_CLOSED_CLICK_TIMEOUT_MS);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("TRUSTED_CLICK_BENCHMARK_FAIL_CLOSED_VIOLATION");
}

async function runFaultChecks(page: Page, benchmark: URL): Promise<TrustedClickBenchmarkFaultChecks> {
  const detached = await exactHandle(page, DETACHED_SELECTOR);
  try {
    await page.evaluate(invokeFaultAction, { expectedHref: benchmark.href, action: "detachTarget" as const });
    await requireRejectedClick(detached);
  } finally {
    await detached.dispose();
  }

  const obscured = await exactHandle(page, OBSCURED_SELECTOR);
  try {
    await page.evaluate(invokeFaultAction, { expectedHref: benchmark.href, action: "obscureTarget" as const });
    await requireRejectedClick(obscured);
  } finally {
    await obscured.dispose();
  }

  const disabled = await exactHandle(page, DISABLED_SELECTOR);
  try {
    await page.evaluate(invokeFaultAction, { expectedHref: benchmark.href, action: "disableTarget" as const });
    await requireRejectedClick(disabled);
  } finally {
    await disabled.dispose();
  }

  const evidence = await page.evaluate(collectFaultEvidence, benchmark.href);
  if (
    evidence.detachedOriginalCount !== 0 ||
    evidence.detachedReplacementCount !== 0 ||
    evidence.obscuredTargetCount !== 0 ||
    evidence.obscuredOverlayCount !== 0 ||
    evidence.disabledTargetCount !== 0 ||
    new URL(page.url()).href !== benchmark.href
  ) {
    throw new Error("TRUSTED_CLICK_BENCHMARK_FAIL_CLOSED_VIOLATION");
  }
  return { detachedHandle: 1, obscuredTarget: 1, disabledTarget: 1 };
}

async function runPositiveIteration(
  handle: ElementHandle<HTMLElement>,
  benchmark: URL
): Promise<Omit<TrustedClickBenchmarkSample, "iteration">> {
  await handle.evaluate(resetExactPrimaryTarget, benchmark.href);
  const startedAt = performance.now();
  await performTrustedBenchmarkHandleClick(handle);
  const trustedElementHandleClickMs = Math.max(0, performance.now() - startedAt);
  const evidence = await handle.evaluate(collectExactPrimaryEvidence, benchmark.href);
  if (
    evidence.clickCount !== 1 ||
    evidence.trustedEventCount !== 1 ||
    evidence.untrustedEventCount !== 0
  ) {
    throw new Error("TRUSTED_CLICK_BENCHMARK_TRUST_GATE_FAILED");
  }
  return {
    trustedElementHandleClickMs,
    clickCount: 1,
    trustedEventCount: 1,
    untrustedEventCount: 0
  };
}

function boundedIterations(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > TRUSTED_CLICK_BENCHMARK_MAX_ITERATIONS) {
    throw new Error("TRUSTED_CLICK_BENCHMARK_ITERATIONS_INVALID");
  }
  return resolved;
}

function trustedSummary(values: readonly number[]): TrustedClickBenchmarkSummary {
  return { metric: "trustedElementHandleClickMs", ...summarizeDurations(values) };
}

export async function runTrustedClickBenchmark(
  page: Page,
  benchmarkValue: string,
  options: TrustedClickBenchmarkOptions = {}
): Promise<TrustedClickBenchmarkReport> {
  const benchmark = assertTrustedClickBenchmarkUrl(benchmarkValue);
  const warmupIterations = boundedIterations(options.warmupIterations, TRUSTED_CLICK_BENCHMARK_WARMUP_ITERATIONS);
  const sampleIterations = boundedIterations(options.sampleIterations, TRUSTED_CLICK_BENCHMARK_SAMPLE_ITERATIONS);
  if (sampleIterations < 1) throw new Error("TRUSTED_CLICK_BENCHMARK_ITERATIONS_INVALID");
  if (new URL(page.url()).href !== benchmark.href) throw new Error("TRUSTED_CLICK_BENCHMARK_PAGE_CHANGED");

  const faultChecks = await runFaultChecks(page, benchmark);
  const primary = await exactHandle(page, PRIMARY_SELECTOR);
  try {
    for (let iteration = 0; iteration < warmupIterations; iteration += 1) {
      await runPositiveIteration(primary, benchmark);
    }
    const samples: TrustedClickBenchmarkSample[] = [];
    for (let iteration = 0; iteration < sampleIterations; iteration += 1) {
      samples.push({ iteration, ...(await runPositiveIteration(primary, benchmark)) });
    }
    return {
      schemaVersion: 1,
      benchmark: "trusted-element-handle-click",
      clock: "monotonic",
      unit: "milliseconds",
      warmupIterations,
      sampleIterations,
      faultChecks,
      samples,
      summaries: [trustedSummary(samples.map((sample) => sample.trustedElementHandleClickMs))]
    };
  } finally {
    await primary.dispose();
  }
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

function safeDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validateFaultChecks(value: unknown): TrustedClickBenchmarkFaultChecks {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, FAULT_KEYS) ||
    value.detachedHandle !== 1 ||
    value.obscuredTarget !== 1 ||
    value.disabledTarget !== 1
  ) {
    throw new Error("TRUSTED_CLICK_BENCHMARK_REPORT_INVALID");
  }
  return { detachedHandle: 1, obscuredTarget: 1, disabledTarget: 1 };
}

function validateSummary(value: unknown, samples: readonly number[]): TrustedClickBenchmarkSummary {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, SUMMARY_KEYS) ||
    value.metric !== "trustedElementHandleClickMs"
  ) {
    throw new Error("TRUSTED_CLICK_BENCHMARK_REPORT_INVALID");
  }
  const expected = trustedSummary(samples);
  for (const key of ["count", "minMs", "maxMs", "p50Ms", "p95Ms", "p99Ms"] as const) {
    if (value[key] !== expected[key]) throw new Error("TRUSTED_CLICK_BENCHMARK_REPORT_INVALID");
  }
  return expected;
}

export function validateTrustedClickBenchmarkReport(value: unknown): TrustedClickBenchmarkReport {
  if (!isRecord(value) || !hasExactKeys(value, REPORT_KEYS)) {
    throw new Error("TRUSTED_CLICK_BENCHMARK_REPORT_INVALID");
  }
  if (
    value.schemaVersion !== 1 ||
    value.benchmark !== "trusted-element-handle-click" ||
    value.clock !== "monotonic" ||
    value.unit !== "milliseconds" ||
    !validIteration(value.warmupIterations) ||
    !validIteration(value.sampleIterations) ||
    (value.warmupIterations as number) > TRUSTED_CLICK_BENCHMARK_MAX_ITERATIONS ||
    (value.sampleIterations as number) < 1 ||
    (value.sampleIterations as number) > TRUSTED_CLICK_BENCHMARK_MAX_ITERATIONS ||
    !Array.isArray(value.samples) ||
    value.samples.length !== value.sampleIterations ||
    !Array.isArray(value.summaries) ||
    value.summaries.length !== 1
  ) {
    throw new Error("TRUSTED_CLICK_BENCHMARK_REPORT_INVALID");
  }
  const samples = value.samples.map((sample, index): TrustedClickBenchmarkSample => {
    if (
      !isRecord(sample) ||
      !hasExactKeys(sample, SAMPLE_KEYS) ||
      sample.iteration !== index ||
      !safeDuration(sample.trustedElementHandleClickMs) ||
      sample.clickCount !== 1 ||
      sample.trustedEventCount !== 1 ||
      sample.untrustedEventCount !== 0
    ) {
      throw new Error("TRUSTED_CLICK_BENCHMARK_REPORT_INVALID");
    }
    return {
      iteration: index,
      trustedElementHandleClickMs: sample.trustedElementHandleClickMs,
      clickCount: 1,
      trustedEventCount: 1,
      untrustedEventCount: 0
    };
  });
  const faultChecks = validateFaultChecks(value.faultChecks);
  const summaries = [
    validateSummary(value.summaries[0], samples.map((sample) => sample.trustedElementHandleClickMs))
  ] as const;
  return {
    schemaVersion: 1,
    benchmark: "trusted-element-handle-click",
    clock: "monotonic",
    unit: "milliseconds",
    warmupIterations: value.warmupIterations as number,
    sampleIterations: value.sampleIterations as number,
    faultChecks,
    samples,
    summaries
  };
}

export function assertTrustedClickBenchmarkGates(report: unknown): void {
  const validated = validateTrustedClickBenchmarkReport(report);
  const summary = validated.summaries[0];
  if (
    summary.p95Ms > TRUSTED_CLICK_BENCHMARK_GATES.p95Ms ||
    summary.p99Ms > TRUSTED_CLICK_BENCHMARK_GATES.p99Ms
  ) {
    throw new Error("TRUSTED_CLICK_BENCHMARK_GATE_FAILED");
  }
}

export function serializeTrustedClickBenchmarkReport(report: unknown): string {
  return JSON.stringify(validateTrustedClickBenchmarkReport(report));
}
