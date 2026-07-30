import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import type { RunnerEvent, RunState, WatchPlanInput } from "../src/core/types.js";
import { closeController, createControllerHttpServer, listenController } from "../src/controller/http.js";
import { ControllerError } from "../src/controller/errors.js";
import { ControllerStore, eventKeyForPlan } from "../src/controller/store.js";

const ATTENDEE_REF_A = "attendee:v1:550e8400-e29b-41d4-a716-446655440000" as const;
const ATTENDEE_REF_B = "attendee:v1:d9428888-122b-4c26-9f8b-6f2f1175e1f4" as const;

function memoryStore(): ControllerStore {
  let nextId = 0;
  let tick = 0;
  return new ControllerStore(":memory:", {
    idFactory: () => `id-${++nextId}`,
    now: () => new Date(Date.UTC(2026, 6, 28, 0, 0, tick++)).toISOString()
  });
}

function safePlan(overrides: Partial<WatchPlanInput> = {}): WatchPlanInput {
  return {
    platform: "damai",
    officialUrl: "https://www.damai.cn/item/123?utm_source=test",
    eventId: "123",
    eventTitle: "测试演唱会 上海站",
    canonicalEventKey: "test-show-2026-shanghai",
    saleAt: "2026-08-01T10:00:00+08:00",
    quantity: 1,
    maxTotalFen: 88_000,
    attendeeRefs: [ATTENDEE_REF_A],
    autoSubmitOrder: true,
    ...overrides
  };
}

function move(store: ControllerStore, runId: string, state: RunState, extra: Partial<RunnerEvent> = {}): void {
  store.applyRunnerEvent({ runId, state, ...extra });
}

function reachVerifyPrice(store: ControllerStore, runId: string, observedTotalFen = 68_000): void {
  const states: RunState[] = [
    "PREWARM",
    "LOGIN_READY",
    "WAIT_FOR_SALE",
    "OFFICIAL_QUEUE",
    "SELECT_SESSION",
    "SELECT_TIER",
    "SELECT_QUANTITY",
    "SELECT_ATTENDEE"
  ];
  for (const state of states) {
    move(store, runId, state, {
      ...(state === "SELECT_SESSION" ? { selectedSession: "首场" } : {}),
      ...(state === "SELECT_TIER" ? { selectedTier: "最低价" } : {})
    });
  }
  move(store, runId, "VERIFY_PRICE", { observedTotalFen });
}

function assertControllerCode(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => error instanceof ControllerError && error.code === code;
}

test("plan CRUD applies safe defaults and only drafts are editable/deletable", () => {
  const store = memoryStore();
  try {
    const plan = store.createPlan({
      platform: "damai",
      eventTitle: "  示例活动  ",
      canonicalEventKey: "show-2026-shanghai",
      sessions: [
        { label: "第二场", priority: 2 },
        { label: "第一场", priority: 1 }
      ]
    });
    assert.equal(plan.status, "DRAFT");
    assert.equal(plan.quantity, 1);
    assert.equal(plan.priceStrategy, "CHEAPEST_FIRST");
    assert.equal(plan.autoSubmitOrder, false);
    assert.equal(plan.canonicalEventKey, "show-2026-shanghai");
    assert.deepEqual(
      plan.sessions.map((session) => session.label),
      ["第一场", "第二场"]
    );

    const updated = store.updatePlan(plan.id, {
      officialUrl: "https://detail.damai.cn/item.htm?id=123",
      eventTitle: null,
      canonicalEventKey: "show-2026-shanghai-v2",
      quantity: 2,
      attendeeRefs: [ATTENDEE_REF_A, ATTENDEE_REF_B]
    });
    assert.equal(updated.eventTitle, undefined);
    assert.equal(updated.canonicalEventKey, "show-2026-shanghai-v2");
    assert.equal(updated.quantity, 2);
    assert.deepEqual(updated.attendeeRefs, [ATTENDEE_REF_A, ATTENDEE_REF_B]);
    assert.deepEqual(updated.attendeeAliases, []);
    assert.equal(store.listPlans().length, 1);

    store.deletePlan(plan.id);
    assert.equal(store.getPlan(plan.id), undefined);
    assert.equal(store.listPlans().length, 0);
  } finally {
    store.close();
  }
});

test("controller persistence accepts only opaque refs and never writes resolved labels", () => {
  const store = memoryStore();
  const unsafe = "LOCAL_DISPLAY_VALUE";
  try {
    let thrown: unknown;
    try {
      store.createPlan({ platform: "damai", attendeeAliases: [unsafe] });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof ControllerError);
    assert.equal(thrown.code, "PLAN_INVALID");
    assert.equal(JSON.stringify(thrown).includes(unsafe), false);

    const plan = store.createPlan({ platform: "damai", attendeeRefs: [ATTENDEE_REF_A] });
    const row = store.database.prepare(`
      SELECT attendee_refs_json, attendee_aliases_json FROM watch_plans WHERE id = ?
    `).get(plan.id) as { attendee_refs_json: string; attendee_aliases_json: string };
    assert.equal(row.attendee_refs_json, JSON.stringify([ATTENDEE_REF_A]));
    assert.equal(row.attendee_aliases_json, "[]");
    assert.deepEqual(store.requirePlan(plan.id).attendeeRefs, [ATTENDEE_REF_A]);
    assert.deepEqual(store.requirePlan(plan.id).attendeeAliases, []);
  } finally {
    store.close();
  }
});

test("submit and success require explicit controller methods and are audited", () => {
  const store = memoryStore();
  try {
    const draft = store.createPlan({
      platform: "damai",
      officialUrl: "https://www.damai.cn/item/123",
      eventTitle: "测试演唱会 上海站",
      canonicalEventKey: "test-show-manual-submit",
      autoSubmitOrder: false
    });
    const armed = store.armPlan(draft.id);
    assert.equal(armed.plan.status, "ARMED");
    assert.equal(armed.run.state, "SCHEDULED");

    reachVerifyPrice(store, armed.run.id, 68_000);
    const review = store.applyRunnerEvent({ runId: armed.run.id, state: "REVIEW_REQUIRED" });
    assert.equal(review.state, "REVIEW_REQUIRED");
    assert.equal(store.getPurchaseLockForRun(review.id), undefined);

    assert.throws(
      () => store.applyRunnerEvent({ runId: armed.run.id, state: "SUBMIT_ORDER" }),
      assertControllerCode("SUBMIT_AUTHORIZATION_REQUIRED")
    );
    const approval = store.authorizeSubmit(armed.run.id, {
      confirmation: "APPROVE_SUBMIT",
      observedTotalFen: 68_000
    });
    assert.equal(approval.allowed, true);
    const submitting = approval.run;
    assert.equal(submitting.state, "SUBMIT_ORDER");
    assert.equal(store.getPurchaseLockForRun(submitting.id)?.status, "HELD");
    assert.throws(
      () => store.authorizeSubmit(armed.run.id, { confirmation: "APPROVE_SUBMIT", observedTotalFen: 68_000 }),
      assertControllerCode("SUBMIT_ALREADY_AUTHORIZED")
    );
    assert.throws(
      () => move(store, submitting.id, "PAY_REQUIRED"),
      assertControllerCode("ORDER_REFERENCE_REQUIRED")
    );
    assert.throws(
      () => move(store, submitting.id, "PAY_REQUIRED", { orderReference: "   " }),
      assertControllerCode("ORDER_REFERENCE_REQUIRED")
    );
    assert.equal(store.requireRun(submitting.id).state, "SUBMIT_ORDER");
    move(store, submitting.id, "PAY_REQUIRED", { orderReference: "order-1" });
    assert.throws(
      () => move(store, submitting.id, "PAY_REQUIRED", { orderReference: "order-2" }),
      assertControllerCode("ORDER_REFERENCE_MISMATCH")
    );
    assert.throws(
      () => move(store, submitting.id, "HUMAN_TAKEOVER", { orderReference: "order-1" }),
      assertControllerCode("ORDER_REFERENCE_OUT_OF_PHASE")
    );
    assert.equal(store.requireRun(submitting.id).orderReference, "order-1");
    assert.throws(
      () => move(store, submitting.id, "SUCCESS"),
      assertControllerCode("SUCCESS_CONFIRMATION_REQUIRED")
    );
    const succeeded = store.confirmSuccess(submitting.id, {
      confirmation: "ORDER_EXISTS",
      orderReference: "order-1"
    });

    assert.equal(succeeded.state, "SUCCESS");
    assert.equal(store.requirePlan(draft.id).status, "COMPLETED");
    assert.equal(store.getPurchaseLockForRun(submitting.id)?.status, "PURCHASED");
    const runAudit = store.getRunAudit(submitting.id);
    assert.equal(runAudit[0]?.fromState, undefined);
    assert.equal(runAudit[0]?.toState, "SCHEDULED");
    assert.ok(runAudit.some((entry) => entry.toState === "REVIEW_REQUIRED"));
    assert.equal(runAudit.at(-1)?.toState, "SUCCESS");
    assert.deepEqual(
      store.getPlanAudit(draft.id).map((entry) => entry.toStatus),
      ["DRAFT", "ARMED", "RUNNING", "COMPLETED"]
    );
  } finally {
    store.close();
  }
});

test("plan cancellation is rejected after submit authorization without changing plan, run, lock, or audits", () => {
  const store = memoryStore();
  try {
    const { plan, run } = store.armPlan(store.createPlan(safePlan()).id);
    reachVerifyPrice(store, run.id);
    const authorized = store.authorizeSubmit(run.id, {
      confirmation: "APPROVE_SUBMIT",
      observedTotalFen: 68_000
    }).run;
    assert.equal(authorized.state, "SUBMIT_ORDER");

    const planBefore = store.requirePlan(plan.id);
    const runBefore = store.requireRun(run.id);
    const lockBefore = store.getPurchaseLockForRun(run.id);
    const planAuditBefore = store.getPlanAudit(plan.id);
    const runAuditBefore = store.getRunAudit(run.id);

    assert.throws(() => store.cancelPlan(plan.id), assertControllerCode("PLAN_NOT_CANCELLABLE_AFTER_SUBMIT"));
    assert.deepEqual(store.requirePlan(plan.id), planBefore);
    assert.deepEqual(store.requireRun(run.id), runBefore);
    assert.deepEqual(store.getPurchaseLockForRun(run.id), lockBefore);
    assert.deepEqual(store.getPlanAudit(plan.id), planAuditBefore);
    assert.deepEqual(store.getRunAudit(run.id), runAuditBefore);
  } finally {
    store.close();
  }
});

test("plan cancellation is rejected from PAY_REQUIRED without changing order evidence or purchase lock", () => {
  const store = memoryStore();
  try {
    const { plan, run } = store.armPlan(store.createPlan(safePlan()).id);
    reachVerifyPrice(store, run.id);
    store.authorizeSubmit(run.id, {
      confirmation: "APPROVE_SUBMIT",
      observedTotalFen: 68_000
    });
    move(store, run.id, "PAY_REQUIRED", { orderReference: "cancel-safety-order" });

    const planBefore = store.requirePlan(plan.id);
    const runBefore = store.requireRun(run.id);
    const lockBefore = store.getPurchaseLockForRun(run.id);

    assert.throws(() => store.cancelPlan(plan.id), assertControllerCode("PLAN_NOT_CANCELLABLE_AFTER_SUBMIT"));
    assert.deepEqual(store.requirePlan(plan.id), planBefore);
    assert.deepEqual(store.requireRun(run.id), runBefore);
    assert.deepEqual(store.getPurchaseLockForRun(run.id), lockBefore);
  } finally {
    store.close();
  }
});

test("a sticky purchase lock rejects cancellation even after the submitted run becomes FAILED", () => {
  const store = memoryStore();
  try {
    const { plan, run } = store.armPlan(store.createPlan(safePlan()).id);
    reachVerifyPrice(store, run.id);
    store.authorizeSubmit(run.id, {
      confirmation: "APPROVE_SUBMIT",
      observedTotalFen: 68_000
    });
    move(store, run.id, "FAILED");
    assert.equal(store.requireRun(run.id).state, "FAILED");
    assert.equal(store.getPurchaseLockForRun(run.id)?.status, "HELD");

    const planBefore = store.requirePlan(plan.id);
    const runBefore = store.requireRun(run.id);
    const lockBefore = store.getPurchaseLockForRun(run.id);
    assert.throws(() => store.cancelPlan(plan.id), assertControllerCode("PLAN_NOT_CANCELLABLE_AFTER_SUBMIT"));
    assert.deepEqual(store.requirePlan(plan.id), planBefore);
    assert.deepEqual(store.requireRun(run.id), runBefore);
    assert.deepEqual(store.getPurchaseLockForRun(run.id), lockBefore);
  } finally {
    store.close();
  }
});

test("plan cancellation before submit authorization still cancels the plan and fails its active run", () => {
  const store = memoryStore();
  try {
    const { plan, run } = store.armPlan(store.createPlan(safePlan()).id);
    reachVerifyPrice(store, run.id);
    assert.equal(store.getPurchaseLockForRun(run.id), undefined);

    const cancelled = store.cancelPlan(plan.id);
    assert.equal(cancelled.plan.status, "CANCELLED");
    assert.equal(cancelled.run?.state, "FAILED");
    assert.equal(cancelled.run?.lastError, "PLAN_CANCELLED");
    assert.equal(store.getPurchaseLockForRun(run.id), undefined);
    assert.equal(store.getPlanAudit(plan.id).at(-1)?.reason, "PLAN_CANCELLED");
    assert.equal(store.getRunAudit(run.id).at(-1)?.message, "PLAN_CANCELLED");
  } finally {
    store.close();
  }
});

test("arming requires canonicalEventKey even when title, ID and URL provide diagnostic fallbacks", () => {
  const store = memoryStore();
  try {
    const draft = store.createPlan({
      platform: "damai",
      officialUrl: "https://www.damai.cn/item/123?utm_source=tracking-a",
      eventId: "123",
      eventTitle: "测试演唱会 上海站",
      autoSubmitOrder: false
    });
    assert.ok(eventKeyForPlan(draft), "fallback remains available for draft diagnostics");
    assert.throws(() => store.armPlan(draft.id), assertControllerCode("EVENT_IDENTITY_REQUIRED"));
    assert.equal(store.requirePlan(draft.id).status, "DRAFT");
    assert.equal(store.listRuns(draft.id).length, 0);
  } finally {
    store.close();
  }
});

test("price limit is fail-closed before submit", () => {
  const store = memoryStore();
  try {
    const { run } = store.armPlan(store.createPlan(safePlan({ maxTotalFen: 50_000 })).id);
    reachVerifyPrice(store, run.id, 50_001);
    assert.throws(
      () => store.authorizeSubmit(run.id, { confirmation: "APPROVE_SUBMIT", observedTotalFen: 50_001 }),
      assertControllerCode("PRICE_LIMIT_EXCEEDED")
    );
    const blocked = store.requireRun(run.id);
    assert.equal(blocked.state, "VERIFY_PRICE");
    assert.equal(store.getPurchaseLockForRun(run.id), undefined);
  } finally {
    store.close();
  }
});

test("verified price and selection snapshots cannot be overwritten", () => {
  const store = memoryStore();
  try {
    const { run } = store.armPlan(store.createPlan(safePlan()).id);
    reachVerifyPrice(store, run.id, 68_000);
    const verified = store.requireRun(run.id);
    assert.equal(verified.observedTotalFen, 68_000);
    assert.ok(verified.priceVerifiedAt);

    assert.throws(
      () => move(store, run.id, "VERIFY_PRICE", { observedTotalFen: 1 }),
      assertControllerCode("PRICE_SNAPSHOT_MISMATCH")
    );
    assert.throws(
      () => move(store, run.id, "REVIEW_REQUIRED", { selectedTier: "高价票" }),
      assertControllerCode("SELECTION_SNAPSHOT_MISMATCH")
    );
    const unchanged = store.requireRun(run.id);
    assert.equal(unchanged.observedTotalFen, 68_000);
    assert.equal(unchanged.selectedTier, "最低价");
  } finally {
    store.close();
  }
});

test("a first price observation outside VERIFY_PRICE is rejected", () => {
  const store = memoryStore();
  try {
    const { run } = store.armPlan(store.createPlan(safePlan()).id);
    move(store, run.id, "PREWARM", { observedTotalFen: 1 });
    assert.fail("out-of-phase price was accepted");
  } catch (error) {
    assert.equal(assertControllerCode("PRICE_OBSERVATION_OUT_OF_PHASE")(error), true);
  } finally {
    store.close();
  }
});

test("canonical event identity takes priority and blocks a cross-platform duplicate atomically", () => {
  const store = memoryStore();
  try {
    const damai = store.createPlan(
      safePlan({
        officialUrl: "https://www.damai.cn/item/123?utm_source=damai&utm_campaign=summer",
        eventId: "damai-123",
        eventTitle: "大麦标题",
        canonicalEventKey: "artist-2026-08-01-shanghai"
      })
    );
    const maoyan = store.createPlan(
      safePlan({
        platform: "maoyan",
        officialUrl: "https://www.maoyan.com/show/456?utm_source=maoyan&utm_campaign=other",
        eventId: "maoyan-456",
        eventTitle: "猫眼的不同标题",
        canonicalEventKey: "ARTIST 2026/08/01 SHANGHAI"
      })
    );
    assert.equal(eventKeyForPlan(damai), eventKeyForPlan(maoyan));

    const damaiRun = store.armPlan(damai.id).run;
    const maoyanRun = store.armPlan(maoyan.id).run;
    reachVerifyPrice(store, damaiRun.id);
    reachVerifyPrice(store, maoyanRun.id);

    const first = store.authorizeSubmit(damaiRun.id, {
      confirmation: "APPROVE_SUBMIT",
      observedTotalFen: 68_000
    });
    assert.equal(first.run.state, "SUBMIT_ORDER");
    const duplicate = store.authorizeSubmit(maoyanRun.id, {
      confirmation: "APPROVE_SUBMIT",
      observedTotalFen: 68_000
    });
    assert.equal(duplicate.allowed, false);
    assert.equal(duplicate.run.state, "DUPLICATE_BLOCKED");
    assert.equal(duplicate.run.lastError, "DUPLICATE_PURCHASE_LOCKED");
    assert.equal(store.getPurchaseLockForRun(damaiRun.id)?.planId, damai.id);
    assert.equal(store.getPurchaseLockForRun(maoyanRun.id), undefined);

    const duplicateAudit = store.getRunAudit(maoyanRun.id);
    assert.equal(duplicateAudit.at(-1)?.toState, "DUPLICATE_BLOCKED");
  } finally {
    store.close();
  }
});

test("submit authorization refuses a legacy run whose canonical identity disappeared", () => {
  const store = memoryStore();
  try {
    const { plan, run } = store.armPlan(store.createPlan(safePlan()).id);
    store.database
      .prepare("UPDATE watch_plans SET canonical_event_key = NULL, event_key = ? WHERE id = ?")
      .run("url:item123utmlegacy", plan.id);
    reachVerifyPrice(store, run.id);

    assert.throws(
      () => store.authorizeSubmit(run.id, { confirmation: "APPROVE_SUBMIT", observedTotalFen: 68_000 }),
      assertControllerCode("EVENT_IDENTITY_REQUIRED")
    );
    assert.equal(store.getPurchaseLockForRun(run.id), undefined);
  } finally {
    store.close();
  }
});

test("held locks require a user-confirmed exact event key before reconciliation", () => {
  const store = memoryStore();
  try {
    const { run } = store.armPlan(store.createPlan(safePlan({ canonicalEventKey: "reconcile-show" })).id);
    reachVerifyPrice(store, run.id);
    assert.equal(
      store.authorizeSubmit(run.id, { confirmation: "APPROVE_SUBMIT", observedTotalFen: 68_000 }).allowed,
      true
    );
    move(store, run.id, "FAILED");
    const lock = store.getPurchaseLockForRun(run.id);
    assert.ok(lock);

    assert.throws(
      () =>
        store.reconcileNoOrder(run.id, {
          confirmation: "NO_ORDER_EXISTS",
          eventKey: "canonical:another-show",
          confirmedByUser: true
        }),
      assertControllerCode("EVENT_KEY_MISMATCH")
    );
    assert.ok(store.getPurchaseLockForRun(run.id));
    store.reconcileNoOrder(run.id, {
      confirmation: "NO_ORDER_EXISTS",
      eventKey: lock.eventKey,
      confirmedByUser: true
    });
    assert.equal(store.getPurchaseLockForRun(run.id), undefined);
    assert.equal(store.getRunAudit(run.id).at(-1)?.message, "NO_ORDER_CONFIRMED_LOCK_RELEASED");
  } finally {
    store.close();
  }
});

test("legacy databases migrate additively and database files stay owner-only", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ticket-agent-controller-"));
  const databasePath = path.join(directory, "legacy.sqlite");
  try {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE watch_plans (
        id TEXT PRIMARY KEY, platform TEXT NOT NULL, official_url TEXT, event_id TEXT,
        event_title TEXT, sale_at TEXT, quantity INTEGER NOT NULL, require_adjacent INTEGER NOT NULL,
        sessions_json TEXT NOT NULL, tiers_json TEXT NOT NULL, max_total_fen INTEGER,
        price_strategy TEXT NOT NULL, attendee_aliases_json TEXT NOT NULL,
        auto_submit_order INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE purchase_runs (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES watch_plans(id), state TEXT NOT NULL,
        observed_total_fen INTEGER, selected_session TEXT, selected_tier TEXT, order_reference TEXT,
        last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE purchase_locks (
        event_key TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES purchase_runs(id) ON DELETE RESTRICT,
        plan_id TEXT NOT NULL REFERENCES watch_plans(id) ON DELETE RESTRICT,
        status TEXT NOT NULL CHECK(status IN ('HELD', 'PURCHASED')),
        acquired_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO watch_plans VALUES (
        'legacy-plan', 'damai', 'https://www.damai.cn/item/legacy', NULL, '旧活动', NULL,
        1, 0, '[]', '[]', 88000, 'CHEAPEST_FIRST', '["本人"]', 1, 'RUNNING',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'
      );
      INSERT INTO purchase_runs VALUES (
        'legacy-run', 'legacy-plan', 'VERIFY_PRICE', 68000, '首场', '最低价', NULL, NULL,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:02.000Z'
      );
      INSERT INTO purchase_locks VALUES (
        'canonical:legacy-show', 'legacy-run', 'legacy-plan', 'HELD',
        '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z'
      );
    `);
    legacy.close();
    chmodSync(databasePath, 0o666);

    const store = new ControllerStore(databasePath);
    try {
      const plan = store.createPlan({ platform: "damai", canonicalEventKey: "persisted-canonical" });
      assert.equal(store.requirePlan(plan.id).canonicalEventKey, "persisted-canonical");
      const planColumns = store.database.prepare("PRAGMA table_info(watch_plans)").all() as Array<{ name: string }>;
      const runColumns = store.database.prepare("PRAGMA table_info(purchase_runs)").all() as Array<{ name: string }>;
      assert.ok(planColumns.some((column) => column.name === "canonical_event_key"));
      assert.ok(planColumns.some((column) => column.name === "event_key"));
      assert.ok(planColumns.some((column) => column.name === "attendee_refs_json"));
      assert.ok(runColumns.some((column) => column.name === "price_verified_at"));
      const migratedRun = store.requireRun("legacy-run");
      assert.equal(migratedRun.state, "FAILED");
      assert.equal(migratedRun.lastError, "ATTENDEE_IDENTITY_MIGRATION_REQUIRED");
      assert.equal(migratedRun.priceVerifiedAt, "2026-01-01T00:00:02.000Z");
      assert.equal(store.getRunAudit("legacy-run").at(-1)?.fromState, "VERIFY_PRICE");
      assert.equal(store.getRunAudit("legacy-run").at(-1)?.toState, "FAILED");
      assert.equal(
        store.getRunAudit("legacy-run").at(-1)?.message,
        "ATTENDEE_IDENTITY_MIGRATION_REQUIRED"
      );
      assert.equal(store.getPurchaseLockForRun("legacy-run")?.status, "HELD");
      const migrated = store.requirePlan("legacy-plan");
      assert.equal(migrated.status, "PAUSED");
      assert.equal(migrated.autoSubmitOrder, false);
      assert.deepEqual(migrated.attendeeRefs, []);
      assert.deepEqual(migrated.attendeeAliases, []);
      const rawIdentity = store.database.prepare(`
        SELECT attendee_refs_json, attendee_aliases_json FROM watch_plans WHERE id = 'legacy-plan'
      `).get() as { attendee_refs_json: string; attendee_aliases_json: string };
      assert.equal(rawIdentity.attendee_refs_json, "[]");
      assert.equal(rawIdentity.attendee_aliases_json, "[]");
      assert.equal(
        store.getPlanAudit("legacy-plan").at(-1)?.reason,
        "ATTENDEE_IDENTITY_MIGRATION_REQUIRED"
      );
      assert.equal(statSync(databasePath).mode & 0o777, 0o600);
    } finally {
      store.close();
    }
    assert.equal(statSync(databasePath).mode & 0o777, 0o600);
    assert.equal(readFileSync(databasePath).includes(Buffer.from("本人", "utf8")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("database paths reject symbolic links before SQLite opens them", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ticket-agent-controller-link-"));
  const targetPath = path.join(directory, "target.sqlite");
  const linkPath = path.join(directory, "controller.sqlite");
  try {
    const target = new DatabaseSync(targetPath);
    target.close();
    symlinkSync(targetPath, linkPath);
    assert.throws(() => new ControllerStore(linkPath), /DATABASE_PATH_UNSAFE/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("arming rejects a paused plan while any prior run remains non-terminal", () => {
  const store = memoryStore();
  try {
    const { plan, run } = store.armPlan(store.createPlan(safePlan({ autoSubmitOrder: false })).id);
    store.database.prepare("UPDATE watch_plans SET status = 'PAUSED' WHERE id = ?").run(plan.id);

    assert.throws(() => store.armPlan(plan.id), assertControllerCode("PLAN_ACTIVE_RUN_EXISTS"));
    assert.equal(store.requirePlan(plan.id).status, "PAUSED");
    assert.deepEqual(store.listRuns(plan.id).map((item) => item.id), [run.id]);
    assert.equal(store.requireRun(run.id).state, "SCHEDULED");
  } finally {
    store.close();
  }
});

test("HTTP controller exposes unauthenticated health only and binds loopback", async () => {
  const store = memoryStore();
  assert.throws(
    () => createControllerHttpServer({ store, token: "too-short" }),
    /at least 32 bytes/
  );
  const token = "controller-test-token-with-32-bytes-minimum";
  const server = createControllerHttpServer({ store, token });
  const address = await listenController(server);
  const baseUrl = `http://${address.host}:${address.port}`;
  try {
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const unauthorized = await fetch(`${baseUrl}/plans`);
    assert.equal(unauthorized.status, 401);

    const created = await fetch(`${baseUrl}/plans`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ platform: "damai", eventTitle: "HTTP 测试" })
    });
    assert.equal(created.status, 201);
    const payload = (await created.json()) as { plan: { status: string; quantity: number } };
    assert.equal(payload.plan.status, "DRAFT");
    assert.equal(payload.plan.quantity, 1);

    const run = store.armPlan(store.createPlan(safePlan()).id).run;
    reachVerifyPrice(store, run.id);
    const approved = await fetch(`${baseUrl}/runs/${run.id}/approve-submit`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ confirmation: "APPROVE_SUBMIT", observedTotalFen: 68_000 })
    });
    assert.equal(approved.status, 200);
    const approvedPayload = (await approved.json()) as { allowed: boolean; run: { state: string } };
    assert.equal(approvedPayload.allowed, true);
    assert.equal(approvedPayload.run.state, "SUBMIT_ORDER");

    const replay = await fetch(`${baseUrl}/runs/${run.id}/approve-submit`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ confirmation: "APPROVE_SUBMIT", observedTotalFen: 68_000 })
    });
    assert.equal(replay.status, 409);
    const replayPayload = (await replay.json()) as { error: { code: string } };
    assert.equal(replayPayload.error.code, "SUBMIT_ALREADY_AUTHORIZED");

    move(store, run.id, "PAY_REQUIRED", { orderReference: "http-order" });
    const confirmed = await fetch(`${baseUrl}/runs/${run.id}/confirm-success`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ confirmation: "ORDER_EXISTS", orderReference: "http-order" })
    });
    assert.equal(confirmed.status, 200);
    const confirmedPayload = (await confirmed.json()) as { run: { state: string } };
    assert.equal(confirmedPayload.run.state, "SUCCESS");
  } finally {
    await closeController(server);
    store.close();
  }
});
