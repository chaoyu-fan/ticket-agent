import assert from "node:assert/strict";
import test from "node:test";

import {
  InProcessSubmitCapabilityConsumer,
  SUBMIT_CAPABILITY_MAX_LIFETIME_MS,
  buildAttendeeSelectionFingerprint,
  canonicalOfficialOrigin,
  createSubmitCapabilityNonce,
  digestRunnerSessionSecret,
  issueSubmitCapability,
  type SubmitCapabilityAttempt,
  type SubmitCapabilityBinding,
  verifySubmitCapability
} from "../src/security/submit-capability.js";
import { buildAttendeeRefAudit, parseAttendeeRef } from "../src/identity/attendee-ref.js";

const SECRET = "submit-capability-test-secret-with-more-than-32-bytes";
const OTHER_SECRET = "a-different-submit-capability-secret-over-32-bytes";
const ISSUED_AT_MS = Date.UTC(2026, 6, 30, 1, 50, 0);
const EARLIEST_SUBMIT_AT_MS = ISSUED_AT_MS + 10 * 60 * 1_000;
const EXPIRES_AT_MS = ISSUED_AT_MS + 20 * 60 * 1_000;
const NONCE = Buffer.alloc(32, 7).toString("base64url");
const RUNNER_SESSION_SECRET = new Uint8Array(Buffer.alloc(32, 8));
const OTHER_RUNNER_SESSION_SECRET = new Uint8Array(Buffer.alloc(32, 9));
const RUNNER_SESSION_DIGEST = digestRunnerSessionSecret(RUNNER_SESSION_SECRET);
const FAST_PATH_CONTRACT_DIGEST = `sha256:${"a".repeat(64)}` as const;
const ATTENDEE_REF_A = parseAttendeeRef("attendee:v1:550e8400-e29b-41d4-a716-446655440000");
const ATTENDEE_REF_B = parseAttendeeRef("attendee:v1:d9428888-122b-4c26-9f8b-6f2f1175e1f4");
const ATTENDEE_AUDIT = buildAttendeeRefAudit([ATTENDEE_REF_A, ATTENDEE_REF_B]);
const OTHER_ATTENDEE_AUDIT = buildAttendeeRefAudit([
  parseAttendeeRef("attendee:v1:00000000-0000-4000-8000-000000000001"),
  parseAttendeeRef("attendee:v1:00000000-0000-4000-8000-000000000002")
]);
const ATTENDEE_SELECTION_FINGERPRINT = buildAttendeeSelectionFingerprint(RUNNER_SESSION_SECRET, [
  JSON.stringify([ATTENDEE_REF_A, "local-display-a"]),
  JSON.stringify([ATTENDEE_REF_B, "local-display-b"])
]);

function binding(overrides: Partial<SubmitCapabilityBinding> = {}): SubmitCapabilityBinding {
  return {
    runId: "run-20260730-001",
    planId: "plan-20260730-001",
    deliveryId: "delivery-20260730-001",
    runnerSessionDigest: RUNNER_SESSION_DIGEST,
    platform: "damai",
    canonicalEventKey: "show-2026-shanghai",
    officialOrigin: "https://detail.damai.cn",
    finalOfficialOrigin: "https://buy.damai.cn",
    fastPathContractDigest: FAST_PATH_CONTRACT_DIGEST,
    eventId: "event-fixture-1",
    eventTitle: "测试演出 上海站",
    quantity: 2,
    requireAdjacent: true,
    attendeeRefCount: ATTENDEE_AUDIT.count,
    attendeeRefFingerprint: ATTENDEE_AUDIT.fingerprint,
    attendeeSelectionFingerprint: ATTENDEE_SELECTION_FINGERPRINT,
    sessionPreferences: [
      { label: "2026-08-08 周六 19:30", priority: 10 },
      { label: "2026-08-09 周日 19:30", priority: 20 }
    ],
    tierPreferences: [
      { label: "看台 580 元", priority: 10, maxUnitPriceFen: 58_000 },
      { label: "看台 780 元", priority: 20, maxUnitPriceFen: 78_000 }
    ],
    maxTotalFen: 120_000,
    ...overrides
  };
}

function issue(value = binding(), options: { nonce?: string } = {}) {
  return issueSubmitCapability(value, SECRET, {
    issuedAtMs: ISSUED_AT_MS,
    earliestSubmitAtMs: EARLIEST_SUBMIT_AT_MS,
    expiresAtMs: EXPIRES_AT_MS,
    nonce: options.nonce ?? createSubmitCapabilityNonce()
  });
}

function controlledConsumer(initialNowMs = ISSUED_AT_MS): {
  consumer: InProcessSubmitCapabilityConsumer;
  setNow: (nowMs: number) => void;
  setWallOnly: (nowMs: number) => void;
} {
  let nowMs = initialNowMs;
  let monotonicMs = 0;
  return {
    consumer: new InProcessSubmitCapabilityConsumer(() => nowMs, () => monotonicMs),
    setNow: (nextNowMs) => {
      monotonicMs += Math.max(1, nextNowMs - nowMs);
      nowMs = nextNowMs;
    },
    setWallOnly: (nextNowMs) => {
      nowMs = nextNowMs;
    }
  };
}

function attempt(overrides: Partial<SubmitCapabilityAttempt> = {}): SubmitCapabilityAttempt {
  return {
    runId: "run-20260730-001",
    planId: "plan-20260730-001",
    deliveryId: "delivery-20260730-001",
    platform: "damai",
    canonicalEventKey: "show-2026-shanghai",
    officialOrigin: "https://detail.damai.cn",
    finalOfficialOrigin: "https://buy.damai.cn",
    fastPathContractDigest: FAST_PATH_CONTRACT_DIGEST,
    eventId: "event-fixture-1",
    eventTitle: "测试演出 上海站",
    quantity: 2,
    requireAdjacent: true,
    adjacentVerified: true,
    attendeeRefCount: ATTENDEE_AUDIT.count,
    attendeeRefFingerprint: ATTENDEE_AUDIT.fingerprint,
    attendeeSelectionFingerprint: ATTENDEE_SELECTION_FINGERPRINT,
    selectedSession: "2026-08-08 周六 19:30",
    selectedSessionPriority: 10,
    selectedTier: "看台 580 元",
    selectedTierPriority: 10,
    selectedTierUnitPriceFen: 58_000,
    observedTotalFen: 116_000,
    ...overrides
  };
}

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    assert.equal((error as Error).message, code);
    return true;
  });
}

test("capability signs every approved event and selection bound without sensitive material", () => {
  const issuedAtMs = Date.now();
  const earliestSubmitAtMs = issuedAtMs;
  const expiresAtMs = issuedAtMs + 60_000;
  const envelope = issueSubmitCapability(binding(), SECRET, {
    issuedAtMs,
    earliestSubmitAtMs,
    expiresAtMs,
    nonce: NONCE
  });
  const claims = verifySubmitCapability(envelope, SECRET);

  assert.equal(claims.runId, "run-20260730-001");
  assert.equal(claims.planId, "plan-20260730-001");
  assert.equal(claims.deliveryId, "delivery-20260730-001");
  assert.equal(claims.runnerSessionDigest, RUNNER_SESSION_DIGEST);
  assert.equal(claims.platform, "damai");
  assert.equal(claims.canonicalEventKey, "show-2026-shanghai");
  assert.equal(claims.officialOrigin, "https://detail.damai.cn");
  assert.equal(claims.finalOfficialOrigin, "https://buy.damai.cn");
  assert.equal(claims.fastPathContractDigest, FAST_PATH_CONTRACT_DIGEST);
  assert.equal(claims.eventId, "event-fixture-1");
  assert.equal(claims.eventTitle, "测试演出 上海站");
  assert.equal(claims.quantity, 2);
  assert.equal(claims.requireAdjacent, true);
  assert.equal(claims.attendeeRefCount, 2);
  assert.equal(claims.attendeeRefFingerprint, ATTENDEE_AUDIT.fingerprint);
  assert.equal(claims.attendeeSelectionFingerprint, ATTENDEE_SELECTION_FINGERPRINT);
  assert.deepEqual(claims.sessionPreferences.map(({ label, priority }) => ({ label, priority })), [
    { label: "2026-08-08 周六 19:30", priority: 10 },
    { label: "2026-08-09 周日 19:30", priority: 20 }
  ]);
  assert.deepEqual(claims.tierPreferences, [
    { label: "看台 580 元", priority: 10, maxUnitPriceFen: 58_000 },
    { label: "看台 780 元", priority: 20, maxUnitPriceFen: 78_000 }
  ]);
  assert.equal(claims.maxTotalFen, 120_000);
  assert.equal(claims.issuedAtMs, issuedAtMs);
  assert.equal(claims.earliestSubmitAtMs, earliestSubmitAtMs);
  assert.equal(claims.expiresAtMs, expiresAtMs);
  assert.equal(claims.nonce, NONCE);
  assert.equal(Object.isFrozen(claims), true);
  assert.equal(Object.isFrozen(claims.sessionPreferences), true);
  assert.equal(Object.isFrozen(claims.sessionPreferences[0]), true);

  const decoded = Buffer.from(envelope.body, "base64url").toString("utf8");
  for (const forbidden of [ATTENDEE_REF_A, ATTENDEE_REF_B, "local-display-a", "cookie", "idCard", "phone", "payment"]) {
    assert.equal(decoded.toLocaleLowerCase("en-US").includes(forbidden.toLowerCase()), false, forbidden);
  }
});

test("official origin is canonical HTTPS and platform scoped", () => {
  assert.equal(canonicalOfficialOrigin("damai", "https://detail.damai.cn"), "https://detail.damai.cn");
  assert.equal(canonicalOfficialOrigin("damai", "https://detail.damai.cn/"), "https://detail.damai.cn");
  for (const invalid of [
    "http://detail.damai.cn",
    "https://detail.damai.cn/item.htm?id=1",
    "https://damai.cn.example.com",
    "https://www.maoyan.com",
    "https://fixture-user:fixture-password@detail.damai.cn",
    "https://detail.damai.cn:444"
  ]) {
    expectCode(() => canonicalOfficialOrigin("damai", invalid), "SUBMIT_CAPABILITY_INPUT_INVALID");
  }
});

test("tampered body, signature, wrong secret, and extra envelope fields fail closed", () => {
  const envelope = issue();
  const changedBody = `${envelope.body[0] === "A" ? "B" : "A"}${envelope.body.slice(1)}`;
  const changedSignature = `${envelope.signature[0] === "A" ? "B" : "A"}${envelope.signature.slice(1)}`;
  const base64urlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const lastSignatureIndex = base64urlAlphabet.indexOf(envelope.signature.at(-1) ?? "");
  const nonCanonicalSignature = `${envelope.signature.slice(0, -1)}${base64urlAlphabet[lastSignatureIndex + 1]}`;
  assert.deepEqual(
    Buffer.from(nonCanonicalSignature, "base64url"),
    Buffer.from(envelope.signature, "base64url"),
    "fixture must change only unused base64 bits"
  );
  expectCode(
    () => verifySubmitCapability({ ...envelope, body: changedBody }, SECRET),
    "SUBMIT_CAPABILITY_INVALID_SIGNATURE"
  );
  expectCode(
    () => verifySubmitCapability({ ...envelope, signature: changedSignature }, SECRET),
    "SUBMIT_CAPABILITY_INVALID_SIGNATURE"
  );
  expectCode(
    () => verifySubmitCapability({ ...envelope, signature: nonCanonicalSignature }, SECRET),
    "SUBMIT_CAPABILITY_ENVELOPE_INVALID"
  );
  expectCode(() => verifySubmitCapability(envelope, OTHER_SECRET), "SUBMIT_CAPABILITY_INVALID_SIGNATURE");
  expectCode(
    () => verifySubmitCapability({ ...envelope, debug: true }, SECRET),
    "SUBMIT_CAPABILITY_ENVELOPE_INVALID"
  );
});

test("future-issued and expired capabilities fail closed against the system clock", () => {
  const nowMs = Date.now();
  const futureEnvelope = issueSubmitCapability(binding(), SECRET, {
    issuedAtMs: nowMs + 60_000,
    earliestSubmitAtMs: nowMs + 60_000,
    expiresAtMs: nowMs + 120_000
  });
  expectCode(
    () => verifySubmitCapability(futureEnvelope, SECRET),
    "SUBMIT_CAPABILITY_FUTURE_ISSUED"
  );
  const expiredEnvelope = issueSubmitCapability(binding(), SECRET, {
    issuedAtMs: nowMs - 120_000,
    earliestSubmitAtMs: nowMs - 90_000,
    expiresAtMs: nowMs - 60_000
  });
  expectCode(() => verifySubmitCapability(expiredEnvelope, SECRET), "SUBMIT_CAPABILITY_EXPIRED");
});

test("issuance rejects weak keys, overlong lifetimes, malformed nonce, and non-canonical bindings", () => {
  expectCode(
    () => issueSubmitCapability(binding(), "short", {
      issuedAtMs: ISSUED_AT_MS,
      earliestSubmitAtMs: EARLIEST_SUBMIT_AT_MS,
      expiresAtMs: EXPIRES_AT_MS
    }),
    "SUBMIT_CAPABILITY_SECRET_TOO_SHORT"
  );
  expectCode(
    () => issueSubmitCapability(binding(), SECRET, {
      issuedAtMs: ISSUED_AT_MS,
      earliestSubmitAtMs: EARLIEST_SUBMIT_AT_MS,
      expiresAtMs: ISSUED_AT_MS + SUBMIT_CAPABILITY_MAX_LIFETIME_MS + 1
    }),
    "SUBMIT_CAPABILITY_INPUT_INVALID"
  );
  expectCode(
    () => issueSubmitCapability(binding(), SECRET, {
      issuedAtMs: ISSUED_AT_MS,
      earliestSubmitAtMs: ISSUED_AT_MS,
      expiresAtMs: ISSUED_AT_MS
    }),
    "SUBMIT_CAPABILITY_INPUT_INVALID"
  );
  expectCode(
    () => issueSubmitCapability(binding(), SECRET, {
      issuedAtMs: ISSUED_AT_MS,
      earliestSubmitAtMs: ISSUED_AT_MS - 1,
      expiresAtMs: EXPIRES_AT_MS
    }),
    "SUBMIT_CAPABILITY_INPUT_INVALID"
  );
  expectCode(
    () => issueSubmitCapability(binding(), SECRET, {
      issuedAtMs: ISSUED_AT_MS,
      earliestSubmitAtMs: EXPIRES_AT_MS,
      expiresAtMs: EXPIRES_AT_MS
    }),
    "SUBMIT_CAPABILITY_INPUT_INVALID"
  );
  expectCode(
    () => issueSubmitCapability(binding(), SECRET, {
      issuedAtMs: ISSUED_AT_MS,
      earliestSubmitAtMs: EARLIEST_SUBMIT_AT_MS,
      expiresAtMs: EXPIRES_AT_MS,
      nonce: "predictable"
    }),
    "SUBMIT_CAPABILITY_INPUT_INVALID"
  );
  expectCode(
    () => issueSubmitCapability(binding(), SECRET, {
      issuedAtMs: ISSUED_AT_MS,
      earliestSubmitAtMs: EARLIEST_SUBMIT_AT_MS,
      expiresAtMs: EXPIRES_AT_MS,
      attendeeName: "must-not-be-an-option"
    } as never),
    "SUBMIT_CAPABILITY_INPUT_INVALID"
  );
  expectCode(
    () => issue(binding({ sessionPreferences: [] })),
    "SUBMIT_CAPABILITY_INPUT_INVALID"
  );
  expectCode(
    () => issue(binding({
      tierPreferences: [
        { label: "二档", priority: 20 },
        { label: "一档", priority: 10 }
      ]
    })),
    "SUBMIT_CAPABILITY_INPUT_INVALID"
  );
  expectCode(
    () => issue(binding({
      sessionPreferences: [
        { label: "同一场次", priority: 10 },
        { label: "同一场次", priority: 20 }
      ]
    })),
    "SUBMIT_CAPABILITY_INPUT_INVALID"
  );
  expectCode(
    () => issue({ ...binding(), attendeeName: "must-not-enter-a-capability" } as SubmitCapabilityBinding),
    "SUBMIT_CAPABILITY_INPUT_INVALID"
  );
  expectCode(
    () => issue(binding({ attendeeRefCount: 1 })),
    "SUBMIT_CAPABILITY_INPUT_INVALID"
  );
  expectCode(
    () => issue(binding({ attendeeRefFingerprint: "sha256:ABC" } as Partial<SubmitCapabilityBinding>)),
    "SUBMIT_CAPABILITY_INPUT_INVALID"
  );
});

test("prepared capability consumes once with no T0 secret or external I/O", () => {
  const envelope = issue();
  const wrongSession = controlledConsumer();
  expectCode(
    () => wrongSession.consumer.prepare(envelope, SECRET, OTHER_RUNNER_SESSION_SECRET),
    "SUBMIT_CAPABILITY_RUNNER_SESSION_MISMATCH"
  );
  const first = controlledConsumer();
  const prepared = first.consumer.prepare(envelope, SECRET, RUNNER_SESSION_SECRET);
  first.setNow(EARLIEST_SUBMIT_AT_MS);
  const claims = first.consumer.consume(prepared, attempt());
  assert.match(claims.nonce, /^[A-Za-z0-9_-]{43}$/u);
  expectCode(
    () => first.consumer.consume(prepared, attempt()),
    "SUBMIT_CAPABILITY_REPLAYED"
  );
  const second = controlledConsumer(EARLIEST_SUBMIT_AT_MS + 1);
  expectCode(
    () => second.consumer.prepare(envelope, SECRET, RUNNER_SESSION_SECRET),
    "SUBMIT_CAPABILITY_REPLAYED"
  );
});

test("signed earliest-submit gate requires both wall and anchored monotonic time", () => {
  const beforeGate = controlledConsumer();
  const preparedBeforeGate = beforeGate.consumer.prepare(issue(), SECRET, RUNNER_SESSION_SECRET);
  beforeGate.setNow(EARLIEST_SUBMIT_AT_MS - 1);
  expectCode(
    () => beforeGate.consumer.consume(preparedBeforeGate, attempt()),
    "SUBMIT_CAPABILITY_TOO_EARLY"
  );
  expectCode(
    () => beforeGate.consumer.consume(preparedBeforeGate, attempt()),
    "SUBMIT_CAPABILITY_REPLAYED"
  );

  const wallJump = controlledConsumer();
  const preparedWallJump = wallJump.consumer.prepare(issue(), SECRET, RUNNER_SESSION_SECRET);
  wallJump.setWallOnly(EARLIEST_SUBMIT_AT_MS);
  expectCode(
    () => wallJump.consumer.consume(preparedWallJump, attempt()),
    "SUBMIT_CAPABILITY_TOO_EARLY"
  );
  expectCode(
    () => wallJump.consumer.consume(preparedWallJump, attempt()),
    "SUBMIT_CAPABILITY_REPLAYED"
  );
});

test("concurrent local consumers yield exactly one winner", async () => {
  const clock = controlledConsumer();
  const prepared = clock.consumer.prepare(issue(), SECRET, RUNNER_SESSION_SECRET);
  const outcomes = await Promise.allSettled([
    Promise.resolve().then(() => {
      clock.setNow(EARLIEST_SUBMIT_AT_MS);
      return clock.consumer.consume(prepared, attempt());
    }),
    Promise.resolve().then(() => clock.consumer.consume(prepared, attempt()))
  ]);
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = outcomes.find((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.ok(rejected);
  assert.equal((rejected.reason as { code?: string }).code, "SUBMIT_CAPABILITY_REPLAYED");
});

test("all event binding mismatches fail and burn the one-shot capability", () => {
  const mutations: Partial<SubmitCapabilityAttempt>[] = [
    { runId: "run-other" },
    { planId: "plan-other" },
    { deliveryId: "delivery-other" },
    { platform: "maoyan" },
    { canonicalEventKey: "other-event" },
    { officialOrigin: "https://www.damai.cn" },
    { finalOfficialOrigin: "https://www.damai.cn" },
    { fastPathContractDigest: `sha256:${"b".repeat(64)}` },
    { eventId: "other-id" },
    { eventTitle: "其他演出" },
    { quantity: 1 },
    { requireAdjacent: false },
    { attendeeRefCount: 1 },
    { attendeeRefFingerprint: OTHER_ATTENDEE_AUDIT.fingerprint },
    { attendeeSelectionFingerprint: `hmac-sha256:${"b".repeat(64)}` }
  ];

  for (const [index, mutation] of mutations.entries()) {
    const uniqueNonce = Buffer.alloc(32, index + 10).toString("base64url");
    const envelope = issueSubmitCapability(binding(), SECRET, {
      issuedAtMs: ISSUED_AT_MS,
      earliestSubmitAtMs: EARLIEST_SUBMIT_AT_MS,
      expiresAtMs: EXPIRES_AT_MS,
      nonce: uniqueNonce
    });
    const clock = controlledConsumer();
    const prepared = clock.consumer.prepare(envelope, SECRET, RUNNER_SESSION_SECRET);
    clock.setNow(EARLIEST_SUBMIT_AT_MS);
    expectCode(
      () => clock.consumer.consume(prepared, attempt(mutation)),
      "SUBMIT_CAPABILITY_BINDING_MISMATCH"
    );
    expectCode(
      () => clock.consumer.consume(prepared, attempt()),
      "SUBMIT_CAPABILITY_REPLAYED"
    );
  }
});

test("unapproved session/tier or priority and excessive/invalid price fail and burn", () => {
  const cases: Array<{ mutation: Partial<SubmitCapabilityAttempt>; code: string }> = [
    { mutation: { adjacentVerified: false }, code: "SUBMIT_CAPABILITY_ADJACENCY_NOT_VERIFIED" },
    { mutation: { selectedSession: "未批准场次" }, code: "SUBMIT_CAPABILITY_SELECTION_MISMATCH" },
    { mutation: { selectedSessionPriority: 20 }, code: "SUBMIT_CAPABILITY_SELECTION_MISMATCH" },
    { mutation: { selectedTier: "未批准票档" }, code: "SUBMIT_CAPABILITY_SELECTION_MISMATCH" },
    { mutation: { selectedTierPriority: 20 }, code: "SUBMIT_CAPABILITY_SELECTION_MISMATCH" },
    {
      mutation: { selectedTierUnitPriceFen: 58_001, observedTotalFen: 116_000 },
      code: "SUBMIT_CAPABILITY_TIER_UNIT_PRICE_LIMIT_EXCEEDED"
    },
    {
      mutation: { selectedTierUnitPriceFen: 58_000, observedTotalFen: 115_999 },
      code: "SUBMIT_CAPABILITY_PRICE_INCONSISTENT"
    },
    { mutation: { observedTotalFen: 120_001 }, code: "SUBMIT_CAPABILITY_PRICE_LIMIT_EXCEEDED" },
    { mutation: { observedTotalFen: -1 }, code: "SUBMIT_CAPABILITY_PRICE_LIMIT_EXCEEDED" }
  ];

  for (const [index, entry] of cases.entries()) {
    const envelope = issueSubmitCapability(binding(), SECRET, {
      issuedAtMs: ISSUED_AT_MS,
      earliestSubmitAtMs: EARLIEST_SUBMIT_AT_MS,
      expiresAtMs: EXPIRES_AT_MS,
      nonce: Buffer.alloc(32, index + 30).toString("base64url")
    });
    const clock = controlledConsumer();
    const prepared = clock.consumer.prepare(envelope, SECRET, RUNNER_SESSION_SECRET);
    clock.setNow(EARLIEST_SUBMIT_AT_MS);
    expectCode(() => clock.consumer.consume(prepared, attempt(entry.mutation)), entry.code);
    expectCode(() => clock.consumer.consume(prepared, attempt()), "SUBMIT_CAPABILITY_REPLAYED");
  }
});

test("capability is rechecked for expiry and future clock movement at T0", () => {
  const futureClock = controlledConsumer(ISSUED_AT_MS - 1);
  expectCode(
    () => futureClock.consumer.prepare(issue(), SECRET, RUNNER_SESSION_SECRET),
    "SUBMIT_CAPABILITY_FUTURE_ISSUED"
  );

  const expiredClock = controlledConsumer();
  const expiredPrepared = expiredClock.consumer.prepare(issue(), SECRET, RUNNER_SESSION_SECRET);
  expiredClock.setNow(EXPIRES_AT_MS);
  expectCode(
    () => expiredClock.consumer.consume(expiredPrepared, attempt()),
    "SUBMIT_CAPABILITY_EXPIRED"
  );
  expectCode(
    () => expiredClock.consumer.consume(expiredPrepared, attempt()),
    "SUBMIT_CAPABILITY_REPLAYED"
  );

  const rollbackClock = controlledConsumer(EARLIEST_SUBMIT_AT_MS + 100);
  const rollbackPrepared = rollbackClock.consumer.prepare(issue(), SECRET, RUNNER_SESSION_SECRET);
  rollbackClock.setNow(EARLIEST_SUBMIT_AT_MS + 99);
  expectCode(
    () => rollbackClock.consumer.consume(rollbackPrepared, attempt()),
    "SUBMIT_CAPABILITY_INPUT_INVALID"
  );
  rollbackClock.setNow(EARLIEST_SUBMIT_AT_MS + 101);
  expectCode(
    () => rollbackClock.consumer.consume(rollbackPrepared, attempt()),
    "SUBMIT_CAPABILITY_REPLAYED"
  );
});

test("process-wide nonce tombstones cannot be bypassed by a second consumer instance", () => {
  const envelope = issue();
  const first = controlledConsumer();
  const prepared = first.consumer.prepare(envelope, SECRET, RUNNER_SESSION_SECRET);
  first.setNow(EARLIEST_SUBMIT_AT_MS);
  first.consumer.consume(prepared, attempt());
  const second = controlledConsumer(EARLIEST_SUBMIT_AT_MS + 1);
  expectCode(() => second.consumer.prepare(envelope, SECRET, RUNNER_SESSION_SECRET), "SUBMIT_CAPABILITY_REPLAYED");
});

test("a forged prepared object is never accepted", () => {
  const clock = controlledConsumer();
  const genuine = clock.consumer.prepare(issue(), SECRET, RUNNER_SESSION_SECRET);
  const forged = { claims: genuine.claims };
  const consumer = controlledConsumer().consumer;
  expectCode(
    () => consumer.consume(forged, attempt()),
    "SUBMIT_CAPABILITY_NOT_PREPARED"
  );
});
