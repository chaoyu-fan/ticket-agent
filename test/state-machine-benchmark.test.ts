import assert from "node:assert/strict";
import test from "node:test";

import type { Page } from "playwright-core";

import {
  assertSameStateMachineBenchmarkOrigin,
  assertStateMachineBenchmarkUrl,
  closeStateMachineBenchmarkServer,
  runStateMachineBenchmark,
  serializeStateMachineBenchmarkReport,
  startStateMachineBenchmarkServer,
  validateStateMachineBenchmarkReport,
  type StateMachineBenchmarkReport
} from "../src/performance/state-machine-benchmark.js";

test("state-machine benchmark target accepts only its exact random numeric-loopback URL", () => {
  const accepted = "http://127.0.0.1:43123/state-machine-benchmark";
  assert.equal(assertStateMachineBenchmarkUrl(accepted).href, accepted);
  for (const blocked of [
    "http://localhost:43123/state-machine-benchmark",
    "http://127.0.0.1/state-machine-benchmark",
    "https://127.0.0.1:43123/state-machine-benchmark",
    "http://127.0.0.1:43123/benchmark",
    "http://127.0.0.1:43123/state-machine-benchmark?next=https://damai.cn",
    "http://user:pass@127.0.0.1:43123/state-machine-benchmark",
    "https://detail.damai.cn/item.htm?id=1"
  ]) {
    assert.throws(() => assertStateMachineBenchmarkUrl(blocked), /STATE_MACHINE_BENCHMARK_TARGET_BLOCKED/);
  }
});

test("state-machine benchmark network policy permits only the current ephemeral origin", () => {
  const target = "http://127.0.0.1:43123/state-machine-benchmark";
  assert.equal(
    assertSameStateMachineBenchmarkOrigin("http://127.0.0.1:43123/favicon.ico", target).origin,
    "http://127.0.0.1:43123"
  );
  for (const blocked of [
    "http://127.0.0.1:43124/state-machine-benchmark",
    "http://localhost:43123/state-machine-benchmark",
    "https://127.0.0.1:43123/state-machine-benchmark",
    "https://detail.damai.cn/item.htm?id=1",
    "data:text/plain,blocked"
  ]) {
    assert.throws(
      () => assertSameStateMachineBenchmarkOrigin(blocked, target),
      /STATE_MACHINE_BENCHMARK_NETWORK_BLOCKED/
    );
  }
});

test("state-machine benchmark server is ephemeral, CSP-isolated, formless, and uses one fixed fake sink", async () => {
  const started = await startStateMachineBenchmarkServer();
  try {
    const target = assertStateMachineBenchmarkUrl(started.url);
    assert.equal(target.hostname, "127.0.0.1");
    assert.notEqual(target.port, "");
    const response = await fetch(target);
    assert.equal(response.status, 200);
    const csp = response.headers.get("content-security-policy") ?? "";
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /form-action 'none'/);
    assert.match(csp, /frame-src 'none'/);
    assert.match(csp, /worker-src 'none'/);
    const html = await response.text();
    assert.match(html, /data-sm-root="v1"/);
    assert.match(html, /data-ticket-agent-test-sink="browser-selection-v1"/);
    assert.equal((html.match(/data-ticket-agent-test-sink="browser-selection-v1"/g) ?? []).length, 2);
    assert.match(html, /data-sm-real-submit/);
    assert.doesNotMatch(html, /<form\b/i);
    assert.doesNotMatch(html, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/);
    assert.doesNotMatch(html, /<(?:img|iframe|link)\b/i);

    const post = await fetch(target, { method: "POST" });
    assert.equal(post.status, 405);
  } finally {
    await closeStateMachineBenchmarkServer(started.server);
  }
});

function reportFixture(): StateMachineBenchmarkReport {
  return {
    schemaVersion: 1,
    benchmark: "browser-selection-state-machine",
    clock: "monotonic",
    unit: "milliseconds",
    warmupIterations: 2,
    sampleIterations: 3,
    samples: [
      { iteration: 0, browserLatencyMs: 1, nodeEndToEndMs: 2 },
      { iteration: 1, browserLatencyMs: 2, nodeEndToEndMs: 3 },
      { iteration: 2, browserLatencyMs: 3, nodeEndToEndMs: 4 }
    ],
    summaries: [
      { metric: "browserLatencyMs", count: 3, minMs: 1, maxMs: 3, p50Ms: 2, p95Ms: 3, p99Ms: 3 },
      { metric: "nodeEndToEndMs", count: 3, minMs: 2, maxMs: 4, p50Ms: 3, p95Ms: 4, p99Ms: 4 }
    ]
  };
}

test("state-machine report is strict numeric JSON with recomputed p50 p95 and p99", () => {
  const serialized = serializeStateMachineBenchmarkReport(reportFixture());
  const parsed = JSON.parse(serialized) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), [
    "benchmark",
    "clock",
    "sampleIterations",
    "samples",
    "schemaVersion",
    "summaries",
    "unit",
    "warmupIterations"
  ]);
  assert.doesNotMatch(serialized, /damai|maoyan|attendee|cookie|selector|https?:\/\//i);
  const validated = validateStateMachineBenchmarkReport(parsed);
  assert.deepEqual(validated.summaries, reportFixture().summaries);
});

test("state-machine report rejects extra text, tampered aggregates, bad ordering, and impossible latency", () => {
  const extra = { ...reportFixture(), note: "free text" };
  assert.throws(() => validateStateMachineBenchmarkReport(extra), /STATE_MACHINE_BENCHMARK_REPORT_INVALID/);

  const tampered = structuredClone(reportFixture());
  tampered.summaries[0]!.p99Ms = 999;
  assert.throws(() => validateStateMachineBenchmarkReport(tampered), /STATE_MACHINE_BENCHMARK_REPORT_INVALID/);

  const reordered = structuredClone(reportFixture()) as unknown as {
    samples: Array<{ iteration: number }>;
  };
  reordered.samples[1]!.iteration = 2;
  assert.throws(() => validateStateMachineBenchmarkReport(reordered), /STATE_MACHINE_BENCHMARK_REPORT_INVALID/);

  const impossible = structuredClone(reportFixture()) as unknown as {
    samples: Array<{ nodeEndToEndMs: number }>;
  };
  impossible.samples[0]!.nodeEndToEndMs = 0;
  assert.throws(() => validateStateMachineBenchmarkReport(impossible), /STATE_MACHINE_BENCHMARK_REPORT_INVALID/);
});

test("state-machine runner refuses wrong pages and invalid sample counts before browser work", async () => {
  const target = "http://127.0.0.1:43123/state-machine-benchmark";
  const wrongPage = { url: () => "https://detail.damai.cn/item.htm?id=1" } as unknown as Page;
  await assert.rejects(
    () => runStateMachineBenchmark(wrongPage, target, { warmupIterations: 0, sampleIterations: 1 }),
    /STATE_MACHINE_BENCHMARK_PAGE_CHANGED/
  );
  const nominalPage = { url: () => target } as unknown as Page;
  await assert.rejects(
    () => runStateMachineBenchmark(nominalPage, target, { warmupIterations: 0, sampleIterations: 0 }),
    /STATE_MACHINE_BENCHMARK_ITERATIONS_INVALID/
  );
});
