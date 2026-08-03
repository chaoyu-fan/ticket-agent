import fs from "node:fs/promises";
import path from "node:path";

import type { Frame, Page } from "playwright-core";

import { buildAttendeeRefAudit } from "../identity/attendee-ref.js";
import { normalizePlan, validatePlan } from "../core/policy.js";
import type { Platform, WatchPlan, WatchPlanInput } from "../core/types.js";
import {
  MAX_SELECTION_RESIDENCY_MS,
  startBrowserSelectionStateMachine,
  validateBrowserSelectionPlan,
  type BrowserSelectionPlan,
  type BrowserSelectionResidentTask,
  type BrowserSelectionResult
} from "./browser-selection-state-machine.js";
import {
  digestFastPathContract,
  validateFastPathContract,
  type FastPathContract
} from "./fast-path-contract.js";
import { PAGE_TOPOLOGY_INVALID, type ExactPageTopologyGuard } from "./page-topology-guard.js";
import { assertTarget } from "./safety.js";

/**
 * A contract rehearsal document deliberately contains no resolved attendee
 * names.  The only attendee material allowed on disk is an opaque ref which
 * is resolved from the Mac Keychain during PREWARM by the CLI boundary.
 */
export type ContractRehearsalPlanDocument = WatchPlanInput;

export interface ContractRehearsalLoadedInput {
  readonly plan: WatchPlan;
  readonly contract: FastPathContract;
  readonly contractDigest: `sha256:${string}`;
  readonly attendeeAudit: ReturnType<typeof buildAttendeeRefAudit>;
}

export interface ContractRehearsalPageEvidence {
  readonly origin: string;
  readonly originHost: string;
  readonly eventTitleCount: number;
  readonly eventIdCount: number;
  readonly sessionOptionCount: number;
  readonly tierOptionCount: number;
  readonly quantityOptionCount: number;
  readonly attendeeOptionCount: number;
  readonly adjacencyCount: number;
  readonly adjacentVerified: boolean;
  readonly totalCount: number;
  readonly submitCount: number;
  readonly eventTitleMatch: boolean;
  readonly eventIdMatch: boolean;
  readonly totalFen: number | null;
  readonly tierUnitPriceFen: number | null;
  readonly submitEnabled: boolean;
  readonly submitLabelAccepted: boolean;
  readonly submitReady: boolean;
  readonly selectorError: boolean;
}

export interface ContractRehearsalCounts {
  readonly eventTitle: number;
  readonly eventId: number;
  readonly sessionOptions: number;
  readonly tierOptions: number;
  readonly quantityOptions: number;
  readonly attendeeOptions: number;
  readonly total: number;
  readonly submit: number;
}

export interface ContractRehearsalPriceEvidence {
  readonly observedTotalFen: number | null;
  readonly tierUnitPriceFen: number | null;
  readonly maxTotalFen: number;
  readonly withinLimit: boolean;
}

export interface ContractRehearsalReadinessEvidence {
  readonly state: "READY" | "NOT_READY" | "NOT_OBSERVED";
  readonly controlCount: number;
  readonly enabled: boolean;
  readonly labelAccepted: boolean;
}

/**
 * Fixed, deliberately redacted report.  Do not add page URLs, visible labels,
 * selectors, HTML, or arbitrary error text to this shape.
 */
export interface ContractRehearsalReport {
  readonly mode: "contract-rehearsal";
  readonly platform: Platform;
  readonly origin: string;
  readonly originHost: string;
  readonly eventIdentityMatch: boolean;
  readonly eventTitleMatch: boolean;
  readonly eventIdMatch: boolean;
  readonly counts: ContractRehearsalCounts;
  readonly attendeeCount: number;
  readonly attendeeFingerprint: `sha256:${string}`;
  readonly selectionReady: boolean;
  readonly documentStable: boolean;
  readonly adjacentVerified: boolean;
  readonly price: ContractRehearsalPriceEvidence;
  readonly readiness: ContractRehearsalReadinessEvidence;
  readonly reversibleActionCount: number;
  readonly fakeClickCount: 0 | 1;
  readonly zeroSubmit: boolean;
  /** No submit/order/payment outcome is inspected by this mode. */
  readonly postSubmitEvidence: "NOT_OBSERVED";
  readonly outcome: "REVIEW_REQUIRED" | "BLOCKED" | "TIMEOUT" | "ABORTED";
  readonly reason: string;
  readonly digest: `sha256:${string}`;
}

export interface RunContractRehearsalOptions {
  readonly page: Page;
  readonly topologyGuard: ExactPageTopologyGuard;
  readonly input: ContractRehearsalLoadedInput;
  /** Runtime labels are owned by the caller and are wiped by that caller. */
  readonly attendeeLabels: readonly string[];
  readonly targetUrl?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Injectable navigation keeps the module deterministic in synthetic tests. */
  readonly navigate?: (page: Page, targetUrl: string) => Promise<void>;
  /** Test-only injection point; production uses the page init/evaluate implementation below. */
  readonly installShield?: (page: Page, contract: FastPathContract) => Promise<void>;
  readonly readShield?: (page: Page) => Promise<ContractRehearsalShieldState>;
  readonly startSelection?: typeof startBrowserSelectionStateMachine;
  readonly collectEvidence?: (
    page: Page,
    contract: FastPathContract,
    plan: BrowserSelectionPlan
  ) => Promise<ContractRehearsalPageEvidence>;
  /** Test-only document watcher; production uses the page's main-frame event. */
  readonly watchDocument?: (page: Page, onChanged: () => void) => () => void;
}

const PLAN_KEYS = [
  "attendeeRefs",
  "autoSubmitOrder",
  "canonicalEventKey",
  "eventId",
  "eventTitle",
  "officialUrl",
  "platform",
  "priceStrategy",
  "quantity",
  "requireAdjacent",
  "saleAt",
  "sessions",
  "tiers",
  "maxTotalFen"
] as const;

const SESSION_KEYS = ["label", "priority"] as const;
const TIER_KEYS = ["label", "maxUnitPriceFen", "priority"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const accepted = new Set(allowed);
  return Object.keys(value).every((key) => accepted.has(key));
}

function fixedRuntimeLabel(value: unknown): value is string {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 200 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

export function sanitizeContractRehearsalError(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  // Only fixed codes are allowed to cross the report boundary.  Playwright
  // errors may contain URLs, selectors, labels, or local paths.
  const known = [
    "PAGE_TOPOLOGY_INVALID",
    "CONTRACT_REHEARSAL_TARGET_INVALID",
    "CONTRACT_REHEARSAL_TARGET_ORIGIN_NOT_ALLOWED",
    "CONTRACT_REHEARSAL_PLAN_INVALID",
    "CONTRACT_REHEARSAL_INPUT_INVALID",
    "CONTRACT_REHEARSAL_NAVIGATION_FAILED",
    "SELECTION_RESIDENCY_ACK_FAILED",
    "SELECTION_ABORTED",
    "SELECTION_TIMEOUT",
    "PAGE_TASK_FAILED",
    "CONTRACT_SELECTOR_INVALID",
    "PAGE_CONTEXT_INVALID",
    "PAGE_ORIGIN_CHANGED",
    "EVENT_EVIDENCE_MISSING",
    "EVENT_EVIDENCE_AMBIGUOUS",
    "EVENT_ID_MISMATCH",
    "EVENT_TITLE_MISMATCH",
    "BLOCKING_STATE_VISIBLE",
    "CHOICE_EVIDENCE_INVALID",
    "CHOICE_AMBIGUOUS",
    "SELECTION_TARGET_CHANGED_AFTER_CLICK",
    "REVERSIBLE_ACTION_FAILED",
    "QUANTITY_EVIDENCE_INVALID",
    "ATTENDEE_EVIDENCE_INVALID",
    "UNEXPECTED_ATTENDEE_SELECTED",
    "ADJACENCY_EVIDENCE_INVALID",
    "TOTAL_EVIDENCE_INVALID",
    "PRICE_LIMIT_EXCEEDED",
    "SUBMIT_READINESS_AMBIGUOUS",
    "SUBMIT_READINESS_EVIDENCE_INVALID",
    "SELECTION_NOT_READY",
    "CONTRACT_REHEARSAL_EVIDENCE_FAILED"
  ];
  const contractCode = /^(CONTRACT_REHEARSAL_[A-Z0-9_]+)(?::|$)/u.exec(raw)?.[1];
  if (contractCode !== undefined) return contractCode;
  for (const code of known) if (raw === code || raw.startsWith(`${code}:`)) return code;
  if (raw.includes("BROWSER_CONTEXT_CLOSED")) return "BROWSER_CONTEXT_CLOSED";
  if (raw.includes("RUN_ABORTED") || raw.includes("ABORT")) return "SELECTION_ABORTED";
  return "CONTRACT_REHEARSAL_FAILED";
}

export interface ContractRehearsalShieldState {
  readonly installed: boolean;
  readonly irreversibleClickCount: number;
  readonly submitEventCount: number;
  readonly configurationError: boolean;
  readonly nativeFormMethodsBlocked: boolean;
}

export interface ContractRehearsalDocumentState {
  readonly installed: boolean;
  readonly changed: boolean;
}

/** Installs in the target document to make same-document URL changes sticky. */
export function contractRehearsalDocumentGuardInit(): void {
  const scope = globalThis as typeof globalThis & {
    __ticketAgentContractRehearsalDocumentGuard_v1?: {
      readonly version: 1;
      readonly installed: boolean;
      readonly changed: boolean;
      readonly arm: () => void;
    };
  };
  if (Object.prototype.hasOwnProperty.call(scope, "__ticketAgentContractRehearsalDocumentGuard_v1")) return;
  let installed = false;
  let changed = false;
  let armed = false;
  const state = Object.freeze({
    version: 1 as const,
    get installed(): boolean { return installed; },
    get changed(): boolean { return changed; },
    arm: (): void => { armed = true; }
  });
  const mark = (): void => { if (armed) changed = true; };
  try {
    // The browser realm gets a non-configurable, non-writable snapshot view;
    // Node-only synthetic tests keep the property configurable so they can
    // restore the process global after each test.
    const browserRealm = typeof document !== "undefined" && document.defaultView === globalThis;
    Object.defineProperty(scope, "__ticketAgentContractRehearsalDocumentGuard_v1", {
      configurable: !browserRealm,
      enumerable: false,
      writable: false,
      value: state
    });
    globalThis.addEventListener("popstate", mark, true);
    globalThis.addEventListener("hashchange", mark, true);
    const originalPushState = history.pushState.bind(history);
    const originalReplaceState = history.replaceState.bind(history);
    const guardedPushState = function(...args: Parameters<History["pushState"]>): void {
      mark();
      originalPushState(...args);
    };
    const guardedReplaceState = function(...args: Parameters<History["replaceState"]>): void {
      mark();
      originalReplaceState(...args);
    };
    Object.defineProperty(history, "pushState", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: guardedPushState
    });
    Object.defineProperty(history, "replaceState", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: guardedReplaceState
    });
    installed = true;
  } catch {
    changed = true;
  }
}

export function contractRehearsalDocumentGuardReadTask(): ContractRehearsalDocumentState {
  const scope = globalThis as typeof globalThis & {
    __ticketAgentContractRehearsalDocumentGuard_v1?: ContractRehearsalDocumentState;
  };
  const state = scope.__ticketAgentContractRehearsalDocumentGuard_v1;
  const descriptor = Object.getOwnPropertyDescriptor(scope, "__ticketAgentContractRehearsalDocumentGuard_v1");
  const hardened = state !== undefined &&
    descriptor?.writable === false &&
    Object.isFrozen(state) &&
    (state as ContractRehearsalDocumentState & { version?: unknown }).version === 1;
  return !hardened
    ? { installed: false, changed: true }
    : { installed: state.installed === true, changed: state.changed === true };
}

/** Arm the already-installed guard after the intended target navigation. */
export function contractRehearsalDocumentGuardArmTask(): ContractRehearsalDocumentState {
  const scope = globalThis as typeof globalThis & {
    __ticketAgentContractRehearsalDocumentGuard_v1?: {
      readonly version: 1;
      readonly installed: boolean;
      readonly changed: boolean;
      readonly arm: () => void;
    };
  };
  const state = scope.__ticketAgentContractRehearsalDocumentGuard_v1;
  const descriptor = Object.getOwnPropertyDescriptor(scope, "__ticketAgentContractRehearsalDocumentGuard_v1");
  const hardened = state !== undefined &&
    descriptor?.writable === false &&
    Object.isFrozen(state) &&
    state.version === 1 &&
    typeof state.arm === "function";
  if (!hardened || state.installed !== true || state.changed === true) {
    throw new Error("CONTRACT_REHEARSAL_DOCUMENT_GUARD_FAILED");
  }
  state.arm();
  return { installed: state.installed === true, changed: Boolean(state.changed) };
}

/** Installed as an init script before navigation; it survives document swaps. */
export function contractRehearsalShieldInit(contract: FastPathContract): void {
  const scope = globalThis as typeof globalThis & {
    __ticketAgentContractRehearsalShield_v1?: {
      readonly version: 1;
      readonly installed: boolean;
      readonly irreversibleClickCount: number;
      readonly submitEventCount: number;
      readonly configurationError: boolean;
      readonly nativeFormMethodsBlocked: boolean;
    };
  };
  if (Object.prototype.hasOwnProperty.call(scope, "__ticketAgentContractRehearsalShield_v1")) return;
  let installed = false;
  let irreversibleClickCount = 0;
  let submitEventCount = 0;
  let configurationError = false;
  let nativeFormMethodsBlocked = false;
  const state = Object.freeze({
    version: 1 as const,
    get installed(): boolean { return installed; },
    get irreversibleClickCount(): number { return irreversibleClickCount; },
    get submitEventCount(): number { return submitEventCount; },
    get configurationError(): boolean { return configurationError; },
    get nativeFormMethodsBlocked(): boolean { return nativeFormMethodsBlocked; }
  });
  const browserRealm = typeof document !== "undefined" && document.defaultView === globalThis;
  try {
    Object.defineProperty(scope, "__ticketAgentContractRehearsalShield_v1", {
      configurable: !browserRealm,
      enumerable: false,
      writable: false,
      value: state
    });
  } catch {
    return;
  }
  const selectors = [
    contract.submitReadiness.selector,
    ...contract.selection.forbiddenActionSelectors
  ];
  for (const selector of selectors) {
    try {
      document.querySelectorAll(selector);
    } catch {
      configurationError = true;
    }
  }
  const matchesForbidden = (target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return false;
    for (const selector of selectors) {
      try {
        if (target.matches(selector) || target.closest(selector) !== null) return true;
      } catch {
        configurationError = true;
        return true;
      }
    }
    return false;
  };
  const onClick = (event: Event): void => {
    if (!matchesForbidden(event.target)) return;
    irreversibleClickCount += 1;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onSubmit = (event: Event): void => {
    submitEventCount += 1;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  try {
    // Window capture runs before any page handler and closes the pointer/
    // submit-handler gap; the document listener remains as a fallback for
    // synthetic/embedded documents.
    globalThis.addEventListener("click", onClick, true);
    globalThis.addEventListener("submit", onSubmit, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
  } catch {
    configurationError = true;
  }
  try {
    const blockedNativeSubmit = function(this: HTMLFormElement): void {
      void this;
      submitEventCount += 1;
    };
    const blockedRequestSubmit = function(this: HTMLFormElement, _submitter?: HTMLElement | null): void {
      void this;
      submitEventCount += 1;
    };
    Object.defineProperty(HTMLFormElement.prototype, "submit", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: blockedNativeSubmit
    });
    Object.defineProperty(HTMLFormElement.prototype, "requestSubmit", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: blockedRequestSubmit
    });
    nativeFormMethodsBlocked =
      HTMLFormElement.prototype.submit === blockedNativeSubmit &&
      HTMLFormElement.prototype.requestSubmit === blockedRequestSubmit;
  } catch {
    configurationError = true;
    nativeFormMethodsBlocked = false;
  }
  installed = true;
}

export function contractRehearsalShieldReadTask(): ContractRehearsalShieldState {
  const scope = globalThis as typeof globalThis & {
    __ticketAgentContractRehearsalShield_v1?: ContractRehearsalShieldState;
  };
  const state = scope.__ticketAgentContractRehearsalShield_v1;
  const descriptor = Object.getOwnPropertyDescriptor(scope, "__ticketAgentContractRehearsalShield_v1");
  const hardened = state !== undefined &&
    descriptor?.writable === false &&
    Object.isFrozen(state) &&
    (state as ContractRehearsalShieldState & { version?: unknown }).version === 1;
  if (!hardened) {
    return {
      installed: false,
      irreversibleClickCount: 0,
      submitEventCount: 0,
      configurationError: true,
      nativeFormMethodsBlocked: false
    };
  }
  const clicksValid = Number.isSafeInteger(state.irreversibleClickCount) && state.irreversibleClickCount >= 0;
  const submitsValid = Number.isSafeInteger(state.submitEventCount) && state.submitEventCount >= 0;
  return {
      installed: state.installed === true,
      irreversibleClickCount: clicksValid ? state.irreversibleClickCount : 0,
      submitEventCount: submitsValid ? state.submitEventCount : 0,
      configurationError: state.configurationError === true || !clicksValid || !submitsValid,
      nativeFormMethodsBlocked: state.nativeFormMethodsBlocked === true
    };
}

/** Installs the shield in the current document and all future navigated documents. */
export async function installContractRehearsalShield(
  page: Pick<Page, "addInitScript" | "evaluate">,
  contract: FastPathContract
): Promise<void> {
  await page.addInitScript(contractRehearsalShieldInit, contract);
  await page.evaluate(contractRehearsalShieldInit, contract);
  const state = await page.evaluate(contractRehearsalShieldReadTask);
  if (state.installed !== true || state.configurationError === true || state.nativeFormMethodsBlocked !== true) {
    throw new Error("CONTRACT_REHEARSAL_SHIELD_FAILED");
  }
}

async function readContractRehearsalShield(page: Pick<Page, "evaluate">): Promise<ContractRehearsalShieldState> {
  return page.evaluate(contractRehearsalShieldReadTask).catch(() => ({
    installed: false,
    irreversibleClickCount: 0,
    submitEventCount: 0,
    configurationError: true,
    nativeFormMethodsBlocked: false
  }));
}

async function safeReadShield(
  reader: (page: Page) => Promise<ContractRehearsalShieldState>,
  page: Page
): Promise<ContractRehearsalShieldState> {
  try {
    return await reader(page);
  } catch {
    return unknownShield();
  }
}

async function installDocumentGuard(page: Pick<Page, "evaluate">): Promise<void> {
  await page.evaluate(contractRehearsalDocumentGuardInit);
  const state = await page.evaluate(contractRehearsalDocumentGuardReadTask);
  if (state.installed !== true || state.changed === true) {
    throw new Error("CONTRACT_REHEARSAL_DOCUMENT_GUARD_FAILED");
  }
}

async function armDocumentGuard(page: Pick<Page, "evaluate">): Promise<void> {
  const state = await page.evaluate(contractRehearsalDocumentGuardArmTask);
  if (state.installed !== true || state.changed === true) {
    throw new Error("CONTRACT_REHEARSAL_DOCUMENT_GUARD_FAILED");
  }
}

async function readDocumentGuard(page: Pick<Page, "evaluate">): Promise<ContractRehearsalDocumentState> {
  try {
    return await page.evaluate(contractRehearsalDocumentGuardReadTask);
  } catch {
    return { installed: false, changed: true };
  }
}

function unknownShield(): ContractRehearsalShieldState {
  return {
    installed: false,
    irreversibleClickCount: 0,
    submitEventCount: 0,
    configurationError: true,
    nativeFormMethodsBlocked: false
  };
}

function assertContractRehearsalPlanBinding(
  plan: Pick<WatchPlan, "officialUrl" | "eventId">,
  targetUrl?: string
): void {
  if (!plan.officialUrl?.trim() || !plan.eventId?.trim()) {
    throw new Error("CONTRACT_REHEARSAL_EVENT_BINDING_REQUIRED");
  }
  let planned: URL;
  let requested: URL;
  try {
    planned = new URL(plan.officialUrl);
    requested = new URL(targetUrl ?? plan.officialUrl);
  } catch {
    throw new Error("CONTRACT_REHEARSAL_TARGET_INVALID");
  }
  if (planned.href !== requested.href) throw new Error("CONTRACT_REHEARSAL_TARGET_INVALID");
}

/** Pure target/origin gate used before browser launch and before Keychain access. */
export function assertContractRehearsalTarget(
  input: Pick<ContractRehearsalLoadedInput, "plan" | "contract">,
  targetUrl?: string
): URL {
  assertContractRehearsalPlanBinding(input.plan, targetUrl);
  const target = assertTarget(input.plan, "rehearsal", targetUrl ?? input.plan.officialUrl);
  if (target === undefined || !input.contract.selection.allowedOrigins.includes(target.origin)) {
    throw new Error("CONTRACT_REHEARSAL_TARGET_ORIGIN_NOT_ALLOWED");
  }
  return target;
}

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function repositoryRoot(start: string): Promise<string> {
  let current = path.resolve(start);
  for (;;) {
    try {
      const [git, packageJson] = await Promise.all([
        fs.stat(path.join(current, ".git")),
        fs.stat(path.join(current, "package.json"))
      ]);
      if ((git.isDirectory() || git.isFile()) && packageJson.isFile()) return await fs.realpath(current);
    } catch {
      // Continue walking toward the filesystem root.
    }
    const parent = path.dirname(current);
    if (parent === current) return await fs.realpath(path.resolve(start));
    current = parent;
  }
}

/**
 * Private input guard.  Synthetic unit tests may explicitly opt out; the
 * production CLI has no flag that enables this bypass.
 */
export async function assertContractRehearsalInputFile(
  filePath: string,
  label: "plan" | "contract",
  options: { repositoryRoot?: string; allowSyntheticInputs?: boolean } = {}
): Promise<string> {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new Error(`CONTRACT_REHEARSAL_${label.toUpperCase()}_PATH_INVALID`);
  }
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch {
    throw new Error(`CONTRACT_REHEARSAL_${label.toUpperCase()}_FILE_INVALID`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`CONTRACT_REHEARSAL_${label.toUpperCase()}_FILE_INVALID`);
  }
  const mode = stat.mode & 0o777;
  if (options.allowSyntheticInputs !== true && mode !== 0o600) {
    throw new Error(`CONTRACT_REHEARSAL_${label.toUpperCase()}_PERMISSIONS_REQUIRED`);
  }
  const resolved = await fs.realpath(filePath).catch(() => "");
  if (!resolved) throw new Error(`CONTRACT_REHEARSAL_${label.toUpperCase()}_FILE_INVALID`);
  if (options.allowSyntheticInputs !== true) {
    const root = await repositoryRoot(options.repositoryRoot ?? process.cwd());
    if (inside(root, resolved)) throw new Error(`CONTRACT_REHEARSAL_${label.toUpperCase()}_MUST_BE_OUTSIDE_REPO`);
  }
  return resolved;
}

function validatePlanDocument(value: unknown): WatchPlanInput {
  if (!isRecord(value) || !onlyKeys(value, PLAN_KEYS)) {
    throw new Error("CONTRACT_REHEARSAL_PLAN_FIELDS_INVALID");
  }
  const plan = value;
  if (plan.autoSubmitOrder !== false) {
    throw new Error("CONTRACT_REHEARSAL_AUTO_SUBMIT_DISABLED");
  }
  if (plan.priceStrategy !== "PREFERRED_ORDER") {
    throw new Error("CONTRACT_REHEARSAL_PREFERRED_ORDER_REQUIRED");
  }
  if (!Array.isArray(plan.attendeeRefs) || plan.attendeeRefs.length < 1) {
    throw new Error("CONTRACT_REHEARSAL_ATTENDEE_REFS_REQUIRED");
  }
  if (!Array.isArray(plan.sessions) || plan.sessions.length < 1 || !Array.isArray(plan.tiers) || plan.tiers.length < 1) {
    throw new Error("CONTRACT_REHEARSAL_SELECTION_PREFERENCES_REQUIRED");
  }
  for (const item of plan.sessions) {
    if (!isRecord(item) || !exactKeys(item, SESSION_KEYS)) throw new Error("CONTRACT_REHEARSAL_SESSION_FIELDS_INVALID");
  }
  for (const item of plan.tiers) {
    if (!isRecord(item) || !onlyKeys(item, TIER_KEYS) || !exactKeys(item, item.maxUnitPriceFen === undefined ? ["label", "priority"] : TIER_KEYS)) {
      throw new Error("CONTRACT_REHEARSAL_TIER_FIELDS_INVALID");
    }
  }
  if (typeof plan.officialUrl !== "string" || !plan.officialUrl.trim() ||
      typeof plan.eventId !== "string" || !plan.eventId.trim() ||
      typeof plan.eventTitle !== "string" || !plan.eventTitle.trim() ||
      !Number.isSafeInteger(plan.quantity) ||
      !Number.isSafeInteger(plan.maxTotalFen)) {
    throw new Error("CONTRACT_REHEARSAL_EVENT_BINDING_REQUIRED");
  }
  if (plan.attendeeRefs.length !== plan.quantity) {
    throw new Error("CONTRACT_REHEARSAL_ATTENDEE_COUNT_MISMATCH");
  }
  return plan as unknown as WatchPlanInput;
}

function buildWatchPlan(input: WatchPlanInput): WatchPlan {
  const validation = validatePlan(input);
  if (!validation.ok) throw new Error(`CONTRACT_REHEARSAL_PLAN_INVALID:${validation.errors.join(";")}`);
  const normalized = normalizePlan(input);
  const now = new Date().toISOString();
  return {
    ...normalized,
    // Current contract rehearsal never persists or forwards resolved aliases.
    attendeeAliases: [],
    id: "contract-rehearsal",
    status: "ARMED",
    createdAt: now,
    updatedAt: now
  };
}

/** Load and validate the strict no-submit plan and selector contract files. */
export async function readContractRehearsalInput(options: {
  planPath: string;
  contractPath: string;
  repositoryRoot?: string;
  allowSyntheticInputs?: boolean;
}): Promise<ContractRehearsalLoadedInput> {
  const planPath = await assertContractRehearsalInputFile(options.planPath, "plan", options);
  const contractPath = await assertContractRehearsalInputFile(options.contractPath, "contract", options);
  if (planPath === contractPath) throw new Error("CONTRACT_REHEARSAL_INPUT_FILES_MUST_DIFFER");
  let planRaw: unknown;
  let contractRaw: unknown;
  try {
    planRaw = JSON.parse(await fs.readFile(planPath, "utf8")) as unknown;
    contractRaw = JSON.parse(await fs.readFile(contractPath, "utf8")) as unknown;
  } catch {
    throw new Error("CONTRACT_REHEARSAL_INPUT_JSON_INVALID");
  }
  const plan = buildWatchPlan(validatePlanDocument(planRaw));
  const contract = validateFastPathContract(contractRaw);
  if (contract.platform !== plan.platform) throw new Error("CONTRACT_REHEARSAL_PLATFORM_MISMATCH");
  const attendeeAudit = buildAttendeeRefAudit(plan.attendeeRefs ?? []);
  return Object.freeze({
    plan,
    contract,
    contractDigest: digestFastPathContract(contract),
    attendeeAudit
  });
}

/** Convert a validated WatchPlan plus runtime Keychain labels to the browser contract plan. */
export function browserPlanForContractRehearsal(
  plan: WatchPlan,
  attendeeLabels: readonly string[]
): BrowserSelectionPlan {
  if (plan.autoSubmitOrder !== false) throw new Error("CONTRACT_REHEARSAL_AUTO_SUBMIT_DISABLED");
  if (plan.eventId === undefined || plan.eventTitle === undefined || plan.maxTotalFen === undefined) {
    throw new Error("CONTRACT_REHEARSAL_EVENT_BINDING_REQUIRED");
  }
  if (!Array.isArray(attendeeLabels) || attendeeLabels.length !== plan.quantity || attendeeLabels.some((label) => !fixedRuntimeLabel(label))) {
    throw new Error("CONTRACT_REHEARSAL_RUNTIME_ATTENDEES_INVALID");
  }
  const browserPlan = validateBrowserSelectionPlan({
    eventId: plan.eventId,
    eventTitle: plan.eventTitle,
    sessionLabels: [...plan.sessions].sort((a, b) => a.priority - b.priority).map((item) => item.label),
    tierPreferences: [...plan.tiers].sort((a, b) => a.priority - b.priority).map((item) => ({
      label: item.label,
      ...(item.maxUnitPriceFen === undefined ? {} : { maxUnitPriceFen: item.maxUnitPriceFen })
    })),
    quantity: plan.quantity,
    attendeeLabels: [...attendeeLabels],
    maxTotalFen: plan.maxTotalFen,
    requireAdjacent: plan.requireAdjacent
  });
  return browserPlan;
}

/** Wipe the short-lived browser plan copy after the page task has settled. */
function wipeBrowserSelectionPlan(plan: BrowserSelectionPlan): void {
  const mutable = plan as unknown as {
    eventId: string;
    eventTitle: string;
    sessionLabels: string[];
    tierPreferences: { label: string }[];
    attendeeLabels: string[];
  };
  mutable.eventId = "";
  mutable.eventTitle = "";
  mutable.sessionLabels.fill("");
  for (const preference of mutable.tierPreferences) preference.label = "";
  mutable.attendeeLabels.fill("");
}

interface EvidenceTaskInput {
  contract: FastPathContract;
  plan: BrowserSelectionPlan;
}

/**
 * Page-only evidence probe.  It returns counts and booleans, never visible
 * labels, text, HTML, selectors, or a non-origin URL component.
 */
export function contractRehearsalEvidenceTask(input: EvidenceTaskInput): ContractRehearsalPageEvidence {
  const selection = input.contract.selection;
  const plan = input.plan;
  const readiness = input.contract.submitReadiness;
  const visible = (element: Element | null): element is Element => {
    if (element === null || !element.isConnected) return false;
    const html = element as HTMLElement;
    if (html.hidden || element.getAttribute("aria-hidden") === "true") return false;
    const view = element.ownerDocument.defaultView;
    if (!view) return false;
    const style = view.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && Number(style.opacity) !== 0 && html.getClientRects().length > 0;
  };
  const normalized = (value: string): string => value.normalize("NFKC").replace(/\s+/gu, "").trim();
  const identity = (value: string): string => value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\p{P}\p{S}\p{Z}]+/gu, "").trim();
  const textOf = (element: Element): string => {
    if (element === document.body || element === document.documentElement) throw new Error("WHOLE_PAGE_TEXT_READ_BLOCKED");
    return (element as HTMLElement).innerText;
  };
  const parseFen = (text: string): number[] => {
    const values: number[] = [];
    const currency = /(?:[￥¥]\s*([0-9]{1,7}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)(?![0-9.,])|(?<![0-9.,])([0-9]{1,7}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)(?![0-9.,])\s*元)/gu;
    for (const match of text.matchAll(currency)) {
      const raw = (match[1] ?? match[2])?.replaceAll(",", "");
      const parts = raw === undefined ? undefined : /^([0-9]+)(?:\.([0-9]{1,2}))?$/u.exec(raw);
      if (!parts?.[1]) continue;
      const fen = Number(parts[1]) * 100 + Number((parts[2] ?? "").padEnd(2, "0"));
      if (Number.isSafeInteger(fen) && fen >= 0) values.push(fen);
    }
    return values;
  };
  let selectorError = false;
  const visibleAll = (selector: string): Element[] => {
    try {
      return Array.from(document.querySelectorAll(selector)).filter(visible);
    } catch {
      selectorError = true;
      return [];
    }
  };
  const countForQuantity = (): number => selection.quantity.option === undefined
    ? visibleAll(selection.quantity.select!.controlSelector).length
    : visibleAll(selection.quantity.option.optionSelector).length;
  const origin = typeof location?.origin === "string" ? location.origin : "";
  const originHost = typeof location?.hostname === "string" ? location.hostname : "";
  const eventTitles = visibleAll(selection.eventTitleSelector);
  const eventIds = visibleAll(selection.eventIdSelector);
  const sessions = visibleAll(selection.session.optionSelector);
  const tiers = visibleAll(selection.tier.optionSelector);
  const attendees = visibleAll(selection.attendee.optionSelector);
  const adjacency = selection.adjacencySelector === undefined ? [] : visibleAll(selection.adjacencySelector);
  const totals = visibleAll(selection.totalSelector);
  const submits = visibleAll(readiness.selector);
  for (const predicate of input.contract.postSubmitPredicates) {
    try {
      document.querySelectorAll(predicate.selector);
    } catch {
      selectorError = true;
    }
  }
  let eventTitleMatch = false;
  let eventIdMatch = false;
  let totalFen: number | null = null;
  let tierUnitPriceFen: number | null = null;
  try {
    eventTitleMatch = eventTitles.length === 1 && identity(textOf(eventTitles[0]!)) === identity(plan.eventTitle);
    const id = eventIds.length === 1 ? eventIds[0]!.getAttribute(selection.eventIdAttribute)?.trim() : undefined;
    eventIdMatch = id !== undefined && id !== "" && id.normalize("NFKC").trim() === plan.eventId.normalize("NFKC").trim();
    if (totals.length === 1) {
      const attr = totals[0]!.getAttribute(selection.totalFenAttribute);
      const parsed = attr !== null && /^(?:0|[1-9][0-9]*)$/u.test(attr) ? Number(attr) : NaN;
      const textValues = parseFen(textOf(totals[0]!));
      if (Number.isSafeInteger(parsed) && textValues.length === 1 && textValues[0] === parsed) totalFen = parsed;
    }
    const selectedTiers = tiers.filter((element) => element.matches(selection.tier.selectedSelector));
    if (selectedTiers.length === 1) {
      const attr = selection.tier.priceFenAttribute === undefined ? null : selectedTiers[0]!.getAttribute(selection.tier.priceFenAttribute);
      const priceNode = selection.tier.priceTextSelector === undefined ? undefined : Array.from(selectedTiers[0]!.querySelectorAll(selection.tier.priceTextSelector)).filter(visible);
      const parsed = attr !== null && /^(?:0|[1-9][0-9]*)$/u.test(attr) ? Number(attr) : NaN;
      const textValues = priceNode?.length === 1 ? parseFen(textOf(priceNode[0]!)) : [];
      if (Number.isSafeInteger(parsed) && textValues.length === 1 && textValues[0] === parsed) tierUnitPriceFen = parsed;
    }
  } catch {
    selectorError = true;
  }
  let submitEnabled = false;
  let submitLabelAccepted = false;
  try {
    if (submits.length === 1) {
      const control = submits[0]! as HTMLButtonElement | HTMLInputElement | HTMLSelectElement;
      submitEnabled = !control.hasAttribute("disabled") && control.getAttribute("aria-disabled") !== "true" && control.disabled !== true;
      const labelNode = readiness.labelSelector === undefined
        ? submits[0]!
        : Array.from(submits[0]!.querySelectorAll(readiness.labelSelector)).filter(visible).length === 1
          ? Array.from(submits[0]!.querySelectorAll(readiness.labelSelector)).filter(visible)[0]!
          : undefined;
      if (labelNode !== undefined) {
        const visibleLabel = normalized(textOf(labelNode));
        const attributeLabel = readiness.labelAttribute === undefined ? "" : normalized(labelNode.getAttribute(readiness.labelAttribute) ?? "");
        const candidate = readiness.labelAttribute === undefined ? visibleLabel : attributeLabel;
        submitLabelAccepted = candidate !== "" && readiness.allowedLabels.some((label) => normalized(label) === candidate) && (visibleLabel === "" || attributeLabel === "" || visibleLabel === attributeLabel);
      }
    }
  } catch {
    selectorError = true;
  }
  return {
    origin,
    originHost,
    eventTitleCount: eventTitles.length,
    eventIdCount: eventIds.length,
    sessionOptionCount: sessions.length,
    tierOptionCount: tiers.length,
    quantityOptionCount: countForQuantity(),
    attendeeOptionCount: attendees.length,
    adjacencyCount: adjacency.length,
    adjacentVerified: !plan.requireAdjacent || plan.quantity <= 1 || adjacency.length === 1,
    totalCount: totals.length,
    submitCount: submits.length,
    eventTitleMatch,
    eventIdMatch,
    totalFen,
    tierUnitPriceFen,
    submitEnabled,
    submitLabelAccepted,
    submitReady: submits.length === 1 && submitEnabled && submitLabelAccepted,
    selectorError
  };
}

function emptyEvidence(origin: string): ContractRehearsalPageEvidence {
  return {
    origin: normalizeOrigin(origin),
    originHost: (() => { try { return new URL(origin).hostname; } catch { return ""; } })(),
    eventTitleCount: 0,
    eventIdCount: 0,
    sessionOptionCount: 0,
    tierOptionCount: 0,
    quantityOptionCount: 0,
    attendeeOptionCount: 0,
    adjacencyCount: 0,
    adjacentVerified: false,
    totalCount: 0,
    submitCount: 0,
    eventTitleMatch: false,
    eventIdMatch: false,
    totalFen: null,
    tierUnitPriceFen: null,
    submitEnabled: false,
    submitLabelAccepted: false,
    submitReady: false,
    selectorError: true
  };
}

function safePageUrl(page: Pick<Page, "url">): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}

/**
 * Watches Playwright's frame-navigation stream and marks only the canonical
 * main document as changed.  The returned disposer is idempotent from the
 * caller's perspective (Playwright's `off` is safe to call once), and is kept
 * separate from the sticky state held by the caller so this helper remains
 * usable with a synthetic EventEmitter in tests.
 */
export function watchMainDocument(page: Pick<Page, "mainFrame" | "on" | "off">, onChanged: () => void): () => void {
  const mainFrame = page.mainFrame();
  const listener = (frame: Frame): void => {
    if (frame === mainFrame) onChanged();
  };
  page.on("framenavigated", listener);
  return () => page.off("framenavigated", listener);
}

function reportFrom(
  input: ContractRehearsalLoadedInput,
  plan: Pick<BrowserSelectionPlan, "maxTotalFen" | "requireAdjacent">,
  selection: BrowserSelectionResult | undefined,
  evidence: ContractRehearsalPageEvidence,
  shield: ContractRehearsalShieldState,
  reason: string,
  documentStable: boolean,
  preserveReason = false
): ContractRehearsalReport {
  const observed = selection?.outcome === "ready" ? selection.observedTotalFen : evidence.totalFen;
  const withinLimit = observed !== null && Number.isSafeInteger(observed) && observed >= 0 && observed <= plan.maxTotalFen;
  const readinessState: ContractRehearsalReadinessEvidence["state"] = selection?.outcome === "ready" && evidence.submitReady
    ? "READY"
    : selection === undefined
      ? "NOT_OBSERVED"
      : "NOT_READY";
  const selectionReady = selection?.outcome === "ready";
  const zeroSubmit = shield.installed === true &&
    shield.configurationError === false &&
    shield.nativeFormMethodsBlocked === true &&
    evidence.selectorError === false &&
    documentStable &&
    shield.irreversibleClickCount === 0 &&
    shield.submitEventCount === 0 &&
    selection?.outcome === "ready" &&
    selection.fakeClickCount === 0;
  const finalOriginReached = evidence.origin === input.contract.finalOfficialOrigin;
  const completeEvidence = selection?.outcome === "ready" &&
    evidence.selectorError === false &&
    evidence.eventTitleCount === 1 &&
    evidence.eventIdCount === 1 &&
    evidence.eventTitleMatch &&
    evidence.eventIdMatch &&
    evidence.totalCount === 1 &&
    evidence.totalFen === selection.observedTotalFen &&
    evidence.tierUnitPriceFen === selection.selectedTierUnitPriceFen &&
    evidence.submitCount === 1 &&
    evidence.submitReady &&
    readinessState === "READY" &&
    finalOriginReached &&
    withinLimit &&
    selection.attendeeCount === input.attendeeAudit.count &&
    (!plan.requireAdjacent || (selection.adjacentVerified === true && evidence.adjacentVerified === true)) &&
    zeroSubmit;
  // A shield failure or any irreversible/submit signal is a hard safety
  // failure.  It must not be downgraded to TIMEOUT/ABORTED merely because the
  // state machine happened to finish with that outcome in the same run.
  const shieldFailed = shield.installed !== true ||
    shield.configurationError === true ||
    shield.nativeFormMethodsBlocked !== true;
  const irreversibleEvent = shield.irreversibleClickCount > 0 ||
    shield.submitEventCount > 0 ||
    (selection?.fakeClickCount ?? 0) > 0;
  const outcome: ContractRehearsalReport["outcome"] = completeEvidence
    ? "REVIEW_REQUIRED"
    : !documentStable || shieldFailed || irreversibleEvent
      ? "BLOCKED"
      : selection?.outcome === "timeout"
      ? "TIMEOUT"
      : selection?.outcome === "aborted"
        ? "ABORTED"
        : "BLOCKED";
  const finalReason = completeEvidence
    ? "NO_SUBMIT_REHEARSAL_COMPLETE"
    : irreversibleEvent
      ? "CONTRACT_REHEARSAL_IRREVERSIBLE_EVENT_BLOCKED"
      : preserveReason
        ? reason
        : shieldFailed
          ? "CONTRACT_REHEARSAL_SHIELD_FAILED"
          : !documentStable
            ? "CONTRACT_REHEARSAL_DOCUMENT_CHANGED"
        : selection?.outcome === "ready" && !finalOriginReached
          ? "CONTRACT_REHEARSAL_FINAL_ORIGIN_MISMATCH"
          : selection?.outcome === "ready"
            ? "CONTRACT_REHEARSAL_EVIDENCE_FAILED"
            : reason;
  return Object.freeze({
    mode: "contract-rehearsal",
    platform: input.plan.platform,
    origin: evidence.origin,
    originHost: evidence.originHost,
    eventIdentityMatch: evidence.eventTitleMatch && evidence.eventIdMatch,
    eventTitleMatch: evidence.eventTitleMatch,
    eventIdMatch: evidence.eventIdMatch,
    counts: Object.freeze({
      eventTitle: evidence.eventTitleCount,
      eventId: evidence.eventIdCount,
      sessionOptions: evidence.sessionOptionCount,
      tierOptions: evidence.tierOptionCount,
      quantityOptions: evidence.quantityOptionCount,
      attendeeOptions: evidence.attendeeOptionCount,
      total: evidence.totalCount,
      submit: evidence.submitCount
    }),
    attendeeCount: input.attendeeAudit.count,
    attendeeFingerprint: input.attendeeAudit.fingerprint,
    selectionReady,
    documentStable,
    adjacentVerified: evidence.adjacentVerified,
    price: Object.freeze({
      observedTotalFen: observed,
      tierUnitPriceFen: selection?.outcome === "ready" ? selection.selectedTierUnitPriceFen : evidence.tierUnitPriceFen,
      maxTotalFen: plan.maxTotalFen,
      withinLimit
    }),
    readiness: Object.freeze({
      state: readinessState,
      controlCount: evidence.submitCount,
      enabled: evidence.submitEnabled,
      labelAccepted: evidence.submitLabelAccepted
    }),
    reversibleActionCount: selection?.reversibleActionCount ?? 0,
    fakeClickCount: selection?.fakeClickCount ?? 0,
    zeroSubmit,
    postSubmitEvidence: "NOT_OBSERVED",
    outcome,
    reason: finalReason,
    digest: input.contractDigest
  });
}

/** Run the contract-driven selection state machine without controller/capability/submit access. */
export async function runContractRehearsal(options: RunContractRehearsalOptions): Promise<ContractRehearsalReport> {
  const { input, page, topologyGuard } = options;
  const browserPlan = (() => {
    try {
      return browserPlanForContractRehearsal(input.plan, options.attendeeLabels);
    } catch {
      return undefined;
    }
  })();
  if (browserPlan === undefined) {
    return reportFrom(
      input,
      { maxTotalFen: input.plan.maxTotalFen ?? 0, requireAdjacent: input.plan.requireAdjacent },
      undefined,
      emptyEvidence(""),
      unknownShield(),
      "CONTRACT_REHEARSAL_PLAN_INVALID",
      false,
      true
    );
  }
  const targetUrl = options.targetUrl ?? input.plan.officialUrl;
  const readShield = options.readShield ?? readContractRehearsalShield;
  const collectEvidence = options.collectEvidence ?? ((targetPage, contract, plan) =>
    targetPage.evaluate(contractRehearsalEvidenceTask, { contract, plan }));
  let resident: BrowserSelectionResidentTask | undefined;
  const stopResident = new AbortController();
  let documentStable = false;
  let documentWatchArmed = false;
  let documentChanged = false;
  let stopDocumentWatch: (() => void) | undefined;
  let checkDocument: (() => Promise<boolean>) | undefined;
  const refreshDocumentState = async (): Promise<boolean> => {
    if (checkDocument === undefined) {
      documentStable = false;
      return false;
    }
    try {
      return await checkDocument();
    } catch {
      documentStable = false;
      return false;
    }
  };
  try {
    // Keep this check inside the try/finally so the copied runtime attendee
    // labels are wiped even when topology is invalid before navigation.
    if (topologyGuard.page !== page || !topologyGuard.recheck()) {
      return reportFrom(input, browserPlan, undefined, emptyEvidence(""), unknownShield(), PAGE_TOPOLOGY_INVALID, false, true);
    }
    const target = assertContractRehearsalTarget(input, targetUrl);
    topologyGuard.assertValid();
    await (options.installShield ?? installContractRehearsalShield)(page, input.contract);
    topologyGuard.assertValid();
    const markDocumentChanged = (): void => {
      // The first navigation is the intended target load.  Register the
      // listener before starting it, but arm the sticky guard only after the
      // navigation promise settles so redirects during that load are not
      // mistaken for post-selection document changes.
      if (!documentWatchArmed) return;
      documentChanged = true;
      documentStable = false;
      stopResident.abort();
    };
    if (options.watchDocument === undefined) {
      // Ensure a fresh document gets the guard before any page script runs.
      await page.addInitScript(contractRehearsalDocumentGuardInit);
    }
    try {
      stopDocumentWatch = options.watchDocument === undefined
        ? watchMainDocument(page, markDocumentChanged)
        : options.watchDocument(page, markDocumentChanged);
    } catch {
      throw new Error("CONTRACT_REHEARSAL_DOCUMENT_GUARD_FAILED");
    }
    const navigate = options.navigate ?? (async (targetPage, url) => {
      await targetPage.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    });
    await navigate(page, target.href);
    documentWatchArmed = true;
    topologyGuard.assertValid();
    const initialHref = safePageUrl(page);
    if (initialHref === "") throw new Error("CONTRACT_REHEARSAL_DOCUMENT_GUARD_FAILED");
    documentStable = false;
    if (options.watchDocument === undefined) {
      await installDocumentGuard(page);
      await armDocumentGuard(page);
    }
    if (documentChanged) throw new Error("CONTRACT_REHEARSAL_DOCUMENT_CHANGED");
    documentStable = true;
    checkDocument = async (): Promise<boolean> => {
      if (documentChanged || !documentStable || safePageUrl(page) !== initialHref) {
        markDocumentChanged();
        return false;
      }
      if (options.watchDocument === undefined) {
        const state = await readDocumentGuard(page);
        if (state.installed !== true || state.changed === true) {
          markDocumentChanged();
          return false;
        }
      }
      return documentStable;
    };
    const navigationShield = await safeReadShield(readShield, page);
    if (!navigationShield.installed || navigationShield.configurationError || !navigationShield.nativeFormMethodsBlocked) {
      throw new Error("CONTRACT_REHEARSAL_SHIELD_FAILED");
    }
    if (!(await checkDocument())) throw new Error("CONTRACT_REHEARSAL_DOCUMENT_CHANGED");
    resident = (options.startSelection ?? startBrowserSelectionStateMachine)(page, {
      contract: input.contract.selection,
      plan: browserPlan,
      timeoutMs: options.timeoutMs ?? MAX_SELECTION_RESIDENCY_MS,
      waitInOfficialQueue: true,
      submitReadiness: input.contract.submitReadiness,
      signal: options.signal === undefined
        ? AbortSignal.any([topologyGuard.signal, stopResident.signal])
        : AbortSignal.any([options.signal, topologyGuard.signal, stopResident.signal])
    });
    let selection: BrowserSelectionResult | undefined;
    try {
      await resident.armed;
    } catch (error) {
      const evidence = await collectEvidence(page, input.contract, browserPlan).catch(() => emptyEvidence(safePageUrl(page)));
      const shield = await safeReadShield(readShield, page);
      await refreshDocumentState();
      if (!topologyGuard.recheck()) {
        return reportFrom(input, browserPlan, undefined, emptyEvidence(safePageUrl(page)), unknownShield(), PAGE_TOPOLOGY_INVALID, false, true);
      }
      return reportFrom(input, browserPlan, undefined, evidence, shield, sanitizeContractRehearsalError(error), documentStable, true);
    }
    selection = await resident.result;
    if (!(await checkDocument())) {
      return reportFrom(input, browserPlan, selection, emptyEvidence(safePageUrl(page)), unknownShield(), "CONTRACT_REHEARSAL_DOCUMENT_CHANGED", false, true);
    }
    if (!topologyGuard.recheck()) {
      return reportFrom(input, browserPlan, selection, emptyEvidence(safePageUrl(page)), unknownShield(), PAGE_TOPOLOGY_INVALID, false, true);
    }
    const evidence = await collectEvidence(page, input.contract, browserPlan).catch(() => emptyEvidence(safePageUrl(page)));
    const shield = await safeReadShield(readShield, page);
    if (!(await checkDocument())) {
      return reportFrom(input, browserPlan, selection, emptyEvidence(safePageUrl(page)), unknownShield(), "CONTRACT_REHEARSAL_DOCUMENT_CHANGED", false, true);
    }
    if (!topologyGuard.recheck()) {
      return reportFrom(input, browserPlan, selection, emptyEvidence(safePageUrl(page)), unknownShield(), PAGE_TOPOLOGY_INVALID, false, true);
    }
    const reason = selection.outcome === "ready"
      ? "NO_SUBMIT_REHEARSAL_COMPLETE"
      : selection.outcome === "timeout"
        ? "SELECTION_TIMEOUT"
        : selection.outcome === "aborted"
          ? "SELECTION_ABORTED"
          : sanitizeContractRehearsalError(selection.outcome === "blocked" ? selection.reason ?? "SELECTION_NOT_READY" : "SELECTION_NOT_READY");
    return reportFrom(input, browserPlan, selection, evidence, shield, reason, documentStable);
  } catch (error) {
    const evidence = await collectEvidence(page, input.contract, browserPlan).catch(() => emptyEvidence(safePageUrl(page)));
    const shield = await safeReadShield(readShield, page);
    await refreshDocumentState();
    if (!topologyGuard.recheck()) {
      return reportFrom(input, browserPlan, undefined, emptyEvidence(safePageUrl(page)), unknownShield(), PAGE_TOPOLOGY_INVALID, false, true);
    }
    return reportFrom(
      input,
      browserPlan,
      undefined,
      evidence,
      shield,
      sanitizeContractRehearsalError(error),
      documentStable,
      true
    );
  } finally {
    try { stopDocumentWatch?.(); } catch { /* context may already be closed */ }
    stopResident.abort();
    if (resident !== undefined) {
      await Promise.race([
        resident.result.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 1_000))
      ]);
    }
    wipeBrowserSelectionPlan(browserPlan);
  }
}
