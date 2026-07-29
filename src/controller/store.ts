import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, lstatSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { canAutoSubmit, normalizePlan, validatePlan } from "../core/policy.js";
import { isTerminal, transition } from "../core/state.js";
import type {
  PlanStatus,
  Platform,
  PriceStrategy,
  PurchaseRun,
  RunnerEvent,
  RunState,
  SessionPreference,
  TierPreference,
  WatchPlan,
  WatchPlanInput
} from "../core/types.js";
import { ControllerError } from "./errors.js";

export interface WatchPlanPatch {
  platform?: Platform;
  officialUrl?: string | null;
  eventId?: string | null;
  eventTitle?: string | null;
  canonicalEventKey?: string | null;
  saleAt?: string | null;
  quantity?: number;
  requireAdjacent?: boolean;
  sessions?: SessionPreference[];
  tiers?: TierPreference[];
  maxTotalFen?: number | null;
  priceStrategy?: PriceStrategy;
  attendeeAliases?: string[];
  autoSubmitOrder?: boolean;
}

export interface ArmPlanResult {
  plan: WatchPlan;
  run: PurchaseRun;
}

export interface CancelPlanResult {
  plan: WatchPlan;
  run?: PurchaseRun;
}

export interface SubmitAuthorizationInput {
  confirmation: "APPROVE_SUBMIT";
  observedTotalFen: number;
}

export interface SubmitAuthorizationResult {
  allowed: boolean;
  run: PurchaseRun;
  message?: string;
}

export interface SuccessConfirmationInput {
  confirmation: "ORDER_EXISTS";
  orderReference: string;
}

export interface NoOrderReconciliationInput {
  confirmation: "NO_ORDER_EXISTS";
  eventKey: string;
  confirmedByUser: true;
}

export interface RunTransitionAudit {
  id: number;
  runId: string;
  fromState?: RunState;
  toState: RunState;
  message?: string;
  observedTotalFen?: number;
  selectedSession?: string;
  selectedTier?: string;
  orderReference?: string;
  at: string;
}

export interface PlanStatusAudit {
  id: number;
  planId: string;
  fromStatus?: PlanStatus;
  toStatus: PlanStatus;
  reason?: string;
  at: string;
}

export type PurchaseLockStatus = "HELD" | "PURCHASED";

export interface PurchaseLock {
  eventKey: string;
  runId: string;
  planId: string;
  status: PurchaseLockStatus;
  acquiredAt: string;
  updatedAt: string;
}

export interface ControllerStoreOptions {
  now?: () => string;
  idFactory?: () => string;
}

type SqlValue = string | number | bigint | Uint8Array | null;
type SqlRow = Record<string, SqlValue>;

const PLAN_STATUSES = new Set<PlanStatus>([
  "DRAFT",
  "ARMED",
  "RUNNING",
  "PAUSED",
  "COMPLETED",
  "CANCELLED"
]);

const RUN_STATES = new Set<RunState>([
  "SCHEDULED",
  "PREWARM",
  "LOGIN_READY",
  "WAIT_FOR_SALE",
  "OFFICIAL_QUEUE",
  "SELECT_SESSION",
  "SELECT_TIER",
  "SELECT_QUANTITY",
  "SELECT_ATTENDEE",
  "VERIFY_PRICE",
  "REVIEW_REQUIRED",
  "SUBMIT_ORDER",
  "PAY_REQUIRED",
  "SUCCESS",
  "CAPTCHA_REQUIRED",
  "LOGIN_EXPIRED",
  "PRICE_LIMIT_EXCEEDED",
  "PAGE_CHANGED",
  "SOLD_OUT",
  "DUPLICATE_BLOCKED",
  "HUMAN_TAKEOVER",
  "FAILED"
]);

const ERROR_STATES = new Set<RunState>([
  "CAPTCHA_REQUIRED",
  "LOGIN_EXPIRED",
  "PRICE_LIMIT_EXCEEDED",
  "PAGE_CHANGED",
  "SOLD_OUT",
  "DUPLICATE_BLOCKED",
  "FAILED"
]);

const hasOwn = (object: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(object, key);

function column(row: SqlRow, name: string): SqlValue {
  const value = row[name];
  if (value === undefined) throw new Error(`Missing database column: ${name}`);
  return value;
}

function asOptionalString(value: SqlValue): string | undefined {
  return value === null ? undefined : String(value);
}

function asNumber(value: SqlValue, field: string): number {
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(`Invalid numeric database value for ${field}`);
  }
  return Number(value);
}

function parseJson<T>(value: SqlValue, field: string): T {
  if (typeof value !== "string") throw new Error(`Invalid JSON database value for ${field}`);
  return JSON.parse(value) as T;
}

function planFromRow(row: SqlRow): WatchPlan {
  const status = String(column(row, "status")) as PlanStatus;
  if (!PLAN_STATUSES.has(status)) throw new Error(`Invalid plan status in database: ${status}`);
  const officialUrl = asOptionalString(column(row, "official_url"));
  const eventId = asOptionalString(column(row, "event_id"));
  const eventTitle = asOptionalString(column(row, "event_title"));
  const canonicalEventKey = asOptionalString(column(row, "canonical_event_key"));
  const saleAt = asOptionalString(column(row, "sale_at"));
  const maxTotalFen = column(row, "max_total_fen");
  return {
    id: String(column(row, "id")),
    platform: String(column(row, "platform")) as Platform,
    ...(officialUrl === undefined ? {} : { officialUrl }),
    ...(eventId === undefined ? {} : { eventId }),
    ...(eventTitle === undefined ? {} : { eventTitle }),
    ...(canonicalEventKey === undefined ? {} : { canonicalEventKey }),
    ...(saleAt === undefined ? {} : { saleAt }),
    quantity: asNumber(column(row, "quantity"), "quantity"),
    requireAdjacent: asNumber(column(row, "require_adjacent"), "require_adjacent") === 1,
    sessions: parseJson<SessionPreference[]>(column(row, "sessions_json"), "sessions_json"),
    tiers: parseJson<TierPreference[]>(column(row, "tiers_json"), "tiers_json"),
    ...(maxTotalFen === null ? {} : { maxTotalFen: asNumber(maxTotalFen, "max_total_fen") }),
    priceStrategy: String(column(row, "price_strategy")) as PriceStrategy,
    attendeeAliases: parseJson<string[]>(column(row, "attendee_aliases_json"), "attendee_aliases_json"),
    autoSubmitOrder: asNumber(column(row, "auto_submit_order"), "auto_submit_order") === 1,
    status,
    createdAt: String(column(row, "created_at")),
    updatedAt: String(column(row, "updated_at"))
  };
}

function runFromRow(row: SqlRow): PurchaseRun {
  const state = String(column(row, "state")) as RunState;
  if (!RUN_STATES.has(state)) throw new Error(`Invalid run state in database: ${state}`);
  const observedTotalFen = column(row, "observed_total_fen");
  const priceVerifiedAt = asOptionalString(column(row, "price_verified_at"));
  const selectedSession = asOptionalString(column(row, "selected_session"));
  const selectedTier = asOptionalString(column(row, "selected_tier"));
  const orderReference = asOptionalString(column(row, "order_reference"));
  const lastError = asOptionalString(column(row, "last_error"));
  return {
    id: String(column(row, "id")),
    planId: String(column(row, "plan_id")),
    state,
    ...(observedTotalFen === null
      ? {}
      : { observedTotalFen: asNumber(observedTotalFen, "observed_total_fen") }),
    ...(priceVerifiedAt === undefined ? {} : { priceVerifiedAt }),
    ...(selectedSession === undefined ? {} : { selectedSession }),
    ...(selectedTier === undefined ? {} : { selectedTier }),
    ...(orderReference === undefined ? {} : { orderReference }),
    ...(lastError === undefined ? {} : { lastError }),
    createdAt: String(column(row, "created_at")),
    updatedAt: String(column(row, "updated_at"))
  };
}

function lockFromRow(row: SqlRow): PurchaseLock {
  return {
    eventKey: String(column(row, "event_key")),
    runId: String(column(row, "run_id")),
    planId: String(column(row, "plan_id")),
    status: String(column(row, "status")) as PurchaseLockStatus,
    acquiredAt: String(column(row, "acquired_at")),
    updatedAt: String(column(row, "updated_at"))
  };
}

function normalizeIdentity(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\p{P}\p{S}\p{Z}]+/gu, "")
    .trim();
}

/**
 * The only identity trusted at arm/submit authorization boundaries. Unlike
 * eventKeyForPlan, this never derives a lock key from mutable platform
 * metadata or a tracking URL.
 */
function canonicalKeyForPlan(plan: Pick<WatchPlan, "canonicalEventKey">): string | undefined {
  const canonical = plan.canonicalEventKey === undefined ? "" : normalizeIdentity(plan.canonicalEventKey);
  return canonical ? `canonical:${canonical}` : undefined;
}

function secureExistingRegularFile(path: string): boolean {
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`DATABASE_PATH_UNSAFE:${path}:expected a regular non-symlink file`);
    }
    chmodSync(path, 0o600);
    return true;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    if (code === "ENOENT") return false;
    throw error;
  }
}

function prepareDatabaseFile(databasePath: string): void {
  if (databasePath === ":memory:") return;
  // SQLite may reuse sidecars left by an interrupted process. They must not be
  // links to unrelated files before SQLite gets a chance to open them.
  secureExistingRegularFile(`${databasePath}-wal`);
  secureExistingRegularFile(`${databasePath}-shm`);
  if (secureExistingRegularFile(databasePath)) return;
  const descriptor = openSync(
    databasePath,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
    0o600
  );
  closeSync(descriptor);
}

/**
 * A stable user-supplied canonical identity wins over all platform metadata.
 * Platform is never included, so matching Damai and Maoyan plans contend for
 * one atomic purchase lock.
 */
export function eventKeyForPlan(
  plan: Pick<WatchPlan, "canonicalEventKey" | "eventTitle" | "eventId" | "officialUrl">
): string | undefined {
  const canonical = canonicalKeyForPlan(plan);
  if (canonical) return canonical;

  const normalizedTitle = plan.eventTitle === undefined ? "" : normalizeIdentity(plan.eventTitle);
  if (normalizedTitle) return `title:${normalizedTitle}`;

  const normalizedId = plan.eventId === undefined ? "" : normalizeIdentity(plan.eventId);
  if (normalizedId) return `id:${normalizedId}`;

  if (plan.officialUrl) {
    try {
      const url = new URL(plan.officialUrl);
      const normalizedPath = `${url.pathname}${url.search}`.replace(/\/$/, "");
      if (normalizedPath) return `url:${normalizeIdentity(normalizedPath)}`;
    } catch {
      // validatePlan reports malformed official URLs before a plan is armed.
    }
  }
  return undefined;
}

function validateInputShape(input: unknown): string[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return ["plan must be an object"];
  const value = input as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof value.platform !== "string") errors.push("platform must be a string");
  for (const field of ["officialUrl", "eventId", "eventTitle", "canonicalEventKey", "saleAt"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") errors.push(`${field} must be a string`);
  }
  if (value.quantity !== undefined && typeof value.quantity !== "number") errors.push("quantity must be a number");
  if (value.requireAdjacent !== undefined && typeof value.requireAdjacent !== "boolean") {
    errors.push("requireAdjacent must be a boolean");
  }
  if (value.maxTotalFen !== undefined && typeof value.maxTotalFen !== "number") {
    errors.push("maxTotalFen must be a number");
  }
  if (value.priceStrategy !== undefined && value.priceStrategy !== "CHEAPEST_FIRST" && value.priceStrategy !== "PREFERRED_ORDER") {
    errors.push("priceStrategy must be CHEAPEST_FIRST or PREFERRED_ORDER");
  }
  if (value.autoSubmitOrder !== undefined && typeof value.autoSubmitOrder !== "boolean") {
    errors.push("autoSubmitOrder must be a boolean");
  }
  if (value.sessions !== undefined) {
    if (!Array.isArray(value.sessions)) {
      errors.push("sessions must be an array");
    } else {
      for (const session of value.sessions) {
        if (typeof session !== "object" || session === null || typeof (session as Record<string, unknown>).label !== "string") {
          errors.push("session labels must be strings");
        }
        if (
          typeof session !== "object" ||
          session === null ||
          !Number.isSafeInteger((session as Record<string, unknown>).priority)
        ) {
          errors.push("session priorities must be integers");
        }
      }
    }
  }
  if (value.tiers !== undefined && !Array.isArray(value.tiers)) errors.push("tiers must be an array");
  if (value.attendeeAliases !== undefined) {
    if (!Array.isArray(value.attendeeAliases) || value.attendeeAliases.some((alias) => typeof alias !== "string")) {
      errors.push("attendeeAliases must be an array of strings");
    }
  }
  return errors;
}

function normalizeAndValidate(input: WatchPlanInput): ReturnType<typeof normalizePlan> {
  const shapeErrors = validateInputShape(input);
  if (shapeErrors.length > 0) throw new ControllerError("PLAN_INVALID", "Plan validation failed", 422, shapeErrors);

  let normalized: ReturnType<typeof normalizePlan>;
  try {
    normalized = normalizePlan(input);
  } catch (error) {
    throw new ControllerError("PLAN_INVALID", "Plan normalization failed", 422, [String(error)]);
  }
  const validation = validatePlan(normalized);
  if (!validation.ok) throw new ControllerError("PLAN_INVALID", "Plan validation failed", 422, validation.errors);
  return normalized;
}

function candidateFromPatch(current: WatchPlan, patch: WatchPlanPatch): WatchPlanInput {
  const candidate: WatchPlanInput = {
    platform: patch.platform ?? current.platform,
    quantity: patch.quantity ?? current.quantity,
    requireAdjacent: patch.requireAdjacent ?? current.requireAdjacent,
    sessions: patch.sessions ?? current.sessions,
    tiers: patch.tiers ?? current.tiers,
    priceStrategy: patch.priceStrategy ?? current.priceStrategy,
    attendeeAliases: patch.attendeeAliases ?? current.attendeeAliases,
    autoSubmitOrder: patch.autoSubmitOrder ?? current.autoSubmitOrder
  };

  const officialUrl = hasOwn(patch, "officialUrl") ? patch.officialUrl : current.officialUrl;
  const eventId = hasOwn(patch, "eventId") ? patch.eventId : current.eventId;
  const eventTitle = hasOwn(patch, "eventTitle") ? patch.eventTitle : current.eventTitle;
  const canonicalEventKey = hasOwn(patch, "canonicalEventKey")
    ? patch.canonicalEventKey
    : current.canonicalEventKey;
  const saleAt = hasOwn(patch, "saleAt") ? patch.saleAt : current.saleAt;
  const maxTotalFen = hasOwn(patch, "maxTotalFen") ? patch.maxTotalFen : current.maxTotalFen;
  if (officialUrl != null) candidate.officialUrl = officialUrl;
  if (eventId != null) candidate.eventId = eventId;
  if (eventTitle != null) candidate.eventTitle = eventTitle;
  if (canonicalEventKey != null) candidate.canonicalEventKey = canonicalEventKey;
  if (saleAt != null) candidate.saleAt = saleAt;
  if (maxTotalFen != null) candidate.maxTotalFen = maxTotalFen;
  return candidate;
}

export class ControllerStore {
  readonly database: DatabaseSync;
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private readonly databasePath: string;

  constructor(databasePath = ":memory:", options: ControllerStoreOptions = {}) {
    this.databasePath = databasePath;
    prepareDatabaseFile(databasePath);
    this.database = new DatabaseSync(databasePath);
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? randomUUID;
    this.initialize();
    this.secureDatabaseFiles();
  }

  private initialize(): void {
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS watch_plans (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        official_url TEXT,
        event_id TEXT,
        event_title TEXT,
        canonical_event_key TEXT,
        event_key TEXT,
        sale_at TEXT,
        quantity INTEGER NOT NULL,
        require_adjacent INTEGER NOT NULL,
        sessions_json TEXT NOT NULL,
        tiers_json TEXT NOT NULL,
        max_total_fen INTEGER,
        price_strategy TEXT NOT NULL,
        attendee_aliases_json TEXT NOT NULL,
        auto_submit_order INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS purchase_runs (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES watch_plans(id) ON DELETE RESTRICT,
        state TEXT NOT NULL,
        observed_total_fen INTEGER,
        price_verified_at TEXT,
        selected_session TEXT,
        selected_tier TEXT,
        order_reference TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_state_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES purchase_runs(id) ON DELETE CASCADE,
        from_state TEXT,
        to_state TEXT NOT NULL,
        message TEXT,
        observed_total_fen INTEGER,
        selected_session TEXT,
        selected_tier TEXT,
        order_reference TEXT,
        at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS plan_status_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id TEXT NOT NULL REFERENCES watch_plans(id) ON DELETE CASCADE,
        from_status TEXT,
        to_status TEXT NOT NULL,
        reason TEXT,
        at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS purchase_locks (
        event_key TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES purchase_runs(id) ON DELETE RESTRICT,
        plan_id TEXT NOT NULL REFERENCES watch_plans(id) ON DELETE RESTRICT,
        status TEXT NOT NULL CHECK(status IN ('HELD', 'PURCHASED')),
        acquired_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    // CREATE TABLE IF NOT EXISTS does not add fields to databases produced by
    // an older release. Additive migrations keep existing plans and audits.
    this.ensureColumn("watch_plans", "canonical_event_key", "TEXT");
    this.ensureColumn("watch_plans", "event_key", "TEXT");
    this.ensureColumn("purchase_runs", "price_verified_at", "TEXT");
    this.database.exec(`
      UPDATE purchase_runs
      SET price_verified_at = updated_at
      WHERE observed_total_fen IS NOT NULL AND price_verified_at IS NULL;

      CREATE INDEX IF NOT EXISTS watch_plans_status_idx ON watch_plans(status);
      CREATE INDEX IF NOT EXISTS watch_plans_event_key_idx ON watch_plans(event_key);
      CREATE INDEX IF NOT EXISTS watch_plans_canonical_event_key_idx ON watch_plans(canonical_event_key);
      CREATE INDEX IF NOT EXISTS purchase_runs_plan_idx ON purchase_runs(plan_id, created_at);
      CREATE INDEX IF NOT EXISTS run_state_audit_run_idx ON run_state_audit(run_id, id);
      CREATE INDEX IF NOT EXISTS plan_status_audit_plan_idx ON plan_status_audit(plan_id, id);
    `);
  }

  private ensureColumn(table: "watch_plans" | "purchase_runs", name: string, declaration: string): void {
    const rows = this.database.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[];
    if (rows.some((row) => String(column(row, "name")) === name)) return;
    this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
  }

  private secureDatabaseFiles(): void {
    if (this.databasePath === ":memory:") return;
    for (const path of [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]) {
      secureExistingRegularFile(path);
    }
  }

  close(): void {
    this.secureDatabaseFiles();
    this.database.close();
    this.secureDatabaseFiles();
  }

  healthCheck(): boolean {
    const row = this.database.prepare("SELECT 1 AS ok").get() as SqlRow | undefined;
    return row?.ok === 1;
  }

  private inTransaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.secureDatabaseFiles();
    }
  }

  createPlan(input: WatchPlanInput): WatchPlan {
    const normalized = normalizeAndValidate(input);
    const id = this.idFactory();
    const at = this.now();
    const plan: WatchPlan = { ...normalized, id, status: "DRAFT", createdAt: at, updatedAt: at };
    const eventKey = eventKeyForPlan(plan) ?? null;

    this.inTransaction(() => {
      this.database
        .prepare(`
          INSERT INTO watch_plans (
            id, platform, official_url, event_id, event_title, canonical_event_key, event_key, sale_at,
            quantity, require_adjacent, sessions_json, tiers_json, max_total_fen,
            price_strategy, attendee_aliases_json, auto_submit_order, status,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          plan.id,
          plan.platform,
          plan.officialUrl ?? null,
          plan.eventId ?? null,
          plan.eventTitle ?? null,
          plan.canonicalEventKey ?? null,
          eventKey,
          plan.saleAt ?? null,
          plan.quantity,
          plan.requireAdjacent ? 1 : 0,
          JSON.stringify(plan.sessions),
          JSON.stringify(plan.tiers),
          plan.maxTotalFen ?? null,
          plan.priceStrategy,
          JSON.stringify(plan.attendeeAliases),
          plan.autoSubmitOrder ? 1 : 0,
          plan.status,
          plan.createdAt,
          plan.updatedAt
        );
      this.insertPlanAudit(plan.id, undefined, "DRAFT", "PLAN_CREATED", at);
    });
    return plan;
  }

  getPlan(id: string): WatchPlan | undefined {
    const row = this.database.prepare("SELECT * FROM watch_plans WHERE id = ?").get(id) as SqlRow | undefined;
    return row === undefined ? undefined : planFromRow(row);
  }

  requirePlan(id: string): WatchPlan {
    const plan = this.getPlan(id);
    if (plan === undefined) throw new ControllerError("PLAN_NOT_FOUND", `Plan ${id} was not found`, 404);
    return plan;
  }

  listPlans(status?: PlanStatus): WatchPlan[] {
    if (status !== undefined && !PLAN_STATUSES.has(status)) {
      throw new ControllerError("INVALID_PLAN_STATUS", `Unknown plan status: ${status}`, 400);
    }
    const rows = (status === undefined
      ? this.database.prepare("SELECT * FROM watch_plans ORDER BY created_at, id").all()
      : this.database.prepare("SELECT * FROM watch_plans WHERE status = ? ORDER BY created_at, id").all(status)) as SqlRow[];
    return rows.map(planFromRow);
  }

  updatePlan(id: string, patch: WatchPlanPatch): WatchPlan {
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      throw new ControllerError("PLAN_INVALID", "Plan patch must be an object", 422);
    }
    return this.inTransaction(() => {
      const current = this.requirePlan(id);
      if (current.status !== "DRAFT") {
        throw new ControllerError("PLAN_NOT_EDITABLE", "Only DRAFT plans may be edited", 409);
      }
      const normalized = normalizeAndValidate(candidateFromPatch(current, patch));
      const at = this.now();
      const updated: WatchPlan = { ...normalized, id: current.id, status: current.status, createdAt: current.createdAt, updatedAt: at };
      const eventKey = eventKeyForPlan(updated) ?? null;
      this.database
        .prepare(`
          UPDATE watch_plans SET
            platform = ?, official_url = ?, event_id = ?, event_title = ?, canonical_event_key = ?, event_key = ?, sale_at = ?,
            quantity = ?, require_adjacent = ?, sessions_json = ?, tiers_json = ?, max_total_fen = ?,
            price_strategy = ?, attendee_aliases_json = ?, auto_submit_order = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(
          updated.platform,
          updated.officialUrl ?? null,
          updated.eventId ?? null,
          updated.eventTitle ?? null,
          updated.canonicalEventKey ?? null,
          eventKey,
          updated.saleAt ?? null,
          updated.quantity,
          updated.requireAdjacent ? 1 : 0,
          JSON.stringify(updated.sessions),
          JSON.stringify(updated.tiers),
          updated.maxTotalFen ?? null,
          updated.priceStrategy,
          JSON.stringify(updated.attendeeAliases),
          updated.autoSubmitOrder ? 1 : 0,
          updated.updatedAt,
          updated.id
        );
      return updated;
    });
  }

  deletePlan(id: string): void {
    this.inTransaction(() => {
      const plan = this.requirePlan(id);
      if (plan.status !== "DRAFT") {
        throw new ControllerError("PLAN_NOT_DELETABLE", "Only DRAFT plans may be deleted", 409);
      }
      const result = this.database.prepare("DELETE FROM watch_plans WHERE id = ?").run(id);
      if (result.changes !== 1) throw new ControllerError("PLAN_NOT_FOUND", `Plan ${id} was not found`, 404);
    });
  }

  armPlan(id: string): ArmPlanResult {
    return this.inTransaction(() => {
      const current = this.requirePlan(id);
      if (current.status !== "DRAFT" && current.status !== "PAUSED") {
        throw new ControllerError("PLAN_NOT_ARMABLE", `Cannot arm a ${current.status} plan`, 409);
      }
      const validation = validatePlan(current);
      if (!validation.ok) throw new ControllerError("PLAN_INVALID", "Plan validation failed", 422, validation.errors);
      const eventKey = canonicalKeyForPlan(current);
      if (eventKey === undefined) {
        throw new ControllerError(
          "EVENT_IDENTITY_REQUIRED",
          "Set a non-empty canonicalEventKey before arming so duplicate purchases use a stable cross-platform identity",
          422
        );
      }
      const existingLock = this.getPurchaseLock(eventKey);
      if (existingLock !== undefined) {
        throw new ControllerError("PURCHASE_LOCK_HELD", "This event already has a held or completed purchase lock", 409, existingLock);
      }

      const at = this.now();
      const run: PurchaseRun = {
        id: this.idFactory(),
        planId: current.id,
        state: "SCHEDULED",
        createdAt: at,
        updatedAt: at
      };
      this.database
        .prepare("UPDATE watch_plans SET status = 'ARMED', event_key = ?, updated_at = ? WHERE id = ?")
        .run(eventKey, at, current.id);
      this.insertPlanAudit(current.id, current.status, "ARMED", "PLAN_ARMED", at);
      this.database
        .prepare(`
          INSERT INTO purchase_runs (
            id, plan_id, state, observed_total_fen, price_verified_at, selected_session, selected_tier,
            order_reference, last_error, created_at, updated_at
          ) VALUES (?, ?, 'SCHEDULED', NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
        `)
        .run(run.id, run.planId, run.createdAt, run.updatedAt);
      this.insertRunAudit(run.id, undefined, "SCHEDULED", "RUN_CREATED", run, at);
      return { plan: this.requirePlan(id), run };
    });
  }

  cancelPlan(id: string): CancelPlanResult {
    return this.inTransaction(() => {
      const plan = this.requirePlan(id);
      let run = this.latestRunForPlan(id);
      const purchaseLock = run === undefined ? undefined : this.getPurchaseLockForRun(run.id);
      if (run?.state === "SUBMIT_ORDER" || run?.state === "PAY_REQUIRED" || purchaseLock !== undefined) {
        throw new ControllerError(
          "PLAN_NOT_CANCELLABLE_AFTER_SUBMIT",
          "A plan cannot be cancelled after submit authorization or while its purchase lock exists",
          409
        );
      }
      if (plan.status === "CANCELLED") return { plan };
      if (plan.status === "COMPLETED") {
        throw new ControllerError("PLAN_NOT_CANCELLABLE", "A completed plan cannot be cancelled", 409);
      }

      const at = this.now();
      if (run !== undefined && !isTerminal(run.state)) {
        const nextState = transition(run.state, "FAILED");
        const previousState = run.state;
        run = { ...run, state: nextState, lastError: "PLAN_CANCELLED", updatedAt: at };
        this.persistRun(run);
        this.insertRunAudit(run.id, previousState, nextState, "PLAN_CANCELLED", run, at);
      }

      this.database.prepare("UPDATE watch_plans SET status = 'CANCELLED', updated_at = ? WHERE id = ?").run(at, id);
      this.insertPlanAudit(id, plan.status, "CANCELLED", "PLAN_CANCELLED", at);
      const cancelled = this.requirePlan(id);
      return run === undefined ? { plan: cancelled } : { plan: cancelled, run };
    });
  }

  getRun(id: string): PurchaseRun | undefined {
    const row = this.database.prepare("SELECT * FROM purchase_runs WHERE id = ?").get(id) as SqlRow | undefined;
    return row === undefined ? undefined : runFromRow(row);
  }

  requireRun(id: string): PurchaseRun {
    const run = this.getRun(id);
    if (run === undefined) throw new ControllerError("RUN_NOT_FOUND", `Run ${id} was not found`, 404);
    return run;
  }

  listRuns(planId?: string): PurchaseRun[] {
    const rows = (planId === undefined
      ? this.database.prepare("SELECT * FROM purchase_runs ORDER BY created_at, id").all()
      : this.database.prepare("SELECT * FROM purchase_runs WHERE plan_id = ? ORDER BY created_at, id").all(planId)) as SqlRow[];
    return rows.map(runFromRow);
  }

  private latestRunForPlan(planId: string): PurchaseRun | undefined {
    const row = this.database
      .prepare("SELECT * FROM purchase_runs WHERE plan_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(planId) as SqlRow | undefined;
    return row === undefined ? undefined : runFromRow(row);
  }

  applyRunnerEvent(event: RunnerEvent): PurchaseRun {
    if (typeof event !== "object" || event === null) {
      throw new ControllerError("EVENT_INVALID", "Runner event must be an object", 422);
    }
    if (typeof event.runId !== "string" || !event.runId) {
      throw new ControllerError("EVENT_INVALID", "runId is required", 422);
    }
    if (!RUN_STATES.has(event.state)) {
      throw new ControllerError("EVENT_INVALID", `Unknown run state: ${String(event.state)}`, 422);
    }
    if (event.at !== undefined && (typeof event.at !== "string" || Number.isNaN(Date.parse(event.at)))) {
      throw new ControllerError("EVENT_INVALID", "at must be an ISO date", 422);
    }
    if (
      event.observedTotalFen !== undefined &&
      (!Number.isSafeInteger(event.observedTotalFen) || event.observedTotalFen < 0)
    ) {
      throw new ControllerError("EVENT_INVALID", "observedTotalFen must be a non-negative integer in fen", 422);
    }
    for (const [field, value] of [
      ["message", event.message],
      ["selectedSession", event.selectedSession],
      ["selectedTier", event.selectedTier],
      ["orderReference", event.orderReference]
    ] as const) {
      if (value !== undefined && typeof value !== "string") {
        throw new ControllerError("EVENT_INVALID", `${field} must be a string`, 422);
      }
    }
    if (event.state === "SUBMIT_ORDER") {
      throw new ControllerError(
        "SUBMIT_AUTHORIZATION_REQUIRED",
        "SUBMIT_ORDER may only be entered through authorizeSubmit/approve-submit",
        409
      );
    }
    if (event.state === "SUCCESS") {
      throw new ControllerError(
        "SUCCESS_CONFIRMATION_REQUIRED",
        "SUCCESS may only be recorded through confirmSuccess/confirm-success",
        409
      );
    }
    if (event.state === "PAY_REQUIRED" && (typeof event.orderReference !== "string" || event.orderReference.trim() === "")) {
      throw new ControllerError(
        "ORDER_REFERENCE_REQUIRED",
        "PAY_REQUIRED requires a non-empty visible order reference",
        422
      );
    }
    if (event.orderReference !== undefined && event.state !== "PAY_REQUIRED") {
      throw new ControllerError(
        "ORDER_REFERENCE_OUT_OF_PHASE",
        "orderReference may only be recorded by a PAY_REQUIRED event",
        422
      );
    }

    return this.inTransaction(() => {
      const current = this.requireRun(event.runId);
      const plan = this.requirePlan(current.planId);
      if (plan.status === "CANCELLED" || plan.status === "COMPLETED" || plan.status === "PAUSED") {
        throw new ControllerError("PLAN_NOT_RUNNING", `Cannot update a ${plan.status} plan`, 409);
      }

      const requestedState = event.state;
      const policyMessage = event.message;
      const at = event.at ?? this.now();
      if (current.state === "VERIFY_PRICE" || current.priceVerifiedAt !== undefined) {
        for (const [field, supplied, frozen] of [
          ["selectedSession", event.selectedSession, current.selectedSession],
          ["selectedTier", event.selectedTier, current.selectedTier]
        ] as const) {
          if (supplied !== undefined && supplied !== frozen) {
            throw new ControllerError(
              "SELECTION_SNAPSHOT_MISMATCH",
              `${field} cannot change after price verification`,
              409
            );
          }
        }
      }
      if (
        current.orderReference !== undefined &&
        event.orderReference !== undefined &&
        event.orderReference.trim() !== current.orderReference
      ) {
        throw new ControllerError(
          "ORDER_REFERENCE_MISMATCH",
          "Recorded order reference is immutable",
          409
        );
      }
      let observedTotalFen = current.observedTotalFen;
      let priceVerifiedAt = current.priceVerifiedAt;
      if (current.observedTotalFen !== undefined && event.observedTotalFen !== undefined) {
        if (event.observedTotalFen !== current.observedTotalFen) {
          throw new ControllerError(
            "PRICE_SNAPSHOT_MISMATCH",
            `Verified total is immutable: ${event.observedTotalFen} does not match ${current.observedTotalFen}`,
            409
          );
        }
      } else if (current.observedTotalFen === undefined && event.observedTotalFen !== undefined) {
        if (requestedState !== "VERIFY_PRICE") {
          throw new ControllerError(
            "PRICE_OBSERVATION_OUT_OF_PHASE",
            "The first observed total must be recorded by a VERIFY_PRICE event",
            409
          );
        }
        observedTotalFen = event.observedTotalFen;
        priceVerifiedAt = at;
      }

      let nextState: RunState;
      try {
        nextState = transition(current.state, requestedState);
      } catch (error) {
        throw new ControllerError("INVALID_TRANSITION", String(error instanceof Error ? error.message : error), 409);
      }

      const updated: PurchaseRun = {
        ...current,
        state: nextState,
        ...(observedTotalFen === undefined ? {} : { observedTotalFen }),
        ...(priceVerifiedAt === undefined ? {} : { priceVerifiedAt }),
        ...(event.selectedSession === undefined ? {} : { selectedSession: event.selectedSession }),
        ...(event.selectedTier === undefined ? {} : { selectedTier: event.selectedTier }),
        ...(event.orderReference === undefined ? {} : { orderReference: event.orderReference.trim() }),
        ...(ERROR_STATES.has(nextState) ? { lastError: policyMessage ?? nextState } : {}),
        updatedAt: at
      };
      this.persistRun(updated);
      this.insertRunAudit(updated.id, current.state, nextState, policyMessage, updated, at);

      this.updatePlanStatusForRun(plan, updated, at);
      return updated;
    });
  }

  authorizeSubmit(runId: string, input: SubmitAuthorizationInput): SubmitAuthorizationResult {
    if (typeof input !== "object" || input === null || input.confirmation !== "APPROVE_SUBMIT") {
      throw new ControllerError("CONFIRMATION_REQUIRED", "Explicit APPROVE_SUBMIT confirmation is required", 422);
    }
    if (!Number.isSafeInteger(input.observedTotalFen) || input.observedTotalFen < 0) {
      throw new ControllerError("PRICE_REQUIRED", "observedTotalFen must be a non-negative integer in fen", 422);
    }

    return this.inTransaction(() => {
      const current = this.requireRun(runId);
      const plan = this.requirePlan(current.planId);
      if (plan.status === "CANCELLED" || plan.status === "COMPLETED" || plan.status === "PAUSED") {
        throw new ControllerError("PLAN_NOT_RUNNING", `Cannot authorize a ${plan.status} plan`, 409);
      }
      const eventKey = canonicalKeyForPlan(plan);
      if (eventKey === undefined) {
        throw new ControllerError(
          "EVENT_IDENTITY_REQUIRED",
          "Submit authorization requires the stable canonicalEventKey captured when the plan was armed",
          409
        );
      }
      const validation = validatePlan(plan);
      if (!validation.ok) {
        throw new ControllerError("PLAN_INVALID", "Plan is no longer valid for submit authorization", 409, validation.errors);
      }
      if (current.observedTotalFen === undefined || current.priceVerifiedAt === undefined) {
        throw new ControllerError("PRICE_REQUIRED", "A verified immutable price snapshot is required", 409);
      }
      if (input.observedTotalFen !== current.observedTotalFen) {
        throw new ControllerError(
          "PRICE_SNAPSHOT_MISMATCH",
          `Approval total ${input.observedTotalFen} does not match verified total ${current.observedTotalFen}`,
          409
        );
      }
      if (plan.maxTotalFen !== undefined && current.observedTotalFen > plan.maxTotalFen) {
        throw new ControllerError(
          "PRICE_LIMIT_EXCEEDED",
          `Verified total ${current.observedTotalFen} exceeds maximum ${plan.maxTotalFen}`,
          409
        );
      }

      if (current.state === "DUPLICATE_BLOCKED") {
        return { allowed: false, run: current, message: "DUPLICATE_PURCHASE_LOCKED" };
      }
      if (current.state === "SUBMIT_ORDER") {
        throw new ControllerError(
          "SUBMIT_ALREADY_AUTHORIZED",
          "Submit authorization is single-use; a retry requires human takeover",
          409
        );
      }
      if (current.state !== "VERIFY_PRICE" && current.state !== "REVIEW_REQUIRED") {
        throw new ControllerError(
          "RUN_NOT_APPROVABLE",
          `Submit approval requires VERIFY_PRICE or REVIEW_REQUIRED, not ${current.state}`,
          409
        );
      }
      if (current.state === "VERIFY_PRICE" && !canAutoSubmit(plan, current.observedTotalFen)) {
        throw new ControllerError(
          "REVIEW_REQUIRED",
          "Automatic submit policy is disabled; enter REVIEW_REQUIRED before explicit approval",
          409
        );
      }

      const at = this.now();
      if (!this.tryAcquirePurchaseLock(plan, current.id, eventKey, at)) {
        const duplicate: PurchaseRun = {
          ...current,
          state: transition(current.state, "DUPLICATE_BLOCKED"),
          lastError: "DUPLICATE_PURCHASE_LOCKED",
          updatedAt: at
        };
        this.persistRun(duplicate);
        this.insertRunAudit(
          duplicate.id,
          current.state,
          duplicate.state,
          "DUPLICATE_PURCHASE_LOCKED",
          duplicate,
          at
        );
        this.updatePlanStatusForRun(plan, duplicate, at);
        return { allowed: false, run: duplicate, message: "DUPLICATE_PURCHASE_LOCKED" };
      }

      const authorized: PurchaseRun = {
        ...current,
        state: transition(current.state, "SUBMIT_ORDER"),
        updatedAt: at
      };
      this.persistRun(authorized);
      this.insertRunAudit(authorized.id, current.state, authorized.state, "SUBMIT_AUTHORIZED", authorized, at);
      this.updatePlanStatusForRun(plan, authorized, at);
      return { allowed: true, run: authorized };
    });
  }

  confirmSuccess(runId: string, input: SuccessConfirmationInput): PurchaseRun {
    if (typeof input !== "object" || input === null || input.confirmation !== "ORDER_EXISTS") {
      throw new ControllerError("CONFIRMATION_REQUIRED", "Explicit ORDER_EXISTS confirmation is required", 422);
    }
    if (typeof input.orderReference !== "string" || input.orderReference.trim() === "") {
      throw new ControllerError("ORDER_REFERENCE_REQUIRED", "A non-empty order reference is required", 422);
    }
    const orderReference = input.orderReference.trim();

    return this.inTransaction(() => {
      const current = this.requireRun(runId);
      const plan = this.requirePlan(current.planId);
      const eventKey = canonicalKeyForPlan(plan);
      if (eventKey === undefined) {
        throw new ControllerError(
          "EVENT_IDENTITY_REQUIRED",
          "Success confirmation requires the stable canonicalEventKey captured when the plan was armed",
          409
        );
      }
      if (current.state === "SUCCESS") {
        if (current.orderReference !== orderReference) {
          throw new ControllerError("ORDER_REFERENCE_MISMATCH", "Success was already confirmed for another order", 409);
        }
        return current;
      }
      const confirmableStates = new Set<RunState>(["SUBMIT_ORDER", "PAY_REQUIRED", "HUMAN_TAKEOVER", "FAILED"]);
      if (!confirmableStates.has(current.state)) {
        throw new ControllerError("RUN_NOT_CONFIRMABLE", `Cannot confirm success from ${current.state}`, 409);
      }
      if (current.orderReference !== undefined && current.orderReference !== orderReference) {
        throw new ControllerError("ORDER_REFERENCE_MISMATCH", "Confirmation does not match recorded order evidence", 409);
      }
      const existingLock = this.getPurchaseLockForRun(runId);
      if (
        current.state !== "HUMAN_TAKEOVER" &&
        existingLock?.status !== "HELD"
      ) {
        throw new ControllerError(
          "PURCHASE_LOCK_MISSING",
          "A submitted or failed run is confirmable only while its submit lock is held",
          409
        );
      }

      const at = this.now();
      if (!this.tryAcquirePurchaseLock(plan, runId, eventKey, at)) {
        throw new ControllerError("DUPLICATE_PURCHASE_LOCKED", "Another run owns the purchase lock", 409);
      }
      const confirmed: PurchaseRun = {
        ...current,
        state: "SUCCESS",
        orderReference,
        updatedAt: at
      };
      this.persistRun(confirmed);
      this.insertRunAudit(confirmed.id, current.state, "SUCCESS", "SUCCESS_CONFIRMED_BY_USER", confirmed, at);
      this.database
        .prepare("UPDATE purchase_locks SET status = 'PURCHASED', updated_at = ? WHERE run_id = ?")
        .run(at, confirmed.id);
      this.updatePlanStatusForRun(plan, confirmed, at);
      return confirmed;
    });
  }

  private persistRun(run: PurchaseRun): void {
    this.database
      .prepare(`
        UPDATE purchase_runs SET
          state = ?, observed_total_fen = ?, price_verified_at = ?, selected_session = ?, selected_tier = ?,
          order_reference = ?, last_error = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        run.state,
        run.observedTotalFen ?? null,
        run.priceVerifiedAt ?? null,
        run.selectedSession ?? null,
        run.selectedTier ?? null,
        run.orderReference ?? null,
        run.lastError ?? null,
        run.updatedAt,
        run.id
      );
  }

  private updatePlanStatusForRun(previous: WatchPlan, run: PurchaseRun, at: string): void {
    let nextStatus = previous.status;
    let reason: string | undefined;
    if (run.state === "SUCCESS") {
      nextStatus = "COMPLETED";
      reason = "RUN_SUCCEEDED";
    } else if (run.state === "FAILED") {
      nextStatus = "PAUSED";
      reason = "RUN_FAILED";
    } else if (previous.status === "ARMED" && run.state !== "SCHEDULED") {
      nextStatus = "RUNNING";
      reason = "RUN_STARTED";
    }
    if (nextStatus === previous.status) return;
    this.database.prepare("UPDATE watch_plans SET status = ?, updated_at = ? WHERE id = ?").run(nextStatus, at, previous.id);
    this.insertPlanAudit(previous.id, previous.status, nextStatus, reason, at);
  }

  private tryAcquirePurchaseLock(plan: WatchPlan, runId: string, eventKey: string, at: string): boolean {
    const existing = this.getPurchaseLock(eventKey);
    if (existing !== undefined) return existing.runId === runId;
    try {
      this.database
        .prepare(`
          INSERT INTO purchase_locks (event_key, run_id, plan_id, status, acquired_at, updated_at)
          VALUES (?, ?, ?, 'HELD', ?, ?)
        `)
        .run(eventKey, runId, plan.id, at, at);
      return true;
    } catch (error) {
      const winner = this.getPurchaseLock(eventKey);
      if (winner !== undefined) return winner.runId === runId;
      throw error;
    }
  }

  getPurchaseLock(eventKey: string): PurchaseLock | undefined {
    const row = this.database.prepare("SELECT * FROM purchase_locks WHERE event_key = ?").get(eventKey) as SqlRow | undefined;
    return row === undefined ? undefined : lockFromRow(row);
  }

  getPurchaseLockForRun(runId: string): PurchaseLock | undefined {
    const row = this.database.prepare("SELECT * FROM purchase_locks WHERE run_id = ?").get(runId) as SqlRow | undefined;
    return row === undefined ? undefined : lockFromRow(row);
  }

  /**
   * A HELD lock is deliberately sticky after submission uncertainty. It may be
   * released only after the run is FAILED and a caller explicitly confirms
   * that the official platform has no order. PURCHASED locks are permanent.
   */
  reconcileNoOrder(runId: string, input: NoOrderReconciliationInput): void {
    if (
      typeof input !== "object" ||
      input === null ||
      input.confirmation !== "NO_ORDER_EXISTS" ||
      input.confirmedByUser !== true ||
      typeof input.eventKey !== "string" ||
      input.eventKey === ""
    ) {
      throw new ControllerError(
        "CONFIRMATION_REQUIRED",
        "NO_ORDER_EXISTS, confirmedByUser=true, and the exact eventKey are required",
        422
      );
    }
    this.inTransaction(() => {
      const run = this.requireRun(runId);
      if (run.state !== "FAILED") {
        throw new ControllerError("RUN_NOT_RECONCILABLE", "Only a FAILED run can release a held purchase lock", 409);
      }
      if (run.orderReference !== undefined) {
        throw new ControllerError(
          "ORDER_EVIDENCE_PRESENT",
          "A run with recorded order evidence cannot release its purchase lock",
          409
        );
      }
      const lock = this.getPurchaseLockForRun(runId);
      if (lock === undefined) {
        throw new ControllerError("PURCHASE_LOCK_NOT_FOUND", "This run has no purchase lock to release", 409);
      }
      if (lock.status === "PURCHASED") {
        throw new ControllerError("PURCHASE_ALREADY_RECORDED", "A completed purchase lock cannot be released", 409);
      }
      if (input.eventKey !== lock.eventKey) {
        throw new ControllerError("EVENT_KEY_MISMATCH", "Confirmed eventKey does not match the held lock", 409);
      }
      this.database.prepare("DELETE FROM purchase_locks WHERE run_id = ?").run(runId);
      const at = this.now();
      this.insertRunAudit(run.id, run.state, run.state, "NO_ORDER_CONFIRMED_LOCK_RELEASED", run, at);
    });
  }

  getRunAudit(runId: string): RunTransitionAudit[] {
    this.requireRun(runId);
    const rows = this.database.prepare("SELECT * FROM run_state_audit WHERE run_id = ? ORDER BY id").all(runId) as SqlRow[];
    return rows.map((row) => {
      const fromState = column(row, "from_state");
      const message = column(row, "message");
      const observedTotalFen = column(row, "observed_total_fen");
      const selectedSession = column(row, "selected_session");
      const selectedTier = column(row, "selected_tier");
      const orderReference = column(row, "order_reference");
      return {
        id: asNumber(column(row, "id"), "id"),
        runId: String(column(row, "run_id")),
        ...(fromState === null ? {} : { fromState: String(fromState) as RunState }),
        toState: String(column(row, "to_state")) as RunState,
        ...(message === null ? {} : { message: String(message) }),
        ...(observedTotalFen === null
          ? {}
          : { observedTotalFen: asNumber(observedTotalFen, "observed_total_fen") }),
        ...(selectedSession === null ? {} : { selectedSession: String(selectedSession) }),
        ...(selectedTier === null ? {} : { selectedTier: String(selectedTier) }),
        ...(orderReference === null ? {} : { orderReference: String(orderReference) }),
        at: String(column(row, "at"))
      };
    });
  }

  getPlanAudit(planId: string): PlanStatusAudit[] {
    this.requirePlan(planId);
    const rows = this.database.prepare("SELECT * FROM plan_status_audit WHERE plan_id = ? ORDER BY id").all(planId) as SqlRow[];
    return rows.map((row) => {
      const fromStatus = column(row, "from_status");
      const reason = column(row, "reason");
      return {
        id: asNumber(column(row, "id"), "id"),
        planId: String(column(row, "plan_id")),
        ...(fromStatus === null ? {} : { fromStatus: String(fromStatus) as PlanStatus }),
        toStatus: String(column(row, "to_status")) as PlanStatus,
        ...(reason === null ? {} : { reason: String(reason) }),
        at: String(column(row, "at"))
      };
    });
  }

  private insertRunAudit(
    runId: string,
    fromState: RunState | undefined,
    toState: RunState,
    message: string | undefined,
    run: PurchaseRun,
    at: string
  ): void {
    this.database
      .prepare(`
        INSERT INTO run_state_audit (
          run_id, from_state, to_state, message, observed_total_fen,
          selected_session, selected_tier, order_reference, at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        runId,
        fromState ?? null,
        toState,
        message ?? null,
        run.observedTotalFen ?? null,
        run.selectedSession ?? null,
        run.selectedTier ?? null,
        run.orderReference ?? null,
        at
      );
  }

  private insertPlanAudit(
    planId: string,
    fromStatus: PlanStatus | undefined,
    toStatus: PlanStatus,
    reason: string | undefined,
    at: string
  ): void {
    this.database
      .prepare("INSERT INTO plan_status_audit (plan_id, from_status, to_status, reason, at) VALUES (?, ?, ?, ?, ?)")
      .run(planId, fromStatus ?? null, toStatus, reason ?? null, at);
  }
}
