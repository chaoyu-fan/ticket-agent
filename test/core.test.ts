import assert from "node:assert/strict";
import test from "node:test";
import { canAutoSubmit, normalizePlan, validatePlan } from "../src/core/policy.js";
import { canTransition, transition } from "../src/core/state.js";
import type { WatchPlan } from "../src/core/types.js";
import { parseAttendeeRef } from "../src/identity/attendee-ref.js";

const ATTENDEE_REF_A = parseAttendeeRef("attendee:v1:550e8400-e29b-41d4-a716-446655440000");
const ATTENDEE_REF_B = parseAttendeeRef("attendee:v1:d9428888-122b-4c26-9f8b-6f2f1175e1f4");

function completePlan(overrides: Partial<WatchPlan> = {}): WatchPlan {
  const now = "2026-07-28T00:00:00.000Z";
  return {
    id: "plan-test-001",
    platform: "damai",
    officialUrl: "https://detail.damai.cn/item.htm?id=123456",
    eventId: "123456",
    eventTitle: "测试演唱会 上海站",
    canonicalEventKey: "test-show-2026-shanghai",
    saleAt: "2026-08-01T10:00:00+08:00",
    quantity: 1,
    requireAdjacent: false,
    sessions: [],
    tiers: [],
    priceStrategy: "CHEAPEST_FIRST",
    attendeeRefs: [ATTENDEE_REF_A],
    attendeeAliases: ["local-display-a"],
    autoSubmitOrder: false,
    status: "DRAFT",
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

test("未指定偏好时默认购买 1 张并优先最低价", () => {
  const plan = normalizePlan({ platform: "damai" });

  assert.equal(plan.quantity, 1);
  assert.equal(plan.priceStrategy, "CHEAPEST_FIRST");
  assert.equal(plan.autoSubmitOrder, false);
});

test("未设置最高总价时禁止开启自动提交", () => {
  const validation = validatePlan({
    platform: "damai",
    officialUrl: "https://detail.damai.cn/item.htm?id=123456",
    attendeeRefs: [ATTENDEE_REF_A],
    autoSubmitOrder: true
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes("autoSubmitOrder requires maxTotalFen"));
  assert.equal(canAutoSubmit(completePlan({ autoSubmitOrder: true }), 38_000), false);
});

test("只接受与计划平台匹配的 HTTPS 官方域名", () => {
  const accepted = ["https://www.damai.cn/", "https://detail.damai.cn/item.htm?id=123456"];
  const rejected = [
    "http://detail.damai.cn/item.htm?id=123456",
    "https://damai.cn.example.com/item/123456",
    "https://example.com/damai.cn/item/123456",
    "https://www.maoyan.com/films/123456",
    "javascript:alert(1)"
  ];

  for (const officialUrl of accepted) {
    assert.equal(validatePlan({ platform: "damai", officialUrl }).ok, true, officialUrl);
  }
  for (const officialUrl of rejected) {
    const result = validatePlan({ platform: "damai", officialUrl });
    assert.equal(result.ok, false, officialUrl);
    assert.ok(result.errors.some((error) => error.startsWith("officialUrl must be")), officialUrl);
  }

  assert.equal(validatePlan({ platform: "maoyan", officialUrl: "https://www.maoyan.com/films/123456" }).ok, true);
});

test("状态机拒绝跳过必要步骤的非法跳转", () => {
  assert.equal(canTransition("SCHEDULED", "SUCCESS"), false);
  assert.throws(() => transition("SCHEDULED", "SUCCESS"), {
    message: "INVALID_TRANSITION:SCHEDULED->SUCCESS"
  });
  assert.equal(transition("SCHEDULED", "PREWARM"), "PREWARM");
  assert.equal(transition("WAIT_FOR_SALE", "PAGE_CHANGED"), "PAGE_CHANGED");
  assert.equal(transition("OFFICIAL_QUEUE", "PAGE_CHANGED"), "PAGE_CHANGED");
});

test("开售时间必须包含明确时区以避免 Mac 时区漂移", () => {
  assert.equal(validatePlan({ platform: "damai", saleAt: "2026-08-01T10:00:00+08:00" }).ok, true);
  assert.equal(validatePlan({ platform: "damai", saleAt: "2026-08-01T02:00:00Z" }).ok, true);
  const ambiguous = validatePlan({ platform: "damai", saleAt: "2026-08-01T10:00:00" });
  assert.equal(ambiguous.ok, false);
  assert.ok(ambiguous.errors.some((error) => /explicit timezone/.test(error)));
});

test("运行时计划校验拒绝未知策略和畸形数组而不抛异常", () => {
  assert.doesNotThrow(() => validatePlan({ platform: "damai", priceStrategy: "UNKNOWN" } as never));
  assert.equal(validatePlan({ platform: "damai", priceStrategy: "UNKNOWN" } as never).ok, false);
  assert.equal(validatePlan({ platform: "damai", sessions: [{ label: 123 }] } as never).ok, false);
  assert.throws(() => normalizePlan({ platform: "damai", tiers: "not-an-array" } as never), /PLAN_SHAPE_INVALID/);
});

test("自动提交要求 opaque attendeeRefs 唯一且与票数完全一致", () => {
  const common = {
    platform: "damai" as const,
    officialUrl: "https://detail.damai.cn/item.htm?id=123456",
    eventId: "123456",
    eventTitle: "测试演唱会 上海站",
    canonicalEventKey: "test-show-2026-shanghai",
    saleAt: "2026-08-01T10:00:00+08:00",
    maxTotalFen: 100_000,
    quantity: 2,
    autoSubmitOrder: true
  };
  assert.equal(validatePlan({ ...common, attendeeRefs: [ATTENDEE_REF_A, ATTENDEE_REF_A] }).ok, false);
  assert.equal(validatePlan({ ...common, attendeeRefs: [ATTENDEE_REF_A] }).ok, false);
  assert.equal(validatePlan({ ...common, attendeeRefs: [ATTENDEE_REF_A, ATTENDEE_REF_B] }).ok, true);
  assert.equal(validatePlan({ ...common, attendeeRefs: ["local-display-a", ATTENDEE_REF_B] as never }).ok, false);
});

test("自动提交要求稳定 canonical 身份并同时绑定活动 ID 和标题", () => {
  const common = {
    platform: "damai" as const,
    officialUrl: "https://detail.damai.cn/item.htm?id=123456",
    eventId: "123456",
    eventTitle: "测试演唱会 上海站",
    canonicalEventKey: "test-show-2026-shanghai",
    saleAt: "2026-08-01T10:00:00+08:00",
    maxTotalFen: 100_000,
    attendeeRefs: [ATTENDEE_REF_A],
    autoSubmitOrder: true
  };

  assert.equal(validatePlan(common).ok, true);
  for (const field of ["canonicalEventKey", "eventId", "eventTitle"] as const) {
    const invalid = { ...common, [field]: "   " };
    assert.equal(validatePlan(invalid).ok, false, field);
  }
  assert.equal(canAutoSubmit(completePlan({ autoSubmitOrder: true, maxTotalFen: 100_000 }), 38_000), true);
  for (const field of ["canonicalEventKey", "eventId", "eventTitle"] as const) {
    const incomplete = completePlan({ autoSubmitOrder: true, maxTotalFen: 100_000 });
    delete incomplete[field];
    assert.equal(canAutoSubmit(incomplete, 38_000), false, field);
  }
});

test("自动提交必须绑定带时区的 saleAt 作为最早提交时间", () => {
  const complete = completePlan({ autoSubmitOrder: true, maxTotalFen: 100_000 });
  assert.equal(validatePlan(complete).ok, true);
  assert.equal(canAutoSubmit(complete, 38_000), true);

  const missing = { ...complete };
  delete missing.saleAt;
  const validation = validatePlan(missing);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes("autoSubmitOrder requires saleAt with an explicit timezone"));
  assert.equal(canAutoSubmit(missing, 38_000), false);
});
