import { performance } from "node:perf_hooks";

import type { ElementHandle, JSHandle, Page } from "playwright-core";

import type { SubmitAttemptOutcome } from "../controller/store.js";
import { buildAttendeeRefAudit, parseAttendeeRefs } from "../identity/attendee-ref.js";
import {
  InProcessSubmitCapabilityConsumer,
  buildAttendeeSelectionFingerprint,
  digestRunnerSessionSecret,
  type PreparedSubmitCapability,
  type RunnerSessionSecret,
  type SubmitCapabilityAttempt
} from "../security/submit-capability.js";
import {
  MAX_SELECTION_RESIDENCY_MS,
  runBrowserSelectionStateMachine,
  type BrowserSelectionResidentTask,
  type BrowserSelectionPlan,
  type BrowserSelectionResult,
  type SelectionChoiceContract
} from "./browser-selection-state-machine.js";
import {
  digestFastPathContract,
  validateFastPathContract,
  type FastPathContract
} from "./fast-path-contract.js";

export const FAST_PATH_TRUSTED_CLICK_TIMEOUT_MS = 1_000;

export type ArmedFastPathReason =
  | "SELECTION_NOT_READY"
  | "RUN_ABORTED"
  | "CAPABILITY_CONSUME_REJECTED"
  | "FINAL_EVIDENCE_REJECTED"
  | "FINAL_GUARD_REJECTED"
  | "TRUSTED_CLICK_DISPATCHED"
  | "TRUSTED_CLICK_OUTCOME_UNKNOWN";

export interface ArmedFastPathResult {
  readonly outcome: SubmitAttemptOutcome;
  readonly reason: ArmedFastPathReason;
  readonly browserSelectionLatencyMs: number;
  /** Starts only after the resident browser task returns fixed evidence. */
  readonly hotPathLatencyMs: number;
  readonly consumeLatencyMs: number;
  readonly finalEvidenceLatencyMs: number;
  readonly trustedClickLatencyMs: number;
}

export interface ArmedFastPathOptions {
  readonly page: Page;
  readonly consumer: InProcessSubmitCapabilityConsumer;
  readonly preparedCapability: PreparedSubmitCapability;
  readonly contract: unknown;
  readonly attendeeRefs: unknown;
  readonly attendeeLabels: readonly string[];
  /** Ownership transfers to this constructor and the buffer is always wiped. */
  readonly runnerSessionSecret: RunnerSessionSecret;
  /** Optional task installed and acknowledged before capability delivery. */
  readonly residentSelection?: BrowserSelectionResidentTask;
  readonly signal?: AbortSignal;
}

interface FinalSubmitExpected {
  readonly finalOfficialOrigin: string;
  readonly eventId: string;
  readonly eventTitle: string;
  readonly selectedSession: string;
  readonly selectedTier: string;
  readonly selectedTierUnitPriceFen: number;
  readonly quantity: number;
  readonly attendeeLabels: readonly string[];
  readonly requireAdjacent: boolean;
  readonly adjacentVerified: boolean;
  readonly observedTotalFen: number;
  readonly maxTotalFen: number;
}

interface FinalSubmitHandleInput {
  readonly contract: FastPathContract;
  readonly expected: FinalSubmitExpected;
}

function fixedRuntimeLabel(value: unknown): value is string {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 200 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function normalizedLabel(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "").trim();
}

/**
 * Cold-path ref -> Keychain label binding. Pair strings are wiped from the
 * temporary array immediately after the session-keyed HMAC is computed.
 */
export function buildRuntimeAttendeeSelectionFingerprint(
  runnerSessionSecret: RunnerSessionSecret,
  attendeeRefs: unknown,
  attendeeLabels: readonly string[]
): `hmac-sha256:${string}` {
  const refs = parseAttendeeRefs(attendeeRefs);
  if (
    !Array.isArray(attendeeLabels) ||
    attendeeLabels.length !== refs.length ||
    attendeeLabels.some((label) => !fixedRuntimeLabel(label)) ||
    new Set(attendeeLabels.map((label) => normalizedLabel(label))).size !== attendeeLabels.length
  ) {
    throw new Error("FAST_PATH_ATTENDEE_BINDING_INVALID");
  }
  const pairs = refs.map((ref, index) => JSON.stringify([ref, attendeeLabels[index]!]));
  try {
    return buildAttendeeSelectionFingerprint(runnerSessionSecret, pairs);
  } finally {
    pairs.fill("");
  }
}

/**
 * Serialized final verifier. It performs no click. Instead it returns the
 * exact reviewed submit node and installs a one-shot capture guard that
 * rechecks the same evidence when the later trusted click event arrives.
 */
export function finalSubmitHandleTask(input: FinalSubmitHandleInput): HTMLElement | null {
  const contract = input.contract;
  const expected = input.expected;
  const selection = contract.selection;
  const readiness = contract.submitReadiness;

  try {
    if (location.origin !== expected.finalOfficialOrigin || location.origin !== contract.finalOfficialOrigin) {
      return null;
    }
    const visible = (element: Element | null): element is Element => {
      if (element === null || !element.isConnected) return false;
      const html = element as HTMLElement;
      if (html.hidden || element.getAttribute("aria-hidden") === "true") return false;
      const view = element.ownerDocument.defaultView;
      if (view === null) return false;
      const style = view.getComputedStyle(element);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        Number(style.opacity) === 0
      ) return false;
      return html.getClientRects().length > 0;
    };
    const enabled = (element: Element): boolean => {
      const control = element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement;
      return !element.hasAttribute("disabled") &&
        element.getAttribute("aria-disabled") !== "true" &&
        control.disabled !== true;
    };
    const textOf = (element: Element): string => {
      if (element === document.body || element === document.documentElement) {
        throw new Error("WHOLE_PAGE_TEXT_READ_BLOCKED");
      }
      return (element as HTMLElement).innerText;
    };
    const normalized = (value: string): string => value.normalize("NFKC").replace(/\s+/gu, "").trim();
    const identity = (value: string): string => value
      .normalize("NFKC")
      .toLocaleLowerCase("zh-CN")
      .replace(/[\p{P}\p{S}\p{Z}]+/gu, "")
      .trim();
    const canonicalId = (value: string): string => value.normalize("NFKC").trim();
    const all = (selector: string): Element[] => Array.from(document.querySelectorAll(selector));
    const visibleAll = (selector: string): Element[] => all(selector).filter(visible);
    const uniqueVisible = (selector: string): Element | undefined => {
      const values = visibleAll(selector);
      return values.length === 1 ? values[0] : undefined;
    };
    const scopedUnique = (root: Element, selector: string | undefined): Element | undefined => {
      if (selector === undefined) return root;
      const values = Array.from(root.querySelectorAll(selector)).filter(visible);
      return values.length === 1 ? values[0] : undefined;
    };
    const selected = (element: Element, choice: SelectionChoiceContract): boolean => {
      try {
        return element.matches(choice.selectedSelector);
      } catch {
        return false;
      }
    };
    const labelOf = (element: Element, choice: SelectionChoiceContract): string | undefined => {
      const label = scopedUnique(element, choice.labelSelector);
      if (label === undefined) return undefined;
      const visibleLabel = textOf(label).trim();
      if (visibleLabel === "") return undefined;
      if (choice.labelAttribute !== undefined) {
        const attribute = element.getAttribute(choice.labelAttribute)?.trim();
        if (!attribute || normalized(attribute) !== normalized(visibleLabel)) return undefined;
      }
      return visibleLabel;
    };
    const exactSelected = (
      choice: SelectionChoiceContract,
      expectedLabel: string
    ): { allValues: Element[]; selectedValue: Element } | undefined => {
      const values = visibleAll(choice.optionSelector);
      const selectedValues = values.filter((value) => selected(value, choice));
      const matches = selectedValues.filter((value) => {
        const label = labelOf(value, choice);
        return label !== undefined && normalized(label) === normalized(expectedLabel);
      });
      return selectedValues.length === 1 && matches.length === 1
        ? { allValues: values, selectedValue: matches[0]! }
        : undefined;
    };
    const parseFen = (text: string): number[] => {
      const values: number[] = [];
      const currency = /(?:[￥¥]\s*([0-9]{1,7}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)(?![0-9.,])|(?<![0-9.,])([0-9]{1,7}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)(?![0-9.,])\s*元)/gu;
      for (const match of text.matchAll(currency)) {
        const raw = (match[1] ?? match[2])?.replaceAll(",", "");
        const parts = raw === undefined ? undefined : /^([0-9]+)(?:\.([0-9]{1,2}))?$/u.exec(raw);
        if (parts?.[1] === undefined) continue;
        const fen = Number(parts[1]) * 100 + Number((parts[2] ?? "").padEnd(2, "0"));
        if (Number.isSafeInteger(fen) && fen >= 0) values.push(fen);
      }
      return values;
    };
    const readinessLabel = (submit: Element): string | undefined => {
      const label = scopedUnique(submit, readiness.labelSelector);
      if (label === undefined) return undefined;
      const visibleLabel = normalized(textOf(label));
      const attributeLabel = readiness.labelAttribute === undefined
        ? ""
        : normalized(label.getAttribute(readiness.labelAttribute) ?? "");
      if (
        (readiness.labelAttribute === undefined && visibleLabel === "") ||
        (readiness.labelAttribute !== undefined && attributeLabel === "") ||
        (visibleLabel !== "" && attributeLabel !== "" && visibleLabel !== attributeLabel)
      ) return undefined;
      return readiness.labelAttribute === undefined ? visibleLabel : attributeLabel;
    };

    const verify = (): HTMLElement | undefined => {
      if (location.origin !== expected.finalOfficialOrigin || location.origin !== contract.finalOfficialOrigin) {
        return undefined;
      }
      for (const predicate of selection.blockingPredicates) {
        if (visibleAll(predicate.selector).length > 0) return undefined;
      }
      for (const predicate of contract.postSubmitPredicates) {
        if (visibleAll(predicate.selector).length > 0) return undefined;
      }

      const title = uniqueVisible(selection.eventTitleSelector);
      const eventId = uniqueVisible(selection.eventIdSelector);
      if (
        title === undefined ||
        identity(textOf(title)) !== identity(expected.eventTitle) ||
        eventId === undefined ||
        canonicalId(eventId.getAttribute(selection.eventIdAttribute) ?? "") !== canonicalId(expected.eventId)
      ) return undefined;

      const session = exactSelected(selection.session, expected.selectedSession);
      const sessionSummary = uniqueVisible(selection.sessionSummarySelector);
      if (
        session === undefined ||
        sessionSummary === undefined ||
        normalized(textOf(sessionSummary)) !== normalized(expected.selectedSession)
      ) return undefined;

      const tier = exactSelected(selection.tier, expected.selectedTier);
      const tierSummary = uniqueVisible(selection.tierSummarySelector);
      if (
        tier === undefined ||
        tierSummary === undefined ||
        normalized(textOf(tierSummary)) !== normalized(expected.selectedTier)
      ) return undefined;
      const tierPriceElement = scopedUnique(tier.selectedValue, selection.tier.priceTextSelector);
      const tierPriceAttribute = selection.tier.priceFenAttribute === undefined
        ? null
        : tier.selectedValue.getAttribute(selection.tier.priceFenAttribute);
      const visibleTierPrices = tierPriceElement === undefined ? [] : parseFen(textOf(tierPriceElement));
      if (
        tierPriceElement === undefined ||
        tierPriceAttribute === null ||
        !/^(?:0|[1-9][0-9]*)$/u.test(tierPriceAttribute) ||
        Number(tierPriceAttribute) !== expected.selectedTierUnitPriceFen ||
        visibleTierPrices.length !== 1 ||
        visibleTierPrices[0] !== expected.selectedTierUnitPriceFen
      ) return undefined;

      const quantitySummary = uniqueVisible(selection.quantity.summarySelector);
      const quantityText = quantitySummary === undefined ? "" : normalized(textOf(quantitySummary));
      if (quantityText !== String(expected.quantity) && quantityText !== `${expected.quantity}张`) return undefined;
      if (selection.quantity.select !== undefined) {
        const controls = visibleAll(selection.quantity.select.controlSelector);
        const control = controls[0] as HTMLSelectElement | undefined;
        if (
          controls.length !== 1 ||
          control === undefined ||
          control.tagName.toLowerCase() !== "select" ||
          !enabled(control) ||
          control.value !== String(expected.quantity)
        ) return undefined;
      } else if (selection.quantity.option !== undefined) {
        if (exactSelected(selection.quantity.option, String(expected.quantity)) === undefined) return undefined;
      }

      const attendeeValues = visibleAll(selection.attendee.optionSelector);
      const selectedAttendees = attendeeValues.filter((value) => selected(value, selection.attendee));
      if (selectedAttendees.length !== expected.quantity) return undefined;
      for (const attendeeLabel of expected.attendeeLabels) {
        const matches = selectedAttendees.filter((value) => {
          const observed = labelOf(value, selection.attendee);
          return observed !== undefined && normalized(observed) === normalized(attendeeLabel);
        });
        if (matches.length !== 1) return undefined;
      }

      if (expected.requireAdjacent && expected.quantity > 1) {
        if (
          expected.adjacentVerified !== true ||
          selection.adjacencySelector === undefined ||
          visibleAll(selection.adjacencySelector).length !== 1
        ) return undefined;
      }

      const total = uniqueVisible(selection.totalSelector);
      const totalAttribute = total?.getAttribute(selection.totalFenAttribute);
      if (
        total === undefined ||
        totalAttribute === null ||
        totalAttribute === undefined ||
        !/^(?:0|[1-9][0-9]*)$/u.test(totalAttribute) ||
        Number(totalAttribute) !== expected.observedTotalFen
      ) return undefined;
      const visibleTotals = parseFen(textOf(total));
      if (
        visibleTotals.length !== 1 ||
        visibleTotals[0] !== expected.observedTotalFen ||
        expected.observedTotalFen > expected.maxTotalFen ||
        expected.selectedTierUnitPriceFen * expected.quantity > expected.observedTotalFen
      ) return undefined;

      const submitValues = visibleAll(readiness.selector);
      const submit = submitValues[0];
      const submitLabel = submit === undefined ? undefined : readinessLabel(submit);
      if (
        submitValues.length !== 1 ||
        submit === undefined ||
        !enabled(submit) ||
        typeof (submit as HTMLElement).click !== "function" ||
        submitLabel === undefined ||
        !readiness.allowedLabels.some((label) => normalized(label) === submitLabel)
      ) return undefined;
      return submit as HTMLElement;
    };

    const submit = verify();
    if (submit === undefined) return null;
    const guardScope = globalThis as typeof globalThis & {
      __ticketAgentFastPathGuards_v1?: WeakMap<HTMLElement, () => boolean>;
    };
    const guardRegistry = guardScope.__ticketAgentFastPathGuards_v1 ??= new WeakMap<HTMLElement, () => boolean>();
    guardRegistry.get(submit)?.();
    let acceptedTrustedClick = false;
    const guardedEvents = new WeakSet<Event>();
    const view = submit.ownerDocument.defaultView;
    const captureGuard = (event: Event): void => {
      if (guardedEvents.has(event)) return;
      const exactTarget = event.target === submit || event.composedPath().includes(submit);
      if (
        event.isTrusted !== true ||
        !exactTarget ||
        acceptedTrustedClick ||
        verify() !== submit
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      acceptedTrustedClick = true;
      guardedEvents.add(event);
      // The DOM proof has already closed over these values; clear the only
      // browser-side copy before ordinary site handlers continue.
      (expected.attendeeLabels as string[]).fill("");
    };
    // Window capture runs before ordinary target/bubble handlers. The exact
    // target guard is a fallback for unusual dispatch paths; WeakSet prevents
    // the same event from being evaluated twice.
    view?.addEventListener("click", captureGuard, { capture: true });
    submit.addEventListener("click", captureGuard, { capture: true });
    guardRegistry.set(submit, () => {
      view?.removeEventListener("click", captureGuard, { capture: true });
      submit.removeEventListener("click", captureGuard, { capture: true });
      (expected.attendeeLabels as string[]).fill("");
      guardRegistry.delete(submit);
      return acceptedTrustedClick;
    });
    return submit;
  } catch {
    return null;
  }
}

export type FinalSubmitGuardResult = "ACCEPTED" | "REJECTED" | "MISSING";

/** Return whether the one-shot guard accepted the exact trusted event, then remove it. */
export function cleanupFinalSubmitGuardTask(submit: HTMLElement): FinalSubmitGuardResult {
  const guardScope = globalThis as typeof globalThis & {
    __ticketAgentFastPathGuards_v1?: WeakMap<HTMLElement, () => boolean>;
  };
  const cleanup = guardScope.__ticketAgentFastPathGuards_v1?.get(submit);
  if (cleanup === undefined) return "MISSING";
  return cleanup() ? "ACCEPTED" : "REJECTED";
}

function zeroMetrics(
  outcome: SubmitAttemptOutcome,
  reason: ArmedFastPathReason,
  selectionLatencyMs: number,
  hotStartedAt?: number,
  consumeLatencyMs = 0,
  finalEvidenceLatencyMs = 0,
  trustedClickLatencyMs = 0
): ArmedFastPathResult {
  return Object.freeze({
    outcome,
    reason,
    browserSelectionLatencyMs: selectionLatencyMs,
    hotPathLatencyMs: hotStartedAt === undefined ? 0 : Math.max(0, performance.now() - hotStartedAt),
    consumeLatencyMs,
    finalEvidenceLatencyMs,
    trustedClickLatencyMs
  });
}

export class ArmedFastPath {
  readonly #page: Page;
  readonly #consumer: InProcessSubmitCapabilityConsumer;
  readonly #prepared: PreparedSubmitCapability;
  readonly #contract: FastPathContract;
  readonly #selectionPlan: BrowserSelectionPlan;
  readonly #attendeeRefCount: number;
  readonly #attendeeRefFingerprint: `sha256:${string}`;
  readonly #attendeeLabels: string[];
  readonly #attendeeSelectionFingerprint: `hmac-sha256:${string}`;
  readonly #residentSelection: BrowserSelectionResidentTask | undefined;
  readonly #signal: AbortSignal | undefined;
  #state: "armed" | "running" | "finished" = "armed";

  constructor(options: ArmedFastPathOptions) {
    this.#page = options.page;
    this.#consumer = options.consumer;
    this.#prepared = options.preparedCapability;
    this.#contract = validateFastPathContract(options.contract);
    this.#signal = options.signal;
    this.#residentSelection = options.residentSelection;
    const claims = this.#prepared.claims;
    let attendeeSelectionFingerprint: `hmac-sha256:${string}`;
    try {
      if (digestRunnerSessionSecret(options.runnerSessionSecret) !== claims.runnerSessionDigest) {
        throw new Error("FAST_PATH_RUNNER_SESSION_MISMATCH");
      }
      attendeeSelectionFingerprint = buildRuntimeAttendeeSelectionFingerprint(
        options.runnerSessionSecret,
        options.attendeeRefs,
        options.attendeeLabels
      );
    } finally {
      options.runnerSessionSecret.fill(0);
    }

    const attendeeRefs = Object.freeze(parseAttendeeRefs(options.attendeeRefs));
    const attendeeAudit = buildAttendeeRefAudit(attendeeRefs);
    if (
      claims.platform !== this.#contract.platform ||
      claims.finalOfficialOrigin !== this.#contract.finalOfficialOrigin ||
      !this.#contract.selection.allowedOrigins.includes(claims.officialOrigin) ||
      claims.fastPathContractDigest !== digestFastPathContract(this.#contract) ||
      attendeeAudit.count !== claims.attendeeRefCount ||
      attendeeAudit.fingerprint !== claims.attendeeRefFingerprint ||
      attendeeSelectionFingerprint !== claims.attendeeSelectionFingerprint ||
      options.attendeeLabels.length !== claims.quantity
    ) {
      throw new Error("FAST_PATH_CAPABILITY_BINDING_MISMATCH");
    }
    this.#attendeeRefCount = attendeeAudit.count;
    this.#attendeeRefFingerprint = attendeeAudit.fingerprint;
    this.#attendeeLabels = [...options.attendeeLabels];
    this.#attendeeSelectionFingerprint = attendeeSelectionFingerprint;
    this.#selectionPlan = Object.freeze({
      eventId: claims.eventId,
      eventTitle: claims.eventTitle,
      sessionLabels: Object.freeze(claims.sessionPreferences.map((preference) => preference.label)),
      tierPreferences: Object.freeze(claims.tierPreferences.map((preference) => Object.freeze({
        label: preference.label,
        ...(preference.maxUnitPriceFen === undefined ? {} : { maxUnitPriceFen: preference.maxUnitPriceFen })
      }))),
      quantity: claims.quantity,
      attendeeLabels: this.#attendeeLabels,
      maxTotalFen: claims.maxTotalFen,
      requireAdjacent: claims.requireAdjacent
    });
  }

  #burnPreparedCapability(): void {
    try {
      this.#consumer.consume(this.#prepared, Object.freeze({}));
    } catch {
      // Expected: consuming an invalid attempt still burns the one-shot first.
    }
  }

  /* HOT_PATH_BEGIN: keep controller, storage, Keychain, hashing and logging out. */
  #attemptFromSelection(selection: BrowserSelectionResult): SubmitCapabilityAttempt {
    if (selection.outcome !== "ready") throw new Error("FAST_PATH_SELECTION_NOT_READY");
    const claims = this.#prepared.claims;
    const session = claims.sessionPreferences.filter(
      (preference) => normalizedLabel(preference.label) === normalizedLabel(selection.selectedSession)
    );
    const tier = claims.tierPreferences.filter(
      (preference) => normalizedLabel(preference.label) === normalizedLabel(selection.selectedTier)
    );
    if (session.length !== 1 || tier.length !== 1) throw new Error("FAST_PATH_SELECTION_MISMATCH");
    return Object.freeze({
      runId: claims.runId,
      planId: claims.planId,
      deliveryId: claims.deliveryId,
      platform: claims.platform,
      canonicalEventKey: claims.canonicalEventKey,
      officialOrigin: claims.officialOrigin,
      finalOfficialOrigin: claims.finalOfficialOrigin,
      fastPathContractDigest: claims.fastPathContractDigest,
      eventId: claims.eventId,
      eventTitle: claims.eventTitle,
      quantity: claims.quantity,
      requireAdjacent: claims.requireAdjacent,
      adjacentVerified: selection.adjacentVerified,
      attendeeRefCount: this.#attendeeRefCount,
      attendeeRefFingerprint: this.#attendeeRefFingerprint,
      attendeeSelectionFingerprint: this.#attendeeSelectionFingerprint,
      selectedSession: selection.selectedSession,
      selectedSessionPriority: session[0]!.priority,
      selectedTier: selection.selectedTier,
      selectedTierPriority: tier[0]!.priority,
      selectedTierUnitPriceFen: selection.selectedTierUnitPriceFen,
      observedTotalFen: selection.observedTotalFen
    });
  }

  async run(): Promise<ArmedFastPathResult> {
    if (this.#state !== "armed") throw new Error("FAST_PATH_ALREADY_USED");
    this.#state = "running";
    let selectionLatencyMs = 0;
    try {
      if (this.#signal?.aborted) {
        this.#burnPreparedCapability();
        return zeroMetrics("ZERO_CLICK_BLOCKED", "RUN_ABORTED", 0);
      }
      const remainingMs = this.#prepared.claims.expiresAtMs - Date.now();
      if (!Number.isSafeInteger(remainingMs) || remainingMs < 50) {
        this.#burnPreparedCapability();
        return zeroMetrics("CONSUME_REJECTED", "CAPABILITY_CONSUME_REJECTED", 0);
      }
      let selection: BrowserSelectionResult;
      try {
        if (this.#residentSelection !== undefined) {
          await this.#residentSelection.armed;
          selection = await this.#residentSelection.result;
        } else {
          selection = await runBrowserSelectionStateMachine(this.#page, {
            contract: this.#contract.selection,
            plan: this.#selectionPlan,
            timeoutMs: Math.min(MAX_SELECTION_RESIDENCY_MS, remainingMs),
            waitInOfficialQueue: true,
            submitReadiness: this.#contract.submitReadiness,
            ...(this.#signal === undefined ? {} : { signal: this.#signal })
          });
        }
      } catch {
        this.#burnPreparedCapability();
        return zeroMetrics("ZERO_CLICK_BLOCKED", "SELECTION_NOT_READY", 0);
      }
      selectionLatencyMs = selection.latencyMs;
      if (selection.outcome !== "ready") {
        this.#burnPreparedCapability();
        return zeroMetrics("ZERO_CLICK_BLOCKED", "SELECTION_NOT_READY", selectionLatencyMs);
      }
      if (this.#signal?.aborted) {
        this.#burnPreparedCapability();
        return zeroMetrics("ZERO_CLICK_BLOCKED", "RUN_ABORTED", selectionLatencyMs);
      }

      const hotStartedAt = performance.now();
      let attempt: SubmitCapabilityAttempt;
      try {
        attempt = this.#attemptFromSelection(selection);
      } catch {
        this.#burnPreparedCapability();
        return zeroMetrics(
          "CONSUME_REJECTED",
          "CAPABILITY_CONSUME_REJECTED",
          selectionLatencyMs,
          hotStartedAt
        );
      }

      const consumeStartedAt = performance.now();
      try {
        this.#consumer.consume(this.#prepared, attempt);
      } catch {
        return zeroMetrics(
          "CONSUME_REJECTED",
          "CAPABILITY_CONSUME_REJECTED",
          selectionLatencyMs,
          hotStartedAt,
          Math.max(0, performance.now() - consumeStartedAt)
        );
      }
      const consumeLatencyMs = Math.max(0, performance.now() - consumeStartedAt);
      if (this.#signal?.aborted) {
        return zeroMetrics(
          "ZERO_CLICK_BLOCKED",
          "RUN_ABORTED",
          selectionLatencyMs,
          hotStartedAt,
          consumeLatencyMs
        );
      }

      const finalInput: FinalSubmitHandleInput = Object.freeze({
        contract: this.#contract,
        expected: Object.freeze({
          finalOfficialOrigin: this.#prepared.claims.finalOfficialOrigin,
          eventId: this.#prepared.claims.eventId,
          eventTitle: this.#prepared.claims.eventTitle,
          selectedSession: selection.selectedSession,
          selectedTier: selection.selectedTier,
          selectedTierUnitPriceFen: selection.selectedTierUnitPriceFen,
          quantity: selection.quantity,
          attendeeLabels: this.#attendeeLabels,
          requireAdjacent: this.#prepared.claims.requireAdjacent,
          adjacentVerified: selection.adjacentVerified,
          observedTotalFen: selection.observedTotalFen,
          maxTotalFen: this.#prepared.claims.maxTotalFen
        })
      });

      const finalEvidenceStartedAt = performance.now();
      let jsHandle: JSHandle<unknown> | undefined;
      let submitHandle: ElementHandle<HTMLElement> | null = null;
      try {
        jsHandle = await this.#page.evaluateHandle(finalSubmitHandleTask, finalInput);
        submitHandle = jsHandle.asElement() as ElementHandle<HTMLElement> | null;
        if (submitHandle === null) {
          await jsHandle.dispose();
          return zeroMetrics(
            "ZERO_CLICK_BLOCKED",
            "FINAL_EVIDENCE_REJECTED",
            selectionLatencyMs,
            hotStartedAt,
            consumeLatencyMs,
            Math.max(0, performance.now() - finalEvidenceStartedAt)
          );
        }
      } catch {
        await jsHandle?.dispose().catch(() => undefined);
        return zeroMetrics(
          "ZERO_CLICK_BLOCKED",
          "FINAL_EVIDENCE_REJECTED",
          selectionLatencyMs,
          hotStartedAt,
          consumeLatencyMs,
          Math.max(0, performance.now() - finalEvidenceStartedAt)
        );
      }
      const finalEvidenceLatencyMs = Math.max(0, performance.now() - finalEvidenceStartedAt);

      const clickStartedAt = performance.now();
      let guardRead = false;
      try {
        if (this.#signal?.aborted) {
          return zeroMetrics(
            "ZERO_CLICK_BLOCKED",
            "RUN_ABORTED",
            selectionLatencyMs,
            hotStartedAt,
            consumeLatencyMs,
            finalEvidenceLatencyMs
          );
        }
        await submitHandle.click({
          force: false,
          noWaitAfter: true,
          scroll: "none",
          timeout: FAST_PATH_TRUSTED_CLICK_TIMEOUT_MS
        });
        const trustedClickLatencyMs = Math.max(0, performance.now() - clickStartedAt);
        let guardResult: FinalSubmitGuardResult;
        try {
          guardResult = await submitHandle.evaluate(cleanupFinalSubmitGuardTask);
          guardRead = true;
        } catch {
          return zeroMetrics(
            "OUTCOME_UNKNOWN",
            "TRUSTED_CLICK_OUTCOME_UNKNOWN",
            selectionLatencyMs,
            hotStartedAt,
            consumeLatencyMs,
            finalEvidenceLatencyMs,
            trustedClickLatencyMs
          );
        }
        if (guardResult === "REJECTED") {
          return zeroMetrics(
            "ZERO_CLICK_BLOCKED",
            "FINAL_GUARD_REJECTED",
            selectionLatencyMs,
            hotStartedAt,
            consumeLatencyMs,
            finalEvidenceLatencyMs,
            trustedClickLatencyMs
          );
        }
        if (guardResult !== "ACCEPTED") {
          return zeroMetrics(
            "OUTCOME_UNKNOWN",
            "TRUSTED_CLICK_OUTCOME_UNKNOWN",
            selectionLatencyMs,
            hotStartedAt,
            consumeLatencyMs,
            finalEvidenceLatencyMs,
            trustedClickLatencyMs
          );
        }
        return zeroMetrics(
          "CLICK_DISPATCHED",
          "TRUSTED_CLICK_DISPATCHED",
          selectionLatencyMs,
          hotStartedAt,
          consumeLatencyMs,
          finalEvidenceLatencyMs,
          trustedClickLatencyMs
        );
      } catch {
        const trustedClickLatencyMs = Math.max(0, performance.now() - clickStartedAt);
        return zeroMetrics(
          "OUTCOME_UNKNOWN",
          "TRUSTED_CLICK_OUTCOME_UNKNOWN",
          selectionLatencyMs,
          hotStartedAt,
          consumeLatencyMs,
          finalEvidenceLatencyMs,
          trustedClickLatencyMs
        );
      } finally {
        if (!guardRead) {
          try {
            await submitHandle.evaluate(cleanupFinalSubmitGuardTask);
          } catch {
            // A navigation destroys the guarded realm; the outcome remains unknown.
          }
        }
        await submitHandle.dispose().catch(() => undefined);
      }
    } finally {
      this.#state = "finished";
      this.#attendeeLabels.fill("");
    }
  }
  /* HOT_PATH_END */
}
