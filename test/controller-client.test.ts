import assert from "node:assert/strict";
import test from "node:test";

import { ControllerClient, ControllerClientError, submitDenial } from "../src/runner/controller-client.js";

const token = "controller-client-test-token-32-bytes-minimum";

test("runner controller client permits only loopback and a long token", () => {
  assert.throws(() => new ControllerClient("https://controller.example.com", token), /CONTROLLER_URL_BLOCKED/);
  assert.throws(() => new ControllerClient("http://127.0.0.1:4317/admin", token), /must not contain a path/);
  assert.throws(() => new ControllerClient("http://127.0.0.1:4317", "short"), /TOKEN_TOO_SHORT/);
  assert.doesNotThrow(() => new ControllerClient("http://127.0.0.1:4317", token));
});

test("duplicate approval errors map to a fail-closed duplicate state", () => {
  const duplicate = submitDenial(new ControllerClientError(409, "PURCHASE_LOCK_HELD", "already held"));
  assert.equal(duplicate.allowed, false);
  assert.equal(duplicate.state, "DUPLICATE_BLOCKED");
  const generic = submitDenial(new Error("offline"));
  assert.equal(generic.state, "HUMAN_TAKEOVER");
});

test("an HTTP 200 authorization body with allowed=false is still denied", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({
      allowed: false,
      message: "DUPLICATE_PURCHASE_LOCKED",
      run: { id: "run-1", planId: "plan-1", state: "DUPLICATE_BLOCKED", createdAt: "x", updatedAt: "x" }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
  try {
    const client = new ControllerClient("http://127.0.0.1:4317", token);
    await assert.rejects(
      () => client.approveSubmit("run-1", 10_000),
      (error: unknown) => error instanceof ControllerClientError && error.code === "DUPLICATE_PURCHASE_LOCKED"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("approval continues only after a strictly matching SUBMIT_ORDER response", async () => {
  const originalFetch = globalThis.fetch;
  const approvedRun = {
    id: "run-1",
    planId: "plan-1",
    state: "SUBMIT_ORDER",
    observedTotalFen: 10_000,
    priceVerifiedAt: "2026-07-30T00:00:01.000Z",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:02.000Z"
  };
  try {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ allowed: true, run: approvedRun }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
    const client = new ControllerClient("http://127.0.0.1:4317", token);
    assert.deepEqual(await client.approveSubmit("run-1", 10_000), approvedRun);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("malformed or mismatched HTTP 200 approvals fail closed", async () => {
  const originalFetch = globalThis.fetch;
  const approvedRun = {
    id: "run-1",
    planId: "plan-1",
    state: "SUBMIT_ORDER",
    observedTotalFen: 10_000,
    priceVerifiedAt: "2026-07-30T00:00:01.000Z",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:02.000Z"
  };
  const invalidPayloads: Array<[string, unknown]> = [
    ["missing allowed", { run: approvedRun }],
    ["missing run", { allowed: true }],
    ["wrong run ID", { allowed: true, run: { ...approvedRun, id: "run-other" } }],
    ["missing plan ID", { allowed: true, run: { ...approvedRun, planId: "" } }],
    ["wrong state", { allowed: true, run: { ...approvedRun, state: "REVIEW_REQUIRED" } }],
    ["wrong total", { allowed: true, run: { ...approvedRun, observedTotalFen: 9_999 } }],
    ["missing verified timestamp", { allowed: true, run: { ...approvedRun, priceVerifiedAt: undefined } }],
    ["non-object body", null]
  ];

  try {
    const client = new ControllerClient("http://127.0.0.1:4317", token);
    for (const [label, payload] of invalidPayloads) {
      globalThis.fetch = async () => new Response(
        JSON.stringify(payload),
        { status: 200, headers: { "content-type": "application/json" } }
      );
      await assert.rejects(
        () => client.approveSubmit("run-1", 10_000),
        (error: unknown) =>
          error instanceof ControllerClientError &&
          error.code === "CONTROLLER_RESPONSE_INVALID" &&
          error.status === 502,
        label
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadRunPlan binds both responses to the requested run and plan", async () => {
  const originalFetch = globalThis.fetch;
  const run = {
    id: "run-1",
    planId: "plan-1",
    state: "SCHEDULED",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:01.000Z"
  };
  const plan = {
    id: "plan-1",
    platform: "damai",
    quantity: 1,
    requireAdjacent: false,
    sessions: [],
    tiers: [],
    priceStrategy: "CHEAPEST_FIRST",
    attendeeAliases: [],
    autoSubmitOrder: false,
    status: "ARMED",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:01.000Z"
  };
  try {
    globalThis.fetch = async (input) => new Response(
      JSON.stringify(String(input).includes("/runs/") ? { run } : { plan }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
    const client = new ControllerClient("http://127.0.0.1:4317", token);
    assert.deepEqual(await client.loadRunPlan("run-1"), { run, plan });

    globalThis.fetch = async () => new Response(
      JSON.stringify({ run: { ...run, id: "run-other" } }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
    await assert.rejects(
      () => client.loadRunPlan("run-1"),
      (error: unknown) => error instanceof ControllerClientError && error.code === "CONTROLLER_RESPONSE_INVALID"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
