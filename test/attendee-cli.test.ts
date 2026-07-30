import assert from "node:assert/strict";
import test from "node:test";

import type { WatchPlan } from "../src/core/types.js";
import { buildAttendeeRefAudit, parseAttendeeRef } from "../src/identity/attendee-ref.js";
import type {
  AttendeeResolution,
  AttendeeResolver,
  AttendeeResolutionRequest
} from "../src/identity/attendee-resolver.js";
import { withRuntimeAttendeeLabels } from "../src/runner/cli.js";

const attendeeRef = parseAttendeeRef("attendee:v1:550e8400-e29b-41d4-a716-446655440000");
const displayLabel = "DISPLAY_VALUE_ONE";

function plan(): WatchPlan {
  return {
    id: "plan-attendee-runtime",
    platform: "damai",
    officialUrl: "https://detail.damai.cn/item.htm?id=123456",
    eventId: "123456",
    eventTitle: "Runtime attendee boundary test",
    canonicalEventKey: "runtime-attendee-boundary-test",
    saleAt: "2026-08-01T10:00:00+08:00",
    quantity: 1,
    requireAdjacent: false,
    sessions: [],
    tiers: [],
    maxTotalFen: 5_800,
    priceStrategy: "CHEAPEST_FIRST",
    attendeeRefs: [attendeeRef],
    attendeeAliases: [],
    autoSubmitOrder: true,
    status: "ARMED",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z"
  };
}

function fakeResolver(
  labels: readonly string[],
  hooks: { resolveCalls: number; disposeCalls: number; requests: AttendeeResolutionRequest[] }
): AttendeeResolver {
  return {
    async resolve(request): Promise<AttendeeResolution> {
      hooks.resolveCalls += 1;
      hooks.requests.push(request);
      let disposed = false;
      return {
        audit: () => buildAttendeeRefAudit(request.attendeeRefs),
        async withLabels<T>(consumer: (values: readonly string[]) => T | Promise<T>): Promise<T> {
          if (disposed) throw new Error("TEST_RESOLUTION_DISPOSED");
          return consumer(Object.freeze([...labels]));
        },
        dispose(): void {
          disposed = true;
          hooks.disposeCalls += 1;
        }
      };
    }
  };
}

function hooks() {
  return { resolveCalls: 0, disposeCalls: 0, requests: [] as AttendeeResolutionRequest[] };
}

test("dry-run and mock never invoke attendee resolution", async () => {
  for (const mode of ["dry-run", "mock"] as const) {
    const original = plan();
    const observed = hooks();
    const resolver = fakeResolver([displayLabel], observed);
    const returned = await withRuntimeAttendeeLabels(mode, original, async (runtimePlan) => runtimePlan, resolver);

    assert.strictEqual(returned, original);
    assert.equal(observed.resolveCalls, 0);
    assert.equal(observed.disposeCalls, 0);
    assert.deepEqual(original.attendeeAliases, []);
  }
});

test("live and rehearsal expose labels only to the runtime plan and wipe them afterwards", async () => {
  for (const mode of ["live", "rehearsal"] as const) {
    const original = plan();
    const observed = hooks();
    const resolver = fakeResolver([displayLabel], observed);
    let escapedAliases: string[] | undefined;

    const result = await withRuntimeAttendeeLabels(mode, original, async (runtimePlan) => {
      assert.notStrictEqual(runtimePlan, original);
      assert.deepEqual(runtimePlan.attendeeAliases, [displayLabel]);
      assert.deepEqual(runtimePlan.attendeeRefs, [attendeeRef]);
      escapedAliases = runtimePlan.attendeeAliases;
      return "OPERATION_COMPLETED";
    }, resolver);

    assert.equal(result, "OPERATION_COMPLETED");
    assert.equal(observed.resolveCalls, 1);
    assert.equal(observed.disposeCalls, 1);
    assert.deepEqual(observed.requests, [{
      platform: "damai",
      attendeeRefs: [attendeeRef],
      phase: "PREWARM",
      saleAt: original.saleAt!
    }]);
    assert.deepEqual(escapedAliases, [""]);
    assert.deepEqual(original.attendeeAliases, []);
  }
});

test("runtime operation failures still wipe aliases and dispose resolution", async () => {
  const original = plan();
  const observed = hooks();
  const resolver = fakeResolver([displayLabel], observed);
  let escapedAliases: string[] | undefined;
  let thrown: unknown;

  try {
    await withRuntimeAttendeeLabels("rehearsal", original, async (runtimePlan) => {
      escapedAliases = runtimePlan.attendeeAliases;
      throw new Error("INJECTED_OPERATION_FAILURE");
    }, resolver);
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof Error);
  assert.equal(thrown.message, "INJECTED_OPERATION_FAILURE");
  assert.equal(thrown.message.includes(displayLabel), false);
  assert.equal(thrown.message.includes(attendeeRef), false);
  assert.equal(observed.disposeCalls, 1);
  assert.deepEqual(escapedAliases, [""]);
  assert.deepEqual(original.attendeeAliases, []);
});

test("resolution count mismatch fails closed before the browser operation", async () => {
  const original = plan();
  const observed = hooks();
  const resolver = fakeResolver([], observed);
  let operationCalls = 0;
  let thrown: unknown;

  try {
    await withRuntimeAttendeeLabels("live", original, async () => {
      operationCalls += 1;
    }, resolver);
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof Error);
  assert.equal(thrown.message, "ATTENDEE_RESOLUTION_COUNT_MISMATCH");
  assert.equal(thrown.message.includes(displayLabel), false);
  assert.equal(thrown.message.includes(attendeeRef), false);
  assert.equal(operationCalls, 0);
  assert.equal(observed.resolveCalls, 1);
  assert.equal(observed.disposeCalls, 1);
  assert.deepEqual(original.attendeeAliases, []);
});
