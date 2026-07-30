import assert from "node:assert/strict";
import test from "node:test";

import type { Page } from "playwright-core";

import {
  assertLoopbackBenchmarkGates,
  assertLoopbackBenchmarkUrl,
  assertSameBenchmarkOrigin,
  closeLoopbackBenchmarkServer,
  runLoopbackHotPathBenchmark,
  startLoopbackBenchmarkServer
} from "../src/performance/loopback-benchmark.js";
import { parsePerformanceReportJson, serializePerformanceReport } from "../src/performance/metrics.js";

test("benchmark target policy accepts only the exact numeric-loopback page", () => {
  assert.equal(assertLoopbackBenchmarkUrl("http://127.0.0.1:43123/benchmark").href, "http://127.0.0.1:43123/benchmark");
  for (const blocked of [
    "https://detail.damai.cn/item.htm?id=1",
    "http://localhost:43123/benchmark",
    "http://127.0.0.1/benchmark",
    "https://127.0.0.1:43123/benchmark",
    "http://user:pass@127.0.0.1:43123/benchmark",
    "http://127.0.0.1:43123/benchmark?url=https://damai.cn",
    "http://127.0.0.1:43123/other"
  ]) {
    assert.throws(() => assertLoopbackBenchmarkUrl(blocked), /BENCHMARK_TARGET_BLOCKED/, blocked);
  }
});

test("network policy confines every resource to the benchmark ephemeral origin", () => {
  const target = "http://127.0.0.1:43123/benchmark";
  assert.equal(assertSameBenchmarkOrigin("http://127.0.0.1:43123/favicon.ico", target).pathname, "/favicon.ico");
  assert.throws(
    () => assertSameBenchmarkOrigin("http://127.0.0.1:43124/benchmark", target),
    /BENCHMARK_NETWORK_BLOCKED/
  );
  assert.throws(
    () => assertSameBenchmarkOrigin("https://damai.cn/", target),
    /BENCHMARK_NETWORK_BLOCKED/
  );
});

test("loopback server is ephemeral, CSP-isolated, and contains only a fake button sink", async () => {
  const started = await startLoopbackBenchmarkServer();
  try {
    const target = assertLoopbackBenchmarkUrl(started.url);
    const response = await fetch(target);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy") ?? "", /connect-src 'none'/);
    assert.match(response.headers.get("content-security-policy") ?? "", /form-action 'none'/);
    const html = await response.text();
    assert.match(html, /data-benchmark-sink="true"/);
    assert.doesNotMatch(html, /<form\b/i);
    assert.doesNotMatch(html, /https?:\/\/(?!127\.0\.0\.1)/i);
  } finally {
    await closeLoopbackBenchmarkServer(started.server);
  }
});

test("hot-path samples map detect validate action and total into strict metrics", async () => {
  const target = "http://127.0.0.1:43123/benchmark";
  const measured = [
    { detectMs: 5, validateMs: 4, actionMs: 3, totalMs: 15, fakeSubmitCount: 1 },
    { detectMs: 6, validateMs: 5, actionMs: 4, totalMs: 18, fakeSubmitCount: 1 }
  ];
  let evaluation = 0;
  const fakePage = {
    url: () => target,
    evaluate: async () => [measured[evaluation++]]
  } as unknown as Page;
  const report = await runLoopbackHotPathBenchmark(fakePage, target, { iterations: 2, warmupIterations: 0 });
  assert.equal(report.measurements.length, 8);
  assert.deepEqual(report.summaries
    .filter(({ stage }) => stage !== "run_total")
    .map(({ stage, count, p50Ms, p95Ms, p99Ms }) => ({ stage, count, p50Ms, p95Ms, p99Ms })), [
    { stage: "sale_state_detection", count: 2, p50Ms: 5, p95Ms: 6, p99Ms: 6 },
    { stage: "page_inspection", count: 2, p50Ms: 4, p95Ms: 5, p99Ms: 5 },
    { stage: "atomic_submit", count: 2, p50Ms: 3, p95Ms: 4, p99Ms: 4 }
  ]);
  assert.equal(report.summaries.find(({ stage }) => stage === "run_total")?.count, 2);
  assert.deepEqual(parsePerformanceReportJson(serializePerformanceReport(report)), report);
  assert.doesNotThrow(() => assertLoopbackBenchmarkGates(report));
});

test("benchmark rejects malformed browser evidence and non-single fake submits", async () => {
  const target = "http://127.0.0.1:43123/benchmark";
  const fakePage = (metric: unknown): Page => ({
    url: () => target,
    evaluate: async () => [metric]
  }) as unknown as Page;

  await assert.rejects(
    runLoopbackHotPathBenchmark(fakePage({
      detectMs: 1,
      validateMs: 1,
      actionMs: 1,
      totalMs: 4,
      fakeSubmitCount: 0
    }), target, { iterations: 1, warmupIterations: 0 }),
    /BENCHMARK_BROWSER_METRIC_INVALID/
  );
  await assert.rejects(
    runLoopbackHotPathBenchmark(fakePage({
      detectMs: 1,
      validateMs: 1,
      actionMs: 1,
      totalMs: 4,
      fakeSubmitCount: 1,
      eventTitle: "sensitive"
    }), target, { iterations: 1, warmupIterations: 0 }),
    /BENCHMARK_BROWSER_METRIC_INVALID/
  );
});
