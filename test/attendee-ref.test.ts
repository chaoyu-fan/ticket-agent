import assert from "node:assert/strict";
import test from "node:test";

import {
  ATTENDEE_REF_AUDIT_SCHEMA,
  assertAttendeePersistenceBoundary,
  buildAttendeeRefAudit,
  createAttendeeRef,
  isAttendeeRef,
  parseAttendeeRef,
  serializeAttendeeRefAudit
} from "../src/identity/attendee-ref.js";

const self = "attendee:v1:550e8400-e29b-41d4-a716-446655440000";
const guest = "attendee:v1:d9428888-122b-4c26-9f8b-6f2f1175e1f4";

test("只接受规范化、非语义的 attendee UUIDv4 引用", () => {
  assert.equal(isAttendeeRef(self), true);
  assert.equal(parseAttendeeRef(self), self);

  for (const unsafe of [
    "本人",
    "张三",
    "13800138000",
    "110101199001011234",
    "person@example.com",
    "self-01",
    ` ${self}`,
    self.toUpperCase(),
    "attendee:v1:550e8400-e29b-11d4-a716-446655440000",
    "attendee:v1:550e8400-e29b-41d4-7716-446655440000",
    null,
    { ref: self }
  ]) {
    assert.equal(isAttendeeRef(unsafe), false);
    assert.throws(() => parseAttendeeRef(unsafe), /ATTENDEE_REF_INVALID/);
  }
});

test("新引用由随机 UUIDv4 生成且可直接通过边界校验", () => {
  const first = createAttendeeRef();
  const second = createAttendeeRef();
  assert.equal(isAttendeeRef(first), true);
  assert.equal(isAttendeeRef(second), true);
  assert.notEqual(first, second);
});

test("持久化边界兼容空旧字段但拒绝任何非空 alias", () => {
  assert.doesNotThrow(() => assertAttendeePersistenceBoundary({ attendeeRefs: [self], attendeeAliases: [] }));
  const unsafe = "LOCAL_DISPLAY_VALUE";
  let thrown: unknown;
  try {
    assertAttendeePersistenceBoundary({ attendeeRefs: [self], attendeeAliases: [unsafe] });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error);
  assert.match(thrown.message, /ATTENDEE_ALIASES_PERSISTENCE_BLOCKED/);
  assert.equal(thrown.message.includes(unsafe), false);
});

test("审计序列化只输出数量和指纹，不输出原始引用", () => {
  const serialized = serializeAttendeeRefAudit([self, guest]);
  const parsed = JSON.parse(serialized) as Record<string, unknown>;

  assert.deepEqual(Object.keys(parsed).sort(), ["count", "fingerprint", "schema"]);
  assert.equal(parsed.schema, ATTENDEE_REF_AUDIT_SCHEMA);
  assert.equal(parsed.count, 2);
  assert.match(String(parsed.fingerprint), /^sha256:[0-9a-f]{64}$/);
  assert.equal(serialized.includes(self), false);
  assert.equal(serialized.includes(guest), false);
  assert.equal(serialized, serializeAttendeeRefAudit([self, guest]));
  assert.notEqual(serialized, serializeAttendeeRefAudit([guest, self]));
});

test("敏感观演人值无法进入审计，错误信息也不回显该值", () => {
  const sensitiveValues = ["张三", "13800138000", "110101199001011234"];

  for (const sensitive of sensitiveValues) {
    let thrown: unknown;
    try {
      serializeAttendeeRefAudit([sensitive]);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof Error);
    assert.match(thrown.message, /ATTENDEE_REF_INVALID/);
    assert.equal(thrown.message.includes(sensitive), false);
  }
});

test("审计拒绝非数组和重复引用", () => {
  assert.throws(
    () => buildAttendeeRefAudit({ attendeeRefs: [self] }),
    /ATTENDEE_REFS_INVALID:expected an array/
  );
  assert.throws(
    () => buildAttendeeRefAudit([self, self]),
    /ATTENDEE_REFS_INVALID:duplicate opaque reference/
  );
});

test("审计不调用不可信输入的 toJSON", () => {
  let called = false;
  const malicious = {
    toJSON(): string {
      called = true;
      return self;
    }
  };

  assert.throws(() => serializeAttendeeRefAudit([malicious]), /ATTENDEE_REF_INVALID/);
  assert.equal(called, false);
});
