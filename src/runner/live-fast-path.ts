import type { Page } from "playwright-core";

import type {
  ClaimSubmitCapabilityInput,
  ClaimSubmitCapabilityResult
} from "../controller/submit-capability-service.js";
import type { SubmitAttemptOutcome, SubmitCapabilityGrant } from "../controller/store.js";
import type { WatchPlan } from "../core/types.js";
import { validatePlan } from "../core/policy.js";
import {
  InProcessSubmitCapabilityConsumer,
  createRunnerSessionSecret,
  digestRunnerSessionSecret,
  type RunnerSessionSecret
} from "../security/submit-capability.js";
import {
  MAX_SELECTION_RESIDENCY_MS,
  startBrowserSelectionStateMachine,
  validateBrowserSelectionPlan,
  type BrowserSelectionResidentTask,
  type RunBrowserSelectionOptions
} from "./browser-selection-state-machine.js";
import {
  ArmedFastPath,
  buildRuntimeAttendeeSelectionFingerprint,
  type ArmedFastPathOptions,
  type ArmedFastPathResult
} from "./armed-fast-path.js";
import {
  digestFastPathContract,
  validateFastPathContract,
  type FastPathContract
} from "./fast-path-contract.js";
import {
  PAGE_TOPOLOGY_INVALID,
  type ExactPageTopologyGuard
} from "./page-topology-guard.js";

export interface LiveFastPathController {
  claimSubmitCapability(
    runId: string,
    input: ClaimSubmitCapabilityInput
  ): Promise<ClaimSubmitCapabilityResult>;
  ackCapabilityPrepared(runId: string, deliveryId: string): Promise<SubmitCapabilityGrant>;
  reportSubmitAttempt(
    runId: string,
    deliveryId: string,
    outcome: SubmitAttemptOutcome
  ): Promise<SubmitCapabilityGrant>;
}

export interface LiveFastPathLifecycleOptions {
  readonly page: Page;
  /**
   * Guard installed before the official navigation; this exact instance is
   * reused for the whole lifecycle. The lifecycle owns listener cleanup and
   * disposes it idempotently when the lifecycle ends.
   */
  readonly topologyGuard: ExactPageTopologyGuard;
  readonly controller: LiveFastPathController;
  readonly runId: string;
  readonly plan: WatchPlan;
  readonly contract: unknown;
  readonly attendeeLabels: readonly string[];
  /** Ownership transfers to this call; the buffer is wiped after local prepare. */
  readonly capabilityKey: Uint8Array;
  readonly signal?: AbortSignal;
}

export type LiveFastPathLifecycleResult =
  | {
      readonly fastPath: ArmedFastPathResult;
      readonly reportStatus: "RECORDED";
      readonly grant: SubmitCapabilityGrant;
    }
  | {
      readonly fastPath: ArmedFastPathResult;
      readonly reportStatus: "UNKNOWN";
    };

interface LiveFastPathDependencies {
  readonly createSessionSecret?: () => RunnerSessionSecret;
  readonly createConsumer?: () => InProcessSubmitCapabilityConsumer;
  readonly startResidentSelection?: (
    page: Pick<Page, "evaluate">,
    options: RunBrowserSelectionOptions
  ) => BrowserSelectionResidentTask;
  readonly createArmedFastPath?: (options: ArmedFastPathOptions) => Pick<ArmedFastPath, "run">;
}


function requiredPlan(plan: WatchPlan): asserts plan is WatchPlan & {
  officialUrl: string;
  eventId: string;
  eventTitle: string;
  canonicalEventKey: string;
  saleAt: string;
  maxTotalFen: number;
  attendeeRefs: NonNullable<WatchPlan["attendeeRefs"]>;
} {
  const validation = validatePlan(plan);
  if (
    !validation.ok ||
    plan.status !== "ARMED" ||
    plan.autoSubmitOrder !== true ||
    plan.priceStrategy !== "PREFERRED_ORDER" ||
    plan.officialUrl === undefined ||
    plan.eventId === undefined ||
    plan.eventTitle === undefined ||
    plan.canonicalEventKey === undefined ||
    plan.saleAt === undefined ||
    plan.maxTotalFen === undefined ||
    plan.attendeeRefs === undefined ||
    plan.attendeeRefs.length !== plan.quantity ||
    plan.sessions.length < 1 ||
    plan.tiers.length < 1
  ) {
    throw new Error("LIVE_FAST_PATH_PLAN_NOT_ARMED");
  }
}

function selectionPlan(plan: WatchPlan, attendeeLabels: readonly string[]) {
  return validateBrowserSelectionPlan({
    eventId: plan.eventId!,
    eventTitle: plan.eventTitle!,
    sessionLabels: [...plan.sessions]
      .sort((left, right) => left.priority - right.priority)
      .map((preference) => preference.label),
    tierPreferences: [...plan.tiers]
      .sort((left, right) => left.priority - right.priority)
      .map((preference) => ({
        label: preference.label,
        ...(preference.maxUnitPriceFen === undefined
          ? {}
          : { maxUnitPriceFen: preference.maxUnitPriceFen })
      })),
    quantity: plan.quantity,
    attendeeLabels,
    maxTotalFen: plan.maxTotalFen!,
    requireAdjacent: plan.requireAdjacent
  });
}

function combinedSignal(external: AbortSignal | undefined, internal: AbortSignal): AbortSignal {
  return external === undefined ? internal : AbortSignal.any([external, internal]);
}

/**
 * Cold path plus the single resident T0 transition. Delivery is attempted at
 * most once, prepared ACK must succeed before `run`, and reporting happens
 * exactly once after the local click outcome is known.
 */
export async function runLiveFastPathLifecycle(
  options: LiveFastPathLifecycleOptions,
  dependencies: LiveFastPathDependencies = {}
): Promise<LiveFastPathLifecycleResult> {
  const capabilityKey = options.capabilityKey;
  const runtimeLabels = [...options.attendeeLabels];
  const stopResident = new AbortController();
  let runnerSessionSecret: RunnerSessionSecret | undefined;
  let resident: BrowserSelectionResidentTask | undefined;
  let topology: ExactPageTopologyGuard | undefined;
  try {
    const suppliedTopologyGuard = options.topologyGuard as ExactPageTopologyGuard | undefined;
    if (
      suppliedTopologyGuard === undefined ||
      typeof suppliedTopologyGuard.recheck !== "function" ||
      typeof suppliedTopologyGuard.dispose !== "function"
    ) {
      throw new Error("LIVE_FAST_PATH_PAGE_TOPOLOGY_GUARD_REQUIRED");
    }
    if (suppliedTopologyGuard.page !== options.page) {
      throw new Error("LIVE_FAST_PATH_PAGE_TOPOLOGY_GUARD_MISMATCH");
    }
    topology = suppliedTopologyGuard;
    if (!topology.recheck()) throw new Error(`LIVE_FAST_PATH_${PAGE_TOPOLOGY_INVALID}`);
    if (!(capabilityKey instanceof Uint8Array) || capabilityKey.byteLength < 32) {
      throw new Error("LIVE_FAST_PATH_CAPABILITY_KEY_INVALID");
    }
    if (typeof options.runId !== "string" || options.runId.length < 1 || options.runId.length > 200) {
      throw new Error("LIVE_FAST_PATH_RUN_ID_INVALID");
    }
    requiredPlan(options.plan);
    const contract: FastPathContract = validateFastPathContract(options.contract);
    if (contract.platform !== options.plan.platform) throw new Error("LIVE_FAST_PATH_CONTRACT_MISMATCH");
    const contractDigest = digestFastPathContract(contract);
    const browserPlan = selectionPlan(options.plan, runtimeLabels);
    if (options.signal?.aborted) throw new Error("LIVE_FAST_PATH_ABORTED");
    const lifecycleSignal = combinedSignal(
      combinedSignal(options.signal, topology.signal),
      stopResident.signal
    );
    runnerSessionSecret = (dependencies.createSessionSecret ?? createRunnerSessionSecret)();
    const runnerSessionDigest = digestRunnerSessionSecret(runnerSessionSecret);
    const attendeeSelectionFingerprint = buildRuntimeAttendeeSelectionFingerprint(
      runnerSessionSecret,
      options.plan.attendeeRefs,
      runtimeLabels
    );

    const startResident = dependencies.startResidentSelection ?? startBrowserSelectionStateMachine;
    resident = startResident(options.page, {
      contract: contract.selection,
      plan: browserPlan,
      timeoutMs: MAX_SELECTION_RESIDENCY_MS,
      waitInOfficialQueue: true,
      submitReadiness: contract.submitReadiness,
      signal: lifecycleSignal
    });
    const exactResident: BrowserSelectionResidentTask = Object.freeze({
      armed: resident.armed,
      result: resident.result.then((selection) => {
        // This synchronous identity snapshot runs immediately before Armed's
        // hot-path signal gates and final trusted click.
        topology!.recheck();
        return selection;
      })
    });
    void exactResident.result.catch(() => undefined);
    await exactResident.armed;
    if (!topology.recheck()) throw new Error(`LIVE_FAST_PATH_${PAGE_TOPOLOGY_INVALID}`);
    if (lifecycleSignal.aborted) throw new Error("LIVE_FAST_PATH_ABORTED");

    let claimed: ClaimSubmitCapabilityResult;
    try {
      // At-most-once by construction: there is no retry or recovery claim in this function.
      claimed = await options.controller.claimSubmitCapability(options.runId, {
        runnerSessionDigest,
        attendeeSelectionFingerprint,
        fastPathContractDigest: contractDigest,
        finalOfficialOrigin: contract.finalOfficialOrigin
      });
    } catch {
      throw new Error("LIVE_FAST_PATH_CAPABILITY_DELIVERY_FAILED");
    }
    // A violation while delivery was in flight cannot undo the claim. Continue
    // only far enough to prepare truthfully, ACK truthfully, burn locally, and
    // persist an explicit zero-click attempt below.
    topology.recheck();

    const consumer = (dependencies.createConsumer ?? (() => new InProcessSubmitCapabilityConsumer()))();
    let prepared;
    try {
      prepared = consumer.prepare(claimed.delivery, capabilityKey, runnerSessionSecret);
    } catch {
      throw new Error("LIVE_FAST_PATH_CAPABILITY_PREPARE_FAILED");
    } finally {
      capabilityKey.fill(0);
    }
    try {
      await options.controller.ackCapabilityPrepared(options.runId, claimed.grant.deliveryId);
    } catch {
      throw new Error("LIVE_FAST_PATH_PREPARED_ACK_FAILED");
    }
    topology.recheck();

    const createArmed = dependencies.createArmedFastPath ?? ((armedOptions) => new ArmedFastPath(armedOptions));
    const armed = createArmed({
      page: options.page,
      consumer,
      preparedCapability: prepared,
      contract,
      attendeeRefs: options.plan.attendeeRefs,
      attendeeLabels: runtimeLabels,
      runnerSessionSecret,
      residentSelection: exactResident,
      signal: lifecycleSignal
    });
    // Fresh exact-page identity check immediately before Armed takes over. Its
    // own signal gates repeat this before consume and before the trusted click.
    topology.recheck();
    const fastPath = await armed.run();
    try {
      const grant = await options.controller.reportSubmitAttempt(
        options.runId,
        claimed.grant.deliveryId,
        fastPath.outcome
      );
      return Object.freeze({ fastPath, reportStatus: "RECORDED", grant });
    } catch {
      // A report failure can never authorize a retry; the visible page needs reconciliation.
      return Object.freeze({ fastPath, reportStatus: "UNKNOWN" });
    }
  } finally {
    stopResident.abort();
    // Keep the exported lifecycle leak-free for direct callers as well as the
    // CLI. The CLI may also dispose the same guard; disposal is idempotent.
    options.topologyGuard?.dispose();
    capabilityKey.fill(0);
    runnerSessionSecret?.fill(0);
    runtimeLabels.fill("");
  }
}
