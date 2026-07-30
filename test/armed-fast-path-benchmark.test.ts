import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import type { Page } from "playwright-core";

import {
  ARMED_FAST_PATH_BENCHMARK_HTML,
  ARMED_FAST_PATH_BENCHMARK_REPORT_JSON_SCHEMA,
  ARMED_FAST_PATH_BENCHMARK_URL,
  assertArmedFastPathBenchmarkGates,
  runArmedFastPathBenchmark,
  serializeArmedFastPathBenchmarkReport,
  validateArmedFastPathBenchmarkReport,
  type ArmedFastPathBenchmarkReport
} from "../src/performance/armed-fast-path-benchmark.js";

test("armed-fast-path fixture is fixed, formless, and cannot initiate network requests", () => {
  assert.equal(ARMED_FAST_PATH_BENCHMARK_URL, "https://buy.damai.cn/__ticket_agent_armed_fast_path_benchmark_v1__");
  assert.equal((ARMED_FAST_PATH_BENCHMARK_HTML.match(/data-submit(?:\s|>)/g) ?? []).length, 1);
  assert.match(ARMED_FAST_PATH_BENCHMARK_HTML, /event\.isTrusted/);
  assert.doesNotMatch(ARMED_FAST_PATH_BENCHMARK_HTML, /<form\b/i);
  assert.doesNotMatch(ARMED_FAST_PATH_BENCHMARK_HTML, /<(?:img|iframe|link|source|video|audio)\b/i);
  assert.doesNotMatch(
    ARMED_FAST_PATH_BENCHMARK_HTML,
    /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(/
  );
});

test("armed-fast-path CLI rejects every argument, including a real event URL, before Chrome work", () => {
  for (const argument of ["unexpected", "https://detail.damai.cn/item.htm?id=1"]) {
    const child = spawnSync(process.execPath, ["scripts/benchmark-armed-fast-path.mjs", argument], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, TICKET_AGENT_CHROME: "/definitely/not/a/chrome-binary" },
      timeout: 10_000
    });
    assert.equal(child.signal, null);
    assert.equal(child.status, 1);
    assert.equal(child.stdout, "");
    assert.equal(child.stderr, "ARMED_FAST_PATH_BENCHMARK_ARGUMENTS_BLOCKED\n");
  }
});

function reportFixture(): ArmedFastPathBenchmarkReport {
  return {
    schemaVersion: 1,
    benchmark: "armed-fast-path",
    clock: "monotonic",
    unit: "milliseconds",
    warmupIterations: 2,
    sampleIterations: 3,
    faultChecks: {
      exactTargetBound: 1,
      evidenceChangedAfterHandle: 1,
      priceChanged: 1,
      detachedHandle: 1,
      obscuredTarget: 1,
      disabledTarget: 1
    },
    samples: [
      {
        iteration: 0,
        browserSelectionLatencyMs: 1,
        hotPathLatencyMs: 10,
        consumeLatencyMs: 1,
        finalEvidenceLatencyMs: 2,
        trustedClickLatencyMs: 7,
        t0ToTrustedClickLatencyMs: 15,
        trustedClickCount: 1,
        untrustedClickCount: 0
      },
      {
        iteration: 1,
        browserSelectionLatencyMs: 2,
        hotPathLatencyMs: 20,
        consumeLatencyMs: 2,
        finalEvidenceLatencyMs: 4,
        trustedClickLatencyMs: 14,
        t0ToTrustedClickLatencyMs: 25,
        trustedClickCount: 1,
        untrustedClickCount: 0
      },
      {
        iteration: 2,
        browserSelectionLatencyMs: 3,
        hotPathLatencyMs: 30,
        consumeLatencyMs: 3,
        finalEvidenceLatencyMs: 6,
        trustedClickLatencyMs: 21,
        t0ToTrustedClickLatencyMs: 35,
        trustedClickCount: 1,
        untrustedClickCount: 0
      }
    ],
    summaries: [
      { metric: "browserSelectionLatencyMs", count: 3, minMs: 1, maxMs: 3, p50Ms: 2, p95Ms: 3, p99Ms: 3 },
      { metric: "hotPathLatencyMs", count: 3, minMs: 10, maxMs: 30, p50Ms: 20, p95Ms: 30, p99Ms: 30 },
      { metric: "consumeLatencyMs", count: 3, minMs: 1, maxMs: 3, p50Ms: 2, p95Ms: 3, p99Ms: 3 },
      { metric: "finalEvidenceLatencyMs", count: 3, minMs: 2, maxMs: 6, p50Ms: 4, p95Ms: 6, p99Ms: 6 },
      { metric: "trustedClickLatencyMs", count: 3, minMs: 7, maxMs: 21, p50Ms: 14, p95Ms: 21, p99Ms: 21 },
      { metric: "t0ToTrustedClickLatencyMs", count: 3, minMs: 15, maxMs: 35, p50Ms: 25, p95Ms: 35, p99Ms: 35 }
    ]
  };
}

test("armed-fast-path report has a closed schema and recomputed p50 p95 and p99", () => {
  const serialized = serializeArmedFastPathBenchmarkReport(reportFixture());
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
  assert.equal(ARMED_FAST_PATH_BENCHMARK_REPORT_JSON_SCHEMA.additionalProperties, false);
  assert.equal(ARMED_FAST_PATH_BENCHMARK_REPORT_JSON_SCHEMA.properties.samples.items.additionalProperties, false);
  assert.equal(ARMED_FAST_PATH_BENCHMARK_REPORT_JSON_SCHEMA.properties.summaries.minItems, 6);
  assert.deepEqual(validateArmedFastPathBenchmarkReport(parsed), reportFixture());
  assert.doesNotThrow(() => assertArmedFastPathBenchmarkGates(parsed));
});

test("armed-fast-path report rejects field, count, fault, click, ordering, and percentile tampering", () => {
  assert.throws(
    () => validateArmedFastPathBenchmarkReport({ ...reportFixture(), note: "free text" }),
    /ARMED_FAST_PATH_BENCHMARK_REPORT_INVALID/
  );

  const wrongCount = structuredClone(reportFixture()) as unknown as { sampleIterations: number };
  wrongCount.sampleIterations = 2;
  assert.throws(() => validateArmedFastPathBenchmarkReport(wrongCount), /ARMED_FAST_PATH_BENCHMARK_REPORT_INVALID/);

  const missingSampleField = structuredClone(reportFixture()) as unknown as {
    samples: Array<Record<string, unknown>>;
  };
  delete missingSampleField.samples[0]!.consumeLatencyMs;
  assert.throws(
    () => validateArmedFastPathBenchmarkReport(missingSampleField),
    /ARMED_FAST_PATH_BENCHMARK_REPORT_INVALID/
  );

  const failedFault = structuredClone(reportFixture()) as unknown as { faultChecks: { obscuredTarget: number } };
  failedFault.faultChecks.obscuredTarget = 0;
  assert.throws(() => validateArmedFastPathBenchmarkReport(failedFault), /ARMED_FAST_PATH_BENCHMARK_REPORT_INVALID/);

  const untrusted = structuredClone(reportFixture()) as unknown as {
    samples: Array<{ trustedClickCount: number; untrustedClickCount: number }>;
  };
  untrusted.samples[0]!.trustedClickCount = 0;
  untrusted.samples[0]!.untrustedClickCount = 1;
  assert.throws(() => validateArmedFastPathBenchmarkReport(untrusted), /ARMED_FAST_PATH_BENCHMARK_REPORT_INVALID/);

  const reordered = structuredClone(reportFixture()) as unknown as { samples: Array<{ iteration: number }> };
  reordered.samples[1]!.iteration = 2;
  assert.throws(() => validateArmedFastPathBenchmarkReport(reordered), /ARMED_FAST_PATH_BENCHMARK_REPORT_INVALID/);

  const tampered = structuredClone(reportFixture());
  tampered.summaries[1]!.p95Ms = 999;
  assert.throws(() => validateArmedFastPathBenchmarkReport(tampered), /ARMED_FAST_PATH_BENCHMARK_REPORT_INVALID/);
});

test("armed-fast-path latency gate validates first and rejects a recomputed slow report", () => {
  const slow = structuredClone(reportFixture()) as unknown as {
    samples: Array<{
      hotPathLatencyMs: number;
      trustedClickLatencyMs: number;
      t0ToTrustedClickLatencyMs: number;
    }>;
    summaries: Array<{
      metric: "browserSelectionLatencyMs" | "hotPathLatencyMs" | "consumeLatencyMs" |
        "finalEvidenceLatencyMs" | "trustedClickLatencyMs" | "t0ToTrustedClickLatencyMs";
      count: number;
      minMs: number;
      maxMs: number;
      p50Ms: number;
      p95Ms: number;
      p99Ms: number;
    }>;
  };
  slow.samples[2]!.hotPathLatencyMs = 130;
  slow.samples[2]!.trustedClickLatencyMs = 101;
  slow.summaries[1] = {
    metric: "hotPathLatencyMs",
    count: 3,
    minMs: 10,
    maxMs: 130,
    p50Ms: 20,
    p95Ms: 130,
    p99Ms: 130
  };
  slow.summaries[4] = {
    metric: "trustedClickLatencyMs",
    count: 3,
    minMs: 7,
    maxMs: 101,
    p50Ms: 14,
    p95Ms: 101,
    p99Ms: 101
  };
  assert.doesNotThrow(() => validateArmedFastPathBenchmarkReport(slow));
  assert.throws(() => assertArmedFastPathBenchmarkGates(slow), /ARMED_FAST_PATH_BENCHMARK_GATE_FAILED/);
});

test("armed-fast-path latency gate includes browser T0-to-trusted-click time", () => {
  const slow = structuredClone(reportFixture()) as unknown as {
    samples: Array<{ t0ToTrustedClickLatencyMs: number }>;
    summaries: Array<{
      metric: "browserSelectionLatencyMs" | "hotPathLatencyMs" | "consumeLatencyMs" |
        "finalEvidenceLatencyMs" | "trustedClickLatencyMs" | "t0ToTrustedClickLatencyMs";
      count: number;
      minMs: number;
      maxMs: number;
      p50Ms: number;
      p95Ms: number;
      p99Ms: number;
    }>;
  };
  slow.samples[2]!.t0ToTrustedClickLatencyMs = 151;
  slow.summaries[5] = {
    metric: "t0ToTrustedClickLatencyMs",
    count: 3,
    minMs: 15,
    maxMs: 151,
    p50Ms: 25,
    p95Ms: 151,
    p99Ms: 151
  };
  assert.doesNotThrow(() => validateArmedFastPathBenchmarkReport(slow));
  assert.throws(() => assertArmedFastPathBenchmarkGates(slow), /ARMED_FAST_PATH_BENCHMARK_GATE_FAILED/);
});

test("armed-fast-path runner refuses wrong pages and invalid sample counts before page evaluation", async () => {
  const wrongPage = { url: () => "https://detail.damai.cn/item.htm?id=1" } as unknown as Page;
  await assert.rejects(
    () => runArmedFastPathBenchmark(wrongPage, { warmupIterations: 0, sampleIterations: 1 }),
    /ARMED_FAST_PATH_BENCHMARK_PAGE_CHANGED/
  );
  const nominalPage = { url: () => ARMED_FAST_PATH_BENCHMARK_URL } as unknown as Page;
  await assert.rejects(
    () => runArmedFastPathBenchmark(nominalPage, { warmupIterations: 0, sampleIterations: 0 }),
    /ARMED_FAST_PATH_BENCHMARK_ITERATIONS_INVALID/
  );
});
