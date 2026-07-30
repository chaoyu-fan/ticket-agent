import type { AttendeeRef } from "../identity/attendee-ref.js";

export type Platform = "damai" | "maoyan";

export type PriceStrategy = "CHEAPEST_FIRST" | "PREFERRED_ORDER";

export type PlanStatus = "DRAFT" | "ARMED" | "RUNNING" | "PAUSED" | "COMPLETED" | "CANCELLED";

export type RunState =
  | "SCHEDULED"
  | "PREWARM"
  | "LOGIN_READY"
  | "WAIT_FOR_SALE"
  | "OFFICIAL_QUEUE"
  | "SELECT_SESSION"
  | "SELECT_TIER"
  | "SELECT_QUANTITY"
  | "SELECT_ATTENDEE"
  | "VERIFY_PRICE"
  | "REVIEW_REQUIRED"
  | "SUBMIT_ORDER"
  | "PAY_REQUIRED"
  | "SUCCESS"
  | "CAPTCHA_REQUIRED"
  | "LOGIN_EXPIRED"
  | "PRICE_LIMIT_EXCEEDED"
  | "PAGE_CHANGED"
  | "SOLD_OUT"
  | "DUPLICATE_BLOCKED"
  | "HUMAN_TAKEOVER"
  | "FAILED";

export interface SessionPreference {
  label: string;
  priority: number;
}

export interface TierPreference {
  label: string;
  /** Price in fen. Optional because some pages disclose price late. */
  maxUnitPriceFen?: number;
  priority: number;
}

export interface WatchPlanInput {
  platform: Platform;
  officialUrl?: string;
  eventId?: string;
  eventTitle?: string;
  /** Stable user-supplied identity shared by Damai and Maoyan plans. */
  canonicalEventKey?: string;
  saleAt?: string;
  quantity?: number;
  requireAdjacent?: boolean;
  sessions?: SessionPreference[];
  tiers?: TierPreference[];
  maxTotalFen?: number;
  priceStrategy?: PriceStrategy;
  /** Opaque Mac-local Keychain handles. Safe to persist and synchronize. */
  /** Untrusted JSON uses strings; normalizePlan validates and brands them. */
  attendeeRefs?: string[];
  /** @deprecated Runtime-only resolved labels. Never persist a non-empty value. */
  attendeeAliases?: string[];
  autoSubmitOrder?: boolean;
}

export interface WatchPlan {
  id: string;
  platform: Platform;
  officialUrl?: string;
  eventId?: string;
  eventTitle?: string;
  canonicalEventKey?: string;
  saleAt?: string;
  quantity: number;
  requireAdjacent: boolean;
  sessions: SessionPreference[];
  tiers: TierPreference[];
  maxTotalFen?: number;
  priceStrategy: PriceStrategy;
  /** Normalized controller plans always provide this field. */
  attendeeRefs?: AttendeeRef[];
  /** Runtime-only labels resolved from Mac Keychain during PREWARM. */
  attendeeAliases: string[];
  autoSubmitOrder: boolean;
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseRun {
  id: string;
  planId: string;
  state: RunState;
  observedTotalFen?: number;
  /** ISO timestamp for the first immutable price observation. */
  priceVerifiedAt?: string;
  selectedSession?: string;
  selectedTier?: string;
  orderReference?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunnerEvent {
  runId: string;
  state: RunState;
  message?: string;
  observedTotalFen?: number;
  /** A non-sensitive digest of the selected session/tier/quantity. */
  selectionFingerprint?: string;
  /** Set only after the adapter has positively verified adjacent seats. */
  adjacentVerified?: boolean;
  selectedSession?: string;
  selectedTier?: string;
  orderReference?: string;
  at?: string;
}

export interface PlanValidation {
  ok: boolean;
  errors: string[];
}
