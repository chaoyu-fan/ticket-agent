import assert from "node:assert/strict";
import test from "node:test";

import {
  PERFORMANCE_REPORT_JSON_SCHEMA,
  PerformanceRecorder,
  buildPerformanceReport,
  parsePerformanceReport,
  parsePerformanceReportJson,
  serializePerformanceReport,
  summarizeDurations
} from "../src/performance/metrics.js";

function clock(values: readonly number[]): () => number {
  const remaining = [...values];
  return () => {
    const value = remaining.shift();
    if (value === undefined) throw new Error("test clock exhausted");
    return value;
  };
}

test("stage timers use a monotonic clock and keep numeric correlation only", () => {
  const recorder = new PerformanceRecorder(clock([100, 112.5, 200, 209]));
  const queue = recorder.start("queue_exit_detection", 7);
  assert.deepEqual(queue.stop(), {
    iteration: 7,
    sequence: 0,
    stage: "queue_exit_detection",
    durationMs: 12.5
  });
  assert.equal(recorder.measureSync("atomic_submit", () => "clicked", 7), "clicked");
  assert.deepEqual(recorder.measurements()[1], {
    iteration: 7,
    sequence: 1,
    stage: "atomic_submit",
    durationMs: 9
  });
});

test("async timing records failures without swallowing the operation error", async () => {
  const recorder = new PerformanceRecorder(clock([1, 6]));
  await assert.rejects(
    recorder.measure("page_inspection", async () => {
      throw new Error("operation failed");
    }),
    /operation failed/
  );
  assert.equal(recorder.measurements()[0]?.durationMs, 5);
});

test("timers reject reuse, clock regression, invalid stages, and unsafe durations", () => {
  const once = new PerformanceRecorder(clock([10, 11])).start("timer_wakeup");
  once.stop();
  assert.throws(() => once.stop(), /PERFORMANCE_TIMER_ALREADY_STOPPED/);

  const regressed = new PerformanceRecorder(clock([20, 19])).start("timer_wakeup");
  assert.throws(() => regressed.stop(), /PERFORMANCE_CLOCK_REGRESSED/);

  const recorder = new PerformanceRecorder();
  assert.throws(
    () => recorder.record("attendee:Alice" as never, 1),
    /PERFORMANCE_STAGE_INVALID/
  );
  assert.throws(() => recorder.record("run_total", Number.NaN), /PERFORMANCE_DURATION_INVALID/);
  assert.throws(() => recorder.record("run_total", 1, -1), /PERFORMANCE_ITERATION_INVALID/);
});

test("p50 p95 and p99 use documented nearest-rank percentiles", () => {
  const values = Array.from({ length: 100 }, (_, index) => index + 1);
  assert.deepEqual(summarizeDurations(values), {
    count: 100,
    minMs: 1,
    maxMs: 100,
    p50Ms: 50,
    p95Ms: 95,
    p99Ms: 99
  });
  assert.throws(() => summarizeDurations([]), /PERFORMANCE_VALUES_EMPTY/);
  assert.throws(() => summarizeDurations([1, Number.POSITIVE_INFINITY]), /PERFORMANCE_DURATION_INVALID/);
});

test("reports preserve raw samples and summarize each stage in canonical order", () => {
  const report = buildPerformanceReport([
    { iteration: 1, sequence: 0, stage: "atomic_submit", durationMs: 8 },
    { iteration: 0, sequence: 1, stage: "queue_exit_detection", durationMs: 40 },
    { iteration: 0, sequence: 2, stage: "atomic_submit", durationMs: 4 }
  ]);
  assert.deepEqual(report.summaries, [
    {
      stage: "queue_exit_detection",
      count: 1,
      minMs: 40,
      maxMs: 40,
      p50Ms: 40,
      p95Ms: 40,
      p99Ms: 40
    },
    {
      stage: "atomic_submit",
      count: 2,
      minMs: 4,
      maxMs: 8,
      p50Ms: 4,
      p95Ms: 8,
      p99Ms: 8
    }
  ]);
  assert.throws(
    () => buildPerformanceReport([
      { iteration: 0, sequence: 0, stage: "run_total", durationMs: 1 },
      { iteration: 1, sequence: 0, stage: "run_total", durationMs: 2 }
    ]),
    /PERFORMANCE_SEQUENCE_DUPLICATE/
  );
});

test("strict JSON round-trips and rejects every free-text or extra field", () => {
  const recorder = new PerformanceRecorder();
  recorder.record("controller_authorization", 12.25, 3);
  const report = recorder.report();
  const json = serializePerformanceReport(report);
  assert.deepEqual(parsePerformanceReportJson(json), report);

  assert.equal(PERFORMANCE_REPORT_JSON_SCHEMA.additionalProperties, false);
  assert.equal(PERFORMANCE_REPORT_JSON_SCHEMA.properties.measurements.items.additionalProperties, false);
  assert.equal(PERFORMANCE_REPORT_JSON_SCHEMA.properties.summaries.items.additionalProperties, false);
  assert.equal(json.includes("url"), false);
  assert.equal(json.includes("eventTitle"), false);
  assert.equal(json.includes("attendee"), false);

  assert.throws(
    () => parsePerformanceReport({ ...report, note: "secret" }),
    /PERFORMANCE_REPORT_SCHEMA_INVALID/
  );
  assert.throws(
    () => parsePerformanceReport({
      ...report,
      measurements: [{ ...report.measurements[0]!, url: "https://example.invalid/private" }]
    }),
    /PERFORMANCE_MEASUREMENT_SCHEMA_INVALID/
  );
  assert.throws(
    () => parsePerformanceReport({
      ...report,
      measurements: [{ ...report.measurements[0]!, stage: "attendee-name" }]
    }),
    /PERFORMANCE_STAGE_INVALID/
  );
});

test("strict parser recomputes summaries and rejects aggregate tampering", () => {
  const recorder = new PerformanceRecorder();
  recorder.record("run_total", 500, 0);
  recorder.record("run_total", 750, 1);
  const report = recorder.report();
  assert.throws(
    () => parsePerformanceReport({
      ...report,
      summaries: [{ ...report.summaries[0]!, p95Ms: 1 }]
    }),
    /PERFORMANCE_SUMMARY_MISMATCH/
  );
  assert.throws(() => parsePerformanceReportJson("not-json"), /PERFORMANCE_JSON_INVALID/);
});
