import { isAttendeeRef, parseAttendeeRef } from "../identity/attendee-ref.js";
import type { PlanValidation, WatchPlan, WatchPlanInput } from "./types.js";

const PRICE_STRATEGIES = new Set(["CHEAPEST_FIRST", "PREFERRED_ORDER"] as const);
const PLATFORMS = new Set(["damai", "maoyan"] as const);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function normalizedIdentity(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\p{P}\p{S}\p{Z}]+/gu, "")
    .trim();
}

function validatePreferenceArray(value: unknown, field: "sessions" | "tiers", errors: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return;
  }
  const labels = new Set<string>();
  const priorities = new Set<number>();
  for (const item of value) {
    if (!isRecord(item)) {
      errors.push(`${field} entries must be objects`);
      continue;
    }
    if (typeof item.label !== "string" || item.label.trim() === "") {
      errors.push(`${field} labels must be non-empty strings`);
    } else {
      const key = normalizedIdentity(item.label);
      if (labels.has(key)) errors.push(`${field} labels must be unique`);
      labels.add(key);
    }
    if (!isFiniteNonNegativeInteger(item.priority)) {
      errors.push(`${field} priorities must be non-negative integers`);
    } else if (priorities.has(item.priority)) {
      errors.push(`${field} priorities must be unique`);
    } else {
      priorities.add(item.priority);
    }
    if (field === "tiers" && item.maxUnitPriceFen !== undefined && !isFiniteNonNegativeInteger(item.maxUnitPriceFen)) {
      errors.push("tier maxUnitPriceFen must be a non-negative integer in fen");
    }
  }
}

/** Runtime validation shared by the CLI and HTTP controller. */
export function validatePlanShape(input: unknown): string[] {
  if (!isRecord(input)) return ["plan must be an object"];
  const errors: string[] = [];
  if (typeof input.platform !== "string") errors.push("platform must be a string");
  if (input.officialUrl !== undefined && typeof input.officialUrl !== "string") errors.push("officialUrl must be a string");
  if (input.eventId !== undefined && typeof input.eventId !== "string") errors.push("eventId must be a string");
  if (input.eventTitle !== undefined && typeof input.eventTitle !== "string") errors.push("eventTitle must be a string");
  if (input.canonicalEventKey !== undefined && typeof input.canonicalEventKey !== "string") {
    errors.push("canonicalEventKey must be a string");
  }
  if (input.saleAt !== undefined && typeof input.saleAt !== "string") errors.push("saleAt must be a string");
  if (input.quantity !== undefined && typeof input.quantity !== "number") errors.push("quantity must be a number");
  if (input.requireAdjacent !== undefined && typeof input.requireAdjacent !== "boolean") {
    errors.push("requireAdjacent must be a boolean");
  }
  if (input.maxTotalFen !== undefined && typeof input.maxTotalFen !== "number") {
    errors.push("maxTotalFen must be a number");
  }
  if (input.priceStrategy !== undefined && typeof input.priceStrategy !== "string") {
    errors.push("priceStrategy must be a string");
  }
  if (input.attendeeRefs !== undefined) {
    if (!Array.isArray(input.attendeeRefs)) {
      errors.push("attendeeRefs must be an array");
    } else if (input.attendeeRefs.some((ref) => !isAttendeeRef(ref))) {
      errors.push("attendeeRefs must contain only canonical opaque references");
    }
  }
  if (input.attendeeAliases !== undefined) {
    if (!Array.isArray(input.attendeeAliases) || input.attendeeAliases.some((alias) => typeof alias !== "string")) {
      errors.push("attendeeAliases must be an array of strings");
    }
  }
  if (input.autoSubmitOrder !== undefined && typeof input.autoSubmitOrder !== "boolean") {
    errors.push("autoSubmitOrder must be a boolean");
  }
  validatePreferenceArray(input.sessions, "sessions", errors);
  validatePreferenceArray(input.tiers, "tiers", errors);
  return errors;
}

export function normalizePlan(input: WatchPlanInput): Omit<WatchPlan, "id" | "status" | "createdAt" | "updatedAt"> {
  const shapeErrors = validatePlanShape(input);
  if (shapeErrors.length > 0) throw new Error(`PLAN_SHAPE_INVALID:${shapeErrors.join(";")}`);
  return {
    platform: input.platform,
    ...(input.officialUrl === undefined ? {} : { officialUrl: input.officialUrl.trim() }),
    ...(input.eventId === undefined ? {} : { eventId: input.eventId.trim() }),
    ...(input.eventTitle === undefined ? {} : { eventTitle: input.eventTitle.trim() }),
    ...(input.canonicalEventKey === undefined ? {} : { canonicalEventKey: input.canonicalEventKey.trim() }),
    ...(input.saleAt === undefined ? {} : { saleAt: input.saleAt }),
    quantity: input.quantity ?? 1,
    requireAdjacent: input.requireAdjacent ?? false,
    sessions: [...(input.sessions ?? [])]
      .map((item) => ({ label: item.label.trim(), priority: item.priority }))
      .sort((a, b) => a.priority - b.priority),
    tiers: [...(input.tiers ?? [])]
      .map((item) => ({
        label: item.label.trim(),
        ...(item.maxUnitPriceFen === undefined ? {} : { maxUnitPriceFen: item.maxUnitPriceFen }),
        priority: item.priority
      }))
      .sort((a, b) => a.priority - b.priority),
    ...(input.maxTotalFen === undefined ? {} : { maxTotalFen: input.maxTotalFen }),
    priceStrategy: input.priceStrategy ?? "CHEAPEST_FIRST",
    attendeeRefs: [...(input.attendeeRefs ?? [])].map((ref) => parseAttendeeRef(ref)),
    attendeeAliases: [...(input.attendeeAliases ?? [])].map((alias) => alias.trim()),
    autoSubmitOrder: input.autoSubmitOrder ?? false
  };
}

export function validatePlan(plan: WatchPlanInput | WatchPlan): PlanValidation {
  const errors = validatePlanShape(plan);
  if (errors.length > 0) return { ok: false, errors };

  if (!PLATFORMS.has(plan.platform as "damai" | "maoyan")) errors.push("platform must be damai or maoyan");
  const quantity = plan.quantity ?? 1;
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 6) {
    errors.push("quantity must be an integer between 1 and 6");
  }
  if (plan.maxTotalFen !== undefined && !isFiniteNonNegativeInteger(plan.maxTotalFen)) {
    errors.push("maxTotalFen must be a non-negative integer in fen");
  }
  if (plan.canonicalEventKey !== undefined) {
    if (!normalizedIdentity(plan.canonicalEventKey) || plan.canonicalEventKey.trim().length > 200) {
      errors.push("canonicalEventKey must be 1-200 non-space characters");
    }
  }
  if (plan.officialUrl !== undefined) {
    try {
      const url = new URL(plan.officialUrl);
      const expectedDomain = plan.platform === "damai" ? "damai.cn" : "maoyan.com";
      const domainMatches = url.hostname === expectedDomain || url.hostname.endsWith(`.${expectedDomain}`);
      if (
        url.protocol !== "https:" ||
        !domainMatches ||
        url.username !== "" ||
        url.password !== "" ||
        (url.port !== "" && url.port !== "443")
      ) {
        errors.push(`officialUrl must be an HTTPS ${plan.platform} URL without embedded credentials`);
      }
    } catch {
      errors.push("officialUrl must be a valid absolute URL");
    }
  }
  if (
    plan.saleAt !== undefined &&
    (Number.isNaN(Date.parse(plan.saleAt)) || !plan.saleAt.includes("T") || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(plan.saleAt))
  ) {
    errors.push("saleAt must be an ISO date-time with an explicit timezone");
  }
  const aliases = plan.attendeeAliases ?? [];
  const aliasKeys = new Set<string>();
  for (const alias of aliases) {
    if (alias.trim() === "" || normalizedIdentity(alias) === "") errors.push("attendee aliases cannot be empty");
    const key = normalizedIdentity(alias);
    if (aliasKeys.has(key)) errors.push("attendee aliases must be unique");
    aliasKeys.add(key);
  }
  const attendeeRefs = plan.attendeeRefs ?? [];
  const refKeys = new Set<string>();
  for (const ref of attendeeRefs) {
    if (!isAttendeeRef(ref)) {
      errors.push("attendeeRefs must contain only canonical opaque references");
      continue;
    }
    if (refKeys.has(ref)) errors.push("attendeeRefs must be unique");
    refKeys.add(ref);
  }
  const priceStrategy = plan.priceStrategy ?? "CHEAPEST_FIRST";
  if (!PRICE_STRATEGIES.has(priceStrategy as "CHEAPEST_FIRST" | "PREFERRED_ORDER")) {
    errors.push("priceStrategy must be CHEAPEST_FIRST or PREFERRED_ORDER");
  }
  if (priceStrategy === "PREFERRED_ORDER" && (plan.tiers?.length ?? 0) === 0) {
    errors.push("PREFERRED_ORDER requires at least one tier preference");
  }
  if (plan.autoSubmitOrder) {
    if (plan.maxTotalFen === undefined) errors.push("autoSubmitOrder requires maxTotalFen");
    if (!plan.officialUrl) errors.push("autoSubmitOrder requires an officialUrl");
    if (!plan.saleAt) errors.push("autoSubmitOrder requires saleAt with an explicit timezone");
    if (!plan.canonicalEventKey || !normalizedIdentity(plan.canonicalEventKey)) {
      errors.push("autoSubmitOrder requires a non-empty canonicalEventKey");
    }
    if (!plan.eventId || !normalizedIdentity(plan.eventId)) {
      errors.push("autoSubmitOrder requires a non-empty eventId");
    }
    if (!plan.eventTitle || !normalizedIdentity(plan.eventTitle)) {
      errors.push("autoSubmitOrder requires a non-empty eventTitle");
    }
    if (attendeeRefs.length !== quantity) {
      errors.push("autoSubmitOrder requires exactly one unique opaque attendeeRef per ticket");
    }
  }
  return { ok: errors.length === 0, errors };
}

export function canAutoSubmit(plan: WatchPlan, observedTotalFen: number): boolean {
  if (!plan.autoSubmitOrder || plan.maxTotalFen === undefined) return false;
  if (!plan.saleAt || !Number.isFinite(Date.parse(plan.saleAt))) return false;
  if (!plan.canonicalEventKey || !normalizedIdentity(plan.canonicalEventKey)) return false;
  if (!plan.eventId || !normalizedIdentity(plan.eventId)) return false;
  if (!plan.eventTitle || !normalizedIdentity(plan.eventTitle)) return false;
  if ((plan.attendeeRefs?.length ?? 0) !== plan.quantity) return false;
  if (new Set(plan.attendeeRefs).size !== plan.quantity) return false;
  if (!Number.isSafeInteger(observedTotalFen) || observedTotalFen < 0) return false;
  return observedTotalFen <= plan.maxTotalFen;
}

export function assertPriceAllowed(plan: WatchPlan, observedTotalFen: number): void {
  if (!Number.isSafeInteger(observedTotalFen) || observedTotalFen < 0) {
    throw new Error(`PRICE_INVALID:${observedTotalFen}`);
  }
  if (plan.maxTotalFen === undefined) {
    if (plan.autoSubmitOrder) throw new Error("AUTO_SUBMIT_BLOCKED_NO_MAX_TOTAL");
    return;
  }
  if (observedTotalFen > plan.maxTotalFen) {
    throw new Error(`PRICE_LIMIT_EXCEEDED:${observedTotalFen}>${plan.maxTotalFen}`);
  }
}
