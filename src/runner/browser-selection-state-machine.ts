import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { Page } from "playwright-core";

/**
 * A browser-resident selection task.
 *
 * This module deliberately has no Damai selectors and is not wired into an
 * adapter.  A caller must supply a selector contract obtained from a
 * read-only rehearsal against the current official page.  The only native
 * action the task can perform is selecting a configured option (and, in the
 * explicit test-only mode, clicking the hard-coded local fake sink). It has
 * no submit/order selector. Native submit/navigation controls are rejected in
 * code, while platform-specific irreversible controls must also be covered by
 * a rehearsed forbidden-action contract before this module can be connected.
 */

// One foreground-frame fallback keeps the missed-mutation path responsive;
// MutationObserver remains the normal zero-polling trigger.
export const DEFAULT_SELECTION_FALLBACK_INTERVAL_MS = 16;
const SELECTION_CANCEL_ACK_TIMEOUT_MS = 250;
export const SELECTION_WAIT_REGISTRY = "__ticketAgentSelectionMachines_v1";
export const FAKE_SELECTION_SINK_SELECTOR = '[data-ticket-agent-test-sink="browser-selection-v1"]';

export type SelectionStage =
  | "event"
  | "session"
  | "tier"
  | "quantity"
  | "attendee"
  | "verify"
  | "fake-submit";

export type SelectionSource = "initial" | "mutation" | "continuation" | "fallback" | "timeout" | "abort";

export type SelectionBlockReason =
  | "CONTRACT_INVALID"
  | "CONTRACT_SELECTOR_INVALID"
  | "PAGE_CONTEXT_INVALID"
  | "PAGE_ORIGIN_CHANGED"
  | "EVENT_EVIDENCE_MISSING"
  | "EVENT_EVIDENCE_AMBIGUOUS"
  | "EVENT_ID_MISMATCH"
  | "EVENT_TITLE_MISMATCH"
  | "BLOCKING_STATE_VISIBLE"
  | "CHOICE_EVIDENCE_INVALID"
  | "CHOICE_AMBIGUOUS"
  | "SELECTION_TARGET_CHANGED_AFTER_CLICK"
  | "REVERSIBLE_ACTION_FAILED"
  | "QUANTITY_EVIDENCE_INVALID"
  | "ATTENDEE_EVIDENCE_INVALID"
  | "UNEXPECTED_ATTENDEE_SELECTED"
  | "ADJACENCY_EVIDENCE_INVALID"
  | "TOTAL_EVIDENCE_INVALID"
  | "PRICE_LIMIT_EXCEEDED"
  | "FAKE_SINK_INVALID"
  | "FAKE_SINK_CLICK_OUTCOME_UNKNOWN"
  | "PAGE_CHANGED_AFTER_FAKE_CLICK"
  | "PAGE_TASK_FAILED";

export interface SelectionBlockingPredicate {
  /** Fixed, non-sensitive key (for example `captcha-visible`). */
  key: string;
  selector: string;
}

export interface SelectionChoiceContract {
  /** Global option selector. It must identify only reversible choice options. */
  optionSelector: string;
  /** Optional selector scoped to one option; absent means the option itself. */
  labelSelector?: string;
  /** Selector tested with `Element.matches` to prove selected state. */
  selectedSelector: string;
  /** Optional selector scoped to one option; absent means the option itself. */
  clickSelector?: string;
  labelAttribute?: string;
  /** Optional selector for visible status/price text scoped to one option. */
  priceTextSelector?: string;
  priceFenAttribute?: string;
}

export interface SelectionQuantityContract {
  summarySelector: string;
  option?: SelectionChoiceContract;
  select?: {
    controlSelector: string;
  };
}

export interface BrowserSelectionContract {
  platform: "damai" | "maoyan";
  /** Exact origins reviewed by the caller. Credentials and paths are rejected. */
  allowedOrigins: readonly string[];
  blockingPredicates: readonly SelectionBlockingPredicate[];
  eventTitleSelector: string;
  eventIdSelector: string;
  eventIdAttribute: string;
  session: SelectionChoiceContract;
  sessionSummarySelector: string;
  tier: SelectionChoiceContract;
  tierSummarySelector: string;
  quantity: SelectionQuantityContract;
  attendee: SelectionChoiceContract;
  adjacencySelector?: string;
  totalSelector: string;
  totalFenAttribute: string;
  /**
   * Selectors identifying irreversible controls.  A candidate option that is
   * itself, contains, or is inside one of these controls is rejected before
   * any click.  The actual submit control is intentionally not accepted by
   * this state machine.
   */
  forbiddenActionSelectors: readonly string[];
}

export interface SelectionTierPreference {
  label: string;
  maxUnitPriceFen?: number;
}

export interface BrowserSelectionPlan {
  eventId: string;
  eventTitle: string;
  sessionLabels: readonly string[];
  tierPreferences: readonly SelectionTierPreference[];
  quantity: number;
  attendeeLabels: readonly string[];
  maxTotalFen: number;
  requireAdjacent: boolean;
}

export interface RunBrowserSelectionOptions {
  contract: BrowserSelectionContract;
  plan: BrowserSelectionPlan;
  timeoutMs: number;
  fallbackIntervalMs?: number;
  /** Only reserved test origins may set this. It clicks no real submit. */
  testOnlyFakeSubmit?: boolean;
  signal?: AbortSignal;
}

interface SerializedSelectionInput {
  runId: string;
  contract: BrowserSelectionContract;
  plan: BrowserSelectionPlan;
  timeoutMs: number;
  fallbackIntervalMs: number;
  testOnlyFakeSubmit: boolean;
}

type BrowserSelectionRegistryEntry = (() => void) | "cancelled";

interface BrowserSelectionReady {
  outcome: "ready" | "test-clicked";
  stage: "verify" | "fake-submit";
  source: Exclude<SelectionSource, "timeout" | "abort">;
  selectedSession: string;
  selectedTier: string;
  selectedTierUnitPriceFen: number;
  observedTotalFen: number;
  quantity: number;
  attendeeCount: number;
  adjacentVerified: boolean;
  reversibleActionCount: number;
  fakeClickCount: 0 | 1;
  browserLatencyMs: number;
}

interface BrowserSelectionStopped {
  outcome: "blocked" | "timeout" | "aborted";
  stage: SelectionStage;
  source: SelectionSource;
  reason?: SelectionBlockReason;
  blockingKey?: string;
  reversibleActionCount: number;
  fakeClickCount: 0 | 1;
  browserLatencyMs: number;
}

type BrowserSelectionPageResult = BrowserSelectionReady | BrowserSelectionStopped;

export type BrowserSelectionResult = BrowserSelectionPageResult & {
  /** Node-side monotonic latency, including the single page.evaluate call. */
  latencyMs: number;
};

const REQUIRED_BLOCKING_KEYS = [
  "captcha-visible",
  "login-required-visible",
  "sold-out-visible",
  "official-queue-visible"
] as const;

function fixedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\u0000");
}

function selectorString(value: unknown): value is string {
  return fixedString(value, 2_000);
}

function validateAttribute(value: unknown, required: boolean): value is string {
  if (value === undefined && !required) return true;
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(value);
}

function normalizeLabel(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").trim();
}

function validateOrigin(value: unknown): string {
  if (!fixedString(value, 300)) throw new Error("SELECTION_ORIGIN_INVALID");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("SELECTION_ORIGIN_INVALID");
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) throw new Error("SELECTION_ORIGIN_INVALID");
  return parsed.origin;
}

function validateChoice(choice: SelectionChoiceContract, name: string, requirePrice: boolean): SelectionChoiceContract {
  if (!choice || typeof choice !== "object") throw new Error(`SELECTION_${name.toUpperCase()}_CONTRACT_INVALID`);
  if (!selectorString(choice.optionSelector) || !selectorString(choice.selectedSelector)) {
    throw new Error(`SELECTION_${name.toUpperCase()}_SELECTOR_INVALID`);
  }
  if (choice.labelSelector !== undefined && !selectorString(choice.labelSelector)) {
    throw new Error(`SELECTION_${name.toUpperCase()}_LABEL_SELECTOR_INVALID`);
  }
  if (choice.clickSelector !== undefined && !selectorString(choice.clickSelector)) {
    throw new Error(`SELECTION_${name.toUpperCase()}_CLICK_SELECTOR_INVALID`);
  }
  if (!validateAttribute(choice.labelAttribute, false)) throw new Error(`SELECTION_${name.toUpperCase()}_ATTRIBUTE_INVALID`);
  if (requirePrice) {
    if (!validateAttribute(choice.priceFenAttribute, true) || !selectorString(choice.priceTextSelector)) {
      throw new Error("SELECTION_TIER_PRICE_CONTRACT_INVALID");
    }
  } else if (choice.priceTextSelector !== undefined || choice.priceFenAttribute !== undefined) {
    if (choice.priceTextSelector !== undefined && !selectorString(choice.priceTextSelector)) {
      throw new Error(`SELECTION_${name.toUpperCase()}_PRICE_SELECTOR_INVALID`);
    }
    if (choice.priceFenAttribute !== undefined && !validateAttribute(choice.priceFenAttribute, true)) {
      throw new Error(`SELECTION_${name.toUpperCase()}_PRICE_ATTRIBUTE_INVALID`);
    }
  }
  return {
    optionSelector: choice.optionSelector.trim(),
    ...(choice.labelSelector === undefined ? {} : { labelSelector: choice.labelSelector.trim() }),
    selectedSelector: choice.selectedSelector.trim(),
    ...(choice.clickSelector === undefined ? {} : { clickSelector: choice.clickSelector.trim() }),
    ...(choice.labelAttribute === undefined ? {} : { labelAttribute: choice.labelAttribute.trim() }),
    ...(choice.priceTextSelector === undefined ? {} : { priceTextSelector: choice.priceTextSelector.trim() }),
    ...(choice.priceFenAttribute === undefined ? {} : { priceFenAttribute: choice.priceFenAttribute.trim() })
  };
}

function validatePlan(plan: BrowserSelectionPlan): BrowserSelectionPlan {
  if (!plan || typeof plan !== "object") throw new Error("SELECTION_PLAN_INVALID");
  if (!fixedString(plan.eventId, 200) || !fixedString(plan.eventTitle, 300)) throw new Error("SELECTION_EVENT_IDENTITY_INVALID");
  if (!Number.isSafeInteger(plan.quantity) || plan.quantity < 1 || plan.quantity > 6) {
    throw new Error("SELECTION_QUANTITY_INVALID");
  }
  if (!Number.isSafeInteger(plan.maxTotalFen) || plan.maxTotalFen < 0) throw new Error("SELECTION_MAX_TOTAL_INVALID");
  if (!Array.isArray(plan.sessionLabels) || plan.sessionLabels.length < 1 || plan.sessionLabels.length > 32) {
    throw new Error("SELECTION_SESSION_PREFERENCES_REQUIRED");
  }
  if (!Array.isArray(plan.tierPreferences) || plan.tierPreferences.length < 1 || plan.tierPreferences.length > 64) {
    throw new Error("SELECTION_TIER_PREFERENCES_REQUIRED");
  }
  if (!Array.isArray(plan.attendeeLabels) || plan.attendeeLabels.length !== plan.quantity) {
    throw new Error("SELECTION_ATTENDEE_COUNT_INVALID");
  }
  const unique = (values: readonly string[], code: string): string[] => {
    const normalized = values.map((value) => {
      if (!fixedString(value, 200) || !normalizeLabel(value)) throw new Error(code);
      return normalizeLabel(value);
    });
    if (new Set(normalized).size !== normalized.length) throw new Error(code);
    return values.map((value) => value.trim());
  };
  const sessionLabels = unique(plan.sessionLabels, "SELECTION_SESSION_LABEL_INVALID");
  const attendeeLabels = unique(plan.attendeeLabels, "SELECTION_ATTENDEE_LABEL_INVALID");
  const tierLabels = unique(plan.tierPreferences.map((item) => item.label), "SELECTION_TIER_LABEL_INVALID");
  const tierPreferences = plan.tierPreferences.map((item, index) => {
    const max = item.maxUnitPriceFen;
    if (max !== undefined && (!Number.isSafeInteger(max) || max < 0)) throw new Error("SELECTION_MAX_UNIT_INVALID");
    return {
      label: tierLabels[index]!,
      ...(max === undefined ? {} : { maxUnitPriceFen: max })
    };
  });
  return {
    eventId: plan.eventId.trim(),
    eventTitle: plan.eventTitle.trim(),
    sessionLabels,
    tierPreferences,
    quantity: plan.quantity,
    attendeeLabels,
    maxTotalFen: plan.maxTotalFen,
    requireAdjacent: plan.requireAdjacent === true
  };
}

function validateContract(contract: BrowserSelectionContract): BrowserSelectionContract {
  if (!contract || typeof contract !== "object") throw new Error("SELECTION_CONTRACT_INVALID");
  if (contract.platform !== "damai" && contract.platform !== "maoyan") throw new Error("SELECTION_PLATFORM_INVALID");
  if (!Array.isArray(contract.allowedOrigins) || contract.allowedOrigins.length < 1 || contract.allowedOrigins.length > 8) {
    throw new Error("SELECTION_ORIGINS_REQUIRED");
  }
  const allowedOrigins = [...new Set(contract.allowedOrigins.map(validateOrigin))];
  if (!Array.isArray(contract.blockingPredicates) || contract.blockingPredicates.length < REQUIRED_BLOCKING_KEYS.length) {
    throw new Error("SELECTION_BLOCKING_CONTRACT_REQUIRED");
  }
  const blockingPredicates = contract.blockingPredicates.map((predicate) => {
    if (!predicate || !fixedString(predicate.key, 100) || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(predicate.key)) {
      throw new Error("SELECTION_BLOCKING_KEY_INVALID");
    }
    if (!selectorString(predicate.selector)) throw new Error("SELECTION_BLOCKING_SELECTOR_INVALID");
    return { key: predicate.key.trim(), selector: predicate.selector.trim() };
  });
  for (const required of REQUIRED_BLOCKING_KEYS) {
    if (!blockingPredicates.some((predicate) => predicate.key === required)) {
      throw new Error(`SELECTION_BLOCKING_KEY_REQUIRED:${required}`);
    }
  }
  const selectorFields = [
    ["eventTitleSelector", contract.eventTitleSelector],
    ["eventIdSelector", contract.eventIdSelector],
    ["sessionSummarySelector", contract.sessionSummarySelector],
    ["tierSummarySelector", contract.tierSummarySelector],
    ["totalSelector", contract.totalSelector],
    ["totalFenAttribute", contract.totalFenAttribute]
  ] as const;
  for (const [name, value] of selectorFields) {
    if (name.endsWith("Attribute")) {
      if (!validateAttribute(value, true)) throw new Error(`SELECTION_${name.toUpperCase()}_INVALID`);
    } else if (!selectorString(value)) {
      throw new Error(`SELECTION_${name.toUpperCase()}_INVALID`);
    }
  }
  if (!validateAttribute(contract.eventIdAttribute, true)) throw new Error("SELECTION_EVENT_ID_ATTRIBUTE_INVALID");
  if (!Array.isArray(contract.forbiddenActionSelectors) || contract.forbiddenActionSelectors.length < 1) {
    throw new Error("SELECTION_FORBIDDEN_ACTION_CONTRACT_REQUIRED");
  }
  const forbiddenActionSelectors = contract.forbiddenActionSelectors.map((selector) => {
    if (!selectorString(selector)) throw new Error("SELECTION_FORBIDDEN_ACTION_SELECTOR_INVALID");
    return selector.trim();
  });
  const quantity = contract.quantity;
  if (!quantity || typeof quantity !== "object" || !selectorString(quantity.summarySelector)) {
    throw new Error("SELECTION_QUANTITY_CONTRACT_INVALID");
  }
  const hasOption = quantity.option !== undefined;
  const hasSelect = quantity.select !== undefined;
  if (hasOption === hasSelect) throw new Error("SELECTION_QUANTITY_MODE_INVALID");
  const option = hasOption ? validateChoice(quantity.option!, "quantity", false) : undefined;
  const select = hasSelect
    ? quantity.select && selectorString(quantity.select.controlSelector)
      ? { controlSelector: quantity.select.controlSelector.trim() }
      : undefined
    : undefined;
  if (hasSelect && select === undefined) throw new Error("SELECTION_QUANTITY_SELECT_INVALID");
  const adjacencySelector = contract.adjacencySelector;
  if (adjacencySelector !== undefined && !selectorString(adjacencySelector)) throw new Error("SELECTION_ADJACENCY_SELECTOR_INVALID");
  return {
    platform: contract.platform,
    allowedOrigins,
    blockingPredicates,
    eventTitleSelector: contract.eventTitleSelector.trim(),
    eventIdSelector: contract.eventIdSelector.trim(),
    eventIdAttribute: contract.eventIdAttribute.trim(),
    session: validateChoice(contract.session, "session", false),
    sessionSummarySelector: contract.sessionSummarySelector.trim(),
    tier: validateChoice(contract.tier, "tier", true),
    tierSummarySelector: contract.tierSummarySelector.trim(),
    quantity: {
      summarySelector: quantity.summarySelector.trim(),
      ...(option === undefined ? {} : { option }),
      ...(select === undefined ? {} : { select })
    },
    attendee: validateChoice(contract.attendee, "attendee", false),
    ...(adjacencySelector === undefined ? {} : { adjacencySelector: adjacencySelector.trim() }),
    totalSelector: contract.totalSelector.trim(),
    totalFenAttribute: contract.totalFenAttribute.trim(),
    forbiddenActionSelectors
  };
}

function validateOptions(options: RunBrowserSelectionOptions): SerializedSelectionInput {
  if (!options || typeof options !== "object") throw new Error("SELECTION_OPTIONS_INVALID");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 50 || options.timeoutMs > 10 * 60 * 1_000) {
    throw new Error("SELECTION_TIMEOUT_INVALID");
  }
  const fallbackIntervalMs = options.fallbackIntervalMs ?? DEFAULT_SELECTION_FALLBACK_INTERVAL_MS;
  if (!Number.isSafeInteger(fallbackIntervalMs) || fallbackIntervalMs < 10 || fallbackIntervalMs > 2_000) {
    throw new Error("SELECTION_FALLBACK_INVALID");
  }
  const contract = validateContract(options.contract);
  const plan = validatePlan(options.plan);
  const testOnlyFakeSubmit = options.testOnlyFakeSubmit === true;
  const originHostAllowed = (origin: string): boolean => {
    const parsed = new URL(origin);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (testOnlyFakeSubmit) {
      if (parsed.protocol === "http:") {
        const port = Number(parsed.port);
        return (host === "localhost" || host === "127.0.0.1") && Number.isInteger(port) && port >= 1 && port <= 65_535;
      }
      return parsed.protocol === "https:" && parsed.port === "" && host.endsWith(".test");
    }
    if (parsed.protocol !== "https:" || parsed.port !== "") return false;
    return contract.platform === "damai"
      ? host === "damai.cn" || host.endsWith(".damai.cn")
      : host === "maoyan.com" || host.endsWith(".maoyan.com");
  };
  if (contract.allowedOrigins.some((origin) => !originHostAllowed(origin))) {
    throw new Error(testOnlyFakeSubmit ? "SELECTION_FAKE_SUBMIT_ORIGIN_BLOCKED" : "SELECTION_PLATFORM_ORIGIN_BLOCKED");
  }
  return {
    runId: randomUUID(),
    contract,
    plan,
    timeoutMs: options.timeoutMs,
    fallbackIntervalMs,
    testOnlyFakeSubmit
  };
}

/**
 * This function is intentionally self-contained because Playwright serializes
 * the callback.  Do not add module-level references, Node APIs, network calls,
 * or `document.body.innerText` reads here.
 */
export function browserSelectionTask(input: SerializedSelectionInput): Promise<BrowserSelectionPageResult> {
  const startedAt = performance.now();
  const registryName = "__ticketAgentSelectionMachines_v1";
  const scope = globalThis as typeof globalThis & {
    __ticketAgentSelectionMachines_v1?: Record<string, BrowserSelectionRegistryEntry | undefined>;
  };
  const registry = scope[registryName] ??= Object.create(null) as Record<string, BrowserSelectionRegistryEntry | undefined>;
  const contract = input.contract;
  const plan = input.plan;
  const sourceStage: { value: SelectionStage } = { value: "event" };
  const sourceName: { value: Exclude<SelectionSource, "timeout" | "abort"> } = { value: "initial" };
  let reversibleActionCount = 0;
  let fakeClickCount: 0 | 1 = 0;

  const elapsed = (): number => Math.max(0, performance.now() - startedAt);
  const stopped = (
    outcome: "blocked" | "timeout" | "aborted",
    reason?: SelectionBlockReason,
    blockingKey?: string
  ): BrowserSelectionStopped => ({
    outcome,
    stage: sourceStage.value,
    source: outcome === "timeout" ? "timeout" : outcome === "aborted" ? "abort" : sourceName.value,
    ...(reason === undefined ? {} : { reason }),
    ...(blockingKey === undefined ? {} : { blockingKey }),
    reversibleActionCount,
    fakeClickCount,
    browserLatencyMs: elapsed()
  });

  const visible = (element: Element | null): element is Element => {
    if (element === null || !element.isConnected) return false;
    const html = element as HTMLElement;
    if (html.hidden || element.getAttribute("aria-hidden") === "true") return false;
    const view = element.ownerDocument.defaultView;
    if (!view) return false;
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
    const formControl = element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement;
    return !element.hasAttribute("disabled") && element.getAttribute("aria-disabled") !== "true" && formControl.disabled !== true;
  };
  const textOf = (element: Element): string => {
    // Even a misconfigured selector contract may not turn a scoped evidence
    // read into an expensive/sensitive whole-page scan.
    if (element === document.body || element === document.documentElement) throw new Error("WHOLE_PAGE_TEXT_READ_BLOCKED");
    return (element as HTMLElement).innerText;
  };
  const normalized = (value: string): string => value.normalize("NFKC").replace(/\s+/g, "").trim();
  const identity = (value: string): string => value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\p{P}\p{S}\p{Z}]+/gu, "")
    .trim();
  const canonicalId = (value: string): string => value.normalize("NFKC").trim();
  const all = (selector: string): Element[] => Array.from(document.querySelectorAll(selector));
  const visibleAll = (selector: string): Element[] => all(selector).filter(visible);
  const uniqueVisible = (selector: string): Element | undefined => {
    const matches = visibleAll(selector);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const scopedUnique = (root: Element, selector: string | undefined): Element | undefined => {
    if (selector === undefined) return root;
    const matches = Array.from(root.querySelectorAll(selector)).filter(visible);
    return matches.length === 1 ? matches[0] : undefined;
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
    const value = textOf(label).trim();
    if (!value) return undefined;
    if (choice.labelAttribute !== undefined) {
      const attribute = element.getAttribute(choice.labelAttribute)?.trim();
      if (!attribute || normalized(attribute) !== normalized(value)) return undefined;
    }
    return value;
  };
  const clickTarget = (element: Element, choice: SelectionChoiceContract): Element | undefined => {
    const target = scopedUnique(element, choice.clickSelector);
    if (target === undefined || !enabled(target) || typeof (target as HTMLElement).click !== "function") return undefined;
    const nativeActionUnsafe = (candidate: Element): boolean => {
      // These checks are immutable and cannot be weakened by a selector
      // contract. In particular, a missing button type defaults to submit.
      const button = candidate.tagName.toLowerCase() === "button" ? candidate : candidate.closest("button");
      if (button !== null) {
        if ((button.getAttribute("type") ?? "submit").toLowerCase() !== "button") return true;
        if (button.closest("form") !== null) return true;
      }
      const input = candidate.tagName.toLowerCase() === "input" ? candidate : candidate.closest("input");
      if (input !== null) {
        const type = (input.getAttribute("type") ?? "text").toLowerCase();
        if (type !== "checkbox" && type !== "radio") return true;
      }
      const anchor = candidate.tagName.toLowerCase() === "a" ? candidate : candidate.closest("a");
      const area = candidate.tagName.toLowerCase() === "area" ? candidate : candidate.closest("area");
      if (anchor?.hasAttribute("href") || area?.hasAttribute("href")) return true;
      if (
        candidate.closest("form") !== null ||
        candidate.closest("[formaction]") !== null ||
        candidate.closest('[role="link"]') !== null
      ) return true;
      return false;
    };
    if (nativeActionUnsafe(element) || nativeActionUnsafe(target)) return undefined;
    for (const forbidden of contract.forbiddenActionSelectors) {
      try {
        if (element.matches(forbidden) || target.matches(forbidden) || element.querySelector(forbidden) !== null || target.querySelector(forbidden) !== null) {
          return undefined;
        }
        if (typeof target.closest === "function" && target.closest(forbidden) !== null) return undefined;
      } catch {
        return undefined;
      }
    }
    return target;
  };
  const parseFen = (text: string): number[] => {
    const values: number[] = [];
    const currency = /(?:[￥¥]\s*([0-9]{1,7}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)(?![0-9.,])|(?<![0-9.,])([0-9]{1,7}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)(?![0-9.,])\s*元)/g;
    for (const match of text.matchAll(currency)) {
      const raw = (match[1] ?? match[2])?.replaceAll(",", "");
      const parts = raw === undefined ? undefined : /^([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(raw);
      if (!parts?.[1]) continue;
      const yuan = Number(parts[1]);
      const fen = yuan * 100 + Number((parts[2] ?? "").padEnd(2, "0"));
      if (Number.isSafeInteger(fen) && fen >= 0) values.push(fen);
    }
    return values;
  };
  const tierPriceOf = (option: Element): number | undefined => {
    const priceTextElement = scopedUnique(option, contract.tier.priceTextSelector);
    const attributeName = contract.tier.priceFenAttribute;
    const attribute = attributeName === undefined ? null : option.getAttribute(attributeName);
    if (priceTextElement === undefined || attribute === null || !/^(?:0|[1-9][0-9]*)$/.test(attribute)) return undefined;
    const value = Number(attribute);
    const visiblePrices = parseFen(textOf(priceTextElement));
    return Number.isSafeInteger(value) && value >= 0 && visiblePrices.length === 1 && visiblePrices[0] === value
      ? value
      : undefined;
  };
  const validSelector = (selector: string): boolean => {
    try {
      document.querySelectorAll(selector);
      return true;
    } catch {
      return false;
    }
  };
  const validateSelectors = (): boolean => {
    const selectors: string[] = [
      contract.eventTitleSelector,
      contract.eventIdSelector,
      contract.sessionSummarySelector,
      contract.tierSummarySelector,
      contract.totalSelector,
      contract.session.optionSelector,
      contract.session.selectedSelector,
      contract.tier.optionSelector,
      contract.tier.selectedSelector,
      contract.attendee.optionSelector,
      contract.attendee.selectedSelector,
      contract.quantity.summarySelector,
      ...contract.forbiddenActionSelectors,
      ...contract.blockingPredicates.map((predicate) => predicate.selector)
    ];
    if (contract.session.labelSelector !== undefined) selectors.push(contract.session.labelSelector);
    if (contract.session.clickSelector !== undefined) selectors.push(contract.session.clickSelector);
    if (contract.tier.labelSelector !== undefined) selectors.push(contract.tier.labelSelector);
    if (contract.tier.clickSelector !== undefined) selectors.push(contract.tier.clickSelector);
    if (contract.tier.priceTextSelector !== undefined) selectors.push(contract.tier.priceTextSelector);
    if (contract.attendee.labelSelector !== undefined) selectors.push(contract.attendee.labelSelector);
    if (contract.attendee.clickSelector !== undefined) selectors.push(contract.attendee.clickSelector);
    if (contract.adjacencySelector !== undefined) selectors.push(contract.adjacencySelector);
    if (contract.quantity.option !== undefined) {
      selectors.push(contract.quantity.option.optionSelector, contract.quantity.option.selectedSelector);
      if (contract.quantity.option.labelSelector !== undefined) selectors.push(contract.quantity.option.labelSelector);
      if (contract.quantity.option.clickSelector !== undefined) selectors.push(contract.quantity.option.clickSelector);
    }
    if (contract.quantity.select !== undefined) selectors.push(contract.quantity.select.controlSelector);
    return selectors.every(validSelector);
  };
  const checkBoundary = (): SelectionBlockReason | undefined => {
    if (typeof location === "undefined" || typeof location.origin !== "string") return "PAGE_CONTEXT_INVALID";
    let current: URL;
    try {
      current = new URL(location.href);
    } catch {
      return "PAGE_CONTEXT_INVALID";
    }
    if (current.username || current.password || !contract.allowedOrigins.includes(current.origin)) return "PAGE_ORIGIN_CHANGED";
    return undefined;
  };
  const checkBlocking = (): { reason: SelectionBlockReason; key: string } | undefined => {
    for (const predicate of contract.blockingPredicates) {
      let matches: Element[];
      try {
        matches = visibleAll(predicate.selector);
      } catch {
        return { reason: "CONTRACT_SELECTOR_INVALID", key: predicate.key };
      }
      if (matches.length > 0) return { reason: "BLOCKING_STATE_VISIBLE", key: predicate.key };
    }
    return undefined;
  };
  const checkEvent = (): SelectionBlockReason | undefined => {
    const title = uniqueVisible(contract.eventTitleSelector);
    if (title === undefined) return "EVENT_EVIDENCE_AMBIGUOUS";
    if (identity(textOf(title)) !== identity(plan.eventTitle)) return "EVENT_TITLE_MISMATCH";
    const ids = visibleAll(contract.eventIdSelector);
    if (ids.length !== 1) return "EVENT_EVIDENCE_AMBIGUOUS";
    const observed = ids[0]!.getAttribute(contract.eventIdAttribute)?.trim();
    if (!observed) return "EVENT_EVIDENCE_MISSING";
    if (canonicalId(observed) !== canonicalId(plan.eventId)) return "EVENT_ID_MISMATCH";
    return undefined;
  };
  const optionsFor = (choice: SelectionChoiceContract): Element[] => {
    const values = visibleAll(choice.optionSelector);
    for (const value of values) {
      if (labelOf(value, choice) === undefined) throw new Error("CHOICE_LABEL_INVALID");
    }
    return values;
  };
  const exactMatches = (values: Element[], choice: SelectionChoiceContract, wanted: string): Element[] => values.filter((value) => {
    const label = labelOf(value, choice);
    return label !== undefined && normalized(label) === normalized(wanted);
  });
  const selectedCount = (values: Element[], choice: SelectionChoiceContract): number => values.filter((value) => selected(value, choice)).length;
  const summaryEquals = (selector: string, expected: string): boolean => {
    const summary = uniqueVisible(selector);
    return summary !== undefined && normalized(textOf(summary)) === normalized(expected);
  };
  const verifySelection = (
    values: Element[],
    choice: SelectionChoiceContract,
    expected: string
  ): SelectionBlockReason | undefined => {
    const matches = exactMatches(values, choice, expected);
    if (matches.length !== 1 || !selected(matches[0]!, choice) || selectedCount(values, choice) !== 1) return "CHOICE_EVIDENCE_INVALID";
    return undefined;
  };

  if (registry[input.runId] === "cancelled") {
    delete registry[input.runId];
    return Promise.resolve(stopped("aborted"));
  }
  if (!validateSelectors()) return Promise.resolve(stopped("blocked", "CONTRACT_SELECTOR_INVALID"));
  const boundary = checkBoundary();
  if (boundary !== undefined) return Promise.resolve(stopped("blocked", boundary));

  let stage: SelectionStage = "event";
  sourceStage.value = stage;
  let selectedSession = "";
  let selectedTier = "";
  let selectedTierUnitPriceFen = 0;
  let observedTotalFen = 0;
  let adjacentVerified = false;
  let pending: {
    stage: SelectionStage;
    option: Element;
    expected: string;
    choice: SelectionChoiceContract;
    priceFen?: number;
  } | undefined;
  let pendingQuantity: { option?: Element; select?: HTMLSelectElement; expected: string } | undefined;
  let settled = false;
  let inspecting = false;
  let observer: MutationObserver | undefined;
  let fallbackTimer: ReturnType<typeof setInterval> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveTask: (result: BrowserSelectionPageResult) => void = () => undefined;

  const finish = (result: BrowserSelectionPageResult): void => {
    if (settled) return;
    settled = true;
    observer?.disconnect();
    if (fallbackTimer !== undefined) clearInterval(fallbackTimer);
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    delete registry[input.runId];
    resolveTask(result);
  };
  const ready = (outcome: "ready" | "test-clicked", source: Exclude<SelectionSource, "timeout" | "abort">): BrowserSelectionReady => ({
    outcome,
    stage: outcome === "ready" ? "verify" : "fake-submit",
    source,
    selectedSession,
    selectedTier,
    selectedTierUnitPriceFen,
    observedTotalFen,
    quantity: plan.quantity,
    attendeeCount: plan.attendeeLabels.length,
    adjacentVerified,
    reversibleActionCount,
    fakeClickCount,
    browserLatencyMs: elapsed()
  });
  const actionFailed = (reason: SelectionBlockReason = "REVERSIBLE_ACTION_FAILED"): void => finish(stopped("blocked", reason));
  const performOptionClick = (option: Element, choice: SelectionChoiceContract): boolean => {
    const target = clickTarget(option, choice);
    if (target === undefined) return false;
    try {
      (target as HTMLElement).click();
    } catch {
      return false;
    }
    reversibleActionCount += 1;
    return true;
  };
  const inspectQuantity = (): boolean => {
    const quantity = contract.quantity;
    const summary = uniqueVisible(quantity.summarySelector);
    if (summary === undefined) return false;
    if (quantity.option !== undefined) {
      let values: Element[];
      try {
        values = optionsFor(quantity.option);
      } catch {
        actionFailed("QUANTITY_EVIDENCE_INVALID");
        return true;
      }
      if (pendingQuantity?.option !== undefined) {
        const pendingOption = pendingQuantity.option;
        const pendingLabel = labelOf(pendingOption, quantity.option);
        if (
          !pendingOption.isConnected ||
          !values.includes(pendingOption) ||
          pendingLabel === undefined ||
          normalized(pendingLabel) !== normalized(pendingQuantity.expected)
        ) {
          actionFailed("SELECTION_TARGET_CHANGED_AFTER_CLICK");
          return true;
        }
        if (!selected(pendingOption, quantity.option)) {
          if (!enabled(pendingOption)) {
            actionFailed("SELECTION_TARGET_CHANGED_AFTER_CLICK");
            return true;
          }
          return false;
        }
        if (selectedCount(values, quantity.option) !== 1) {
          actionFailed("QUANTITY_EVIDENCE_INVALID");
          return true;
        }
        if (normalized(textOf(summary)) !== String(plan.quantity) && normalized(textOf(summary)) !== `${plan.quantity}张`) {
          return false;
        }
        pendingQuantity = undefined;
        return true;
      }
      const matches = exactMatches(values, quantity.option, String(plan.quantity));
      if (matches.length > 1) {
        actionFailed("QUANTITY_EVIDENCE_INVALID");
        return true;
      }
      if (matches.length === 0) return false;
      const option = matches[0]!;
      if (!selected(option, quantity.option)) {
        if (!performOptionClick(option, quantity.option)) {
          actionFailed();
          return true;
        }
        pendingQuantity = { option, expected: String(plan.quantity) };
        queueMicrotask(() => inspect("continuation"));
        return false;
      }
      if (selectedCount(values, quantity.option) !== 1 || normalized(textOf(summary)) !== String(plan.quantity) && normalized(textOf(summary)) !== `${plan.quantity}张`) {
        return false;
      }
      pendingQuantity = undefined;
      return true;
    }
    const selectSpec = quantity.select!;
    const controls = visibleAll(selectSpec.controlSelector);
    if (pendingQuantity?.select !== undefined) {
      const pendingSelect = pendingQuantity.select;
      if (!pendingSelect.isConnected || controls.length !== 1 || controls[0] !== pendingSelect) {
        actionFailed("SELECTION_TARGET_CHANGED_AFTER_CLICK");
        return true;
      }
      if (pendingSelect.value !== pendingQuantity.expected) {
        if (!enabled(pendingSelect)) {
          actionFailed("SELECTION_TARGET_CHANGED_AFTER_CLICK");
          return true;
        }
        return false;
      }
      if (normalized(textOf(summary)) !== String(plan.quantity) && normalized(textOf(summary)) !== `${plan.quantity}张`) return false;
      pendingQuantity = undefined;
      return true;
    }
    if (controls.length > 1) {
      actionFailed("QUANTITY_EVIDENCE_INVALID");
      return true;
    }
    if (controls.length === 0) return false;
    const control = controls[0]!;
    if (control.tagName.toLowerCase() !== "select" || !enabled(control)) {
      actionFailed("QUANTITY_EVIDENCE_INVALID");
      return true;
    }
    const select = control as HTMLSelectElement;
    if (select.value !== String(plan.quantity)) {
      const options = Array.from(select.options).filter((option) => !option.disabled && option.value === String(plan.quantity));
      if (options.length !== 1) return false;
      try {
        select.value = String(plan.quantity);
        select.dispatchEvent(new Event("input", { bubbles: true }));
        select.dispatchEvent(new Event("change", { bubbles: true }));
      } catch {
        actionFailed();
        return true;
      }
      reversibleActionCount += 1;
      pendingQuantity = { select, expected: String(plan.quantity) };
      queueMicrotask(() => inspect("continuation"));
      return false;
    }
    if (normalized(textOf(summary)) !== String(plan.quantity) && normalized(textOf(summary)) !== `${plan.quantity}张`) return false;
    pendingQuantity = undefined;
    return true;
  };
  const inspect = (source: Exclude<SelectionSource, "timeout" | "abort">): void => {
    if (settled || inspecting) return;
    inspecting = true;
    sourceName.value = source;
    try {
      for (let transition = 0; transition < 16 && !settled; transition += 1) {
        const boundaryNow = checkBoundary();
        if (boundaryNow !== undefined) {
          finish(stopped("blocked", boundaryNow));
          return;
        }
        const blocking = checkBlocking();
        if (blocking !== undefined) {
          finish(stopped("blocked", blocking.reason, blocking.key));
          return;
        }
        const eventError = checkEvent();
        if (eventError !== undefined) {
          finish(stopped("blocked", eventError));
          return;
        }
        sourceStage.value = stage;
        if (stage === "event") {
          stage = "session";
          continue;
        }
        if (stage === "session") {
          let values: Element[];
          try {
            values = optionsFor(contract.session);
          } catch {
            finish(stopped("blocked", "CHOICE_EVIDENCE_INVALID"));
            return;
          }
          if (pending?.stage === "session") {
            const pendingLabel = labelOf(pending.option, pending.choice);
            if (
              !pending.option.isConnected ||
              !values.includes(pending.option) ||
              pendingLabel === undefined ||
              normalized(pendingLabel) !== normalized(pending.expected)
            ) {
              finish(stopped("blocked", "SELECTION_TARGET_CHANGED_AFTER_CLICK"));
              return;
            }
            if (!selected(pending.option, pending.choice)) {
              if (!enabled(pending.option)) finish(stopped("blocked", "SELECTION_TARGET_CHANGED_AFTER_CLICK"));
              return;
            }
            if (selectedCount(values, contract.session) !== 1) {
              finish(stopped("blocked", "CHOICE_EVIDENCE_INVALID"));
              return;
            }
            selectedSession = pending.expected;
            pending = undefined;
            stage = "tier";
            continue;
          }
          const preferred = plan.sessionLabels.find((label) => exactMatches(values.filter(enabled), contract.session, label).length > 0);
          if (preferred === undefined) return;
          const matches = exactMatches(values.filter(enabled), contract.session, preferred);
          if (matches.length !== 1) {
            finish(stopped("blocked", "CHOICE_AMBIGUOUS"));
            return;
          }
          const option = matches[0]!;
          if (!selected(option, contract.session)) {
            if (!performOptionClick(option, contract.session)) {
              finish(stopped("blocked", "REVERSIBLE_ACTION_FAILED"));
              return;
            }
            pending = { stage, option, expected: preferred, choice: contract.session };
            queueMicrotask(() => inspect("continuation"));
            return;
          }
          if (selectedCount(values, contract.session) !== 1) {
            finish(stopped("blocked", "CHOICE_EVIDENCE_INVALID"));
            return;
          }
          selectedSession = preferred;
          pending = undefined;
          stage = "tier";
          continue;
        }
        if (stage === "tier") {
          let values: Element[];
          try {
            values = optionsFor(contract.tier);
          } catch {
            finish(stopped("blocked", "CHOICE_EVIDENCE_INVALID"));
            return;
          }
          const priced: { option: Element; label: string; priceFen: number }[] = [];
          if (pending?.stage === "tier") {
            const pendingTier = pending;
            const pendingLabel = labelOf(pendingTier.option, pendingTier.choice);
            const currentPrice = tierPriceOf(pendingTier.option);
            const preference = plan.tierPreferences.find((item) => normalized(item.label) === normalized(pendingTier.expected));
            if (
              !pendingTier.option.isConnected ||
              !values.includes(pendingTier.option) ||
              pendingLabel === undefined ||
              normalized(pendingLabel) !== normalized(pendingTier.expected) ||
              currentPrice === undefined ||
              pendingTier.priceFen === undefined ||
              currentPrice !== pendingTier.priceFen ||
              preference === undefined
            ) {
              finish(stopped("blocked", "SELECTION_TARGET_CHANGED_AFTER_CLICK"));
              return;
            }
            if (
              (preference.maxUnitPriceFen !== undefined && currentPrice > preference.maxUnitPriceFen) ||
              currentPrice * plan.quantity > plan.maxTotalFen
            ) {
              finish(stopped("blocked", "PRICE_LIMIT_EXCEEDED"));
              return;
            }
            if (!selected(pendingTier.option, pendingTier.choice)) {
              if (!enabled(pendingTier.option)) finish(stopped("blocked", "SELECTION_TARGET_CHANGED_AFTER_CLICK"));
              return;
            }
            if (selectedCount(values, contract.tier) !== 1) {
              finish(stopped("blocked", "CHOICE_EVIDENCE_INVALID"));
              return;
            }
            selectedTier = pendingTier.expected;
            selectedTierUnitPriceFen = currentPrice;
            pending = undefined;
            stage = "quantity";
            continue;
          }
          for (const option of values) {
            if (!enabled(option)) continue;
            const label = labelOf(option, contract.tier);
            const priceFen = tierPriceOf(option);
            if (label === undefined || priceFen === undefined) {
              finish(stopped("blocked", "CHOICE_EVIDENCE_INVALID"));
              return;
            }
            priced.push({ option, label, priceFen });
          }
          let chosen: { option: Element; label: string; priceFen: number } | undefined;
          for (const preference of plan.tierPreferences) {
            const matches = priced.filter((candidate) => normalized(candidate.label) === normalized(preference.label));
            if (matches.length > 1) {
              finish(stopped("blocked", "CHOICE_AMBIGUOUS"));
              return;
            }
            const candidate = matches[0];
            if (candidate !== undefined && (preference.maxUnitPriceFen === undefined || candidate.priceFen <= preference.maxUnitPriceFen) && candidate.priceFen * plan.quantity <= plan.maxTotalFen) {
              chosen = candidate;
              break;
            }
          }
          if (chosen === undefined) return;
          if (!selected(chosen.option, contract.tier)) {
            if (!performOptionClick(chosen.option, contract.tier)) {
              finish(stopped("blocked", "REVERSIBLE_ACTION_FAILED"));
              return;
            }
            pending = { stage, option: chosen.option, expected: chosen.label, choice: contract.tier, priceFen: chosen.priceFen };
            queueMicrotask(() => inspect("continuation"));
            return;
          }
          if (selectedCount(values, contract.tier) !== 1) {
            finish(stopped("blocked", "CHOICE_EVIDENCE_INVALID"));
            return;
          }
          selectedTier = chosen.label;
          selectedTierUnitPriceFen = chosen.priceFen;
          pending = undefined;
          stage = "quantity";
          continue;
        }
        if (stage === "quantity") {
          if (!inspectQuantity()) return;
          stage = "attendee";
          continue;
        }
        if (stage === "attendee") {
          let values: Element[];
          try {
            values = optionsFor(contract.attendee);
          } catch {
            finish(stopped("blocked", "ATTENDEE_EVIDENCE_INVALID"));
            return;
          }
          if (pending?.stage === "attendee") {
            const pendingLabel = labelOf(pending.option, pending.choice);
            if (
              !pending.option.isConnected ||
              !values.includes(pending.option) ||
              pendingLabel === undefined ||
              normalized(pendingLabel) !== normalized(pending.expected)
            ) {
              finish(stopped("blocked", "SELECTION_TARGET_CHANGED_AFTER_CLICK"));
              return;
            }
            if (!selected(pending.option, pending.choice)) {
              if (!enabled(pending.option)) finish(stopped("blocked", "SELECTION_TARGET_CHANGED_AFTER_CLICK"));
              return;
            }
            pending = undefined;
          }
          const selectedValues = values.filter((value) => selected(value, contract.attendee));
          for (const value of selectedValues) {
            const label = labelOf(value, contract.attendee);
            if (label === undefined || !plan.attendeeLabels.some((expected) => normalized(expected) === normalized(label))) {
              finish(stopped("blocked", "UNEXPECTED_ATTENDEE_SELECTED"));
              return;
            }
          }
          for (const expected of plan.attendeeLabels) {
            const matches = exactMatches(values.filter(enabled), contract.attendee, expected);
            if (matches.length !== 1) return;
            const option = matches[0]!;
            if (!selected(option, contract.attendee)) {
              if (pending?.stage === stage && pending.option === option) return;
              if (!performOptionClick(option, contract.attendee)) {
                finish(stopped("blocked", "REVERSIBLE_ACTION_FAILED"));
                return;
              }
              pending = { stage, option, expected, choice: contract.attendee };
              queueMicrotask(() => inspect("continuation"));
              return;
            }
          }
          if (selectedCount(values, contract.attendee) !== plan.quantity) return;
          pending = undefined;
          stage = "verify";
          continue;
        }
        if (stage === "verify") {
          const sessionValues = optionsFor(contract.session);
          const tierValues = optionsFor(contract.tier);
          const attendeeValues = optionsFor(contract.attendee);
          if (verifySelection(sessionValues, contract.session, selectedSession) !== undefined || !summaryEquals(contract.sessionSummarySelector, selectedSession)) {
            finish(stopped("blocked", "CHOICE_EVIDENCE_INVALID"));
            return;
          }
          const selectedTierOption = exactMatches(tierValues, contract.tier, selectedTier);
          if (selectedTierOption.length !== 1 || !selected(selectedTierOption[0]!, contract.tier) || selectedCount(tierValues, contract.tier) !== 1 || !summaryEquals(contract.tierSummarySelector, selectedTier)) {
            finish(stopped("blocked", "CHOICE_EVIDENCE_INVALID"));
            return;
          }
          const currentTierPrice = tierPriceOf(selectedTierOption[0]!);
          const selectedPreference = plan.tierPreferences.find((item) => normalized(item.label) === normalized(selectedTier));
          if (currentTierPrice === undefined || selectedPreference === undefined) {
            finish(stopped("blocked", "CHOICE_EVIDENCE_INVALID"));
            return;
          }
          if (
            (selectedPreference.maxUnitPriceFen !== undefined && currentTierPrice > selectedPreference.maxUnitPriceFen) ||
            currentTierPrice * plan.quantity > plan.maxTotalFen
          ) {
            finish(stopped("blocked", "PRICE_LIMIT_EXCEEDED"));
            return;
          }
          if (currentTierPrice !== selectedTierUnitPriceFen) {
            finish(stopped("blocked", "CHOICE_EVIDENCE_INVALID"));
            return;
          }
          const quantitySummary = uniqueVisible(contract.quantity.summarySelector);
          if (quantitySummary === undefined || (normalized(textOf(quantitySummary)) !== String(plan.quantity) && normalized(textOf(quantitySummary)) !== `${plan.quantity}张`)) {
            finish(stopped("blocked", "QUANTITY_EVIDENCE_INVALID"));
            return;
          }
          if (contract.quantity.select !== undefined) {
            const controls = visibleAll(contract.quantity.select.controlSelector);
            const control = controls[0];
            const select = control as HTMLSelectElement | undefined;
            const matchingOptions = select === undefined || control?.tagName.toLowerCase() !== "select"
              ? []
              : Array.from(select.options).filter((option) => !option.disabled && option.value === String(plan.quantity));
            if (
              controls.length !== 1 ||
              control === undefined ||
              !enabled(control) ||
              control.tagName.toLowerCase() !== "select" ||
              select?.value !== String(plan.quantity) ||
              matchingOptions.length !== 1
            ) {
              finish(stopped("blocked", "QUANTITY_EVIDENCE_INVALID"));
              return;
            }
          } else if (contract.quantity.option !== undefined) {
            const quantityValues = optionsFor(contract.quantity.option);
            const selectedQuantity = exactMatches(quantityValues, contract.quantity.option, String(plan.quantity));
            if (
              selectedQuantity.length !== 1 ||
              !selected(selectedQuantity[0]!, contract.quantity.option) ||
              selectedCount(quantityValues, contract.quantity.option) !== 1
            ) {
              finish(stopped("blocked", "QUANTITY_EVIDENCE_INVALID"));
              return;
            }
          }
          if (
            selectedCount(attendeeValues, contract.attendee) !== plan.quantity ||
            plan.attendeeLabels.some((expected) => {
              const matches = exactMatches(attendeeValues, contract.attendee, expected);
              return matches.length !== 1 || !selected(matches[0]!, contract.attendee);
            })
          ) {
            finish(stopped("blocked", "ATTENDEE_EVIDENCE_INVALID"));
            return;
          }
          if (plan.requireAdjacent && plan.quantity > 1) {
            if (contract.adjacencySelector === undefined || visibleAll(contract.adjacencySelector).length !== 1) {
              finish(stopped("blocked", "ADJACENCY_EVIDENCE_INVALID"));
              return;
            }
            adjacentVerified = true;
          } else {
            adjacentVerified = true;
          }
          const totals = visibleAll(contract.totalSelector);
          if (totals.length !== 1) {
            finish(stopped("blocked", "TOTAL_EVIDENCE_INVALID"));
            return;
          }
          const total = totals[0]!;
          const totalAttribute = total.getAttribute(contract.totalFenAttribute);
          const totalText = parseFen(textOf(total));
          if (totalAttribute === null || !/^(?:0|[1-9][0-9]*)$/.test(totalAttribute) || totalText.length !== 1) {
            finish(stopped("blocked", "TOTAL_EVIDENCE_INVALID"));
            return;
          }
          observedTotalFen = Number(totalAttribute);
          if (!Number.isSafeInteger(observedTotalFen) || totalText[0] !== observedTotalFen) {
            finish(stopped("blocked", "TOTAL_EVIDENCE_INVALID"));
            return;
          }
          if (observedTotalFen > plan.maxTotalFen || selectedTierUnitPriceFen * plan.quantity > plan.maxTotalFen) {
            finish(stopped("blocked", "PRICE_LIMIT_EXCEEDED"));
            return;
          }
          if (!input.testOnlyFakeSubmit) {
            finish(ready("ready", source));
            return;
          }
          stage = "fake-submit";
          continue;
        }
        if (stage === "fake-submit") {
          const sinkValues = visibleAll('[data-ticket-agent-test-sink="browser-selection-v1"]');
          if (sinkValues.length !== 1) {
            finish(stopped("blocked", "FAKE_SINK_INVALID"));
            return;
          }
          const sink = sinkValues[0]!;
          if (!enabled(sink) || sink.tagName.toLowerCase() !== "button" || sink.getAttribute("type") !== "button" || sink.closest("form") !== null || sink.getAttribute("data-ticket-agent-test-click-count") !== "0") {
            finish(stopped("blocked", "FAKE_SINK_INVALID"));
            return;
          }
          const beforeOrigin = location.href;
          try {
            (sink as HTMLElement).click();
          } catch {
            fakeClickCount = 1;
            finish(stopped("blocked", "FAKE_SINK_CLICK_OUTCOME_UNKNOWN"));
            return;
          }
          fakeClickCount = 1;
          if (location.href !== beforeOrigin) {
            finish(stopped("blocked", "PAGE_CHANGED_AFTER_FAKE_CLICK"));
            return;
          }
          if (sink.getAttribute("data-ticket-agent-test-click-count") !== "1") {
            finish(stopped("blocked", "FAKE_SINK_CLICK_OUTCOME_UNKNOWN"));
            return;
          }
          finish(ready("test-clicked", source));
          return;
        }
      }
    } catch {
      finish(stopped("blocked", "PAGE_CONTEXT_INVALID"));
    } finally {
      inspecting = false;
    }
  };

  return new Promise<BrowserSelectionPageResult>((resolve) => {
    resolveTask = resolve;
    if (registry[input.runId] === "cancelled") {
      finish(stopped("aborted"));
      return;
    }
    registry[input.runId] = () => finish(stopped("aborted"));
    try {
      observer = new MutationObserver(() => inspect("mutation"));
      observer.observe(document.documentElement ?? document, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true
      });
      fallbackTimer = setInterval(() => inspect("fallback"), input.fallbackIntervalMs);
      timeoutTimer = setTimeout(() => finish(stopped("timeout")), input.timeoutMs);
      inspect("initial");
    } catch {
      finish(stopped("blocked", "PAGE_CONTEXT_INVALID"));
    }
  });
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
}

/**
 * Runs one browser-resident task.  The normal success path performs exactly
 * one `page.evaluate`; a second evaluate is used only to cancel a timed-out or
 * aborted observer and never performs a selection or click.
 */
export async function runBrowserSelectionStateMachine(
  page: Pick<Page, "evaluate">,
  options: RunBrowserSelectionOptions
): Promise<BrowserSelectionResult> {
  const startedAt = performance.now();
  const input = validateOptions(options);
  if (options.signal?.aborted) {
    return {
      outcome: "aborted",
      stage: "event",
      source: "abort",
      reversibleActionCount: 0,
      fakeClickCount: 0,
      browserLatencyMs: 0,
      latencyMs: elapsedSince(startedAt)
    };
  }
  const browserTask = page.evaluate(browserSelectionTask, input) as Promise<BrowserSelectionPageResult>;
  let detachAbort: (() => void) | undefined;
  let nodeTimeout: ReturnType<typeof setTimeout> | undefined;
  const abortWait = options.signal === undefined
    ? undefined
    : new Promise<"aborted">((resolve) => {
        const abort = (): void => resolve("aborted");
        options.signal!.addEventListener("abort", abort, { once: true });
        detachAbort = () => options.signal!.removeEventListener("abort", abort);
        if (options.signal!.aborted) abort();
      });
  const timeoutWait = new Promise<"timeout">((resolve) => {
    nodeTimeout = setTimeout(() => resolve("timeout"), options.timeoutMs);
  });
  const cancel = async (): Promise<BrowserSelectionPageResult | undefined> => {
    const cancellation = page.evaluate(
      ({ runId }: { runId: string }): void => {
        const scope = globalThis as typeof globalThis & {
          __ticketAgentSelectionMachines_v1?: Record<string, BrowserSelectionRegistryEntry | undefined>;
        };
        const registry = scope.__ticketAgentSelectionMachines_v1 ??= Object.create(null) as Record<string, BrowserSelectionRegistryEntry | undefined>;
        const current = registry[runId];
        if (typeof current === "function") {
          current();
          return;
        }
        registry[runId] = "cancelled";
        const cleanupTimer = setTimeout(() => {
          if (registry[runId] === "cancelled") delete registry[runId];
        }, 30_000);
        (cleanupTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
      },
      { runId: input.runId }
    ).then(() => true, () => false);
    let acknowledgementTimer: ReturnType<typeof setTimeout> | undefined;
    const acknowledged = await Promise.race([
      cancellation,
      new Promise<false>((resolve) => {
        acknowledgementTimer = setTimeout(() => resolve(false), SELECTION_CANCEL_ACK_TIMEOUT_MS);
      })
    ]);
    if (acknowledgementTimer !== undefined) clearTimeout(acknowledgementTimer);
    if (!acknowledged) {
      void browserTask.catch(() => undefined);
      return undefined;
    }
    let settlementTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        browserTask.catch(() => undefined),
        new Promise<undefined>((resolve) => {
          settlementTimer = setTimeout(() => resolve(undefined), SELECTION_CANCEL_ACK_TIMEOUT_MS);
        })
      ]);
    } finally {
      if (settlementTimer !== undefined) clearTimeout(settlementTimer);
    }
  };
  try {
    type Winner =
      | { kind: "browser"; result: BrowserSelectionPageResult }
      | { kind: "timeout" }
      | { kind: "abort" };
    const candidates: Promise<Winner>[] = [
      browserTask.then((result): Winner => ({ kind: "browser", result })),
      timeoutWait.then((): Winner => ({ kind: "timeout" }))
    ];
    if (abortWait !== undefined) candidates.push(abortWait.then(() => ({ kind: "abort" as const })));
    const winner = await Promise.race(candidates);
    if (winner.kind === "abort") {
      const cancelled = await cancel();
      return {
        outcome: "aborted",
        stage: cancelled?.stage ?? "event",
        source: "abort",
        reversibleActionCount: cancelled?.reversibleActionCount ?? 0,
        fakeClickCount: cancelled?.fakeClickCount ?? 0,
        browserLatencyMs: cancelled?.browserLatencyMs ?? 0,
        latencyMs: elapsedSince(startedAt)
      };
    }
    if (winner.kind === "timeout") {
      const cancelled = await cancel();
      return {
        outcome: "timeout",
        stage: cancelled?.stage ?? "event",
        source: "timeout",
        reversibleActionCount: cancelled?.reversibleActionCount ?? 0,
        fakeClickCount: cancelled?.fakeClickCount ?? 0,
        browserLatencyMs: cancelled?.browserLatencyMs ?? options.timeoutMs,
        latencyMs: elapsedSince(startedAt)
      };
    }
    return { ...winner.result, latencyMs: elapsedSince(startedAt) };
  } catch {
    const cancelled = await cancel();
    return {
      outcome: "blocked",
      stage: cancelled?.stage ?? "event",
      source: "initial",
      reason: "PAGE_TASK_FAILED",
      reversibleActionCount: cancelled?.reversibleActionCount ?? 0,
      fakeClickCount: cancelled?.fakeClickCount ?? 0,
      browserLatencyMs: cancelled?.browserLatencyMs ?? 0,
      latencyMs: elapsedSince(startedAt)
    };
  } finally {
    if (nodeTimeout !== undefined) clearTimeout(nodeTimeout);
    detachAbort?.();
  }
}
