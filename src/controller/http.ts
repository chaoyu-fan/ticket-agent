import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";

import type { PlanStatus, RunnerEvent, WatchPlanInput } from "../core/types.js";
import { canonicalOfficialOrigin } from "../security/submit-capability.js";
import { ControllerError, isControllerError } from "./errors.js";
import type {
  ClaimSubmitCapabilityInput,
  SubmitCapabilityService
} from "./submit-capability-service.js";
import {
  ControllerStore,
  type NoOrderReconciliationInput,
  type SubmitAttemptOutcome,
  type SubmitAuthorizationInput,
  type SuccessConfirmationInput,
  type WatchPlanPatch
} from "./store.js";

export interface ControllerHttpOptions {
  store: ControllerStore;
  token: string;
  submitCapabilityService: SubmitCapabilityService;
  maxBodyBytes?: number;
}

export interface ListenControllerOptions {
  host?: "127.0.0.1" | "::1" | "localhost";
  port?: number;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function json(response: ServerResponse, status: number, body: unknown): void {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": encoded.byteLength,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(encoded);
}

function noContent(response: ServerResponse): void {
  response.writeHead(204, { "cache-control": "no-store" });
  response.end();
}

function authorized(request: IncomingMessage, token: string): boolean {
  const supplied = Buffer.from(request.headers.authorization ?? "", "utf8");
  const expected = Buffer.from(`Bearer ${token}`, "utf8");
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}

function requireJsonContentType(request: IncomingMessage): void {
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !/^\s*application\/json\s*(?:;|$)/iu.test(contentType)
  ) {
    throw new ControllerError(
      "UNSUPPORTED_MEDIA_TYPE",
      "Request Content-Type must be application/json",
      415
    );
  }
}

async function readJson(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    received += buffer.byteLength;
    if (received > maxBodyBytes) throw new ControllerError("BODY_TOO_LARGE", "Request body is too large", 413);
    chunks.push(buffer);
  }
  if (received === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ControllerError("INVALID_JSON", "Request body must be valid JSON", 400);
  }
}

function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ControllerError("INVALID_BODY", "Request body must be a JSON object", 422);
  }
  return value as Record<string, unknown>;
}

function exactObjectBody(
  value: unknown,
  expectedKeys: readonly string[],
  code: string,
  message: string
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ControllerError(code, message, 422);
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).sort().join(",") !== [...expectedKeys].sort().join(",")) {
    throw new ControllerError(code, message, 422);
  }
  return body;
}

function deliveryIdFromPreparedAck(value: unknown): string {
  const body = exactObjectBody(
    value,
    ["deliveryId"],
    "SUBMIT_CAPABILITY_PREPARED_ACK_INVALID",
    "Prepared acknowledgement must contain only a valid deliveryId"
  );
  const deliveryId = body.deliveryId;
  if (
    typeof deliveryId !== "string" ||
    deliveryId.length < 1 ||
    deliveryId.length > 200 ||
    deliveryId.trim() !== deliveryId ||
    /[\u0000-\u001f\u007f]/u.test(deliveryId)
  ) {
    throw new ControllerError(
      "SUBMIT_CAPABILITY_PREPARED_ACK_INVALID",
      "Prepared acknowledgement must contain only a valid deliveryId",
      422
    );
  }
  return deliveryId;
}

function claimSubmitCapabilityBody(value: unknown): ClaimSubmitCapabilityInput {
  const body = exactObjectBody(
    value,
    [
      "attendeeSelectionFingerprint",
      "fastPathContractDigest",
      "finalOfficialOrigin",
      "runnerSessionDigest"
    ],
    "SUBMIT_CAPABILITY_DELIVERY_INVALID",
    "Capability delivery request fields are invalid"
  );
  const runnerSessionDigest = body.runnerSessionDigest;
  const attendeeSelectionFingerprint = body.attendeeSelectionFingerprint;
  const fastPathContractDigest = body.fastPathContractDigest;
  const finalOfficialOrigin = body.finalOfficialOrigin;
  if (
    typeof runnerSessionDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(runnerSessionDigest) ||
    typeof attendeeSelectionFingerprint !== "string" ||
    !/^hmac-sha256:[0-9a-f]{64}$/u.test(attendeeSelectionFingerprint) ||
    typeof fastPathContractDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(fastPathContractDigest) ||
    typeof finalOfficialOrigin !== "string" ||
    finalOfficialOrigin.length < 1 ||
    finalOfficialOrigin.length > 300 ||
    finalOfficialOrigin.trim() !== finalOfficialOrigin ||
    /[\u0000-\u001f\u007f]/u.test(finalOfficialOrigin)
  ) {
    throw new ControllerError(
      "SUBMIT_CAPABILITY_DELIVERY_INVALID",
      "Capability delivery request fields are invalid",
      422
    );
  }
  return {
    runnerSessionDigest: runnerSessionDigest as `sha256:${string}`,
    attendeeSelectionFingerprint: attendeeSelectionFingerprint as `hmac-sha256:${string}`,
    fastPathContractDigest: fastPathContractDigest as `sha256:${string}`,
    finalOfficialOrigin
  };
}

const SUBMIT_ATTEMPT_OUTCOMES = new Set<SubmitAttemptOutcome>([
  "CLICK_DISPATCHED",
  "OUTCOME_UNKNOWN",
  "CONSUME_REJECTED",
  "ZERO_CLICK_BLOCKED"
]);

function submitAttemptBody(value: unknown): { deliveryId: string; outcome: SubmitAttemptOutcome } {
  const body = exactObjectBody(
    value,
    ["deliveryId", "outcome"],
    "SUBMIT_CAPABILITY_ATTEMPT_INVALID",
    "Submit attempt must contain only a valid deliveryId and outcome"
  );
  const deliveryId = body.deliveryId;
  const outcome = body.outcome;
  if (
    typeof deliveryId !== "string" ||
    deliveryId.length < 1 ||
    deliveryId.length > 200 ||
    deliveryId.trim() !== deliveryId ||
    /[\u0000-\u001f\u007f]/u.test(deliveryId) ||
    typeof outcome !== "string" ||
    !SUBMIT_ATTEMPT_OUTCOMES.has(outcome as SubmitAttemptOutcome)
  ) {
    throw new ControllerError(
      "SUBMIT_CAPABILITY_ATTEMPT_INVALID",
      "Submit attempt must contain only a valid deliveryId and outcome",
      422
    );
  }
  return { deliveryId, outcome: outcome as SubmitAttemptOutcome };
}

function routeId(pathname: string, suffix = ""): string | undefined {
  const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^/plans/([^/]+)${escapedSuffix}$`).exec(pathname);
  if (match?.[1] === undefined) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    throw new ControllerError("INVALID_PATH", "Path contains invalid encoding", 400);
  }
}

function runRouteId(pathname: string, suffix = ""): string | undefined {
  const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^/runs/([^/]+)${escapedSuffix}$`).exec(pathname);
  if (match?.[1] === undefined) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    throw new ControllerError("INVALID_PATH", "Path contains invalid encoding", 400);
  }
}

async function handle(options: Required<ControllerHttpOptions>, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (method === "GET" && url.pathname === "/healthz") {
    json(response, options.store.healthCheck() ? 200 : 503, { ok: options.store.healthCheck() });
    return;
  }

  if (!authorized(request, options.token)) {
    response.setHeader("www-authenticate", 'Bearer realm="ticket-agent"');
    json(response, 401, { error: { code: "UNAUTHORIZED", message: "A valid Bearer token is required" } });
    return;
  }

  if (method === "POST" && url.pathname === "/plans") {
    const body = objectBody(await readJson(request, options.maxBodyBytes));
    json(response, 201, { plan: options.store.createPlan(body as unknown as WatchPlanInput) });
    return;
  }
  if (method === "GET" && url.pathname === "/plans") {
    const statusValue = url.searchParams.get("status");
    const status = statusValue === null ? undefined : (statusValue as PlanStatus);
    json(response, 200, { plans: options.store.listPlans(status) });
    return;
  }

  const planId = routeId(url.pathname);
  if (planId !== undefined) {
    if (method === "GET") {
      json(response, 200, { plan: options.store.requirePlan(planId) });
      return;
    }
    if (method === "PATCH") {
      const body = objectBody(await readJson(request, options.maxBodyBytes));
      json(response, 200, { plan: options.store.updatePlan(planId, body as unknown as WatchPlanPatch) });
      return;
    }
    if (method === "DELETE") {
      options.store.deletePlan(planId);
      noContent(response);
      return;
    }
  }

  const armId = routeId(url.pathname, "/arm");
  if (method === "POST" && armId !== undefined) {
    json(response, 200, options.store.armPlan(armId));
    return;
  }

  const cancelId = routeId(url.pathname, "/cancel");
  if (method === "POST" && cancelId !== undefined) {
    json(response, 200, options.store.cancelPlan(cancelId));
    return;
  }

  const planRunsId = routeId(url.pathname, "/runs");
  if (method === "GET" && planRunsId !== undefined) {
    options.store.requirePlan(planRunsId);
    json(response, 200, { runs: options.store.listRuns(planRunsId) });
    return;
  }

  const planAuditId = routeId(url.pathname, "/audit");
  if (method === "GET" && planAuditId !== undefined) {
    json(response, 200, { audit: options.store.getPlanAudit(planAuditId) });
    return;
  }

  const runId = runRouteId(url.pathname);
  if (method === "GET" && runId !== undefined) {
    json(response, 200, { run: options.store.requireRun(runId) });
    return;
  }

  const eventRunId = runRouteId(url.pathname, "/events");
  if (method === "POST" && eventRunId !== undefined) {
    const body = objectBody(await readJson(request, options.maxBodyBytes));
    if (body.runId !== eventRunId) {
      throw new ControllerError("RUN_ID_MISMATCH", "Body runId must match the URL", 422);
    }
    json(response, 200, { run: options.store.applyRunnerEvent(body as unknown as RunnerEvent) });
    return;
  }

  const deliverCapabilityRunId = runRouteId(url.pathname, "/submit-capability/deliver");
  if (method === "POST" && deliverCapabilityRunId !== undefined) {
    requireJsonContentType(request);
    const body = claimSubmitCapabilityBody(await readJson(request, options.maxBodyBytes));
    const run = options.store.requireRun(deliverCapabilityRunId);
    const plan = options.store.requirePlan(run.planId);
    try {
      canonicalOfficialOrigin(plan.platform, body.finalOfficialOrigin);
    } catch {
      throw new ControllerError(
        "SUBMIT_CAPABILITY_DELIVERY_INVALID",
        "finalOfficialOrigin must be a canonical official platform origin",
        422
      );
    }
    json(
      response,
      201,
      options.submitCapabilityService.claimDelivery(deliverCapabilityRunId, body)
    );
    return;
  }

  const preparedAckRunId = runRouteId(url.pathname, "/submit-capability/prepared-ack");
  if (method === "POST" && preparedAckRunId !== undefined) {
    requireJsonContentType(request);
    const deliveryId = deliveryIdFromPreparedAck(await readJson(request, options.maxBodyBytes));
    json(response, 200, {
      grant: options.store.ackSubmitCapabilityPrepared(preparedAckRunId, deliveryId)
    });
    return;
  }

  const submitAttemptRunId = runRouteId(url.pathname, "/submit-attempt");
  if (method === "POST" && submitAttemptRunId !== undefined) {
    requireJsonContentType(request);
    const body = submitAttemptBody(await readJson(request, options.maxBodyBytes));
    json(response, 200, {
      grant: options.store.recordSubmitAttemptOutcome(
        submitAttemptRunId,
        body.deliveryId,
        body.outcome
      )
    });
    return;
  }

  const capabilityGrantRunId = runRouteId(url.pathname, "/submit-capability");
  if (method === "GET" && capabilityGrantRunId !== undefined) {
    options.store.requireRun(capabilityGrantRunId);
    const grant = options.store.getSubmitCapabilityGrant(capabilityGrantRunId);
    if (grant === undefined) {
      throw new ControllerError(
        "SUBMIT_CAPABILITY_GRANT_NOT_FOUND",
        "No capability grant exists",
        404
      );
    }
    json(response, 200, { grant });
    return;
  }

  const approveSubmitRunId = runRouteId(url.pathname, "/approve-submit");
  if (method === "POST" && approveSubmitRunId !== undefined) {
    const body = objectBody(await readJson(request, options.maxBodyBytes));
    const authorization = options.store.authorizeSubmit(
      approveSubmitRunId,
      body as unknown as SubmitAuthorizationInput
    );
    if (!authorization.allowed) {
      json(response, 409, {
        error: {
          code: "DUPLICATE_PURCHASE_LOCKED",
          message: authorization.message ?? "Another run owns the purchase lock"
        },
        run: authorization.run
      });
      return;
    }
    json(response, 200, authorization);
    return;
  }

  const confirmSuccessRunId = runRouteId(url.pathname, "/confirm-success");
  if (method === "POST" && confirmSuccessRunId !== undefined) {
    const body = objectBody(await readJson(request, options.maxBodyBytes));
    json(response, 200, {
      run: options.store.confirmSuccess(confirmSuccessRunId, body as unknown as SuccessConfirmationInput)
    });
    return;
  }

  const runAuditId = runRouteId(url.pathname, "/audit");
  if (method === "GET" && runAuditId !== undefined) {
    json(response, 200, { audit: options.store.getRunAudit(runAuditId) });
    return;
  }

  const reconcileRunId = runRouteId(url.pathname, "/reconcile-no-order");
  if (method === "POST" && reconcileRunId !== undefined) {
    const body = objectBody(await readJson(request, options.maxBodyBytes));
    options.store.reconcileNoOrder(reconcileRunId, body as unknown as NoOrderReconciliationInput);
    noContent(response);
    return;
  }

  json(response, 404, { error: { code: "NOT_FOUND", message: "Route not found" } });
}

export function createControllerHttpServer(options: ControllerHttpOptions): Server {
  if (Buffer.byteLength(options.token, "utf8") < 32) {
    throw new Error("Controller Bearer token must contain at least 32 bytes");
  }
  const resolved: Required<ControllerHttpOptions> = {
    store: options.store,
    token: options.token,
    submitCapabilityService: options.submitCapabilityService,
    maxBodyBytes: options.maxBodyBytes ?? 256 * 1024
  };
  return createServer((request, response) => {
    void handle(resolved, request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      if (isControllerError(error)) {
        json(response, error.httpStatus, {
          error: {
            code: error.code,
            message: error.message,
            ...(error.details === undefined ? {} : { details: error.details })
          }
        });
        return;
      }
      json(response, 500, { error: { code: "INTERNAL_ERROR", message: "Internal controller error" } });
    });
  });
}

export async function listenController(
  server: Server,
  options: ListenControllerOptions = {}
): Promise<{ host: string; port: number }> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  if (!LOOPBACK_HOSTS.has(host)) throw new Error(`Refusing non-loopback controller host: ${host}`);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error(`Invalid controller port: ${port}`);

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Controller did not bind a TCP loopback address");
  if (isIP(address.address) === 0 && address.address !== "localhost") throw new Error("Controller resolved an invalid address");
  return { host: address.address, port: address.port };
}

export async function closeController(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
