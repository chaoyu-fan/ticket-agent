import type { PurchaseRun, RunnerEvent, WatchPlan } from "../core/types.js";
import { validatePlan } from "../core/policy.js";
import { assertAttendeePersistenceBoundary } from "../identity/attendee-ref.js";

interface ErrorPayload {
  error?: { code?: string; message?: string; details?: unknown };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const RUN_STATES = new Set([
  "SCHEDULED", "PREWARM", "LOGIN_READY", "WAIT_FOR_SALE", "OFFICIAL_QUEUE", "SELECT_SESSION",
  "SELECT_TIER", "SELECT_QUANTITY", "SELECT_ATTENDEE", "VERIFY_PRICE", "REVIEW_REQUIRED", "SUBMIT_ORDER",
  "PAY_REQUIRED", "SUCCESS", "CAPTCHA_REQUIRED", "LOGIN_EXPIRED", "PRICE_LIMIT_EXCEEDED", "PAGE_CHANGED",
  "SOLD_OUT", "DUPLICATE_BLOCKED", "HUMAN_TAKEOVER", "FAILED"
]);
const PLAN_STATUSES = new Set(["DRAFT", "ARMED", "RUNNING", "PAUSED", "COMPLETED", "CANCELLED"]);

function invalidApproval(message: string): ControllerClientError {
  return new ControllerClientError(502, "CONTROLLER_RESPONSE_INVALID", message);
}

export class ControllerClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ControllerClientError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function controllerBase(value: string): URL {
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !isLoopback(url.hostname)) {
    throw new Error("CONTROLLER_URL_BLOCKED:controller must use a loopback HTTP(S) URL on the Mac");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("CONTROLLER_URL_BLOCKED:credentials, query and fragment are not allowed");
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    throw new Error("CONTROLLER_URL_BLOCKED:controller URL must not contain a path");
  }
  url.pathname = url.pathname.replace(/\/?$/, "/");
  return url;
}

export class ControllerClient {
  private readonly baseUrl: URL;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    if (Buffer.byteLength(token, "utf8") < 32) throw new Error("CONTROLLER_TOKEN_TOO_SHORT:minimum=32");
    this.baseUrl = controllerBase(baseUrl);
    this.token = token;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const url = new URL(path.replace(/^\//, ""), this.baseUrl);
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000)
    });
    const payload: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errorPayload = isRecord(payload) && isRecord(payload.error)
        ? payload.error as ErrorPayload["error"]
        : undefined;
      throw new ControllerClientError(
        response.status,
        typeof errorPayload?.code === "string" ? errorPayload.code : "CONTROLLER_REQUEST_FAILED",
        typeof errorPayload?.message === "string"
          ? errorPayload.message
          : `Controller returned HTTP ${response.status}`,
        errorPayload?.details
      );
    }
    return payload as T;
  }

  async loadRunPlan(runId: string): Promise<{ run: PurchaseRun; plan: WatchPlan }> {
    const runPayload = await this.request<unknown>("GET", `/runs/${encodeURIComponent(runId)}`);
    if (!isRecord(runPayload) || !isRecord(runPayload.run)) {
      throw invalidApproval("Controller run response must contain a run object");
    }
    const run = runPayload.run;
    if (
      run.id !== runId ||
      typeof run.planId !== "string" ||
      run.planId.trim() === "" ||
      typeof run.state !== "string" ||
      !RUN_STATES.has(run.state) ||
      typeof run.createdAt !== "string" ||
      Number.isNaN(Date.parse(run.createdAt)) ||
      typeof run.updatedAt !== "string" ||
      Number.isNaN(Date.parse(run.updatedAt))
    ) {
      throw invalidApproval("Controller run response is malformed or does not match the requested run");
    }

    const planPayload = await this.request<unknown>("GET", `/plans/${encodeURIComponent(run.planId)}`);
    if (!isRecord(planPayload) || !isRecord(planPayload.plan)) {
      throw invalidApproval("Controller plan response must contain a plan object");
    }
    const plan = planPayload.plan;
    try {
      assertAttendeePersistenceBoundary(plan);
    } catch {
      throw invalidApproval("Controller plan contains forbidden attendee identity material");
    }
    if (
      plan.id !== run.planId ||
      typeof plan.status !== "string" ||
      !PLAN_STATUSES.has(plan.status) ||
      typeof plan.createdAt !== "string" ||
      Number.isNaN(Date.parse(plan.createdAt)) ||
      typeof plan.updatedAt !== "string" ||
      Number.isNaN(Date.parse(plan.updatedAt)) ||
      !validatePlan(plan as unknown as WatchPlan).ok
    ) {
      throw invalidApproval("Controller plan response is invalid or does not match the run planId");
    }
    return { run: run as unknown as PurchaseRun, plan: plan as unknown as WatchPlan };
  }

  async recordEvent(event: RunnerEvent): Promise<void> {
    // These states have dedicated step-up endpoints and must never be accepted
    // through the generic event channel.
    if (event.state === "SUBMIT_ORDER" || event.state === "SUCCESS") return;
    await this.request<{ run: PurchaseRun }>("POST", `/runs/${encodeURIComponent(event.runId)}/events`, event);
  }

  async approveSubmit(runId: string, observedTotalFen: number): Promise<PurchaseRun> {
    const payload = await this.request<unknown>(
      "POST",
      `/runs/${encodeURIComponent(runId)}/approve-submit`,
      { confirmation: "APPROVE_SUBMIT", observedTotalFen }
    );
    if (!isRecord(payload)) {
      throw invalidApproval("Controller approval response must be a JSON object");
    }
    if (payload.allowed === false) {
      const message = typeof payload.message === "string"
        ? payload.message
        : "Controller denied submit authorization";
      throw new ControllerClientError(
        409,
        /(?:DUPLICATE|PURCHASE_LOCK)/.test(message) ? "DUPLICATE_PURCHASE_LOCKED" : "SUBMIT_AUTHORIZATION_DENIED",
        message
      );
    }
    if (payload.allowed !== true) {
      throw invalidApproval("Controller approval response must contain allowed=true");
    }
    if (!isRecord(payload.run)) {
      throw invalidApproval("Controller approval response must contain a run object");
    }

    const run = payload.run;
    if (run.id !== runId) {
      throw invalidApproval("Controller approval run ID does not match the requested run");
    }
    if (typeof run.planId !== "string" || run.planId.trim() === "") {
      throw invalidApproval("Controller approval run must contain a non-empty planId");
    }
    if (run.state !== "SUBMIT_ORDER") {
      throw invalidApproval("Controller approval run must be in SUBMIT_ORDER");
    }
    if (run.observedTotalFen !== observedTotalFen) {
      throw invalidApproval("Controller approval total does not match the requested verified total");
    }
    if (
      typeof run.priceVerifiedAt !== "string" ||
      run.priceVerifiedAt.trim() === "" ||
      Number.isNaN(Date.parse(run.priceVerifiedAt))
    ) {
      throw invalidApproval("Controller approval run must contain priceVerifiedAt");
    }
    if (typeof run.createdAt !== "string" || run.createdAt.trim() === "" || Number.isNaN(Date.parse(run.createdAt))) {
      throw invalidApproval("Controller approval run must contain createdAt");
    }
    if (typeof run.updatedAt !== "string" || run.updatedAt.trim() === "" || Number.isNaN(Date.parse(run.updatedAt))) {
      throw invalidApproval("Controller approval run must contain updatedAt");
    }
    for (const field of ["selectedSession", "selectedTier", "orderReference", "lastError"] as const) {
      if (run[field] !== undefined && typeof run[field] !== "string") {
        throw invalidApproval(`Controller approval run field ${field} must be a string when present`);
      }
    }
    return run as unknown as PurchaseRun;
  }
}

export function submitDenial(error: unknown): {
  allowed: false;
  state: "DUPLICATE_BLOCKED" | "HUMAN_TAKEOVER";
  message: string;
} {
  if (error instanceof ControllerClientError && /(?:DUPLICATE|PURCHASE_LOCK)/.test(error.code)) {
    return { allowed: false, state: "DUPLICATE_BLOCKED", message: `${error.code}:${error.message}` };
  }
  const message = error instanceof Error ? error.message : "Controller approval failed";
  return { allowed: false, state: "HUMAN_TAKEOVER", message: `CONTROLLER_APPROVAL_FAILED:${message}` };
}
