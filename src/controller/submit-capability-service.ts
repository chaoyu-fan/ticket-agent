import { createHash, randomUUID } from "node:crypto";

import { buildAttendeeRefAudit } from "../identity/attendee-ref.js";
import {
  SUBMIT_CAPABILITY_VERSION,
  createSubmitCapabilityNonce,
  issueSubmitCapability,
  type SignedSubmitCapability,
  type SubmitCapabilitySecret
} from "../security/submit-capability.js";
import { ControllerError } from "./errors.js";
import {
  ControllerStore,
  type SubmitCapabilityGrant,
  type SubmitCapabilityGrantClaimResult
} from "./store.js";
import type { PurchaseRun } from "../core/types.js";

const DEFAULT_POST_SALE_CAPABILITY_MS = 20 * 60 * 1_000;
const MAX_PRE_SALE_DELIVERY_MS = 10 * 60 * 1_000;

export interface ClaimSubmitCapabilityInput {
  readonly runnerSessionDigest: `sha256:${string}`;
  readonly attendeeSelectionFingerprint: `hmac-sha256:${string}`;
  readonly fastPathContractDigest: `sha256:${string}`;
  readonly finalOfficialOrigin: string;
}

export interface ClaimSubmitCapabilityResult {
  readonly delivery: SignedSubmitCapability;
  readonly grant: SubmitCapabilityGrant;
  readonly run: PurchaseRun;
}

export interface SubmitCapabilityServiceOptions {
  readonly nowMs?: () => number;
  readonly deliveryIdFactory?: () => string;
  readonly nonceFactory?: () => string;
  readonly postSaleLifetimeMs?: number;
}

function sha256(domain: string, value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(domain, "utf8")
    .update(value)
    .digest("hex")}`;
}

function assertClaimInput(input: ClaimSubmitCapabilityInput): ClaimSubmitCapabilityInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ControllerError("SUBMIT_CAPABILITY_DELIVERY_INVALID", "Delivery input must be an object", 422);
  }
  const expected = [
    "attendeeSelectionFingerprint",
    "fastPathContractDigest",
    "finalOfficialOrigin",
    "runnerSessionDigest"
  ].sort().join(",");
  if (Object.keys(input).sort().join(",") !== expected) {
    throw new ControllerError("SUBMIT_CAPABILITY_DELIVERY_INVALID", "Delivery input fields are invalid", 422);
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(input.runnerSessionDigest)) {
    throw new ControllerError("SUBMIT_CAPABILITY_DELIVERY_INVALID", "runnerSessionDigest is invalid", 422);
  }
  if (!/^hmac-sha256:[0-9a-f]{64}$/u.test(input.attendeeSelectionFingerprint)) {
    throw new ControllerError(
      "SUBMIT_CAPABILITY_DELIVERY_INVALID",
      "attendeeSelectionFingerprint is invalid",
      422
    );
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(input.fastPathContractDigest)) {
    throw new ControllerError("SUBMIT_CAPABILITY_DELIVERY_INVALID", "fastPathContractDigest is invalid", 422);
  }
  if (
    typeof input.finalOfficialOrigin !== "string" ||
    input.finalOfficialOrigin.length < 1 ||
    input.finalOfficialOrigin.length > 300 ||
    input.finalOfficialOrigin.trim() !== input.finalOfficialOrigin
  ) {
    throw new ControllerError("SUBMIT_CAPABILITY_DELIVERY_INVALID", "finalOfficialOrigin is invalid", 422);
  }
  return Object.freeze({ ...input });
}

/**
 * Cold-path issuer. It creates an envelope in memory, then asks the store to
 * atomically burn delivery metadata and acquire the sticky lock. The envelope
 * is returned only after that transaction commits and is never persisted.
 */
export class SubmitCapabilityService {
  private readonly nowMs: () => number;
  private readonly deliveryIdFactory: () => string;
  private readonly nonceFactory: () => string;
  private readonly postSaleLifetimeMs: number;

  constructor(
    private readonly store: ControllerStore,
    private readonly capabilitySecret: SubmitCapabilitySecret,
    options: SubmitCapabilityServiceOptions = {}
  ) {
    this.nowMs = options.nowMs ?? Date.now;
    this.deliveryIdFactory = options.deliveryIdFactory ?? randomUUID;
    this.nonceFactory = options.nonceFactory ?? createSubmitCapabilityNonce;
    this.postSaleLifetimeMs = options.postSaleLifetimeMs ?? DEFAULT_POST_SALE_CAPABILITY_MS;
    if (
      !Number.isSafeInteger(this.postSaleLifetimeMs) ||
      this.postSaleLifetimeMs < 60_000 ||
      this.postSaleLifetimeMs > DEFAULT_POST_SALE_CAPABILITY_MS
    ) {
      throw new ControllerError(
        "SUBMIT_CAPABILITY_SERVICE_INVALID",
        "postSaleLifetimeMs must be between one and twenty minutes",
        500
      );
    }
  }

  claimDelivery(runId: string, rawInput: ClaimSubmitCapabilityInput): ClaimSubmitCapabilityResult {
    if (typeof runId !== "string" || runId.length < 1 || runId.length > 200) {
      throw new ControllerError("SUBMIT_CAPABILITY_DELIVERY_INVALID", "runId is invalid", 422);
    }
    const input = assertClaimInput(rawInput);
    const run = this.store.requireRun(runId);
    const plan = this.store.requirePlan(run.planId);
    if (
      plan.officialUrl === undefined ||
      plan.eventId === undefined ||
      plan.eventTitle === undefined ||
      plan.canonicalEventKey === undefined ||
      plan.saleAt === undefined ||
      plan.maxTotalFen === undefined ||
      plan.attendeeRefs === undefined ||
      plan.priceStrategy !== "PREFERRED_ORDER" ||
      plan.sessions.length < 1 ||
      plan.tiers.length < 1
    ) {
      throw new ControllerError(
        "SUBMIT_CAPABILITY_PLAN_INVALID",
        "Armed fast-path plan is missing a required binding or ordered preference",
        409
      );
    }
    const issuedAtMs = this.nowMs();
    const earliestSubmitAtMs = Date.parse(plan.saleAt);
    if (
      !Number.isSafeInteger(issuedAtMs) ||
      !Number.isSafeInteger(earliestSubmitAtMs) ||
      earliestSubmitAtMs < issuedAtMs ||
      earliestSubmitAtMs - issuedAtMs > MAX_PRE_SALE_DELIVERY_MS
    ) {
      throw new ControllerError(
        "SUBMIT_CAPABILITY_OUTSIDE_PREWARM",
        "Capability delivery is allowed only inside the T-10 prewarm window",
        409
      );
    }
    const expiresAtMs = earliestSubmitAtMs + this.postSaleLifetimeMs;
    const deliveryId = this.deliveryIdFactory();
    const nonce = this.nonceFactory();
    const attendeeAudit = buildAttendeeRefAudit(plan.attendeeRefs);
    const officialOrigin = new URL(plan.officialUrl).origin;
    const delivery = issueSubmitCapability({
      runId,
      planId: plan.id,
      deliveryId,
      runnerSessionDigest: input.runnerSessionDigest,
      platform: plan.platform,
      canonicalEventKey: plan.canonicalEventKey,
      officialOrigin,
      finalOfficialOrigin: input.finalOfficialOrigin,
      fastPathContractDigest: input.fastPathContractDigest,
      eventId: plan.eventId,
      eventTitle: plan.eventTitle,
      quantity: plan.quantity,
      requireAdjacent: plan.requireAdjacent,
      attendeeRefCount: attendeeAudit.count,
      attendeeRefFingerprint: attendeeAudit.fingerprint,
      attendeeSelectionFingerprint: input.attendeeSelectionFingerprint,
      sessionPreferences: plan.sessions,
      tierPreferences: plan.tiers,
      maxTotalFen: plan.maxTotalFen
    }, this.capabilitySecret, {
      issuedAtMs,
      earliestSubmitAtMs,
      expiresAtMs,
      nonce
    });
    const claim: SubmitCapabilityGrantClaimResult = this.store.claimSubmitCapabilityDelivery(runId, {
      deliveryId,
      capabilityVersion: SUBMIT_CAPABILITY_VERSION,
      capabilityNonceSha256: sha256(
        "ticket-agent/capability-nonce/v1\u0000",
        Buffer.from(nonce, "base64url")
      ),
      runnerSessionSha256: input.runnerSessionDigest,
      claimsBodySha256: sha256("ticket-agent/capability-body/v1\u0000", delivery.body),
      issuedAtMs,
      earliestSubmitAtMs,
      expiresAtMs
    });
    return Object.freeze({ delivery, grant: claim.grant, run: claim.run });
  }
}
