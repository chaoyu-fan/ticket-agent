import type { Locator, Page } from "playwright-core";

import type { Platform, RunState, WatchPlan } from "../core/types.js";

export type AdapterPhase =
  | "prewarm"
  | "queue"
  | "session"
  | "tier"
  | "quantity"
  | "attendee"
  | "verify"
  | "submit";

export type PriceObservation =
  | { kind: "missing"; valuesFen: [] }
  | { kind: "unique"; valuesFen: [number]; totalFen: number }
  | { kind: "ambiguous"; valuesFen: number[] }
  | { kind: "invalid"; valuesFen: number[] };

export interface PageSignals {
  url: string;
  title: string;
  /** Visible event heading when the adapter can identify one. */
  eventTitle?: string;
  /** Platform event identifier extracted from visible/URL-safe metadata. */
  eventId?: string;
  readable: boolean;
  captchaRequired: boolean;
  loginRequired: boolean;
  soldOut: boolean;
  inOfficialQueue: boolean;
  /** Positive evidence that the selected quantity can be seated together. */
  adjacentAvailable?: boolean;
  /** A visible post-submit payment/order state, if present. */
  paymentRequired?: boolean;
  orderReference?: string;
  price: PriceObservation;
  /** Non-sensitive labels only. Body text and account data must never be returned. */
  evidence: string[];
}

export interface GuardDecision {
  blocked: boolean;
  state?: Extract<
    RunState,
    "CAPTCHA_REQUIRED" | "LOGIN_EXPIRED" | "SOLD_OUT" | "PRICE_LIMIT_EXCEEDED" | "PAGE_CHANGED"
  >;
  message?: string;
  observedTotalFen?: number;
}

export interface AdapterStepResult {
  ok: boolean;
  message: string;
  selectedLabel?: string;
  selectionFingerprint?: string;
  adjacentVerified?: boolean;
  orderReference?: string;
  paymentRequired?: boolean;
  blockedState?: Extract<
    RunState,
    | "SOLD_OUT"
    | "PAGE_CHANGED"
    | "CAPTCHA_REQUIRED"
    | "LOGIN_EXPIRED"
    | "PRICE_LIMIT_EXCEEDED"
    | "HUMAN_TAKEOVER"
  >;
}

export interface AdapterContext {
  page: Page;
  plan: WatchPlan;
}

/**
 * Context for the single irreversible DOM action. `approvedTotalFen` must be
 * copied from the controller's successful submit authorization response, not
 * merely from an earlier page observation. The remaining fields are
 * non-sensitive selection evidence recorded by the runner and rechecked by
 * the adapter in the same browser task as the click.
 */
export interface ApprovedSubmitContext extends AdapterContext {
  approvedTotalFen: number;
  selectedSession: string;
  selectedTier: string;
  adjacentVerified: boolean;
}

/**
 * UI-only adapter contract. Implementations may use visible DOM controls but
 * must not call, discover, or replay private platform APIs.
 */
export interface TicketPlatformAdapter {
  readonly platform: Platform;
  readonly implemented: boolean;
  /** Must remain false until selectors have been reviewed against a real, user-supplied official page. */
  readonly liveReady: boolean;

  supportsOfficialUrl(url: URL): boolean;
  navigate(page: Page, url: string): Promise<void>;
  inspect(context: AdapterContext, phase: AdapterPhase): Promise<PageSignals>;
  guard(signals: PageSignals, phase: AdapterPhase, plan: WatchPlan): GuardDecision;

  selectSession(context: AdapterContext): Promise<AdapterStepResult>;
  selectTier(context: AdapterContext): Promise<AdapterStepResult>;
  selectQuantity(context: AdapterContext): Promise<AdapterStepResult>;
  selectAttendees(context: AdapterContext): Promise<AdapterStepResult>;
  submitOrder(context: ApprovedSubmitContext): Promise<AdapterStepResult>;
}

export interface VisibleCandidate {
  locator: Locator;
  label: string;
  priceFen?: number;
}
