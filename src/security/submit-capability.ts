import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";

/**
 * A short-lived, HMAC-authenticated capability used only for the final local
 * submit transition.  It is deliberately a separate primitive from the
 * controller's general-purpose signed envelopes: the claims are narrow,
 * canonical, and contain no identity, cookie, or payment material.
 */

export const SUBMIT_CAPABILITY_VERSION = 1 as const;
export const SUBMIT_CAPABILITY_PURPOSE = "ticket-agent.submit-order" as const;
/** Keep a pre-warmed capability short lived even if a caller supplies a bad TTL. */
export const SUBMIT_CAPABILITY_MAX_LIFETIME_MS = 30 * 60 * 1_000;
export const SUBMIT_CAPABILITY_MIN_SECRET_BYTES = 32;
const SUBMIT_CAPABILITY_MAX_BODY_CHARS = 64 * 1024;

export type CapabilityPlatform = "damai" | "maoyan";

export interface SubmitCapabilityPreference {
  readonly label: string;
  readonly priority: number;
  readonly maxUnitPriceFen?: number;
}

export interface SubmitCapabilityBinding {
  readonly runId: string;
  readonly planId: string;
  readonly platform: CapabilityPlatform;
  readonly canonicalEventKey: string;
  /** Canonical HTTPS origin, for example https://detail.damai.cn. */
  readonly officialOrigin: string;
  readonly eventId: string;
  readonly eventTitle: string;
  readonly quantity: number;
  readonly requireAdjacent: boolean;
  /** Non-sensitive audit binding only; raw refs and resolved labels are forbidden. */
  readonly attendeeRefCount: number;
  readonly attendeeRefFingerprint: `sha256:${string}`;
  /** Preferences are sorted by ascending priority and are immutable once signed. */
  readonly sessionPreferences: readonly SubmitCapabilityPreference[];
  readonly tierPreferences: readonly SubmitCapabilityPreference[];
  readonly maxTotalFen: number;
}

export interface SubmitCapabilityClaims extends SubmitCapabilityBinding {
  readonly version: typeof SUBMIT_CAPABILITY_VERSION;
  readonly purpose: typeof SUBMIT_CAPABILITY_PURPOSE;
  readonly issuedAtMs: number;
  /** Earliest wall-clock instant at which the one-shot may be consumed. */
  readonly earliestSubmitAtMs: number;
  readonly expiresAtMs: number;
  /** 32 random bytes encoded as unpadded base64url. */
  readonly nonce: string;
}

export interface SignedSubmitCapability {
  readonly body: string;
  readonly signature: string;
}

export interface SubmitCapabilityIssueOptions {
  /**
   * Absolute not-before instant. For a scheduled sale this must be the
   * reviewed saleAt; for an already-open event it may equal issuedAtMs.
   */
  readonly earliestSubmitAtMs: number;
  /** Absolute expiry. Requiring this makes the T-10/T0 lifetime explicit. */
  readonly expiresAtMs: number;
  readonly issuedAtMs?: number;
  /**
   * A pre-generated nonce may be supplied when its digest is reserved in the
   * controller's sticky-lock transaction. Use createSubmitCapabilityNonce().
   */
  readonly nonce?: string;
}

/** What the browser state machine observed immediately before the click. */
export interface SubmitCapabilityAttempt {
  readonly runId: string;
  readonly planId: string;
  readonly platform: CapabilityPlatform;
  readonly canonicalEventKey: string;
  readonly officialOrigin: string;
  readonly eventId: string;
  readonly eventTitle: string;
  readonly quantity: number;
  readonly requireAdjacent: boolean;
  readonly attendeeRefCount: number;
  readonly attendeeRefFingerprint: `sha256:${string}`;
  readonly selectedSession: string;
  readonly selectedSessionPriority: number;
  readonly selectedTier: string;
  readonly selectedTierPriority: number;
  readonly selectedTierUnitPriceFen: number;
  readonly observedTotalFen: number;
}

export interface PreparedSubmitCapability {
  readonly claims: SubmitCapabilityClaims;
}

export type SubmitCapabilityErrorCode =
  | "SUBMIT_CAPABILITY_SECRET_TOO_SHORT"
  | "SUBMIT_CAPABILITY_SECRET_INVALID"
  | "SUBMIT_CAPABILITY_INPUT_INVALID"
  | "SUBMIT_CAPABILITY_ENVELOPE_INVALID"
  | "SUBMIT_CAPABILITY_INVALID_SIGNATURE"
  | "SUBMIT_CAPABILITY_INVALID_CLAIMS"
  | "SUBMIT_CAPABILITY_FUTURE_ISSUED"
  | "SUBMIT_CAPABILITY_TOO_EARLY"
  | "SUBMIT_CAPABILITY_EXPIRED"
  | "SUBMIT_CAPABILITY_REPLAYED"
  | "SUBMIT_CAPABILITY_NOT_PREPARED"
  | "SUBMIT_CAPABILITY_BINDING_MISMATCH"
  | "SUBMIT_CAPABILITY_SELECTION_MISMATCH"
  | "SUBMIT_CAPABILITY_TIER_UNIT_PRICE_LIMIT_EXCEEDED"
  | "SUBMIT_CAPABILITY_PRICE_INCONSISTENT"
  | "SUBMIT_CAPABILITY_PRICE_LIMIT_EXCEEDED";

export class SubmitCapabilityError extends Error {
  readonly code: SubmitCapabilityErrorCode;

  constructor(code: SubmitCapabilityErrorCode) {
    super(code);
    this.name = "SubmitCapabilityError";
    this.code = code;
  }
}

export type SubmitCapabilitySecret = string | Uint8Array;

function fail(code: SubmitCapabilityErrorCode): never {
  throw new SubmitCapabilityError(code);
}

function secretBytes(secret: SubmitCapabilitySecret): Buffer {
  let bytes: Buffer;
  if (typeof secret === "string") {
    bytes = Buffer.from(secret, "utf8");
  } else if (secret instanceof Uint8Array) {
    bytes = Buffer.from(secret);
  } else {
    fail("SUBMIT_CAPABILITY_SECRET_INVALID");
  }
  if (bytes.byteLength < SUBMIT_CAPABILITY_MIN_SECRET_BYTES) {
    fail("SUBMIT_CAPABILITY_SECRET_TOO_SHORT");
  }
  return bytes;
}

function assertClock(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail("SUBMIT_CAPABILITY_INPUT_INVALID");
}

function assertMonotonicClock(nowMs: number): void {
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs) || nowMs < 0) {
    fail("SUBMIT_CAPABILITY_INPUT_INVALID");
  }
}

function assertText(value: unknown, maxLength: number): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail("SUBMIT_CAPABILITY_INPUT_INVALID");
  }
}

function identityKey(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("zh-CN");
}

function isOfficialHost(platform: CapabilityPlatform, hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^www\./u, "");
  const root = platform === "damai" ? "damai.cn" : "maoyan.com";
  return normalized === root || normalized.endsWith(`.${root}`);
}

/**
 * Normalize and validate an official page URL to the exact origin that gets
 * bound into the capability.  Paths, query strings, credentials, and non-HTTPS
 * URLs are intentionally not accepted here.
 */
export function canonicalOfficialOrigin(platform: CapabilityPlatform, origin: string): string {
  assertText(origin, 300);
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    fail("SUBMIT_CAPABILITY_INPUT_INVALID");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    (parsed.port !== "" && parsed.port !== "443") ||
    !isOfficialHost(platform, parsed.hostname) ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    fail("SUBMIT_CAPABILITY_INPUT_INVALID");
  }
  // URL.origin removes a default :443 and canonicalizes host casing.
  const canonical = parsed.origin;
  if (origin !== canonical && origin !== `${canonical}/`) {
    fail("SUBMIT_CAPABILITY_INPUT_INVALID");
  }
  return canonical;
}

function assertPreferenceArray(value: unknown, field: "sessionPreferences" | "tierPreferences"): SubmitCapabilityPreference[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    fail("SUBMIT_CAPABILITY_INPUT_INVALID");
  }
  const result: SubmitCapabilityPreference[] = [];
  const labels = new Set<string>();
  let previousPriority = -1;
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      fail("SUBMIT_CAPABILITY_INPUT_INVALID");
    }
    const item = entry as Record<string, unknown>;
    const keys = Object.keys(item).sort().join(",");
    if (field === "sessionPreferences" && keys !== "label,priority") {
      fail("SUBMIT_CAPABILITY_INVALID_CLAIMS");
    }
    if (field === "tierPreferences" && keys !== "label,maxUnitPriceFen,priority" && keys !== "label,priority") {
      fail("SUBMIT_CAPABILITY_INVALID_CLAIMS");
    }
    assertText(item.label, 300);
    if (!Number.isSafeInteger(item.priority) || (item.priority as number) < 0 || (item.priority as number) <= previousPriority) {
      fail("SUBMIT_CAPABILITY_INPUT_INVALID");
    }
    const key = identityKey(item.label);
    if (labels.has(key)) fail("SUBMIT_CAPABILITY_INPUT_INVALID");
    labels.add(key);
    previousPriority = item.priority as number;
    if (item.maxUnitPriceFen !== undefined && (!Number.isSafeInteger(item.maxUnitPriceFen) || (item.maxUnitPriceFen as number) < 0)) {
      fail("SUBMIT_CAPABILITY_INPUT_INVALID");
    }
    result.push({
      label: item.label,
      priority: item.priority as number,
      ...(item.maxUnitPriceFen === undefined ? {} : { maxUnitPriceFen: item.maxUnitPriceFen as number })
    });
  }
  return result;
}

function nonceIsValid(nonce: unknown): nonce is string {
  return typeof nonce === "string" && /^[A-Za-z0-9_-]{43}$/u.test(nonce);
}

function assertNonce(nonce: unknown): asserts nonce is string {
  if (!nonceIsValid(nonce)) fail("SUBMIT_CAPABILITY_INPUT_INVALID");
  const decoded = Buffer.from(nonce, "base64url");
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== nonce) {
    fail("SUBMIT_CAPABILITY_INPUT_INVALID");
  }
}

/** Generate the only supported production nonce shape (256 bits). */
export function createSubmitCapabilityNonce(): string {
  return randomBytes(32).toString("base64url");
}

function cloneAndFreezeClaims(claims: SubmitCapabilityClaims): SubmitCapabilityClaims {
  const sessions = claims.sessionPreferences.map((item) => Object.freeze({ ...item }));
  const tiers = claims.tierPreferences.map((item) => Object.freeze({ ...item }));
  return Object.freeze({
    ...claims,
    sessionPreferences: Object.freeze(sessions),
    tierPreferences: Object.freeze(tiers)
  });
}

function validateBinding(binding: SubmitCapabilityBinding): SubmitCapabilityBinding {
  if (typeof binding !== "object" || binding === null) fail("SUBMIT_CAPABILITY_INPUT_INVALID");
  const expectedKeys = [
    "canonicalEventKey",
    "attendeeRefCount",
    "attendeeRefFingerprint",
    "eventId",
    "eventTitle",
    "maxTotalFen",
    "officialOrigin",
    "planId",
    "platform",
    "quantity",
    "requireAdjacent",
    "runId",
    "sessionPreferences",
    "tierPreferences"
  ].sort().join(",");
  if (Object.keys(binding).sort().join(",") !== expectedKeys) fail("SUBMIT_CAPABILITY_INPUT_INVALID");
  assertText(binding.runId, 200);
  assertText(binding.planId, 200);
  if (binding.platform !== "damai" && binding.platform !== "maoyan") fail("SUBMIT_CAPABILITY_INPUT_INVALID");
  assertText(binding.canonicalEventKey, 200);
  const officialOrigin = canonicalOfficialOrigin(binding.platform, binding.officialOrigin);
  assertText(binding.eventId, 200);
  assertText(binding.eventTitle, 500);
  if (!Number.isSafeInteger(binding.quantity) || binding.quantity < 1 || binding.quantity > 6) {
    fail("SUBMIT_CAPABILITY_INPUT_INVALID");
  }
  if (typeof binding.requireAdjacent !== "boolean") fail("SUBMIT_CAPABILITY_INPUT_INVALID");
  if (!Number.isSafeInteger(binding.attendeeRefCount) || binding.attendeeRefCount !== binding.quantity) {
    fail("SUBMIT_CAPABILITY_INPUT_INVALID");
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(binding.attendeeRefFingerprint)) {
    fail("SUBMIT_CAPABILITY_INPUT_INVALID");
  }
  const sessionPreferences = assertPreferenceArray(binding.sessionPreferences, "sessionPreferences").map((item) => Object.freeze({ ...item }));
  const tierPreferences = assertPreferenceArray(binding.tierPreferences, "tierPreferences").map((item) => Object.freeze({ ...item }));
  if (!Number.isSafeInteger(binding.maxTotalFen) || binding.maxTotalFen < 0) fail("SUBMIT_CAPABILITY_INPUT_INVALID");
  return {
    runId: binding.runId,
    planId: binding.planId,
    platform: binding.platform,
    canonicalEventKey: binding.canonicalEventKey,
    officialOrigin,
    eventId: binding.eventId,
    eventTitle: binding.eventTitle,
    quantity: binding.quantity,
    requireAdjacent: binding.requireAdjacent,
    attendeeRefCount: binding.attendeeRefCount,
    attendeeRefFingerprint: binding.attendeeRefFingerprint,
    sessionPreferences: Object.freeze(sessionPreferences),
    tierPreferences: Object.freeze(tierPreferences),
    maxTotalFen: binding.maxTotalFen
  };
}

function claimsForIssue(binding: SubmitCapabilityBinding, options: SubmitCapabilityIssueOptions): SubmitCapabilityClaims {
  const normalizedBinding = validateBinding(binding);
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    fail("SUBMIT_CAPABILITY_INPUT_INVALID");
  }
  const allowedOptionKeys = new Set(["earliestSubmitAtMs", "expiresAtMs", "issuedAtMs", "nonce"]);
  if (
    Object.keys(options).some((key) => !allowedOptionKeys.has(key)) ||
    !("earliestSubmitAtMs" in options) ||
    !("expiresAtMs" in options)
  ) {
    fail("SUBMIT_CAPABILITY_INPUT_INVALID");
  }
  const issuedAtMs = options.issuedAtMs ?? Date.now();
  assertClock(issuedAtMs);
  if (
    !Number.isSafeInteger(options.earliestSubmitAtMs) ||
    options.earliestSubmitAtMs < issuedAtMs ||
    !Number.isSafeInteger(options.expiresAtMs) ||
    options.expiresAtMs <= options.earliestSubmitAtMs
  ) {
    fail("SUBMIT_CAPABILITY_INPUT_INVALID");
  }
  if (options.expiresAtMs - issuedAtMs > SUBMIT_CAPABILITY_MAX_LIFETIME_MS) {
    fail("SUBMIT_CAPABILITY_INPUT_INVALID");
  }
  const nonce = options.nonce ?? createSubmitCapabilityNonce();
  assertNonce(nonce);
  return cloneAndFreezeClaims({
    version: SUBMIT_CAPABILITY_VERSION,
    purpose: SUBMIT_CAPABILITY_PURPOSE,
    ...normalizedBinding,
    issuedAtMs,
    earliestSubmitAtMs: options.earliestSubmitAtMs,
    expiresAtMs: options.expiresAtMs,
    nonce
  });
}

function canonicalClaimsJson(claims: SubmitCapabilityClaims): string {
  return JSON.stringify({
    version: claims.version,
    purpose: claims.purpose,
    runId: claims.runId,
    planId: claims.planId,
    platform: claims.platform,
    canonicalEventKey: claims.canonicalEventKey,
    officialOrigin: claims.officialOrigin,
    eventId: claims.eventId,
    eventTitle: claims.eventTitle,
    quantity: claims.quantity,
    requireAdjacent: claims.requireAdjacent,
    attendeeRefCount: claims.attendeeRefCount,
    attendeeRefFingerprint: claims.attendeeRefFingerprint,
    sessionPreferences: claims.sessionPreferences,
    tierPreferences: claims.tierPreferences,
    maxTotalFen: claims.maxTotalFen,
    issuedAtMs: claims.issuedAtMs,
    earliestSubmitAtMs: claims.earliestSubmitAtMs,
    expiresAtMs: claims.expiresAtMs,
    nonce: claims.nonce
  });
}

function hmacFor(body: string, secret: SubmitCapabilitySecret): Buffer {
  const key = secretBytes(secret);
  try {
    return createHmac("sha256", key).update("ticket-agent/submit-capability/v1\u0000", "utf8").update(body, "utf8").digest();
  } finally {
    // Do not retain a copied Uint8Array key beyond the HMAC operation.
    key.fill(0);
  }
}

function encodeBody(claims: SubmitCapabilityClaims): string {
  return Buffer.from(canonicalClaimsJson(claims), "utf8").toString("base64url");
}

function assertEnvelopeShape(envelope: unknown): asserts envelope is SignedSubmitCapability {
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    fail("SUBMIT_CAPABILITY_ENVELOPE_INVALID");
  }
  const keys = Object.keys(envelope as Record<string, unknown>).sort().join(",");
  const value = envelope as Record<string, unknown>;
  if (keys !== "body,signature" || typeof value.body !== "string" || typeof value.signature !== "string") {
    fail("SUBMIT_CAPABILITY_ENVELOPE_INVALID");
  }
  if (value.body.length === 0 || value.body.length > SUBMIT_CAPABILITY_MAX_BODY_CHARS || !/^[A-Za-z0-9_-]+$/u.test(value.body)) {
    fail("SUBMIT_CAPABILITY_ENVELOPE_INVALID");
  }
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value.signature)) fail("SUBMIT_CAPABILITY_ENVELOPE_INVALID");
  const signatureBytes = Buffer.from(value.signature, "base64url");
  if (signatureBytes.byteLength !== 32 || signatureBytes.toString("base64url") !== value.signature) {
    fail("SUBMIT_CAPABILITY_ENVELOPE_INVALID");
  }
}

function parseAndValidateClaims(body: string, nowMs: number): SubmitCapabilityClaims {
  let decodedText: string;
  try {
    const bytes = Buffer.from(body, "base64url");
    if (bytes.byteLength === 0 || bytes.toString("base64url") !== body) fail("SUBMIT_CAPABILITY_ENVELOPE_INVALID");
    decodedText = bytes.toString("utf8");
  } catch {
    fail("SUBMIT_CAPABILITY_ENVELOPE_INVALID");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(decodedText);
  } catch {
    fail("SUBMIT_CAPABILITY_INVALID_CLAIMS");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("SUBMIT_CAPABILITY_INVALID_CLAIMS");
  const value = raw as Record<string, unknown>;
  const expectedKeys = [
    "canonicalEventKey",
    "attendeeRefCount",
    "attendeeRefFingerprint",
    "eventId",
    "eventTitle",
    "earliestSubmitAtMs",
    "expiresAtMs",
    "issuedAtMs",
    "maxTotalFen",
    "nonce",
    "officialOrigin",
    "planId",
    "platform",
    "purpose",
    "quantity",
    "requireAdjacent",
    "runId",
    "sessionPreferences",
    "tierPreferences",
    "version"
  ].sort().join(",");
  if (Object.keys(value).sort().join(",") !== expectedKeys) fail("SUBMIT_CAPABILITY_INVALID_CLAIMS");
  if (value.version !== SUBMIT_CAPABILITY_VERSION || value.purpose !== SUBMIT_CAPABILITY_PURPOSE) {
    fail("SUBMIT_CAPABILITY_INVALID_CLAIMS");
  }
  if (
    !Number.isSafeInteger(value.issuedAtMs) ||
    !Number.isSafeInteger(value.earliestSubmitAtMs) ||
    !Number.isSafeInteger(value.expiresAtMs) ||
    (value.issuedAtMs as number) < 0 ||
    (value.earliestSubmitAtMs as number) < (value.issuedAtMs as number) ||
    (value.expiresAtMs as number) <= (value.earliestSubmitAtMs as number)
  ) {
    fail("SUBMIT_CAPABILITY_INVALID_CLAIMS");
  }
  if ((value.expiresAtMs as number) - (value.issuedAtMs as number) > SUBMIT_CAPABILITY_MAX_LIFETIME_MS) {
    fail("SUBMIT_CAPABILITY_INVALID_CLAIMS");
  }
  assertNonce(value.nonce);
  const binding = validateBinding({
    runId: value.runId as string,
    planId: value.planId as string,
    platform: value.platform as CapabilityPlatform,
    canonicalEventKey: value.canonicalEventKey as string,
    officialOrigin: value.officialOrigin as string,
    eventId: value.eventId as string,
    eventTitle: value.eventTitle as string,
    quantity: value.quantity as number,
    requireAdjacent: value.requireAdjacent as boolean,
    attendeeRefCount: value.attendeeRefCount as number,
    attendeeRefFingerprint: value.attendeeRefFingerprint as `sha256:${string}`,
    sessionPreferences: value.sessionPreferences as SubmitCapabilityPreference[],
    tierPreferences: value.tierPreferences as SubmitCapabilityPreference[],
    maxTotalFen: value.maxTotalFen as number
  });
  const claims = cloneAndFreezeClaims({
    version: SUBMIT_CAPABILITY_VERSION,
    purpose: SUBMIT_CAPABILITY_PURPOSE,
    ...binding,
    issuedAtMs: value.issuedAtMs as number,
    earliestSubmitAtMs: value.earliestSubmitAtMs as number,
    expiresAtMs: value.expiresAtMs as number,
    nonce: value.nonce
  });
  if (canonicalClaimsJson(claims) !== decodedText) fail("SUBMIT_CAPABILITY_INVALID_CLAIMS");
  if (claims.issuedAtMs > nowMs) fail("SUBMIT_CAPABILITY_FUTURE_ISSUED");
  if (claims.expiresAtMs <= nowMs) fail("SUBMIT_CAPABILITY_EXPIRED");
  return claims;
}

/** Create a short-lived, canonical HMAC capability. */
export function issueSubmitCapability(
  binding: SubmitCapabilityBinding,
  secret: SubmitCapabilitySecret,
  options: SubmitCapabilityIssueOptions
): SignedSubmitCapability {
  const claims = claimsForIssue(binding, options);
  const body = encodeBody(claims);
  if (body.length > SUBMIT_CAPABILITY_MAX_BODY_CHARS) fail("SUBMIT_CAPABILITY_INPUT_INVALID");
  return { body, signature: hmacFor(body, secret).toString("base64url") };
}

/** Verify authenticity, schema, temporal bounds, and canonical encoding. */
function verifySubmitCapabilityAt(
  envelope: unknown,
  secret: SubmitCapabilitySecret,
  nowMs: number
): SubmitCapabilityClaims {
  assertClock(nowMs);
  assertEnvelopeShape(envelope);
  const expected = hmacFor(envelope.body, secret);
  const received = Buffer.from(envelope.signature, "base64url");
  if (received.byteLength !== expected.byteLength || !timingSafeEqual(expected, received)) {
    fail("SUBMIT_CAPABILITY_INVALID_SIGNATURE");
  }
  return parseAndValidateClaims(envelope.body, nowMs);
}

/** Verify with the current system clock; callers cannot override expiry time. */
export function verifySubmitCapability(
  envelope: unknown,
  secret: SubmitCapabilitySecret
): SubmitCapabilityClaims {
  return verifySubmitCapabilityAt(envelope, secret, Date.now());
}

function assertAttemptShape(attempt: unknown): asserts attempt is SubmitCapabilityAttempt {
  if (typeof attempt !== "object" || attempt === null || Array.isArray(attempt)) fail("SUBMIT_CAPABILITY_BINDING_MISMATCH");
  const value = attempt as Record<string, unknown>;
  const expectedKeys = [
    "canonicalEventKey",
    "attendeeRefCount",
    "attendeeRefFingerprint",
    "eventId",
    "eventTitle",
    "observedTotalFen",
    "officialOrigin",
    "planId",
    "platform",
    "quantity",
    "requireAdjacent",
    "runId",
    "selectedSession",
    "selectedSessionPriority",
    "selectedTier",
    "selectedTierPriority",
    "selectedTierUnitPriceFen"
  ].sort().join(",");
  if (Object.keys(value).sort().join(",") !== expectedKeys) fail("SUBMIT_CAPABILITY_BINDING_MISMATCH");
  assertText(value.runId, 200);
  assertText(value.planId, 200);
  if (value.platform !== "damai" && value.platform !== "maoyan") fail("SUBMIT_CAPABILITY_BINDING_MISMATCH");
  assertText(value.canonicalEventKey, 200);
  assertText(value.officialOrigin, 300);
  assertText(value.eventId, 200);
  assertText(value.eventTitle, 500);
  if (!Number.isSafeInteger(value.quantity) || (value.quantity as number) < 1 || (value.quantity as number) > 6) {
    fail("SUBMIT_CAPABILITY_BINDING_MISMATCH");
  }
  if (typeof value.requireAdjacent !== "boolean") fail("SUBMIT_CAPABILITY_BINDING_MISMATCH");
  if (!Number.isSafeInteger(value.attendeeRefCount) || (value.attendeeRefCount as number) < 1) {
    fail("SUBMIT_CAPABILITY_BINDING_MISMATCH");
  }
  if (typeof value.attendeeRefFingerprint !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value.attendeeRefFingerprint)) {
    fail("SUBMIT_CAPABILITY_BINDING_MISMATCH");
  }
  assertText(value.selectedSession, 300);
  assertText(value.selectedTier, 300);
  if (!Number.isSafeInteger(value.selectedSessionPriority) || (value.selectedSessionPriority as number) < 0) {
    fail("SUBMIT_CAPABILITY_SELECTION_MISMATCH");
  }
  if (!Number.isSafeInteger(value.selectedTierPriority) || (value.selectedTierPriority as number) < 0) {
    fail("SUBMIT_CAPABILITY_SELECTION_MISMATCH");
  }
  if (!Number.isSafeInteger(value.selectedTierUnitPriceFen) || (value.selectedTierUnitPriceFen as number) < 0) {
    fail("SUBMIT_CAPABILITY_TIER_UNIT_PRICE_LIMIT_EXCEEDED");
  }
  if (!Number.isSafeInteger(value.observedTotalFen) || (value.observedTotalFen as number) < 0) {
    fail("SUBMIT_CAPABILITY_PRICE_LIMIT_EXCEEDED");
  }
}

const ATTEMPT_BINDING_FIELDS = Object.freeze([
  "runId",
  "planId",
  "platform",
  "canonicalEventKey",
  "officialOrigin",
  "eventId",
  "eventTitle",
  "quantity",
  "requireAdjacent",
  "attendeeRefCount",
  "attendeeRefFingerprint"
] as const);

function verifyAttempt(entry: ConsumerEntry, attempt: SubmitCapabilityAttempt): void {
  const { claims } = entry;
  for (const field of ATTEMPT_BINDING_FIELDS) {
    if (claims[field] !== attempt[field]) fail("SUBMIT_CAPABILITY_BINDING_MISMATCH");
  }
  const sessionLabel = entry.sessionByPriority.get(attempt.selectedSessionPriority);
  const tier = entry.tierByPriority.get(attempt.selectedTierPriority);
  if (sessionLabel !== attempt.selectedSession || !tier || tier.label !== attempt.selectedTier) {
    fail("SUBMIT_CAPABILITY_SELECTION_MISMATCH");
  }
  if (tier.maxUnitPriceFen !== undefined && attempt.selectedTierUnitPriceFen > tier.maxUnitPriceFen) {
    fail("SUBMIT_CAPABILITY_TIER_UNIT_PRICE_LIMIT_EXCEEDED");
  }
  const lineTotalFen = attempt.selectedTierUnitPriceFen * claims.quantity;
  if (!Number.isSafeInteger(lineTotalFen) || lineTotalFen > attempt.observedTotalFen) {
    // Current policy permits only explicit fees above the line total. A future
    // discount policy must be represented and verified separately.
    fail("SUBMIT_CAPABILITY_PRICE_INCONSISTENT");
  }
  if (attempt.observedTotalFen > claims.maxTotalFen) fail("SUBMIT_CAPABILITY_PRICE_LIMIT_EXCEEDED");
}

interface ConsumerEntry {
  readonly handle: PreparedSubmitCapability;
  readonly claims: SubmitCapabilityClaims;
  readonly sessionByPriority: ReadonlyMap<number, string>;
  readonly tierByPriority: ReadonlyMap<number, SubmitCapabilityPreference>;
  readonly preparedWallNowMs: number;
  readonly preparedMonotonicMs: number;
  readonly monotonicClock: SubmitCapabilityMonotonicClock;
  lastMonotonicMs: number;
  state: "prepared" | "consumed";
}

// A nonce registry must be shared by every consumer instance in this module.
// Keeping only nonce tombstones has small, bounded-per-run memory cost while
// preventing a second Consumer instance from replaying the same envelope.
const processRegisteredNonces = new Set<string>();
const processPreparedHandles = new WeakMap<object, ConsumerEntry>();

export type SubmitCapabilityClock = () => number;
export type SubmitCapabilityMonotonicClock = () => number;

/**
 * Single-process prepare/consume gate.  There is intentionally no await or
 * external I/O between the state check and the state transition in consume;
 * JavaScript's run-to-completion semantics make it atomic within this process.
 * It is not a cross-process durable replay barrier (see docs/SUBMIT_CAPABILITY.md).
 */
export class InProcessSubmitCapabilityConsumer {
  private readonly clock: SubmitCapabilityClock;
  private readonly monotonicClock: SubmitCapabilityMonotonicClock;
  private lastNowMs: number | undefined;

  constructor(
    clock: SubmitCapabilityClock = Date.now,
    monotonicClock: SubmitCapabilityMonotonicClock = () => performance.now()
  ) {
    this.clock = clock;
    this.monotonicClock = monotonicClock;
  }

  private now(): number {
    const nowMs = this.clock();
    assertClock(nowMs);
    // A wall-clock rollback could otherwise make an expired token appear live.
    // Production uses Date.now; constructor injection exists for deterministic tests.
    if (this.lastNowMs !== undefined && nowMs < this.lastNowMs) {
      fail("SUBMIT_CAPABILITY_INPUT_INVALID");
    }
    this.lastNowMs = nowMs;
    return nowMs;
  }

  prepare(envelope: unknown, secret: SubmitCapabilitySecret): PreparedSubmitCapability {
    const nowMs = this.now();
    const monotonicMs = this.monotonicClock();
    assertMonotonicClock(monotonicMs);
    const claims = verifySubmitCapabilityAt(envelope, secret, nowMs);
    if (processRegisteredNonces.has(claims.nonce)) fail("SUBMIT_CAPABILITY_REPLAYED");
    const handle = Object.freeze({ claims });
    const sessionByPriority = new Map(claims.sessionPreferences.map((item) => [item.priority, item.label] as const));
    const tierByPriority = new Map(claims.tierPreferences.map((item) => [item.priority, item] as const));
    const entry: ConsumerEntry = {
      handle,
      claims,
      sessionByPriority,
      tierByPriority,
      preparedWallNowMs: nowMs,
      preparedMonotonicMs: monotonicMs,
      monotonicClock: this.monotonicClock,
      lastMonotonicMs: monotonicMs,
      state: "prepared"
    };
    processRegisteredNonces.add(claims.nonce);
    processPreparedHandles.set(handle, entry);
    return handle;
  }

  consume(prepared: PreparedSubmitCapability, attempt: unknown): SubmitCapabilityClaims {
    const entry = processPreparedHandles.get(prepared as object);
    if (!entry) fail("SUBMIT_CAPABILITY_NOT_PREPARED");
    // Consume before validation so a malformed/stale DOM cannot be retried by
    // a second click or a second caller.  Any failure therefore remains closed.
    if (entry.state !== "prepared") fail("SUBMIT_CAPABILITY_REPLAYED");
    entry.state = "consumed";
    const nowMs = this.now();
    const monotonicMs = entry.monotonicClock();
    assertMonotonicClock(monotonicMs);
    if (monotonicMs < entry.lastMonotonicMs) fail("SUBMIT_CAPABILITY_INPUT_INVALID");
    entry.lastMonotonicMs = monotonicMs;
    const elapsedMs = Math.floor(monotonicMs - entry.preparedMonotonicMs);
    const anchoredNowMs = entry.preparedWallNowMs + elapsedMs;
    assertClock(anchoredNowMs);
    if (entry.claims.issuedAtMs > nowMs) fail("SUBMIT_CAPABILITY_FUTURE_ISSUED");
    if (entry.claims.expiresAtMs <= nowMs || entry.claims.expiresAtMs <= anchoredNowMs) {
      fail("SUBMIT_CAPABILITY_EXPIRED");
    }
    // Require both clocks to cross the signed gate. A forward wall-clock jump
    // cannot make a T-10 capability consumable before the elapsed monotonic
    // duration, while a rollback remains fail-closed in now().
    if (entry.claims.earliestSubmitAtMs > nowMs || entry.claims.earliestSubmitAtMs > anchoredNowMs) {
      fail("SUBMIT_CAPABILITY_TOO_EARLY");
    }
    assertAttemptShape(attempt);
    verifyAttempt(entry, attempt);
    return entry.claims;
  }
}
