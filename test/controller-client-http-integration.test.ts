import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { WatchPlanInput } from "../src/core/types.js";
import {
  closeController,
  createControllerHttpServer,
  listenController
} from "../src/controller/http.js";
import {
  SubmitCapabilityService,
  type ClaimSubmitCapabilityInput
} from "../src/controller/submit-capability-service.js";
import { ControllerStore } from "../src/controller/store.js";
import {
  ControllerClient,
  ControllerClientError
} from "../src/runner/controller-client.js";
import {
  buildAttendeeSelectionFingerprint,
  digestRunnerSessionSecret
} from "../src/security/submit-capability.js";

const CONTROLLER_TOKEN = "controller-http-integration-token-at-least-32-bytes";
const CAPABILITY_KEY = "controller-http-integration-capability-key-at-least-32-bytes";
const SALE_AT = "2026-08-01T10:00:00+08:00";
const SALE_AT_MS = Date.parse(SALE_AT);
const ISSUED_AT_MS = SALE_AT_MS - 5 * 60 * 1_000;
const DELIVERY_ID = "loopback-http-delivery-1";
const ATTENDEE_REF = "attendee:v1:550e8400-e29b-41d4-a716-446655440000" as const;
const ATTENDEE_LABEL = "合成HTTP观演人-SENSITIVE";
const RUNNER_SESSION_SECRET = new Uint8Array(Buffer.alloc(32, 31));
const CAPABILITY_NONCE_BYTES = Buffer.alloc(32, 29);
const CAPABILITY_NONCE = CAPABILITY_NONCE_BYTES.toString("base64url");

interface RunningController {
  readonly client: ControllerClient;
  readonly server: Server;
  readonly store: ControllerStore;
}

function plan(): WatchPlanInput {
  return {
    platform: "damai",
    officialUrl: "https://detail.damai.cn/item.htm?id=123",
    eventId: "123",
    eventTitle: "Loopback HTTP lifecycle test",
    canonicalEventKey: "loopback-http-lifecycle-test",
    saleAt: SALE_AT,
    quantity: 1,
    sessions: [{ label: "首场", priority: 10 }],
    tiers: [{ label: "看台", priority: 10, maxUnitPriceFen: 58_000 }],
    priceStrategy: "PREFERRED_ORDER",
    maxTotalFen: 60_000,
    attendeeRefs: [ATTENDEE_REF],
    autoSubmitOrder: true
  };
}

function claimInput(): ClaimSubmitCapabilityInput {
  return {
    runnerSessionDigest: digestRunnerSessionSecret(RUNNER_SESSION_SECRET),
    attendeeSelectionFingerprint: buildAttendeeSelectionFingerprint(RUNNER_SESSION_SECRET, [
      JSON.stringify([ATTENDEE_REF, ATTENDEE_LABEL])
    ]),
    fastPathContractDigest: `sha256:${"c".repeat(64)}`,
    finalOfficialOrigin: "https://buy.damai.cn"
  };
}

test("ControllerClient completes the durable submit-capability lifecycle over loopback HTTP", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ticket-agent-http-lifecycle-"));
  const databasePath = path.join(directory, "controller.sqlite");
  let nextId = 0;
  let tick = 0;
  let running: RunningController | undefined;

  const open = async (): Promise<RunningController> => {
    const store = new ControllerStore(databasePath, {
      idFactory: () => `http-integration-${++nextId}`,
      now: () => new Date(ISSUED_AT_MS + tick++).toISOString()
    });
    const submitCapabilityService = new SubmitCapabilityService(store, CAPABILITY_KEY, {
      nowMs: () => ISSUED_AT_MS,
      deliveryIdFactory: () => DELIVERY_ID,
      nonceFactory: () => CAPABILITY_NONCE
    });
    const server = createControllerHttpServer({
      store,
      token: CONTROLLER_TOKEN,
      submitCapabilityService
    });
    try {
      const address = await listenController(server);
      return {
        store,
        server,
        client: new ControllerClient(`http://${address.host}:${address.port}`, CONTROLLER_TOKEN)
      };
    } catch (error) {
      await closeController(server);
      store.close();
      throw error;
    }
  };

  const close = async (): Promise<void> => {
    if (running === undefined) return;
    const current = running;
    running = undefined;
    try {
      await closeController(current.server);
    } finally {
      current.store.close();
    }
  };

  try {
    running = await open();
    const armed = running.store.armPlan(running.store.createPlan(plan()).id);
    const runId = armed.run.id;

    const claimed = await running.client.claimSubmitCapability(runId, claimInput());
    assert.equal(claimed.run.state, "PREWARM");
    assert.equal(claimed.grant.deliveryId, DELIVERY_ID);
    assert.equal(claimed.grant.status, "DELIVERY_CLAIMED");
    assert.ok(claimed.delivery.body.length > 0);
    assert.ok(claimed.delivery.signature.length > 0);
    assert.equal(running.store.getPurchaseLockForRun(runId)?.status, "HELD");
    const decodedClaims = Buffer.from(claimed.delivery.body, "base64url").toString("utf8");
    const scanDatabaseArtifacts = (phase: string): void => {
      for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
        if (!existsSync(candidate)) continue;
        const bytes = readFileSync(candidate);
        for (const forbidden of [
          Buffer.from(CONTROLLER_TOKEN, "utf8"),
          Buffer.from(CAPABILITY_KEY, "utf8"),
          Buffer.from(claimed.delivery.body, "utf8"),
          Buffer.from(claimed.delivery.signature, "utf8"),
          Buffer.from(decodedClaims, "utf8"),
          CAPABILITY_NONCE_BYTES,
          Buffer.from(RUNNER_SESSION_SECRET),
          Buffer.from(ATTENDEE_LABEL, "utf8")
        ]) {
          assert.equal(
            bytes.includes(forbidden),
            false,
            `${phase}:${path.basename(candidate)} leaked secret material`
          );
        }
      }
    };
    scanDatabaseArtifacts("claim-open");

    await close();
    running = await open();

    const persistedClaim = await running.client.getSubmitCapabilityGrant(runId);
    assert.equal(persistedClaim.status, "DELIVERY_CLAIMED");
    assert.equal(persistedClaim.deliveryId, DELIVERY_ID);
    await assert.rejects(
      () => running!.client.claimSubmitCapability(runId, claimInput()),
      (error: unknown) =>
        error instanceof ControllerClientError &&
        error.status === 409 &&
        error.code === "SUBMIT_CAPABILITY_ALREADY_DELIVERED"
    );

    const prepared = await running.client.ackCapabilityPrepared(runId, DELIVERY_ID);
    assert.equal(prepared.status, "RUNNER_PREPARED");
    assert.ok(prepared.runnerPreparedAt);
    scanDatabaseArtifacts("prepared-open");

    await close();
    running = await open();

    const persistedPrepared = await running.client.getSubmitCapabilityGrant(runId);
    assert.equal(persistedPrepared.status, "RUNNER_PREPARED");

    // The public contract is a run-level action. Keep the formerly divergent
    // nested spelling closed so server and client cannot silently drift apart.
    const nestedAttempt = await fetch(
      `http://127.0.0.1:${(running.server.address() as { port: number }).port}` +
        `/runs/${encodeURIComponent(runId)}/submit-capability/attempt`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${CONTROLLER_TOKEN}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ deliveryId: DELIVERY_ID, outcome: "ZERO_CLICK_BLOCKED" })
      }
    );
    assert.equal(nestedAttempt.status, 404);

    const attempted = await running.client.reportSubmitAttempt(
      runId,
      DELIVERY_ID,
      "ZERO_CLICK_BLOCKED"
    );
    assert.equal(attempted.status, "ZERO_CLICK_BLOCKED");
    assert.equal(attempted.attemptOutcome, "ZERO_CLICK_BLOCKED");
    assert.ok(attempted.attemptedAt);
    assert.equal((await running.client.getSubmitCapabilityGrant(runId)).status, "ZERO_CLICK_BLOCKED");
    scanDatabaseArtifacts("attempt-open");

    await close();
    running = await open();

    const persistedAttempt = await running.client.getSubmitCapabilityGrant(runId);
    assert.equal(persistedAttempt.status, "ZERO_CLICK_BLOCKED");
    assert.equal(persistedAttempt.deliveryId, DELIVERY_ID);
    assert.equal(running.store.requireRun(runId).state, "FAILED");
    assert.equal(running.store.getPurchaseLockForRun(runId)?.status, "HELD");
    assert.equal(
      (await running.client.reportSubmitAttempt(runId, DELIVERY_ID, "ZERO_CLICK_BLOCKED")).status,
      "ZERO_CLICK_BLOCKED"
    );
    await assert.rejects(
      () => running!.client.reportSubmitAttempt(runId, DELIVERY_ID, "CLICK_DISPATCHED"),
      (error: unknown) =>
        error instanceof ControllerClientError &&
        error.status === 409 &&
        error.code === "SUBMIT_CAPABILITY_ATTEMPT_ALREADY_RECORDED"
    );

    scanDatabaseArtifacts("restart-open");
    await close();
    scanDatabaseArtifacts("closed");
  } finally {
    await close();
    rmSync(directory, { recursive: true, force: true });
  }
});
