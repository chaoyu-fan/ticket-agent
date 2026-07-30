import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { WatchPlanInput } from "../src/core/types.js";
import { ControllerError } from "../src/controller/errors.js";
import {
  SubmitCapabilityService,
  type ClaimSubmitCapabilityInput
} from "../src/controller/submit-capability-service.js";
import { ControllerStore } from "../src/controller/store.js";
import {
  InProcessSubmitCapabilityConsumer,
  buildAttendeeSelectionFingerprint,
  digestRunnerSessionSecret
} from "../src/security/submit-capability.js";

const CAPABILITY_SECRET = "durable-capability-test-key-with-at-least-thirty-two-bytes";
const RUNNER_SESSION_SECRET = new Uint8Array(Buffer.alloc(32, 21));
const SALE_AT = "2026-08-01T10:00:00+08:00";
const SALE_AT_MS = Date.parse(SALE_AT);
const ISSUED_AT_MS = SALE_AT_MS - 5 * 60 * 1_000;
const ATTENDEE_REF = "attendee:v1:550e8400-e29b-41d4-a716-446655440000" as const;
const NONCE = Buffer.alloc(32, 22).toString("base64url");
const EVENT_KEY = "canonical:durablefastpathshow";

function plan(overrides: Partial<WatchPlanInput> = {}): WatchPlanInput {
  return {
    platform: "damai",
    officialUrl: "https://detail.damai.cn/item.htm?id=123",
    eventId: "123",
    eventTitle: "合成极速演出",
    canonicalEventKey: "durable-fast-path-show",
    saleAt: SALE_AT,
    quantity: 1,
    sessions: [{ label: "首场", priority: 10 }],
    tiers: [{ label: "看台", priority: 10, maxUnitPriceFen: 58_000 }],
    priceStrategy: "PREFERRED_ORDER",
    maxTotalFen: 60_000,
    attendeeRefs: [ATTENDEE_REF],
    autoSubmitOrder: true,
    ...overrides
  };
}

function input(): ClaimSubmitCapabilityInput {
  return {
    runnerSessionDigest: digestRunnerSessionSecret(RUNNER_SESSION_SECRET),
    attendeeSelectionFingerprint: buildAttendeeSelectionFingerprint(RUNNER_SESSION_SECRET, [
      JSON.stringify([ATTENDEE_REF, "合成观演人"])
    ]),
    fastPathContractDigest: `sha256:${"c".repeat(64)}`,
    finalOfficialOrigin: "https://buy.damai.cn"
  };
}

function deterministicStore(databasePath = ":memory:"): ControllerStore {
  let nextId = 0;
  let tick = 0;
  return new ControllerStore(databasePath, {
    idFactory: () => `id-${++nextId}`,
    now: () => new Date(ISSUED_AT_MS + tick++).toISOString()
  });
}

function service(store: ControllerStore, deliveryId = "delivery-1", nonce = NONCE): SubmitCapabilityService {
  return new SubmitCapabilityService(store, CAPABILITY_SECRET, {
    nowMs: () => ISSUED_AT_MS,
    deliveryIdFactory: () => deliveryId,
    nonceFactory: () => nonce
  });
}

function controllerCode(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => error instanceof ControllerError && error.code === code;
}

test("at-most-once delivery atomically creates a durable grant and sticky lock", () => {
  const store = deterministicStore();
  try {
    const armed = store.armPlan(store.createPlan(plan()).id);
    const claimed = service(store).claimDelivery(armed.run.id, input());

    assert.equal(claimed.run.state, "PREWARM");
    assert.equal(store.requirePlan(armed.plan.id).status, "RUNNING");
    assert.equal(store.getPurchaseLockForRun(armed.run.id)?.status, "HELD");
    assert.equal(store.getPurchaseLockForRun(armed.run.id)?.eventKey, EVENT_KEY);
    assert.equal(claimed.grant.status, "DELIVERY_CLAIMED");
    assert.equal(claimed.grant.deliveryId, "delivery-1");
    assert.equal(claimed.grant.runnerSessionSha256, input().runnerSessionDigest);

    const consumer = new InProcessSubmitCapabilityConsumer(
      () => ISSUED_AT_MS,
      () => 0
    );
    const preparedCapability = consumer.prepare(
      claimed.delivery,
      CAPABILITY_SECRET,
      RUNNER_SESSION_SECRET
    );
    const claims = preparedCapability.claims;
    assert.equal(claims.deliveryId, claimed.grant.deliveryId);
    assert.equal(claims.runnerSessionDigest, input().runnerSessionDigest);
    assert.equal(claims.earliestSubmitAtMs, SALE_AT_MS);
    assert.equal(claims.finalOfficialOrigin, "https://buy.damai.cn");
    assert.equal(claims.fastPathContractDigest, input().fastPathContractDigest);
    assert.equal(claims.attendeeSelectionFingerprint, input().attendeeSelectionFingerprint);

    const persisted = store.database.prepare(
      "SELECT * FROM submit_capability_grants WHERE run_id = ?"
    ).get(armed.run.id) as Record<string, unknown>;
    const persistedText = JSON.stringify(persisted);
    assert.equal(persistedText.includes(claimed.delivery.body), false);
    assert.equal(persistedText.includes(claimed.delivery.signature), false);
    assert.equal(persistedText.includes(CAPABILITY_SECRET), false);
    assert.equal(persistedText.includes(ATTENDEE_REF), false);
    assert.equal(persistedText.includes("合成观演人"), false);

    assert.throws(
      () => service(store, "delivery-2", Buffer.alloc(32, 23).toString("base64url")).claimDelivery(armed.run.id, input()),
      controllerCode("SUBMIT_CAPABILITY_ALREADY_DELIVERED")
    );
    assert.equal(store.getSubmitCapabilityGrant(armed.run.id)?.deliveryId, "delivery-1");
    assert.equal(store.getPurchaseLockForRun(armed.run.id)?.status, "HELD");
    assert.throws(
      () => store.authorizeSubmit(armed.run.id, { confirmation: "APPROVE_SUBMIT", observedTotalFen: 58_000 }),
      controllerCode("SUBMIT_CAPABILITY_GRANT_EXISTS")
    );
    assert.throws(() => store.cancelPlan(armed.plan.id), controllerCode("PLAN_NOT_CANCELLABLE_AFTER_SUBMIT"));
  } finally {
    store.close();
  }
});

test("active capability rejects generic runner events before and after prepared ACK", () => {
  const store = deterministicStore();
  try {
    const armed = store.armPlan(store.createPlan(plan({ canonicalEventKey: "event-race-show" })).id);
    const claimed = service(store).claimDelivery(armed.run.id, input());
    assert.throws(
      () => store.applyRunnerEvent({ runId: armed.run.id, state: "FAILED", message: "stale runner" }),
      controllerCode("SUBMIT_CAPABILITY_GRANT_EXISTS")
    );
    assert.equal(store.requireRun(armed.run.id).state, "PREWARM");
    assert.equal(store.requirePlan(armed.plan.id).status, "RUNNING");

    store.ackSubmitCapabilityPrepared(armed.run.id, claimed.grant.deliveryId);
    assert.throws(
      () => store.applyRunnerEvent({ runId: armed.run.id, state: "HUMAN_TAKEOVER", message: "stale runner" }),
      controllerCode("SUBMIT_CAPABILITY_GRANT_EXISTS")
    );
    const reported = store.recordSubmitAttemptOutcome(
      armed.run.id,
      claimed.grant.deliveryId,
      "ZERO_CLICK_BLOCKED"
    );
    assert.equal(reported.status, "ZERO_CLICK_BLOCKED");
    assert.equal(store.requireRun(armed.run.id).state, "FAILED");
    assert.equal(store.getPurchaseLockForRun(armed.run.id)?.status, "HELD");
  } finally {
    store.close();
  }
});

test("a delivery known to be unprepared can finalize as zero-click without fabricating an ACK", () => {
  const store = deterministicStore();
  try {
    const armed = store.armPlan(store.createPlan(plan({ canonicalEventKey: "unprepared-zero-click-show" })).id);
    const claimed = service(store).claimDelivery(armed.run.id, input());
    const abandoned = store.recordSubmitAttemptOutcome(
      armed.run.id,
      claimed.grant.deliveryId,
      "ZERO_CLICK_BLOCKED"
    );
    assert.equal(abandoned.status, "ZERO_CLICK_BLOCKED");
    assert.equal(abandoned.attemptOutcome, "ZERO_CLICK_BLOCKED");
    assert.equal(abandoned.runnerPreparedAt, undefined);
    assert.ok(abandoned.attemptedAt);
    assert.equal(store.requireRun(armed.run.id).state, "FAILED");
    assert.equal(store.getPurchaseLockForRun(armed.run.id)?.status, "HELD");
    assert.throws(
      () => store.ackSubmitCapabilityPrepared(armed.run.id, claimed.grant.deliveryId),
      controllerCode("SUBMIT_CAPABILITY_GRANT_FINALIZED")
    );
  } finally {
    store.close();
  }
});

test("prepared ACK and attempt report require the bound active run and sticky lock", () => {
  const drifted = deterministicStore();
  try {
    const armed = drifted.armPlan(drifted.createPlan(plan({ canonicalEventKey: "drifted-runtime-show" })).id);
    const claimed = service(drifted).claimDelivery(armed.run.id, input());
    drifted.database.prepare("UPDATE purchase_runs SET state = 'FAILED' WHERE id = ?").run(armed.run.id);
    assert.throws(
      () => drifted.ackSubmitCapabilityPrepared(armed.run.id, claimed.grant.deliveryId),
      controllerCode("SUBMIT_CAPABILITY_RUNTIME_MISMATCH")
    );
    assert.equal(drifted.getSubmitCapabilityGrant(armed.run.id)?.status, "DELIVERY_CLAIMED");
  } finally {
    drifted.close();
  }

  const missingLock = deterministicStore();
  try {
    const armed = missingLock.armPlan(missingLock.createPlan(plan({ canonicalEventKey: "missing-lock-show" })).id);
    const claimed = service(missingLock).claimDelivery(armed.run.id, input());
    missingLock.ackSubmitCapabilityPrepared(armed.run.id, claimed.grant.deliveryId);
    missingLock.database.prepare("DELETE FROM purchase_locks WHERE run_id = ?").run(armed.run.id);
    assert.throws(
      () => missingLock.recordSubmitAttemptOutcome(
        armed.run.id,
        claimed.grant.deliveryId,
        "CLICK_DISPATCHED"
      ),
      controllerCode("SUBMIT_CAPABILITY_RUNTIME_MISMATCH")
    );
    assert.equal(missingLock.getSubmitCapabilityGrant(armed.run.id)?.status, "RUNNER_PREPARED");
    assert.equal(missingLock.requireRun(armed.run.id).state, "PREWARM");
  } finally {
    missingLock.close();
  }
});

test("the first prepared ACK after capability expiry is rejected without mutating the grant", () => {
  let nextId = 0;
  let nowMs = ISSUED_AT_MS;
  const store = new ControllerStore(":memory:", {
    idFactory: () => `expired-ack-${++nextId}`,
    now: () => new Date(nowMs).toISOString()
  });
  try {
    const armed = store.armPlan(store.createPlan(plan({ canonicalEventKey: "expired-ack-show" })).id);
    const claimed = service(store).claimDelivery(armed.run.id, input());
    nowMs = claimed.grant.expiresAtMs + 1;

    assert.throws(
      () => store.ackSubmitCapabilityPrepared(armed.run.id, claimed.grant.deliveryId),
      controllerCode("SUBMIT_CAPABILITY_EXPIRED")
    );
    const persisted = store.getSubmitCapabilityGrant(armed.run.id);
    assert.equal(persisted?.status, "DELIVERY_CLAIMED");
    assert.equal(persisted?.runnerPreparedAt, undefined);
  } finally {
    store.close();
  }
});

test("prepared and zero-click reports are idempotent but never permit redelivery", () => {
  const store = deterministicStore();
  try {
    const armed = store.armPlan(store.createPlan(plan({ canonicalEventKey: "zero-click-show" })).id);
    const claimed = service(store).claimDelivery(armed.run.id, input());
    const prepared = store.ackSubmitCapabilityPrepared(armed.run.id, claimed.grant.deliveryId);
    assert.equal(prepared.status, "RUNNER_PREPARED");
    assert.deepEqual(
      store.ackSubmitCapabilityPrepared(armed.run.id, claimed.grant.deliveryId),
      prepared
    );

    const blocked = store.recordSubmitAttemptOutcome(
      armed.run.id,
      claimed.grant.deliveryId,
      "ZERO_CLICK_BLOCKED"
    );
    assert.equal(blocked.status, "ZERO_CLICK_BLOCKED");
    assert.equal(store.requireRun(armed.run.id).state, "FAILED");
    assert.equal(store.getPurchaseLockForRun(armed.run.id)?.status, "HELD");
    assert.deepEqual(
      store.recordSubmitAttemptOutcome(armed.run.id, claimed.grant.deliveryId, "ZERO_CLICK_BLOCKED"),
      blocked
    );
    assert.throws(
      () => store.recordSubmitAttemptOutcome(armed.run.id, claimed.grant.deliveryId, "CLICK_DISPATCHED"),
      controllerCode("SUBMIT_CAPABILITY_ATTEMPT_ALREADY_RECORDED")
    );

    const eventKey = store.getPurchaseLockForRun(armed.run.id)!.eventKey;
    assert.throws(
      () => store.reconcileNoOrder(armed.run.id, {
        confirmation: "NO_ORDER_EXISTS",
        confirmedByUser: true,
        eventKey
      }),
      controllerCode("SUBMIT_CAPABILITY_DELIVERY_MISMATCH")
    );
    store.reconcileNoOrder(armed.run.id, {
      confirmation: "NO_ORDER_EXISTS",
      confirmedByUser: true,
      eventKey,
      deliveryId: claimed.grant.deliveryId
    });
    assert.equal(store.getPurchaseLockForRun(armed.run.id), undefined);
    assert.equal(store.getSubmitCapabilityGrant(armed.run.id)?.status, "RECONCILED_NO_ORDER");
    assert.throws(
      () => service(store, "delivery-retry", Buffer.alloc(32, 24).toString("base64url")).claimDelivery(armed.run.id, input()),
      controllerCode("SUBMIT_CAPABILITY_ALREADY_DELIVERED")
    );
  } finally {
    store.close();
  }
});

test("click dispatch keeps the lock and success permanently confirms the grant", () => {
  const store = deterministicStore();
  try {
    const armed = store.armPlan(store.createPlan(plan({ canonicalEventKey: "confirmed-show" })).id);
    const claimed = service(store).claimDelivery(armed.run.id, input());
    store.ackSubmitCapabilityPrepared(armed.run.id, claimed.grant.deliveryId);
    const dispatched = store.recordSubmitAttemptOutcome(
      armed.run.id,
      claimed.grant.deliveryId,
      "CLICK_DISPATCHED"
    );
    assert.equal(dispatched.status, "CLICK_DISPATCHED");
    assert.equal(store.requireRun(armed.run.id).state, "HUMAN_TAKEOVER");
    assert.equal(store.getPurchaseLockForRun(armed.run.id)?.status, "HELD");

    const confirmed = store.confirmSuccess(armed.run.id, {
      confirmation: "ORDER_EXISTS",
      orderReference: "synthetic-order-1"
    });
    assert.equal(confirmed.state, "SUCCESS");
    assert.equal(store.getPurchaseLockForRun(armed.run.id)?.status, "PURCHASED");
    assert.equal(store.getSubmitCapabilityGrant(armed.run.id)?.status, "ORDER_CONFIRMED");
  } finally {
    store.close();
  }
});

test("grant and lock survive controller restart and response-loss retry is rejected", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ticket-agent-grant-"));
  const databasePath = path.join(directory, "controller.sqlite");
  let first: ControllerStore | undefined;
  let reopened: ControllerStore | undefined;
  try {
    first = deterministicStore(databasePath);
    const armed = first.armPlan(first.createPlan(plan({ canonicalEventKey: "restart-show" })).id);
    const claimed = service(first).claimDelivery(armed.run.id, input());
    first.close();
    first = undefined;

    reopened = deterministicStore(databasePath);
    assert.equal(reopened.getSubmitCapabilityGrant(armed.run.id)?.deliveryId, claimed.grant.deliveryId);
    assert.equal(reopened.getPurchaseLockForRun(armed.run.id)?.status, "HELD");
    assert.throws(
      () => service(reopened!, "delivery-after-restart", Buffer.alloc(32, 25).toString("base64url"))
        .claimDelivery(armed.run.id, input()),
      controllerCode("SUBMIT_CAPABILITY_ALREADY_DELIVERED")
    );
  } finally {
    first?.close();
    reopened?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fast-path delivery rejects a missing session order or a non-priority strategy before signing", () => {
  for (const overrides of [
    { sessions: [] },
    { priceStrategy: "CHEAPEST_FIRST" as const }
  ]) {
    const store = deterministicStore();
    try {
      const armed = store.armPlan(store.createPlan(plan(overrides)).id);
      assert.throws(
        () => service(store).claimDelivery(armed.run.id, input()),
        controllerCode("SUBMIT_CAPABILITY_PLAN_INVALID")
      );
      assert.equal(store.getSubmitCapabilityGrant(armed.run.id), undefined);
      assert.equal(store.getPurchaseLockForRun(armed.run.id), undefined);
      assert.equal(store.requireRun(armed.run.id).state, "SCHEDULED");
    } finally {
      store.close();
    }
  }
});
