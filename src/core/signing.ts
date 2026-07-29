import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export interface SignedEnvelope {
  body: string;
  signature: string;
}

interface EnvelopeBody<T> {
  payload: T;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
}

const minimumSecretLength = 32;

function assertSecret(secret: string): void {
  if (Buffer.byteLength(secret, "utf8") < minimumSecretLength) {
    throw new Error(`SIGNING_SECRET_TOO_SHORT:minimum=${minimumSecretLength}`);
  }
}

function signatureFor(body: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(body, "utf8").digest();
}

export function signPayload<T>(payload: T, secret: string, ttlSeconds = 900): SignedEnvelope {
  assertSecret(secret);
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86_400) {
    throw new Error("INVALID_SIGNING_TTL");
  }
  const issuedAt = new Date();
  const bodyValue: EnvelopeBody<T> = {
    payload,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + ttlSeconds * 1_000).toISOString(),
    nonce: randomUUID()
  };
  const body = Buffer.from(JSON.stringify(bodyValue), "utf8").toString("base64url");
  return { body, signature: signatureFor(body, secret).toString("base64url") };
}

export function verifyPayload<T>(envelope: SignedEnvelope, secret: string, now = new Date()): EnvelopeBody<T> {
  assertSecret(secret);
  const expected = signatureFor(envelope.body, secret);
  const received = Buffer.from(envelope.signature, "base64url");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new Error("INVALID_SIGNATURE");
  }
  let decoded: EnvelopeBody<T>;
  try {
    decoded = JSON.parse(Buffer.from(envelope.body, "base64url").toString("utf8")) as EnvelopeBody<T>;
  } catch {
    throw new Error("INVALID_ENVELOPE_BODY");
  }
  if (Number.isNaN(Date.parse(decoded.expiresAt)) || Date.parse(decoded.expiresAt) < now.getTime()) {
    throw new Error("ENVELOPE_EXPIRED");
  }
  return decoded;
}
