import { createHash } from "node:crypto";

import type {
  ClaimSubmitCapabilityInput,
  ClaimSubmitCapabilityResult
} from "../controller/submit-capability-service.js";
import type {
  SubmitAttemptOutcome,
  SubmitCapabilityGrant,
  SubmitCapabilityGrantStatus
} from "../controller/store.js";
import type { PurchaseRun, RunnerEvent, WatchPlan } from "../core/types.js";
import { validatePlan } from "../core/policy.js";
import { assertAttendeePersistenceBoundary } from "../identity/attendee-ref.js";
import {
  SUBMIT_CAPABILITY_MAX_LIFETIME_MS,
  SUBMIT_CAPABILITY_VERSION,
  type SignedSubmitCapability
} from "../security/submit-capability.js";

interface ErrorPayload {
  error?: { code?: string; message?: string; details?: unknown };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const RUN_STATES = new Set([
  "SCHEDULED", "PREWARM", "LOGIN_READY", "WAIT_FOR_SALE", "OFFICIAL_QUEUE", "SELECT_SESSION",
  "SELECT_TIER", "SELECT_QUANTITY", "SELECT_ATTENDEE", "VERIFY_PRICE", "REVIEW_REQUIRED", "SUBMIT_ORDER",
  "PAY_REQUIRED", "SUCCESS", "CAPTCHA_REQUIRED", "LOGIN_EXPIRED", "PRICE_LIMIT_EXCEEDED", "PAGE_CHANGED",
  "SOLD_OUT", "DUPLICATE_BLOCKED", "HUMAN_TAKEOVER", "FAILED"
]);
const PLAN_STATUSES = new Set(["DRAFT", "ARMED", "RUNNING", "PAUSED", "COMPLETED", "CANCELLED"]);
const SUBMIT_CAPABILITY_GRANT_STATUSES = new Set<SubmitCapabilityGrantStatus>([
  "DELIVERY_CLAIMED",
  "RUNNER_PREPARED",
  "CLICK_DISPATCHED",
  "OUTCOME_UNKNOWN",
  "CONSUME_REJECTED",
  "ZERO_CLICK_BLOCKED",
  "ORDER_CONFIRMED",
  "RECONCILED_NO_ORDER"
]);
const SUBMIT_ATTEMPT_OUTCOMES = new Set<SubmitAttemptOutcome>([
  "CLICK_DISPATCHED",
  "OUTCOME_UNKNOWN",
  "CONSUME_REJECTED",
  "ZERO_CLICK_BLOCKED"
]);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CAPABILITY_BODY_PATTERN = /^[A-Za-z0-9_-]+$/u;
const CAPABILITY_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_CAPABILITY_BODY_CHARS = 64 * 1024;
const RUN_REQUIRED_KEYS = ["createdAt", "id", "planId", "state", "updatedAt"] as const;
const RUN_OPTIONAL_KEYS = [
  "lastError",
  "observedTotalFen",
  "orderReference",
  "priceVerifiedAt",
  "selectedSession",
  "selectedTier"
] as const;
const GRANT_REQUIRED_KEYS = [
  "capabilityNonceSha256",
  "capabilityVersion",
  "claimsBodySha256",
  "deliveryClaimedAt",
  "deliveryId",
  "earliestSubmitAtMs",
  "eventKey",
  "expiresAtMs",
  "issuedAtMs",
  "planId",
  "runId",
  "runnerSessionSha256",
  "status",
  "updatedAt"
] as const;
const GRANT_OPTIONAL_KEYS = ["attemptOutcome", "attemptedAt", "runnerPreparedAt"] as const;

function invalidApproval(message: string): ControllerClientError {
  return new ControllerClientError(502, "CONTROLLER_RESPONSE_INVALID", message);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const actual = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && actual.every((key) => allowed.has(key));
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isBoundedText(value: unknown, maxLength = 1_000): value is string {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maxLength &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function validateSignedSubmitCapability(value: unknown): SignedSubmitCapability {
  if (!isRecord(value) || !hasExactKeys(value, ["body", "signature"])) {
    throw invalidApproval("Controller capability delivery must contain only body and signature");
  }
  const body = value.body;
  const signature = value.signature;
  if (
    typeof body !== "string" ||
    body.length < 1 ||
    body.length > MAX_CAPABILITY_BODY_CHARS ||
    !CAPABILITY_BODY_PATTERN.test(body) ||
    Buffer.from(body, "base64url").toString("base64url") !== body ||
    typeof signature !== "string" ||
    !CAPABILITY_SIGNATURE_PATTERN.test(signature) ||
    Buffer.from(signature, "base64url").byteLength !== 32 ||
    Buffer.from(signature, "base64url").toString("base64url") !== signature
  ) {
    throw invalidApproval("Controller capability delivery envelope is malformed");
  }
  return { body, signature };
}

function capabilityBodyDigest(body: string): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update("ticket-agent/capability-body/v1\u0000", "utf8")
    .update(body, "utf8")
    .digest("hex")}`;
}

function validateRunResponse(
  value: unknown,
  expectedRunId: string,
  expectedState?: string
): PurchaseRun {
  if (!isRecord(value) || !hasExactKeys(value, RUN_REQUIRED_KEYS, RUN_OPTIONAL_KEYS)) {
    throw invalidApproval("Controller run response has invalid fields");
  }
  if (
    value.id !== expectedRunId ||
    !isBoundedText(value.planId, 200) ||
    typeof value.state !== "string" ||
    !RUN_STATES.has(value.state) ||
    (expectedState !== undefined && value.state !== expectedState) ||
    !isCanonicalTimestamp(value.createdAt) ||
    !isCanonicalTimestamp(value.updatedAt) ||
    Date.parse(value.updatedAt) < Date.parse(value.createdAt) ||
    (value.observedTotalFen !== undefined && !isSafeNonNegativeInteger(value.observedTotalFen)) ||
    (value.priceVerifiedAt !== undefined && !isCanonicalTimestamp(value.priceVerifiedAt))
  ) {
    throw invalidApproval("Controller run response is malformed or does not match the requested run");
  }
  for (const field of ["lastError", "orderReference", "selectedSession", "selectedTier"] as const) {
    if (value[field] !== undefined && !isBoundedText(value[field])) {
      throw invalidApproval(`Controller run field ${field} is invalid`);
    }
  }
  const selectedSession = value.selectedSession;
  const selectedTier = value.selectedTier;
  const orderReference = value.orderReference;
  const lastError = value.lastError;
  return {
    id: expectedRunId,
    planId: value.planId,
    state: value.state as PurchaseRun["state"],
    ...(value.observedTotalFen === undefined ? {} : { observedTotalFen: value.observedTotalFen }),
    ...(value.priceVerifiedAt === undefined ? {} : { priceVerifiedAt: value.priceVerifiedAt }),
    ...(typeof selectedSession === "string" ? { selectedSession } : {}),
    ...(typeof selectedTier === "string" ? { selectedTier } : {}),
    ...(typeof orderReference === "string" ? { orderReference } : {}),
    ...(typeof lastError === "string" ? { lastError } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

interface GrantExpectation {
  readonly runId: string;
  readonly deliveryId?: string;
  readonly runnerSessionDigest?: string;
  readonly allowedStatuses?: ReadonlySet<SubmitCapabilityGrantStatus>;
  readonly attemptOutcome?: SubmitAttemptOutcome;
}

function validateGrantResponse(value: unknown, expectation: GrantExpectation): SubmitCapabilityGrant {
  if (!isRecord(value) || !hasExactKeys(value, GRANT_REQUIRED_KEYS, GRANT_OPTIONAL_KEYS)) {
    throw invalidApproval("Controller capability grant response has invalid fields");
  }
  if (
    value.runId !== expectation.runId ||
    !isBoundedText(value.planId, 200) ||
    !isBoundedText(value.eventKey) ||
    !isBoundedText(value.deliveryId, 200) ||
    (expectation.deliveryId !== undefined && value.deliveryId !== expectation.deliveryId) ||
    value.capabilityVersion !== SUBMIT_CAPABILITY_VERSION ||
    typeof value.capabilityNonceSha256 !== "string" ||
    !SHA256_PATTERN.test(value.capabilityNonceSha256) ||
    typeof value.runnerSessionSha256 !== "string" ||
    !SHA256_PATTERN.test(value.runnerSessionSha256) ||
    (expectation.runnerSessionDigest !== undefined && value.runnerSessionSha256 !== expectation.runnerSessionDigest) ||
    typeof value.claimsBodySha256 !== "string" ||
    !SHA256_PATTERN.test(value.claimsBodySha256) ||
    !isSafeNonNegativeInteger(value.issuedAtMs) ||
    !isSafeNonNegativeInteger(value.earliestSubmitAtMs) ||
    !isSafeNonNegativeInteger(value.expiresAtMs) ||
    value.earliestSubmitAtMs < value.issuedAtMs ||
    value.expiresAtMs <= value.earliestSubmitAtMs ||
    value.expiresAtMs - value.issuedAtMs > SUBMIT_CAPABILITY_MAX_LIFETIME_MS ||
    typeof value.status !== "string" ||
    !SUBMIT_CAPABILITY_GRANT_STATUSES.has(value.status as SubmitCapabilityGrantStatus) ||
    (expectation.allowedStatuses !== undefined &&
      !expectation.allowedStatuses.has(value.status as SubmitCapabilityGrantStatus)) ||
    !isCanonicalTimestamp(value.deliveryClaimedAt) ||
    !isCanonicalTimestamp(value.updatedAt) ||
    Date.parse(value.updatedAt) < Date.parse(value.deliveryClaimedAt)
  ) {
    throw invalidApproval("Controller capability grant is malformed or does not match the request");
  }

  const status = value.status as SubmitCapabilityGrantStatus;
  const attemptOutcome = value.attemptOutcome;
  const runnerPreparedAt = value.runnerPreparedAt;
  const attemptedAt = value.attemptedAt;
  const unpreparedZeroClickHistory =
    (status === "ZERO_CLICK_BLOCKED" || status === "RECONCILED_NO_ORDER") &&
    runnerPreparedAt === undefined &&
    attemptOutcome === "ZERO_CLICK_BLOCKED" &&
    attemptedAt !== undefined;
  if (
    (attemptOutcome !== undefined &&
      (typeof attemptOutcome !== "string" || !SUBMIT_ATTEMPT_OUTCOMES.has(attemptOutcome as SubmitAttemptOutcome))) ||
    (runnerPreparedAt !== undefined && !isCanonicalTimestamp(runnerPreparedAt)) ||
    (attemptedAt !== undefined && !isCanonicalTimestamp(attemptedAt)) ||
    (runnerPreparedAt === undefined &&
      (attemptOutcome !== undefined || attemptedAt !== undefined) &&
      !unpreparedZeroClickHistory) ||
    ((attemptOutcome === undefined) !== (attemptedAt === undefined)) ||
    (runnerPreparedAt !== undefined && Date.parse(runnerPreparedAt) < Date.parse(value.deliveryClaimedAt)) ||
    (attemptedAt !== undefined && Date.parse(attemptedAt) < Date.parse(value.deliveryClaimedAt)) ||
    (attemptedAt !== undefined && runnerPreparedAt !== undefined && Date.parse(attemptedAt) < Date.parse(runnerPreparedAt)) ||
    (runnerPreparedAt !== undefined && Date.parse(value.updatedAt) < Date.parse(runnerPreparedAt)) ||
    (attemptedAt !== undefined && Date.parse(value.updatedAt) < Date.parse(attemptedAt))
  ) {
    throw invalidApproval("Controller capability grant lifecycle timestamps are invalid");
  }

  const isAttemptStatus = SUBMIT_ATTEMPT_OUTCOMES.has(status as SubmitAttemptOutcome);
  if (
    (status === "DELIVERY_CLAIMED" &&
      (runnerPreparedAt !== undefined || attemptOutcome !== undefined || attemptedAt !== undefined)) ||
    (status === "RUNNER_PREPARED" &&
      (runnerPreparedAt === undefined || attemptOutcome !== undefined || attemptedAt !== undefined)) ||
    (isAttemptStatus &&
      (attemptOutcome !== status || attemptedAt === undefined ||
        (runnerPreparedAt === undefined && !unpreparedZeroClickHistory))) ||
    (status === "ORDER_CONFIRMED" &&
      (runnerPreparedAt === undefined || attemptedAt === undefined ||
        (attemptOutcome !== "CLICK_DISPATCHED" && attemptOutcome !== "OUTCOME_UNKNOWN"))) ||
    (expectation.attemptOutcome !== undefined && attemptOutcome !== expectation.attemptOutcome)
  ) {
    throw invalidApproval("Controller capability grant status evidence is inconsistent");
  }

  return {
    runId: expectation.runId,
    planId: value.planId,
    eventKey: value.eventKey,
    deliveryId: value.deliveryId,
    capabilityVersion: SUBMIT_CAPABILITY_VERSION,
    capabilityNonceSha256: value.capabilityNonceSha256 as `sha256:${string}`,
    runnerSessionSha256: value.runnerSessionSha256 as `sha256:${string}`,
    claimsBodySha256: value.claimsBodySha256 as `sha256:${string}`,
    issuedAtMs: value.issuedAtMs,
    earliestSubmitAtMs: value.earliestSubmitAtMs,
    expiresAtMs: value.expiresAtMs,
    status,
    ...(attemptOutcome === undefined ? {} : { attemptOutcome: attemptOutcome as SubmitAttemptOutcome }),
    deliveryClaimedAt: value.deliveryClaimedAt,
    ...(runnerPreparedAt === undefined ? {} : { runnerPreparedAt }),
    ...(attemptedAt === undefined ? {} : { attemptedAt }),
    updatedAt: value.updatedAt
  };
}

export class ControllerClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ControllerClientError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function controllerBase(value: string): URL {
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !isLoopback(url.hostname)) {
    throw new Error("CONTROLLER_URL_BLOCKED:controller must use a loopback HTTP(S) URL on the Mac");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("CONTROLLER_URL_BLOCKED:credentials, query and fragment are not allowed");
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    throw new Error("CONTROLLER_URL_BLOCKED:controller URL must not contain a path");
  }
  url.pathname = url.pathname.replace(/\/?$/, "/");
  return url;
}

export class ControllerClient {
  private readonly baseUrl: URL;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    if (Buffer.byteLength(token, "utf8") < 32) throw new Error("CONTROLLER_TOKEN_TOO_SHORT:minimum=32");
    this.baseUrl = controllerBase(baseUrl);
    this.token = token;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const url = new URL(path.replace(/^\//, ""), this.baseUrl);
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000)
    });
    const payload: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errorPayload = isRecord(payload) && isRecord(payload.error)
        ? payload.error as ErrorPayload["error"]
        : undefined;
      throw new ControllerClientError(
        response.status,
        typeof errorPayload?.code === "string" ? errorPayload.code : "CONTROLLER_REQUEST_FAILED",
        typeof errorPayload?.message === "string"
          ? errorPayload.message
          : `Controller returned HTTP ${response.status}`,
        errorPayload?.details
      );
    }
    return payload as T;
  }

  async loadRunPlan(runId: string): Promise<{ run: PurchaseRun; plan: WatchPlan }> {
    const runPayload = await this.request<unknown>("GET", `/runs/${encodeURIComponent(runId)}`);
    if (!isRecord(runPayload) || !isRecord(runPayload.run)) {
      throw invalidApproval("Controller run response must contain a run object");
    }
    const run = runPayload.run;
    if (
      run.id !== runId ||
      typeof run.planId !== "string" ||
      run.planId.trim() === "" ||
      typeof run.state !== "string" ||
      !RUN_STATES.has(run.state) ||
      typeof run.createdAt !== "string" ||
      Number.isNaN(Date.parse(run.createdAt)) ||
      typeof run.updatedAt !== "string" ||
      Number.isNaN(Date.parse(run.updatedAt))
    ) {
      throw invalidApproval("Controller run response is malformed or does not match the requested run");
    }

    const planPayload = await this.request<unknown>("GET", `/plans/${encodeURIComponent(run.planId)}`);
    if (!isRecord(planPayload) || !isRecord(planPayload.plan)) {
      throw invalidApproval("Controller plan response must contain a plan object");
    }
    const plan = planPayload.plan;
    try {
      assertAttendeePersistenceBoundary(plan);
    } catch {
      throw invalidApproval("Controller plan contains forbidden attendee identity material");
    }
    if (
      plan.id !== run.planId ||
      typeof plan.status !== "string" ||
      !PLAN_STATUSES.has(plan.status) ||
      typeof plan.createdAt !== "string" ||
      Number.isNaN(Date.parse(plan.createdAt)) ||
      typeof plan.updatedAt !== "string" ||
      Number.isNaN(Date.parse(plan.updatedAt)) ||
      !validatePlan(plan as unknown as WatchPlan).ok
    ) {
      throw invalidApproval("Controller plan response is invalid or does not match the run planId");
    }
    return { run: run as unknown as PurchaseRun, plan: plan as unknown as WatchPlan };
  }

  async recordEvent(event: RunnerEvent): Promise<void> {
    // These states have dedicated step-up endpoints and must never be accepted
    // through the generic event channel.
    if (event.state === "SUBMIT_ORDER" || event.state === "SUCCESS") return;
    await this.request<{ run: PurchaseRun }>("POST", `/runs/${encodeURIComponent(event.runId)}/events`, event);
  }

  async claimSubmitCapability(
    runId: string,
    input: ClaimSubmitCapabilityInput
  ): Promise<ClaimSubmitCapabilityResult> {
    const requestInput: ClaimSubmitCapabilityInput = {
      runnerSessionDigest: input.runnerSessionDigest,
      attendeeSelectionFingerprint: input.attendeeSelectionFingerprint,
      fastPathContractDigest: input.fastPathContractDigest,
      finalOfficialOrigin: input.finalOfficialOrigin
    };
    const payload = await this.request<unknown>(
      "POST",
      `/runs/${encodeURIComponent(runId)}/submit-capability/deliver`,
      requestInput
    );
    if (!isRecord(payload) || !hasExactKeys(payload, ["delivery", "grant", "run"])) {
      throw invalidApproval("Controller capability claim response must contain only delivery, grant, and run");
    }
    const delivery = validateSignedSubmitCapability(payload.delivery);
    const grant = validateGrantResponse(payload.grant, {
      runId,
      runnerSessionDigest: requestInput.runnerSessionDigest,
      allowedStatuses: new Set<SubmitCapabilityGrantStatus>(["DELIVERY_CLAIMED"])
    });
    if (grant.claimsBodySha256 !== capabilityBodyDigest(delivery.body)) {
      throw invalidApproval("Controller capability body digest does not match the delivered envelope");
    }
    const run = validateRunResponse(payload.run, runId, "PREWARM");
    if (run.planId !== grant.planId) {
      throw invalidApproval("Controller capability grant planId does not match the delivered run");
    }
    return { delivery, grant, run };
  }

  async ackCapabilityPrepared(runId: string, deliveryId: string): Promise<SubmitCapabilityGrant> {
    const payload = await this.request<unknown>(
      "POST",
      `/runs/${encodeURIComponent(runId)}/submit-capability/prepared-ack`,
      { deliveryId }
    );
    if (!isRecord(payload) || !hasExactKeys(payload, ["grant"])) {
      throw invalidApproval("Controller prepared acknowledgement must contain only grant");
    }
    return validateGrantResponse(payload.grant, {
      runId,
      deliveryId,
      allowedStatuses: new Set<SubmitCapabilityGrantStatus>(["RUNNER_PREPARED"])
    });
  }

  async reportSubmitAttempt(
    runId: string,
    deliveryId: string,
    outcome: SubmitAttemptOutcome
  ): Promise<SubmitCapabilityGrant> {
    if (!SUBMIT_ATTEMPT_OUTCOMES.has(outcome)) {
      throw new Error("SUBMIT_CAPABILITY_ATTEMPT_INVALID:unsupported outcome");
    }
    const payload = await this.request<unknown>(
      "POST",
      `/runs/${encodeURIComponent(runId)}/submit-attempt`,
      { deliveryId, outcome }
    );
    if (!isRecord(payload) || !hasExactKeys(payload, ["grant"])) {
      throw invalidApproval("Controller submit-attempt response must contain only grant");
    }
    return validateGrantResponse(payload.grant, {
      runId,
      deliveryId,
      allowedStatuses: new Set<SubmitCapabilityGrantStatus>([outcome]),
      attemptOutcome: outcome
    });
  }

  async getSubmitCapabilityGrant(runId: string): Promise<SubmitCapabilityGrant> {
    const payload = await this.request<unknown>(
      "GET",
      `/runs/${encodeURIComponent(runId)}/submit-capability`
    );
    if (!isRecord(payload) || !hasExactKeys(payload, ["grant"])) {
      throw invalidApproval("Controller capability status response must contain only grant");
    }
    return validateGrantResponse(payload.grant, { runId });
  }

  async approveSubmit(runId: string, observedTotalFen: number): Promise<PurchaseRun> {
    const payload = await this.request<unknown>(
      "POST",
      `/runs/${encodeURIComponent(runId)}/approve-submit`,
      { confirmation: "APPROVE_SUBMIT", observedTotalFen }
    );
    if (!isRecord(payload)) {
      throw invalidApproval("Controller approval response must be a JSON object");
    }
    if (payload.allowed === false) {
      const message = typeof payload.message === "string"
        ? payload.message
        : "Controller denied submit authorization";
      throw new ControllerClientError(
        409,
        /(?:DUPLICATE|PURCHASE_LOCK)/.test(message) ? "DUPLICATE_PURCHASE_LOCKED" : "SUBMIT_AUTHORIZATION_DENIED",
        message
      );
    }
    if (payload.allowed !== true) {
      throw invalidApproval("Controller approval response must contain allowed=true");
    }
    if (!isRecord(payload.run)) {
      throw invalidApproval("Controller approval response must contain a run object");
    }

    const run = payload.run;
    if (run.id !== runId) {
      throw invalidApproval("Controller approval run ID does not match the requested run");
    }
    if (typeof run.planId !== "string" || run.planId.trim() === "") {
      throw invalidApproval("Controller approval run must contain a non-empty planId");
    }
    if (run.state !== "SUBMIT_ORDER") {
      throw invalidApproval("Controller approval run must be in SUBMIT_ORDER");
    }
    if (run.observedTotalFen !== observedTotalFen) {
      throw invalidApproval("Controller approval total does not match the requested verified total");
    }
    if (
      typeof run.priceVerifiedAt !== "string" ||
      run.priceVerifiedAt.trim() === "" ||
      Number.isNaN(Date.parse(run.priceVerifiedAt))
    ) {
      throw invalidApproval("Controller approval run must contain priceVerifiedAt");
    }
    if (typeof run.createdAt !== "string" || run.createdAt.trim() === "" || Number.isNaN(Date.parse(run.createdAt))) {
      throw invalidApproval("Controller approval run must contain createdAt");
    }
    if (typeof run.updatedAt !== "string" || run.updatedAt.trim() === "" || Number.isNaN(Date.parse(run.updatedAt))) {
      throw invalidApproval("Controller approval run must contain updatedAt");
    }
    for (const field of ["selectedSession", "selectedTier", "orderReference", "lastError"] as const) {
      if (run[field] !== undefined && typeof run[field] !== "string") {
        throw invalidApproval(`Controller approval run field ${field} must be a string when present`);
      }
    }
    return run as unknown as PurchaseRun;
  }
}

export function submitDenial(error: unknown): {
  allowed: false;
  state: "DUPLICATE_BLOCKED" | "HUMAN_TAKEOVER";
  message: string;
} {
  if (error instanceof ControllerClientError && /(?:DUPLICATE|PURCHASE_LOCK)/.test(error.code)) {
    return { allowed: false, state: "DUPLICATE_BLOCKED", message: `${error.code}:${error.message}` };
  }
  const message = error instanceof Error ? error.message : "Controller approval failed";
  return { allowed: false, state: "HUMAN_TAKEOVER", message: `CONTROLLER_APPROVAL_FAILED:${message}` };
}
