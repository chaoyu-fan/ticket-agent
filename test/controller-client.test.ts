import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { SubmitAttemptOutcome, SubmitCapabilityGrantStatus } from "../src/controller/store.js";
import { ControllerClient, ControllerClientError, submitDenial } from "../src/runner/controller-client.js";

const token = "controller-client-test-token-32-bytes-minimum";
const deliveryId = "delivery-1";
const deliveryBody = Buffer.from('{"opaque":"capability"}', "utf8").toString("base64url");
const delivery = {
  body: deliveryBody,
  signature: Buffer.alloc(32, 7).toString("base64url")
};
const runnerSessionDigest = `sha256:${"a".repeat(64)}` as const;
const claimInput = {
  runnerSessionDigest,
  attendeeSelectionFingerprint: `hmac-sha256:${"b".repeat(64)}` as const,
  fastPathContractDigest: `sha256:${"c".repeat(64)}` as const,
  finalOfficialOrigin: "https://buy.damai.cn"
};

function bodyDigest(body = deliveryBody): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update("ticket-agent/capability-body/v1\u0000", "utf8")
    .update(body, "utf8")
    .digest("hex")}`;
}

function runFixture(runId = "run-1", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: runId,
    planId: "plan-1",
    state: "PREWARM",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:01.000Z",
    ...overrides
  };
}

function grantFixture(
  status: SubmitCapabilityGrantStatus = "DELIVERY_CLAIMED",
  runId = "run-1",
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const lifecycle: Record<string, unknown> = {};
  if (status === "RUNNER_PREPARED") {
    lifecycle.runnerPreparedAt = "2026-07-30T00:00:02.000Z";
  } else if (
    status === "CLICK_DISPATCHED" ||
    status === "OUTCOME_UNKNOWN" ||
    status === "CONSUME_REJECTED" ||
    status === "ZERO_CLICK_BLOCKED"
  ) {
    lifecycle.runnerPreparedAt = "2026-07-30T00:00:02.000Z";
    lifecycle.attemptOutcome = status;
    lifecycle.attemptedAt = "2026-07-30T00:00:03.000Z";
  } else if (status === "ORDER_CONFIRMED") {
    lifecycle.runnerPreparedAt = "2026-07-30T00:00:02.000Z";
    lifecycle.attemptOutcome = "CLICK_DISPATCHED";
    lifecycle.attemptedAt = "2026-07-30T00:00:03.000Z";
  }
  return {
    runId,
    planId: "plan-1",
    eventKey: "event:v1:damai:fixture",
    deliveryId,
    capabilityVersion: 2,
    capabilityNonceSha256: `sha256:${"d".repeat(64)}`,
    runnerSessionSha256: runnerSessionDigest,
    claimsBodySha256: bodyDigest(),
    issuedAtMs: 1_000,
    earliestSubmitAtMs: 2_000,
    expiresAtMs: 3_000,
    status,
    deliveryClaimedAt: "2026-07-30T00:00:01.000Z",
    ...lifecycle,
    updatedAt: status === "DELIVERY_CLAIMED"
      ? "2026-07-30T00:00:01.000Z"
      : status === "RUNNER_PREPARED"
        ? "2026-07-30T00:00:02.000Z"
        : "2026-07-30T00:00:03.000Z",
    ...overrides
  };
}

function claimFixture(runId = "run-1", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    delivery,
    grant: grantFixture("DELIVERY_CLAIMED", runId),
    run: runFixture(runId),
    ...overrides
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

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
    attendeeRefs: [],
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

    const unsafe = "LOCAL_DISPLAY_VALUE";
    globalThis.fetch = async (input) => new Response(
      JSON.stringify(String(input).includes("/runs/") ? { run } : { plan: { ...plan, attendeeAliases: [unsafe] } }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
    await assert.rejects(
      () => client.loadRunPlan("run-1"),
      (error: unknown) =>
        error instanceof ControllerClientError &&
        error.code === "CONTROLLER_RESPONSE_INVALID" &&
        !error.message.includes(unsafe)
    );

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

test("capability client uses encoded exact routes and validates matching success responses", async () => {
  const originalFetch = globalThis.fetch;
  const runId = "run /中文";
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const attempted = grantFixture("CLICK_DISPATCHED", runId);
  try {
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), ...(init === undefined ? {} : { init }) });
      switch (requests.length) {
        case 1:
          return jsonResponse(claimFixture(runId), 201);
        case 2:
          return jsonResponse({ grant: grantFixture("RUNNER_PREPARED", runId) });
        case 3:
          return jsonResponse({ grant: attempted });
        case 4:
          return jsonResponse({ grant: attempted });
        default:
          throw new Error("unexpected request");
      }
    };
    const client = new ControllerClient("http://127.0.0.1:4317", token);
    const claimed = await client.claimSubmitCapability(
      runId,
      { ...claimInput, unexpected: "must-not-cross-wire" } as typeof claimInput
    );
    assert.equal(claimed.delivery.body, deliveryBody);
    assert.equal(claimed.grant.runId, runId);
    assert.equal(claimed.grant.status, "DELIVERY_CLAIMED");
    assert.equal(claimed.run.state, "PREWARM");
    assert.equal((await client.ackCapabilityPrepared(runId, deliveryId)).status, "RUNNER_PREPARED");
    assert.equal(
      (await client.reportSubmitAttempt(runId, deliveryId, "CLICK_DISPATCHED")).attemptOutcome,
      "CLICK_DISPATCHED"
    );
    assert.equal((await client.getSubmitCapabilityGrant(runId)).status, "CLICK_DISPATCHED");

    const encoded = encodeURIComponent(runId);
    assert.deepEqual(requests.map((request) => request.url), [
      `http://127.0.0.1:4317/runs/${encoded}/submit-capability/deliver`,
      `http://127.0.0.1:4317/runs/${encoded}/submit-capability/prepared-ack`,
      `http://127.0.0.1:4317/runs/${encoded}/submit-attempt`,
      `http://127.0.0.1:4317/runs/${encoded}/submit-capability`
    ]);
    assert.deepEqual(JSON.parse(String(requests[0]!.init?.body)), claimInput);
    assert.deepEqual(JSON.parse(String(requests[1]!.init?.body)), { deliveryId });
    assert.deepEqual(JSON.parse(String(requests[2]!.init?.body)), {
      deliveryId,
      outcome: "CLICK_DISPATCHED"
    });
    assert.equal(requests[3]!.init?.method, "GET");
    assert.equal(requests[3]!.init?.body, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("capability claim rejects malformed, extra, mismatched, and digest-inconsistent success bodies", async () => {
  const originalFetch = globalThis.fetch;
  const base = claimFixture();
  const invalidPayloads: Array<[string, unknown]> = [
    ["non-object", null],
    ["extra response field", { ...base, extra: true }],
    ["extra envelope field", { ...base, delivery: { ...delivery, note: "blocked" } }],
    ["malformed envelope body", { ...base, delivery: { ...delivery, body: "not+base64" } }],
    ["malformed signature", { ...base, delivery: { ...delivery, signature: "short" } }],
    ["wrong run ID", { ...base, grant: grantFixture("DELIVERY_CLAIMED", "run-other") }],
    ["wrong run state", { ...base, run: runFixture("run-1", { state: "SCHEDULED" }) }],
    ["plan mismatch", { ...base, run: runFixture("run-1", { planId: "plan-other" }) }],
    ["wrong grant status", {
      ...base,
      grant: grantFixture("RUNNER_PREPARED")
    }],
    ["wrong runner session digest", {
      ...base,
      grant: grantFixture("DELIVERY_CLAIMED", "run-1", { runnerSessionSha256: `sha256:${"e".repeat(64)}` })
    }],
    ["wrong capability body digest", {
      ...base,
      grant: grantFixture("DELIVERY_CLAIMED", "run-1", { claimsBodySha256: `sha256:${"f".repeat(64)}` })
    }],
    ["invalid capability time order", {
      ...base,
      grant: grantFixture("DELIVERY_CLAIMED", "run-1", { earliestSubmitAtMs: 999 })
    }],
    ["extra grant field", {
      ...base,
      grant: { ...grantFixture(), secret: "blocked" }
    }],
    ["extra run field", {
      ...base,
      run: runFixture("run-1", { note: "blocked" })
    }]
  ];
  try {
    const client = new ControllerClient("http://127.0.0.1:4317", token);
    for (const [label, payload] of invalidPayloads) {
      globalThis.fetch = async () => jsonResponse(payload, 201);
      await assert.rejects(
        () => client.claimSubmitCapability("run-1", claimInput),
        (error: unknown) =>
          error instanceof ControllerClientError &&
          error.code === "CONTROLLER_RESPONSE_INVALID" &&
          error.status === 502 &&
          !error.message.includes(deliveryBody),
        label
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("prepared acknowledgement and submit-attempt reports accept only their exact lifecycle status", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const client = new ControllerClient("http://127.0.0.1:4317", token);
    globalThis.fetch = async () => jsonResponse({ grant: grantFixture("RUNNER_PREPARED") });
    assert.equal((await client.ackCapabilityPrepared("run-1", deliveryId)).status, "RUNNER_PREPARED");

    const prepared = grantFixture("RUNNER_PREPARED");
    const { runnerPreparedAt: _removed, ...missingPreparedAt } = prepared;
    const invalidAcknowledgements = [
      { grant: grantFixture("DELIVERY_CLAIMED") },
      { grant: grantFixture("RUNNER_PREPARED", "run-1", { deliveryId: "delivery-other" }) },
      { grant: missingPreparedAt },
      { grant: grantFixture("RUNNER_PREPARED"), extra: true }
    ];
    for (const payload of invalidAcknowledgements) {
      globalThis.fetch = async () => jsonResponse(payload);
      await assert.rejects(
        () => client.ackCapabilityPrepared("run-1", deliveryId),
        (error: unknown) => error instanceof ControllerClientError && error.code === "CONTROLLER_RESPONSE_INVALID"
      );
    }

    const outcomes: SubmitAttemptOutcome[] = [
      "CLICK_DISPATCHED",
      "OUTCOME_UNKNOWN",
      "CONSUME_REJECTED",
      "ZERO_CLICK_BLOCKED"
    ];
    for (const outcome of outcomes) {
      globalThis.fetch = async () => jsonResponse({ grant: grantFixture(outcome) });
      const grant = await client.reportSubmitAttempt("run-1", deliveryId, outcome);
      assert.equal(grant.status, outcome);
      assert.equal(grant.attemptOutcome, outcome);
    }

    const unpreparedZeroClick = grantFixture("ZERO_CLICK_BLOCKED");
    delete unpreparedZeroClick.runnerPreparedAt;
    globalThis.fetch = async () => jsonResponse({ grant: unpreparedZeroClick });
    const abandoned = await client.reportSubmitAttempt(
      "run-1",
      deliveryId,
      "ZERO_CLICK_BLOCKED"
    );
    assert.equal(abandoned.status, "ZERO_CLICK_BLOCKED");
    assert.equal(abandoned.runnerPreparedAt, undefined);

    globalThis.fetch = async () => jsonResponse({ grant: grantFixture("OUTCOME_UNKNOWN") });
    await assert.rejects(
      () => client.reportSubmitAttempt("run-1", deliveryId, "CLICK_DISPATCHED"),
      (error: unknown) => error instanceof ControllerClientError && error.code === "CONTROLLER_RESPONSE_INVALID"
    );
    await assert.rejects(
      () => client.reportSubmitAttempt("run-1", deliveryId, "NOT_ALLOWED" as SubmitAttemptOutcome),
      /SUBMIT_CAPABILITY_ATTEMPT_INVALID/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("read-only capability status accepts every coherent grant status and rejects inconsistent evidence", async () => {
  const originalFetch = globalThis.fetch;
  const statuses: SubmitCapabilityGrantStatus[] = [
    "DELIVERY_CLAIMED",
    "RUNNER_PREPARED",
    "CLICK_DISPATCHED",
    "OUTCOME_UNKNOWN",
    "CONSUME_REJECTED",
    "ZERO_CLICK_BLOCKED",
    "ORDER_CONFIRMED",
    "RECONCILED_NO_ORDER"
  ];
  try {
    const client = new ControllerClient("http://127.0.0.1:4317", token);
    for (const status of statuses) {
      globalThis.fetch = async () => jsonResponse({ grant: grantFixture(status) });
      assert.equal((await client.getSubmitCapabilityGrant("run-1")).status, status);
    }
    globalThis.fetch = async () => jsonResponse({
      grant: grantFixture("CLICK_DISPATCHED", "run-1", { attemptOutcome: "OUTCOME_UNKNOWN" })
    });
    await assert.rejects(
      () => client.getSubmitCapabilityGrant("run-1"),
      (error: unknown) => error instanceof ControllerClientError && error.code === "CONTROLLER_RESPONSE_INVALID"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("read-only capability status accepts reconciled unprepared zero-click history", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => jsonResponse({
      grant: grantFixture("RECONCILED_NO_ORDER", "run-1", {
        attemptOutcome: "ZERO_CLICK_BLOCKED",
        attemptedAt: "2026-07-30T00:00:03.000Z",
        updatedAt: "2026-07-30T00:00:04.000Z"
      })
    });
    const client = new ControllerClient("http://127.0.0.1:4317", token);
    const grant = await client.getSubmitCapabilityGrant("run-1");
    assert.equal(grant.status, "RECONCILED_NO_ORDER");
    assert.equal(grant.attemptOutcome, "ZERO_CLICK_BLOCKED");
    assert.equal(grant.runnerPreparedAt, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("capability client preserves controller errors without accepting malformed HTTP 200 bodies", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const client = new ControllerClient("http://127.0.0.1:4317", token);
    globalThis.fetch = async () => jsonResponse({
      error: {
        code: "SUBMIT_CAPABILITY_ALREADY_DELIVERED",
        message: "delivery already burned",
        details: { retryable: false }
      }
    }, 409);
    await assert.rejects(
      () => client.claimSubmitCapability("run-1", claimInput),
      (error: unknown) =>
        error instanceof ControllerClientError &&
        error.status === 409 &&
        error.code === "SUBMIT_CAPABILITY_ALREADY_DELIVERED" &&
        (error.details as { retryable?: boolean } | undefined)?.retryable === false
    );

    globalThis.fetch = async () => new Response("not-json", { status: 200 });
    await assert.rejects(
      () => client.ackCapabilityPrepared("run-1", deliveryId),
      (error: unknown) =>
        error instanceof ControllerClientError &&
        error.status === 502 &&
        error.code === "CONTROLLER_RESPONSE_INVALID"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
