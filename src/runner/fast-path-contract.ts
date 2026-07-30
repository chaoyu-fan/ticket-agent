import { createHash } from "node:crypto";

import { canonicalOfficialOrigin } from "../security/submit-capability.js";
import {
  validateBrowserSelectionContract,
  validateFastPathSubmitReadiness,
  type BrowserSelectionContract,
  type FastPathSubmitReadinessContract,
  type SelectionBlockingPredicate,
  type SelectionChoiceContract
} from "./browser-selection-state-machine.js";

export const FAST_PATH_CONTRACT_VERSION = 1 as const;
export const FAST_PATH_TRUSTED_CLICK_POLICY = "element-handle-actionability-v1" as const;
export const FAST_PATH_CLICK_GUARD_POLICY = "capture-reverify-once-v1" as const;

const REQUIRED_POST_SUBMIT_KEYS = ["order-reference-visible", "payment-visible"] as const;

export interface FastPathPostSubmitPredicate {
  /** Fixed, non-sensitive evidence key. */
  readonly key: (typeof REQUIRED_POST_SUBMIT_KEYS)[number] | string;
  readonly selector: string;
}

/**
 * Versioned selector/evidence contract. A capability binds its digest, never
 * the selectors themselves. No contract is production-ready until it has been
 * calibrated against the current official page on the user's Mac.
 */
export interface FastPathContract {
  readonly version: typeof FAST_PATH_CONTRACT_VERSION;
  readonly platform: "damai" | "maoyan";
  readonly finalOfficialOrigin: string;
  readonly selection: BrowserSelectionContract;
  readonly submitReadiness: FastPathSubmitReadinessContract;
  readonly postSubmitPredicates: readonly FastPathPostSubmitPredicate[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function selector(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 2_000 ||
    value.trim() !== value ||
    value.includes("\u0000")
  ) {
    throw new Error("FAST_PATH_CONTRACT_SELECTOR_INVALID");
  }
  return value;
}

function normalizePostSubmitPredicates(value: unknown): readonly FastPathPostSubmitPredicate[] {
  if (!Array.isArray(value) || value.length < REQUIRED_POST_SUBMIT_KEYS.length || value.length > 16) {
    throw new Error("FAST_PATH_POST_SUBMIT_PREDICATES_INVALID");
  }
  const keys = new Set<string>();
  const normalized = value.map((entry) => {
    if (!isRecord(entry) || !exactKeys(entry, ["key", "selector"])) {
      throw new Error("FAST_PATH_POST_SUBMIT_PREDICATES_INVALID");
    }
    if (
      typeof entry.key !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,99}$/u.test(entry.key) ||
      keys.has(entry.key)
    ) {
      throw new Error("FAST_PATH_POST_SUBMIT_PREDICATES_INVALID");
    }
    keys.add(entry.key);
    return Object.freeze({ key: entry.key, selector: selector(entry.selector) });
  });
  for (const required of REQUIRED_POST_SUBMIT_KEYS) {
    if (!keys.has(required)) throw new Error(`FAST_PATH_POST_SUBMIT_PREDICATE_REQUIRED:${required}`);
  }
  return Object.freeze(normalized);
}

export function validateFastPathContract(value: unknown): FastPathContract {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "finalOfficialOrigin",
      "platform",
      "postSubmitPredicates",
      "selection",
      "submitReadiness",
      "version"
    ]) ||
    value.version !== FAST_PATH_CONTRACT_VERSION ||
    (value.platform !== "damai" && value.platform !== "maoyan")
  ) {
    throw new Error("FAST_PATH_CONTRACT_INVALID");
  }
  const selection = validateBrowserSelectionContract(value.selection as BrowserSelectionContract);
  if (selection.platform !== value.platform) throw new Error("FAST_PATH_CONTRACT_PLATFORM_MISMATCH");
  const finalOfficialOrigin = canonicalOfficialOrigin(value.platform, value.finalOfficialOrigin as string);
  if (!selection.allowedOrigins.includes(finalOfficialOrigin)) {
    throw new Error("FAST_PATH_FINAL_ORIGIN_NOT_ALLOWED");
  }
  const submitReadiness = validateFastPathSubmitReadiness(
    value.submitReadiness as FastPathSubmitReadinessContract,
    selection.forbiddenActionSelectors
  );
  if (submitReadiness === undefined) throw new Error("FAST_PATH_SUBMIT_READINESS_REQUIRED");
  const postSubmitPredicates = normalizePostSubmitPredicates(value.postSubmitPredicates);
  return Object.freeze({
    version: FAST_PATH_CONTRACT_VERSION,
    platform: value.platform,
    finalOfficialOrigin,
    selection,
    submitReadiness,
    postSubmitPredicates
  });
}

function canonicalChoice(choice: SelectionChoiceContract): Record<string, unknown> {
  return {
    optionSelector: choice.optionSelector,
    ...(choice.labelSelector === undefined ? {} : { labelSelector: choice.labelSelector }),
    selectedSelector: choice.selectedSelector,
    ...(choice.clickSelector === undefined ? {} : { clickSelector: choice.clickSelector }),
    ...(choice.labelAttribute === undefined ? {} : { labelAttribute: choice.labelAttribute }),
    ...(choice.priceTextSelector === undefined ? {} : { priceTextSelector: choice.priceTextSelector }),
    ...(choice.priceFenAttribute === undefined ? {} : { priceFenAttribute: choice.priceFenAttribute })
  };
}

function canonicalPredicates(
  values: readonly (SelectionBlockingPredicate | FastPathPostSubmitPredicate)[]
): readonly Record<string, string>[] {
  return [...values]
    .map(({ key, selector: predicateSelector }) => ({ key, selector: predicateSelector }))
    .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}

function canonicalContractJson(contract: FastPathContract): string {
  const selection = contract.selection;
  return JSON.stringify({
    version: contract.version,
    platform: contract.platform,
    finalOfficialOrigin: contract.finalOfficialOrigin,
    selection: {
      platform: selection.platform,
      allowedOrigins: [...selection.allowedOrigins].sort(),
      blockingPredicates: canonicalPredicates(selection.blockingPredicates),
      eventTitleSelector: selection.eventTitleSelector,
      eventIdSelector: selection.eventIdSelector,
      eventIdAttribute: selection.eventIdAttribute,
      session: canonicalChoice(selection.session),
      sessionSummarySelector: selection.sessionSummarySelector,
      tier: canonicalChoice(selection.tier),
      tierSummarySelector: selection.tierSummarySelector,
      quantity: {
        summarySelector: selection.quantity.summarySelector,
        ...(selection.quantity.option === undefined
          ? { select: { controlSelector: selection.quantity.select!.controlSelector } }
          : { option: canonicalChoice(selection.quantity.option) })
      },
      attendee: canonicalChoice(selection.attendee),
      ...(selection.adjacencySelector === undefined
        ? {}
        : { adjacencySelector: selection.adjacencySelector }),
      totalSelector: selection.totalSelector,
      totalFenAttribute: selection.totalFenAttribute,
      forbiddenActionSelectors: [...selection.forbiddenActionSelectors].sort()
    },
    submitReadiness: {
      selector: contract.submitReadiness.selector,
      ...(contract.submitReadiness.labelSelector === undefined
        ? {}
        : { labelSelector: contract.submitReadiness.labelSelector }),
      ...(contract.submitReadiness.labelAttribute === undefined
        ? {}
        : { labelAttribute: contract.submitReadiness.labelAttribute }),
      allowedLabels: [...contract.submitReadiness.allowedLabels].sort()
    },
    postSubmitPredicates: canonicalPredicates(contract.postSubmitPredicates),
    trustedClickPolicy: FAST_PATH_TRUSTED_CLICK_POLICY,
    clickGuardPolicy: FAST_PATH_CLICK_GUARD_POLICY
  });
}

/** Compute only during PREWARM; this hash must never enter the T0 hot path. */
export function digestFastPathContract(value: unknown): `sha256:${string}` {
  const contract = validateFastPathContract(value);
  return `sha256:${createHash("sha256")
    .update("ticket-agent/fast-path-contract/v1\u0000", "utf8")
    .update(canonicalContractJson(contract), "utf8")
    .digest("hex")}`;
}
