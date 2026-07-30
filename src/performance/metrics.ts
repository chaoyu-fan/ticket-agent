/**
 * Fixed performance stages. Keeping this list closed prevents event titles,
 * attendee names, URLs, selectors, or arbitrary notes from entering reports.
 */
export const PERFORMANCE_STAGES = [
  "timer_wakeup",
  "sale_state_detection",
  "queue_exit_detection",
  "page_inspection",
  "session_selection",
  "tier_selection",
  "quantity_selection",
  "attendee_selection",
  "price_snapshot",
  "controller_authorization",
  "post_authorization_verification",
  "atomic_submit",
  "confirmation_ready",
  "run_total"
] as const;

export type PerformanceStage = (typeof PERFORMANCE_STAGES)[number];
export type MonotonicClock = () => number;

export interface PerformanceMeasurement {
  /** Numeric correlation only; never use an event, account, or attendee ID. */
  iteration: number;
  /** Recorder-local ordering, starting at zero. */
  sequence: number;
  stage: PerformanceStage;
  durationMs: number;
}

export interface DurationSummary {
  count: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface StageDurationSummary extends DurationSummary {
  stage: PerformanceStage;
}

export interface PerformanceReport {
  schemaVersion: 1;
  clock: "monotonic";
  unit: "milliseconds";
  measurements: PerformanceMeasurement[];
  summaries: StageDurationSummary[];
}

export interface StageTimer {
  stop(): PerformanceMeasurement;
}

const STAGE_SET = new Set<string>(PERFORMANCE_STAGES);
const REPORT_KEYS = ["schemaVersion", "clock", "unit", "measurements", "summaries"] as const;
const MEASUREMENT_KEYS = ["iteration", "sequence", "stage", "durationMs"] as const;
const SUMMARY_KEYS = ["stage", "count", "minMs", "maxMs", "p50Ms", "p95Ms", "p99Ms"] as const;

/**
 * Machine-readable privacy schema. Every object rejects extra properties and
 * the only string-valued measurement field is the closed stage enum.
 */
export const PERFORMANCE_REPORT_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://ticket-agent.local/schemas/performance-report-v1.json",
  type: "object",
  additionalProperties: false,
  required: REPORT_KEYS,
  properties: {
    schemaVersion: { const: 1 },
    clock: { const: "monotonic" },
    unit: { const: "milliseconds" },
    measurements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: MEASUREMENT_KEYS,
        properties: {
          iteration: { type: "integer", minimum: 0 },
          sequence: { type: "integer", minimum: 0 },
          stage: { type: "string", enum: PERFORMANCE_STAGES },
          durationMs: { type: "number", minimum: 0 }
        }
      }
    },
    summaries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: SUMMARY_KEYS,
        properties: {
          stage: { type: "string", enum: PERFORMANCE_STAGES },
          count: { type: "integer", minimum: 1 },
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isSafeOrdinal(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPerformanceStage(value: unknown): value is PerformanceStage {
  return typeof value === "string" && STAGE_SET.has(value);
}

function normalizeDuration(value: number): number {
  if (!isDuration(value)) throw new Error("PERFORMANCE_DURATION_INVALID");
  return Object.is(value, -0) ? 0 : value;
}

/** Uses the nearest-rank definition: rank = ceil(percentile * sample count). */
export function summarizeDurations(values: readonly number[]): DurationSummary {
  if (values.length === 0) throw new Error("PERFORMANCE_VALUES_EMPTY");
  const sorted = values.map(normalizeDuration).sort((left, right) => left - right);
  const atPercentile = (percentile: number): number => {
    const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
    return sorted[index]!;
  };
  return {
    count: sorted.length,
    minMs: sorted[0]!,
    maxMs: sorted[sorted.length - 1]!,
    p50Ms: atPercentile(0.50),
    p95Ms: atPercentile(0.95),
    p99Ms: atPercentile(0.99)
  };
}

function validateMeasurement(value: unknown): PerformanceMeasurement {
  if (!isRecord(value) || !hasExactKeys(value, MEASUREMENT_KEYS)) {
    throw new Error("PERFORMANCE_MEASUREMENT_SCHEMA_INVALID");
  }
  if (!isSafeOrdinal(value.iteration) || !isSafeOrdinal(value.sequence)) {
    throw new Error("PERFORMANCE_MEASUREMENT_ORDINAL_INVALID");
  }
  if (!isPerformanceStage(value.stage)) throw new Error("PERFORMANCE_STAGE_INVALID");
  return {
    iteration: value.iteration,
    sequence: value.sequence,
    stage: value.stage,
    durationMs: normalizeDuration(value.durationMs as number)
  };
}

function summaryForStage(stage: PerformanceStage, measurements: readonly PerformanceMeasurement[]): StageDurationSummary {
  const summary = summarizeDurations(
    measurements.filter((measurement) => measurement.stage === stage).map((measurement) => measurement.durationMs)
  );
  return { stage, ...summary };
}

/** Builds a canonical report with summaries ordered by the fixed stage list. */
export function buildPerformanceReport(measurements: readonly PerformanceMeasurement[]): PerformanceReport {
  const validated = measurements.map(validateMeasurement);
  const sequences = new Set<number>();
  for (const measurement of validated) {
    if (sequences.has(measurement.sequence)) throw new Error("PERFORMANCE_SEQUENCE_DUPLICATE");
    sequences.add(measurement.sequence);
  }
  const summaries = PERFORMANCE_STAGES
    .filter((stage) => validated.some((measurement) => measurement.stage === stage))
    .map((stage) => summaryForStage(stage, validated));
  return {
    schemaVersion: 1,
    clock: "monotonic",
    unit: "milliseconds",
    measurements: validated,
    summaries
  };
}

function sameNumber(left: number, right: number): boolean {
  return Object.is(left, right) || left === right;
}

function validateSummary(value: unknown): StageDurationSummary {
  if (!isRecord(value) || !hasExactKeys(value, SUMMARY_KEYS)) {
    throw new Error("PERFORMANCE_SUMMARY_SCHEMA_INVALID");
  }
  if (!isPerformanceStage(value.stage)) throw new Error("PERFORMANCE_STAGE_INVALID");
  if (typeof value.count !== "number" || !Number.isSafeInteger(value.count) || value.count < 1) {
    throw new Error("PERFORMANCE_SUMMARY_COUNT_INVALID");
  }
  for (const key of ["minMs", "maxMs", "p50Ms", "p95Ms", "p99Ms"] as const) {
    if (!isDuration(value[key])) throw new Error("PERFORMANCE_SUMMARY_DURATION_INVALID");
  }
  return {
    stage: value.stage,
    count: value.count,
    minMs: normalizeDuration(value.minMs as number),
    maxMs: normalizeDuration(value.maxMs as number),
    p50Ms: normalizeDuration(value.p50Ms as number),
    p95Ms: normalizeDuration(value.p95Ms as number),
    p99Ms: normalizeDuration(value.p99Ms as number)
  };
}

/**
 * Validates an untrusted object without ever copying unknown/free-text fields.
 * Summaries are recomputed so a report cannot carry inconsistent aggregates.
 */
export function parsePerformanceReport(value: unknown): PerformanceReport {
  if (!isRecord(value) || !hasExactKeys(value, REPORT_KEYS)) {
    throw new Error("PERFORMANCE_REPORT_SCHEMA_INVALID");
  }
  if (value.schemaVersion !== 1 || value.clock !== "monotonic" || value.unit !== "milliseconds") {
    throw new Error("PERFORMANCE_REPORT_VERSION_INVALID");
  }
  if (!Array.isArray(value.measurements) || !Array.isArray(value.summaries)) {
    throw new Error("PERFORMANCE_REPORT_ARRAYS_INVALID");
  }

  const canonical = buildPerformanceReport(value.measurements);
  const suppliedSummaries = value.summaries.map(validateSummary);
  if (suppliedSummaries.length !== canonical.summaries.length) {
    throw new Error("PERFORMANCE_SUMMARY_MISMATCH");
  }
  for (let index = 0; index < canonical.summaries.length; index += 1) {
    const expected = canonical.summaries[index]!;
    const supplied = suppliedSummaries[index]!;
    if (
      supplied.stage !== expected.stage ||
      supplied.count !== expected.count ||
      !sameNumber(supplied.minMs, expected.minMs) ||
      !sameNumber(supplied.maxMs, expected.maxMs) ||
      !sameNumber(supplied.p50Ms, expected.p50Ms) ||
      !sameNumber(supplied.p95Ms, expected.p95Ms) ||
      !sameNumber(supplied.p99Ms, expected.p99Ms)
    ) {
      throw new Error("PERFORMANCE_SUMMARY_MISMATCH");
    }
  }
  return canonical;
}

/** Parses strict JSON; errors never include the input payload. */
export function parsePerformanceReportJson(json: string): PerformanceReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("PERFORMANCE_JSON_INVALID");
  }
  return parsePerformanceReport(parsed);
}

export function serializePerformanceReport(report: PerformanceReport): string {
  return JSON.stringify(parsePerformanceReport(report));
}

/** Records stage durations using a monotonic clock such as performance.now(). */
export class PerformanceRecorder {
  readonly #clock: MonotonicClock;
  readonly #measurements: PerformanceMeasurement[] = [];
  #lastClockValue: number | undefined;
  #nextSequence = 0;

  constructor(clock: MonotonicClock = () => globalThis.performance.now()) {
    this.#clock = clock;
  }

  #readClock(): number {
    const value = this.#clock();
    if (!isDuration(value)) throw new Error("PERFORMANCE_CLOCK_INVALID");
    if (this.#lastClockValue !== undefined && value < this.#lastClockValue) {
      throw new Error("PERFORMANCE_CLOCK_REGRESSED");
    }
    this.#lastClockValue = value;
    return value;
  }

  #append(stage: PerformanceStage, iteration: number, durationMs: number): PerformanceMeasurement {
    if (!isPerformanceStage(stage)) throw new Error("PERFORMANCE_STAGE_INVALID");
    if (!isSafeOrdinal(iteration)) throw new Error("PERFORMANCE_ITERATION_INVALID");
    const measurement: PerformanceMeasurement = {
      iteration,
      sequence: this.#nextSequence,
      stage,
      durationMs: normalizeDuration(durationMs)
    };
    this.#nextSequence += 1;
    this.#measurements.push(measurement);
    return { ...measurement };
  }

  start(stage: PerformanceStage, iteration = 0): StageTimer {
    if (!isPerformanceStage(stage)) throw new Error("PERFORMANCE_STAGE_INVALID");
    if (!isSafeOrdinal(iteration)) throw new Error("PERFORMANCE_ITERATION_INVALID");
    const startedAt = this.#readClock();
    let stopped = false;
    return {
      stop: (): PerformanceMeasurement => {
        if (stopped) throw new Error("PERFORMANCE_TIMER_ALREADY_STOPPED");
        const endedAt = this.#readClock();
        stopped = true;
        return this.#append(stage, iteration, endedAt - startedAt);
      }
    };
  }

  record(stage: PerformanceStage, durationMs: number, iteration = 0): PerformanceMeasurement {
    return this.#append(stage, iteration, durationMs);
  }

  measureSync<T>(stage: PerformanceStage, operation: () => T, iteration = 0): T {
    const timer = this.start(stage, iteration);
    try {
      return operation();
    } finally {
      timer.stop();
    }
  }

  async measure<T>(stage: PerformanceStage, operation: () => T | Promise<T>, iteration = 0): Promise<T> {
    const timer = this.start(stage, iteration);
    try {
      return await operation();
    } finally {
      timer.stop();
    }
  }

  measurements(): PerformanceMeasurement[] {
    return this.#measurements.map((measurement) => ({ ...measurement }));
  }

  report(): PerformanceReport {
    return buildPerformanceReport(this.#measurements);
  }
}
