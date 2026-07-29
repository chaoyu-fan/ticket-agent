import type { Page } from "playwright-core";

import type { RunnerEvent, WatchPlan } from "../core/types.js";
import type { TicketPlatformAdapter } from "../adapters/types.js";

/** A mode is deliberately required; there is no implicit live mode. */
export type RunnerMode = "dry-run" | "mock" | "live";

export interface LocalRunnerRequest {
  runId: string;
  plan: WatchPlan;
  mode: RunnerMode;
  /** Overrides plan.officialUrl only for a validated mock/dry-run target. */
  targetUrl?: string;
}

export interface LocalRunnerOptions {
  page?: Page;
  adapter?: TicketPlatformAdapter;
  onEvent?: (event: RunnerEvent) => void | Promise<void>;
  /**
   * Required before a live DOM submit. The controller should return allowed
   * only after its explicit approve-submit endpoint has atomically recorded
   * SUBMIT_ORDER and acquired the duplicate-order lock. onEvent is therefore
   * not called for the runner's corresponding local SUBMIT_ORDER event.
   */
  authorizeSubmit?: (input: {
    runId: string;
    plan: WatchPlan;
    observedTotalFen: number;
  }) =>
    | (
      | { allowed: true; approvedTotalFen: number }
      | { allowed: false; state?: "DUPLICATE_BLOCKED" | "HUMAN_TAKEOVER"; message?: string }
    )
    | Promise<
      | { allowed: true; approvedTotalFen: number }
      | { allowed: false; state?: "DUPLICATE_BLOCKED" | "HUMAN_TAKEOVER"; message?: string }
    >;
  /** Injectable wall clock and sleep keep sale/queue waiting deterministic in tests. */
  now?: () => Date;
  sleep?: (milliseconds: number) => void | Promise<void>;
  /** A live run started earlier than this window remains SCHEDULED and opens no browser. */
  prewarmWindowMs?: number;
  /** Visible-DOM queue checks are serial and never refresh or open another page. */
  queuePollIntervalMs?: number;
  /** Used by the Mac CLI to turn SIGINT/SIGTERM into a persisted FAILED state. */
  signal?: AbortSignal;
  /** Detects controller-side cancellation/revocation during long waits. */
  checkRunActive?: (input: { runId: string; expectedState: RunnerEvent["state"] }) =>
    | { active: boolean; message?: string }
    | Promise<{ active: boolean; message?: string }>;
}

export interface LocalRunnerResult {
  runId: string;
  state: RunnerEvent["state"];
  message: string;
  observedTotalFen?: number;
  selectedSession?: string;
  selectedTier?: string;
  adjacentVerified?: boolean;
  /** Present only after a visible, adapter-confirmed payment/order state. */
  orderReference?: string;
  events: RunnerEvent[];
}
