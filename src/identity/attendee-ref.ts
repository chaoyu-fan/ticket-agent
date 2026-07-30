import { createHash, randomUUID } from "node:crypto";

declare const attendeeRefBrand: unique symbol;

/**
 * A non-semantic, Mac-local handle for an attendee record. It is safe to put
 * this handle in plans, but the real name or identity data it resolves to is
 * never part of this type.
 */
export type AttendeeRef = string & { readonly [attendeeRefBrand]: true };

export const ATTENDEE_REF_AUDIT_SCHEMA = "ticket-agent/attendee-ref-audit/v1" as const;

// UUIDv4 keeps the reference non-semantic and gives it enough entropy that a
// caller cannot accidentally use a name, phone number, email address, or
// identity-card number as the handle. Lowercase canonical form avoids aliases
// for the same reference.
const ATTENDEE_REF_PATTERN =
  /^attendee:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface AttendeeRefAudit {
  readonly schema: typeof ATTENDEE_REF_AUDIT_SCHEMA;
  readonly count: number;
  /** Digest of ordered opaque references; raw references are not serialized. */
  readonly fingerprint: `sha256:${string}`;
}

/** Runtime predicate for untrusted plan/controller input. */
export function isAttendeeRef(value: unknown): value is AttendeeRef {
  return typeof value === "string" && ATTENDEE_REF_PATTERN.test(value);
}

/**
 * Validates without trimming or normalizing. Error text deliberately never
 * contains the rejected input because that input may be a real name or other
 * sensitive value.
 */
export function parseAttendeeRef(value: unknown): AttendeeRef {
  if (!isAttendeeRef(value)) {
    throw new Error("ATTENDEE_REF_INVALID:expected canonical attendee:v1 UUIDv4 reference");
  }
  return value;
}

/** Creates a new non-semantic reference without accepting identity material. */
export function createAttendeeRef(): AttendeeRef {
  return parseAttendeeRef(`attendee:v1:${randomUUID()}`);
}

export function parseAttendeeRefs(value: unknown): AttendeeRef[] {
  if (!Array.isArray(value)) {
    throw new Error("ATTENDEE_REFS_INVALID:expected an array of opaque references");
  }

  const refs = value.map((candidate) => parseAttendeeRef(candidate));
  if (new Set<string>(refs).size !== refs.length) {
    throw new Error("ATTENDEE_REFS_INVALID:duplicate opaque reference");
  }
  return refs;
}

/**
 * Enforces the disk/controller boundary for a plan-shaped value. Empty legacy
 * arrays remain readable for rollback compatibility, but a non-empty legacy
 * alias can never be written or returned by current code.
 */
export function assertAttendeePersistenceBoundary(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const input = value as Record<string, unknown>;
  if (input.attendeeAliases !== undefined) {
    if (!Array.isArray(input.attendeeAliases) || input.attendeeAliases.length !== 0) {
      throw new Error("ATTENDEE_ALIASES_PERSISTENCE_BLOCKED:use opaque attendeeRefs");
    }
  }
  if (input.attendeeRefs !== undefined) parseAttendeeRefs(input.attendeeRefs);
}

/**
 * Produces the only attendee audit shape allowed by this boundary. The helper
 * accepts untrusted input, validates every entry as an opaque reference, and
 * emits only a count plus a digest. It never invokes toJSON on caller values
 * and never serializes real names, labels, identifiers, or the refs themselves.
 */
export function buildAttendeeRefAudit(value: unknown): AttendeeRefAudit {
  const refs = parseAttendeeRefs(value);
  const digest = createHash("sha256")
    .update(JSON.stringify(refs), "utf8")
    .digest("hex");
  return Object.freeze({
    schema: ATTENDEE_REF_AUDIT_SCHEMA,
    count: refs.length,
    fingerprint: `sha256:${digest}`
  });
}

/** Serializes only the fixed, non-sensitive audit shape above. */
export function serializeAttendeeRefAudit(value: unknown): string {
  return JSON.stringify(buildAttendeeRefAudit(value));
}
