import assert from "node:assert/strict";
import test from "node:test";
import { signPayload, verifyPayload } from "../src/core/signing.js";

const secret = "a-development-test-secret-that-is-long-enough";

test("signed payload verifies before expiry", () => {
  const envelope = signPayload({ planId: "plan-1" }, secret, 60);
  assert.deepEqual(verifyPayload<{ planId: string }>(envelope, secret).payload, { planId: "plan-1" });
});

test("tampered payload is rejected", () => {
  const envelope = signPayload({ planId: "plan-1" }, secret, 60);
  const tampered = { ...envelope, body: `${envelope.body.slice(0, -1)}A` };
  assert.throws(() => verifyPayload(tampered, secret), /INVALID_SIGNATURE/);
});

test("expired payload is rejected", () => {
  const envelope = signPayload({ planId: "plan-1" }, secret, 1);
  assert.throws(
    () => verifyPayload(envelope, secret, new Date(Date.now() + 2_000)),
    /ENVELOPE_EXPIRED/
  );
});
