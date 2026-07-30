import assert from "node:assert/strict";
import test from "node:test";

import type { ElementHandle, Page } from "playwright-core";

import {
  assertSameTrustedClickBenchmarkOrigin,
  assertTrustedClickBenchmarkGates,
  assertTrustedClickBenchmarkUrl,
  closeTrustedClickBenchmarkServer,
  performTrustedBenchmarkHandleClick,
  runTrustedClickBenchmark,
  serializeTrustedClickBenchmarkReport,
  startTrustedClickBenchmarkServer,
  validateTrustedClickBenchmarkReport,
  type TrustedClickBenchmarkReport
} from "../src/performance/trusted-click-benchmark.js";

test("trusted-click benchmark accepts only its exact random numeric-loopback URL", () => {
  const accepted = "http://127.0.0.1:43123/trusted-click-benchmark";
  assert.equal(assertTrustedClickBenchmarkUrl(accepted).href, accepted);
  for (const blocked of [
    "http://localhost:43123/trusted-click-benchmark",
    "http://127.0.0.1/trusted-click-benchmark",
    "https://127.0.0.1:43123/trusted-click-benchmark",
    "http://127.0.0.1:43123/benchmark",
    "http://127.0.0.1:43123/trusted-click-benchmark?next=https://damai.cn",
    "http://user:pass@127.0.0.1:43123/trusted-click-benchmark",
    "https://detail.damai.cn/item.htm?id=1"
  ]) {
    assert.throws(() => assertTrustedClickBenchmarkUrl(blocked), /TRUSTED_CLICK_BENCHMARK_TARGET_BLOCKED/);
  }
});

test("trusted-click benchmark network policy permits only the current ephemeral origin", () => {
  const target = "http://127.0.0.1:43123/trusted-click-benchmark";
  assert.equal(
    assertSameTrustedClickBenchmarkOrigin("http://127.0.0.1:43123/favicon.ico", target).origin,
    "http://127.0.0.1:43123"
  );
  for (const blocked of [
    "http://127.0.0.1:43124/trusted-click-benchmark",
    "http://localhost:43123/trusted-click-benchmark",
    "https://127.0.0.1:43123/trusted-click-benchmark",
    "https://detail.damai.cn/item.htm?id=1",
    "data:text/plain,blocked"
  ]) {
    assert.throws(
      () => assertSameTrustedClickBenchmarkOrigin(blocked, target),
      /TRUSTED_CLICK_BENCHMARK_NETWORK_BLOCKED/
    );
  }
});

test("trusted-click fixture is formless, isolated, and contains trusted plus fail-closed gates", async () => {
  const started = await startTrustedClickBenchmarkServer();
  try {
    const target = assertTrustedClickBenchmarkUrl(started.url);
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
    assert.equal((html.match(/<button[^>]*data-tc-primary="v1"/g) ?? []).length, 1);
    assert.match(html, /event\.isTrusted/);
    assert.match(html, /data-tc-detached="v1"/);
    assert.match(html, /data-tc-obscured="v1"/);
    assert.match(html, /data-tc-overlay="v1"/);
    assert.match(html, /data-tc-disabled="v1"/);
    assert.doesNotMatch(html, /\.click\s*\(/);
    assert.doesNotMatch(html, /<form\b/i);
    assert.doesNotMatch(html, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/);
    assert.doesNotMatch(html, /<(?:img|iframe|link)\b/i);

    const post = await fetch(target, { method: "POST" });
    assert.equal(post.status, 405);
  } finally {
    await closeTrustedClickBenchmarkServer(started.server);
  }
});

test("trusted benchmark click always keeps actionability and forbids force", async () => {
  let supplied: unknown;
  const handle = {
    click: async (options: unknown): Promise<void> => {
      supplied = options;
    }
  } as unknown as Pick<ElementHandle<HTMLElement>, "click">;
  await performTrustedBenchmarkHandleClick(handle, 321);
  assert.deepEqual(supplied, {
    force: false,
    noWaitAfter: true,
    scroll: "none",
    timeout: 321
  });
  await assert.rejects(
    () => performTrustedBenchmarkHandleClick(handle, 0),
    /TRUSTED_CLICK_BENCHMARK_TIMEOUT_INVALID/
  );
});

function reportFixture(): TrustedClickBenchmarkReport {
  return {
    schemaVersion: 1,
    benchmark: "trusted-element-handle-click",
    clock: "monotonic",
    unit: "milliseconds",
    warmupIterations: 2,
    sampleIterations: 3,
    faultChecks: { detachedHandle: 1, obscuredTarget: 1, disabledTarget: 1 },
    samples: [
      { iteration: 0, trustedElementHandleClickMs: 1, clickCount: 1, trustedEventCount: 1, untrustedEventCount: 0 },
      { iteration: 1, trustedElementHandleClickMs: 2, clickCount: 1, trustedEventCount: 1, untrustedEventCount: 0 },
      { iteration: 2, trustedElementHandleClickMs: 3, clickCount: 1, trustedEventCount: 1, untrustedEventCount: 0 }
    ],
    summaries: [
      {
        metric: "trustedElementHandleClickMs",
        count: 3,
        minMs: 1,
        maxMs: 3,
        p50Ms: 2,
        p95Ms: 3,
        p99Ms: 3
      }
    ]
  };
}

test("trusted-click report is strict numeric JSON with recomputed p50 p95 and p99", () => {
  const serialized = serializeTrustedClickBenchmarkReport(reportFixture());
  const parsed = JSON.parse(serialized) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), [
    "benchmark",
    "clock",
    "faultChecks",
    "sampleIterations",
    "samples",
    "schemaVersion",
    "summaries",
    "unit",
    "warmupIterations"
  ]);
  assert.doesNotMatch(serialized, /damai|maoyan|attendee|cookie|selector|https?:\/\//i);
  const validated = validateTrustedClickBenchmarkReport(parsed);
  assert.deepEqual(validated, reportFixture());
  assert.doesNotThrow(() => assertTrustedClickBenchmarkGates(validated));
});

test("trusted-click report rejects untrusted, duplicate, missing fault, extra, and tampered evidence", () => {
  const untrusted = structuredClone(reportFixture()) as unknown as {
    samples: Array<{ trustedEventCount: number; untrustedEventCount: number }>;
  };
  untrusted.samples[0]!.trustedEventCount = 0;
  untrusted.samples[0]!.untrustedEventCount = 1;
  assert.throws(() => validateTrustedClickBenchmarkReport(untrusted), /TRUSTED_CLICK_BENCHMARK_REPORT_INVALID/);

  const duplicate = structuredClone(reportFixture()) as unknown as {
    samples: Array<{ clickCount: number }>;
  };
  duplicate.samples[1]!.clickCount = 2;
  assert.throws(() => validateTrustedClickBenchmarkReport(duplicate), /TRUSTED_CLICK_BENCHMARK_REPORT_INVALID/);

  const missingFault = structuredClone(reportFixture()) as unknown as {
    faultChecks: { obscuredTarget: number };
  };
  missingFault.faultChecks.obscuredTarget = 0;
  assert.throws(() => validateTrustedClickBenchmarkReport(missingFault), /TRUSTED_CLICK_BENCHMARK_REPORT_INVALID/);

  const extra = { ...reportFixture(), note: "free text" };
  assert.throws(() => validateTrustedClickBenchmarkReport(extra), /TRUSTED_CLICK_BENCHMARK_REPORT_INVALID/);

  const tampered = structuredClone(reportFixture());
  tampered.summaries[0]!.p99Ms = 999;
  assert.throws(() => validateTrustedClickBenchmarkReport(tampered), /TRUSTED_CLICK_BENCHMARK_REPORT_INVALID/);
});

test("trusted-click latency gate rejects an otherwise valid slow report", () => {
  const slow = structuredClone(reportFixture()) as unknown as {
    samples: Array<{ trustedElementHandleClickMs: number }>;
    summaries: Array<{
      metric: "trustedElementHandleClickMs";
      count: number;
      minMs: number;
      maxMs: number;
      p50Ms: number;
      p95Ms: number;
      p99Ms: number;
    }>;
  };
  slow.samples[2]!.trustedElementHandleClickMs = 101;
  slow.summaries[0] = {
    metric: "trustedElementHandleClickMs",
    count: 3,
    minMs: 1,
    maxMs: 101,
    p50Ms: 2,
    p95Ms: 101,
    p99Ms: 101
  };
  assert.doesNotThrow(() => validateTrustedClickBenchmarkReport(slow));
  assert.throws(() => assertTrustedClickBenchmarkGates(slow), /TRUSTED_CLICK_BENCHMARK_GATE_FAILED/);
});

test("trusted-click runner refuses wrong pages and invalid sample counts before browser work", async () => {
  const target = "http://127.0.0.1:43123/trusted-click-benchmark";
  const wrongPage = { url: () => "https://detail.damai.cn/item.htm?id=1" } as unknown as Page;
  await assert.rejects(
    () => runTrustedClickBenchmark(wrongPage, target, { warmupIterations: 0, sampleIterations: 1 }),
    /TRUSTED_CLICK_BENCHMARK_PAGE_CHANGED/
  );
  const nominalPage = { url: () => target } as unknown as Page;
  await assert.rejects(
    () => runTrustedClickBenchmark(nominalPage, target, { warmupIterations: 0, sampleIterations: 0 }),
    /TRUSTED_CLICK_BENCHMARK_ITERATIONS_INVALID/
  );
});
