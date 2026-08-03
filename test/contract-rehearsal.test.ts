import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Page } from "playwright-core";

import type { WatchPlanInput } from "../src/core/types.js";
import { parseRunnerArgs } from "../src/runner/cli.js";
import type { BrowserSelectionPlan, BrowserSelectionResult } from "../src/runner/browser-selection-state-machine.js";
import {
  assertContractRehearsalTarget,
  contractRehearsalDocumentGuardArmTask,
  contractRehearsalDocumentGuardInit,
  contractRehearsalDocumentGuardReadTask,
  contractRehearsalShieldInit,
  contractRehearsalShieldReadTask,
  readContractRehearsalInput,
  runContractRehearsal,
  watchMainDocument,
  type ContractRehearsalLoadedInput,
  type ContractRehearsalPageEvidence,
  type ContractRehearsalShieldState
} from "../src/runner/contract-rehearsal.js";
import { FAST_PATH_CONTRACT_VERSION, type FastPathContract } from "../src/runner/fast-path-contract.js";
import type { ExactPageTopologyGuard } from "../src/runner/page-topology-guard.js";

const EVENT_URL = "https://buy.damai.cn/order-confirm?itemId=event-1";
const ATTENDEE_REF = "attendee:v1:123e4567-e89b-42d3-a456-426614174000";

function choice(optionSelector: string, withPrice = false) {
  return {
    optionSelector,
    labelSelector: "[data-label]",
    labelAttribute: "data-visible-label",
    selectedSelector: '[data-selected="true"]',
    ...(withPrice
      ? { priceTextSelector: "[data-price]", priceFenAttribute: "data-price-fen" }
      : {})
  };
}

function contract(overrides: Partial<FastPathContract> = {}): FastPathContract {
  return {
    version: FAST_PATH_CONTRACT_VERSION,
    platform: "damai",
    finalOfficialOrigin: "https://buy.damai.cn",
    selection: {
      platform: "damai",
      allowedOrigins: ["https://buy.damai.cn", "https://detail.damai.cn"],
      blockingPredicates: [
        { key: "captcha-visible", selector: "[data-captcha]" },
        { key: "login-required-visible", selector: "[data-login]" },
        { key: "sold-out-visible", selector: "[data-sold-out]" },
        { key: "official-queue-visible", selector: "[data-queue]" }
      ],
      eventTitleSelector: "[data-event-title]",
      eventIdSelector: "[data-event-id]",
      eventIdAttribute: "data-event-id",
      session: choice("[data-session]"),
      sessionSummarySelector: "[data-session-summary]",
      tier: choice("[data-tier]", true),
      tierSummarySelector: "[data-tier-summary]",
      quantity: {
        summarySelector: "[data-quantity-summary]",
        option: choice("[data-quantity]")
      },
      attendee: choice("[data-attendee]"),
      adjacencySelector: "[data-adjacent]",
      totalSelector: "[data-total]",
      totalFenAttribute: "data-total-fen",
      forbiddenActionSelectors: ["[data-submit]", "[data-pay]"]
    },
    submitReadiness: {
      selector: "[data-submit]",
      allowedLabels: ["确认订单"]
    },
    postSubmitPredicates: [
      { key: "order-reference-visible", selector: "[data-order-reference]" },
      { key: "payment-visible", selector: "[data-payment]" }
    ],
    ...overrides
  };
}

function plan(overrides: Partial<WatchPlanInput> = {}): WatchPlanInput {
  return {
    platform: "damai",
    officialUrl: EVENT_URL,
    eventId: "event-1",
    eventTitle: "合成私有活动标题",
    quantity: 1,
    requireAdjacent: false,
    sessions: [{ label: "合成私有场次", priority: 0 }],
    tiers: [{ label: "合成私有票档", maxUnitPriceFen: 5_800, priority: 0 }],
    maxTotalFen: 6_000,
    priceStrategy: "PREFERRED_ORDER",
    attendeeRefs: [ATTENDEE_REF],
    autoSubmitOrder: false,
    ...overrides
  };
}

async function withPrivateInputs(
  run: (input: ContractRehearsalLoadedInput, files: { planPath: string; contractPath: string }) => Promise<void>
): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ticket-agent-contract-rehearsal-"));
  const planPath = path.join(directory, "plan.json");
  const contractPath = path.join(directory, "contract.json");
  try {
    await fs.writeFile(planPath, JSON.stringify(plan()), { mode: 0o600 });
    await fs.writeFile(contractPath, JSON.stringify(contract()), { mode: 0o600 });
    await fs.chmod(planPath, 0o600);
    await fs.chmod(contractPath, 0o600);
    const input = await readContractRehearsalInput({ planPath, contractPath, repositoryRoot: process.cwd() });
    await run(input, { planPath, contractPath });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("contract-rehearsal CLI requires confirmation, contract, plan, URL, and no controller", () => {
  const base = ["--contract-rehearsal", "--plan", "/private/plan.json", "--contract", "/private/contract.json", "--url", EVENT_URL];
  assert.throws(() => parseRunnerArgs(base), /confirm-rehearsal/);
  assert.throws(
    () => parseRunnerArgs(["--contract-rehearsal", "--confirm-rehearsal", "--plan", "/private/plan.json", "--url", EVENT_URL]),
    /requires --contract/
  );
  assert.throws(
    () => parseRunnerArgs(["--contract-rehearsal", "--confirm-rehearsal", "--plan", "/private/plan.json", "--contract", "/private/contract.json"]),
    /requires --url/
  );
  const parsed = parseRunnerArgs([...base, "--confirm-rehearsal"]);
  assert.equal(parsed.mode, "contract-rehearsal");
  assert.equal(parsed.contractPath, "/private/contract.json");
  assert.throws(
    () => parseRunnerArgs([...base, "--confirm-rehearsal", "--controller-url", "http://127.0.0.1:4317"]),
    /--contract-rehearsal cannot be combined with controller/
  );
  assert.throws(
    () => parseRunnerArgs([...base, "--confirm-rehearsal", "--confirm-live"]),
    /--contract-rehearsal cannot be combined with --confirm-live/
  );
  assert.throws(
    () => parseRunnerArgs([
      "--contract-rehearsal",
      "--confirm-rehearsal",
      "--contract",
      "/private/contract.json",
      "--url",
      EVENT_URL
    ]),
    /--contract-rehearsal requires --plan/
  );
  assert.throws(() => parseRunnerArgs(["--dry-run", "--contract", "/private/contract.json"]), /only valid/);
  assert.throws(
    () => parseRunnerArgs(["--help"]),
    /--confirm-rehearsal  required together with --rehearsal or --contract-rehearsal/
  );
});

test("private contract rehearsal inputs are raw strict plans, mode 0600, and contain only opaque attendee refs", async () => {
  await withPrivateInputs(async (input, files) => {
    assert.equal(input.plan.autoSubmitOrder, false);
    assert.equal(input.attendeeAudit.count, 1);
    assert.match(input.attendeeAudit.fingerprint, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(assertContractRehearsalTarget(input, EVENT_URL).href, EVENT_URL);
    assert.throws(
      () => assertContractRehearsalTarget(input, "https://buy.damai.cn/order-confirm?itemId=other"),
      /CONTRACT_REHEARSAL_TARGET_INVALID/
    );

    await fs.writeFile(files.planPath, JSON.stringify({ ...plan(), runtimeAttendeeLabels: ["真实姓名"] }));
    await assert.rejects(
      () => readContractRehearsalInput({ ...files, repositoryRoot: process.cwd() }),
      /CONTRACT_REHEARSAL_PLAN_FIELDS_INVALID/
    );

    await fs.writeFile(files.planPath, JSON.stringify(plan({ attendeeRefs: [] })));
    await assert.rejects(
      () => readContractRehearsalInput({ ...files, repositoryRoot: process.cwd() }),
      /CONTRACT_REHEARSAL_ATTENDEE_REFS_REQUIRED/
    );

    await fs.writeFile(files.planPath, JSON.stringify(plan({ priceStrategy: "CHEAPEST_FIRST" })));
    await assert.rejects(
      () => readContractRehearsalInput({ ...files, repositoryRoot: process.cwd() }),
      /CONTRACT_REHEARSAL_PREFERRED_ORDER_REQUIRED/
    );

    await fs.writeFile(files.planPath, JSON.stringify(plan()));
    await fs.chmod(files.planPath, 0o644);
    await assert.rejects(
      () => readContractRehearsalInput({ ...files, repositoryRoot: process.cwd() }),
      /CONTRACT_REHEARSAL_PLAN_PERMISSIONS_REQUIRED/
    );
  });
});

class ShieldElement {
  constructor(readonly forbidden = false) {}
  matches(selector: string): boolean { return this.forbidden && selector === "[data-submit]"; }
  closest(selector: string): ShieldElement | null { return this.matches(selector) ? this : null; }
}

class ShieldFormElement extends ShieldElement {
  submit(): void {}
  requestSubmit(): void {}
}

class ShieldDocument {
  readonly listeners = new Map<string, ((event: Event) => void)[]>();
  querySelectorAll(selector: string): Element[] {
    if (selector === "[") throw new Error("invalid selector must not escape");
    return [];
  }
  addEventListener(name: string, listener: EventListenerOrEventListenerObject, _options?: boolean | AddEventListenerOptions): void {
    const callback = typeof listener === "function" ? listener : listener.handleEvent.bind(listener);
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]);
  }
  emit(name: string, target: ShieldElement): { prevented: boolean; stopped: boolean } {
    const state = { prevented: false, stopped: false };
    const event = {
      target,
      preventDefault: () => { state.prevented = true; },
      stopImmediatePropagation: () => { state.stopped = true; }
    } as unknown as Event;
    for (const listener of this.listeners.get(name) ?? []) listener(event);
    return state;
  }
}

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[name];
  else Object.defineProperty(globalThis, name, descriptor);
}

test("the pre-navigation shield blocks forbidden clicks, submit events, form.submit, and requestSubmit", () => {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const addEventListenerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "addEventListener");
  const elementDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Element");
  const formDescriptor = Object.getOwnPropertyDescriptor(globalThis, "HTMLFormElement");
  const stateDescriptor = Object.getOwnPropertyDescriptor(globalThis, "__ticketAgentContractRehearsalShield_v1");
  const document = new ShieldDocument();
  const globalListenerNames: string[] = [];
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  Object.defineProperty(globalThis, "addEventListener", {
    configurable: true,
    value: (name: string) => { globalListenerNames.push(name); }
  });
  Object.defineProperty(globalThis, "Element", { configurable: true, value: ShieldElement });
  Object.defineProperty(globalThis, "HTMLFormElement", { configurable: true, value: ShieldFormElement });
  try {
    contractRehearsalShieldInit(contract());
    const normal = document.emit("click", new ShieldElement(false));
    const forbidden = document.emit("click", new ShieldElement(true));
    document.emit("submit", new ShieldFormElement());
    new ShieldFormElement().submit();
    new ShieldFormElement().requestSubmit();
    const state = contractRehearsalShieldReadTask();
    assert.deepEqual(normal, { prevented: false, stopped: false });
    assert.deepEqual(forbidden, { prevented: true, stopped: true });
    assert.equal(state.installed, true);
    assert.equal(state.nativeFormMethodsBlocked, true);
    assert.equal(state.irreversibleClickCount, 1);
    assert.equal(state.submitEventCount, 3);
    assert.deepEqual(globalListenerNames, ["click", "submit"]);
    const exposed = (globalThis as Record<string, unknown>).__ticketAgentContractRehearsalShield_v1 as Record<string, unknown>;
    assert.equal(Object.isFrozen(exposed), true);
    assert.equal(Reflect.set(exposed, "irreversibleClickCount", 0), false);
    assert.equal(contractRehearsalShieldReadTask().irreversibleClickCount, 1);
    assert.equal(Object.getOwnPropertyDescriptor(globalThis, "__ticketAgentContractRehearsalShield_v1")?.writable, false);
  } finally {
    restoreGlobal("document", documentDescriptor);
    restoreGlobal("addEventListener", addEventListenerDescriptor);
    restoreGlobal("Element", elementDescriptor);
    restoreGlobal("HTMLFormElement", formDescriptor);
    restoreGlobal("__ticketAgentContractRehearsalShield_v1", stateDescriptor);
  }
});

test("same-document guard installs in a Node-only synthetic window and stays sticky", () => {
  const historyDescriptor = Object.getOwnPropertyDescriptor(globalThis, "history");
  const addEventListenerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "addEventListener");
  const stateDescriptor = Object.getOwnPropertyDescriptor(globalThis, "__ticketAgentContractRehearsalDocumentGuard_v1");
  const listeners = new Map<string, EventListener>();
  const calls = { pushState: 0, replaceState: 0 };
  const fakeHistory = {
    pushState(_data: unknown, _title: string, _url?: string | URL | null): void { calls.pushState += 1; },
    replaceState(_data: unknown, _title: string, _url?: string | URL | null): void { calls.replaceState += 1; }
  } as unknown as History;
  const fakeAddEventListener = ((type: string, listener: EventListenerOrEventListenerObject): void => {
    if (typeof listener === "function") listeners.set(type, listener);
  }) as typeof globalThis.addEventListener;
  const scope = globalThis as typeof globalThis & {
    __ticketAgentContractRehearsalDocumentGuard_v1?: { installed: boolean; changed: boolean };
  };
  Object.defineProperty(globalThis, "history", { configurable: true, writable: true, value: fakeHistory });
  Object.defineProperty(globalThis, "addEventListener", { configurable: true, writable: true, value: fakeAddEventListener });
  try {
    contractRehearsalDocumentGuardInit();
    assert.deepEqual(contractRehearsalDocumentGuardReadTask(), { installed: true, changed: false });
    // Initial-page history changes are tolerated until the post-navigation arm.
    fakeHistory.pushState({}, "", "/same-document-a");
    assert.equal(calls.pushState, 1);
    assert.equal(contractRehearsalDocumentGuardReadTask().changed, false);
    assert.deepEqual(contractRehearsalDocumentGuardArmTask(), { installed: true, changed: false });
    fakeHistory.replaceState({}, "", "/same-document-b");
    assert.equal(calls.replaceState, 1);
    assert.equal(contractRehearsalDocumentGuardReadTask().changed, true);
    listeners.get("popstate")?.(new Event("popstate"));
    assert.equal(contractRehearsalDocumentGuardReadTask().changed, true);
    listeners.get("hashchange")?.(new Event("hashchange"));
    assert.equal(contractRehearsalDocumentGuardReadTask().changed, true);
    const exposed = scope.__ticketAgentContractRehearsalDocumentGuard_v1 as unknown as Record<string, unknown>;
    assert.equal(Reflect.set(exposed, "changed", false), false);
    assert.equal(contractRehearsalDocumentGuardReadTask().changed, true);
    assert.equal(Object.isFrozen(exposed), true);
    assert.equal(Object.getOwnPropertyDescriptor(globalThis, "__ticketAgentContractRehearsalDocumentGuard_v1")?.writable, false);
  } finally {
    restoreGlobal("history", historyDescriptor);
    restoreGlobal("addEventListener", addEventListenerDescriptor);
    restoreGlobal("__ticketAgentContractRehearsalDocumentGuard_v1", stateDescriptor);
  }
});

test("main-document watcher ignores child frames and disposes its real event listener", () => {
  const events = new EventEmitter();
  const mainFrame = {} as Page["mainFrame"] extends () => infer FrameType ? FrameType : never;
  const childFrame = {} as typeof mainFrame;
  const pageLike = {
    mainFrame: () => mainFrame,
    on(event: string, listener: (...args: unknown[]) => void) {
      events.on(event, listener);
      return pageLike;
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      events.off(event, listener);
      return pageLike;
    }
  };
  const page = pageLike as unknown as Pick<Page, "mainFrame" | "on" | "off">;
  let changed = false;
  let callbackCount = 0;
  const dispose = watchMainDocument(page, () => {
    callbackCount += 1;
    changed = true;
  });
  assert.equal(events.listenerCount("framenavigated"), 1);
  events.emit("framenavigated", childFrame);
  assert.equal(changed, false);
  assert.equal(callbackCount, 0);
  events.emit("framenavigated", mainFrame);
  assert.equal(changed, true);
  assert.equal(callbackCount, 1);
  events.emit("framenavigated", childFrame);
  assert.equal(callbackCount, 1);
  dispose();
  assert.equal(events.listenerCount("framenavigated"), 0);
  events.emit("framenavigated", mainFrame);
  assert.equal(callbackCount, 1);
  dispose();
  assert.equal(events.listenerCount("framenavigated"), 0);
});

const READY_SELECTION: BrowserSelectionResult = {
  outcome: "ready",
  stage: "verify",
  source: "initial",
  selectedSession: "合成私有场次",
  selectedTier: "合成私有票档",
  selectedTierUnitPriceFen: 5_800,
  observedTotalFen: 5_800,
  quantity: 1,
  attendeeCount: 1,
  adjacentVerified: true,
  reversibleActionCount: 4,
  fakeClickCount: 0,
  browserLatencyMs: 1,
  latencyMs: 2
};

const TIMEOUT_SELECTION: BrowserSelectionResult = {
  outcome: "timeout",
  stage: "event",
  source: "timeout",
  reversibleActionCount: 0,
  fakeClickCount: 0,
  browserLatencyMs: 1,
  latencyMs: 2
};

const ABORTED_SELECTION: BrowserSelectionResult = {
  outcome: "aborted",
  stage: "event",
  source: "abort",
  reversibleActionCount: 0,
  fakeClickCount: 0,
  browserLatencyMs: 1,
  latencyMs: 2
};

const READY_EVIDENCE: ContractRehearsalPageEvidence = {
  origin: "https://buy.damai.cn",
  originHost: "buy.damai.cn",
  eventTitleCount: 1,
  eventIdCount: 1,
  sessionOptionCount: 1,
  tierOptionCount: 1,
  quantityOptionCount: 1,
  attendeeOptionCount: 1,
  adjacencyCount: 0,
  adjacentVerified: true,
  totalCount: 1,
  submitCount: 1,
  eventTitleMatch: true,
  eventIdMatch: true,
  totalFen: 5_800,
  tierUnitPriceFen: 5_800,
  submitEnabled: true,
  submitLabelAccepted: true,
  submitReady: true,
  selectorError: false
};

const SAFE_SHIELD: ContractRehearsalShieldState = {
  installed: true,
  irreversibleClickCount: 0,
  submitEventCount: 0,
  configurationError: false,
  nativeFormMethodsBlocked: true
};

function fakeTopology(page: Page, valid = true): ExactPageTopologyGuard {
  const controller = new AbortController();
  return {
    page,
    signal: controller.signal,
    recheck: () => valid,
    assertValid: () => { if (!valid) throw new Error("PAGE_TOPOLOGY_INVALID"); },
    dispose: () => undefined
  };
}

async function syntheticReport(
  input: ContractRehearsalLoadedInput,
  overrides: {
    evidence?: ContractRehearsalPageEvidence;
    shield?: ContractRehearsalShieldState;
    selection?: BrowserSelectionResult;
    evidenceFailure?: boolean;
    documentChange?: boolean;
    capturePlan?: (plan: BrowserSelectionPlan) => void;
    topologyInvalid?: boolean;
    installFailure?: boolean;
    targetUrl?: string;
    attendeeLabels?: readonly string[];
  } = {}
) {
  let currentUrl = "about:blank";
  let documentChangedCallback: (() => void) | undefined;
  const page = { url: () => currentUrl } as unknown as Page;
  return runContractRehearsal({
    page,
    topologyGuard: fakeTopology(page, overrides.topologyInvalid !== true),
    input,
    attendeeLabels: overrides.attendeeLabels ?? ["合成运行时观演人"],
    targetUrl: overrides.targetUrl ?? EVENT_URL,
    navigate: async (_page, target) => {
      // The synthetic navigation proves the main-document watcher is
      // installed before goto; this initial load is intentionally unarmed.
      assert.notEqual(documentChangedCallback, undefined);
      currentUrl = target;
    },
    installShield: async () => {
      if (overrides.installFailure) throw new Error("CONTRACT_REHEARSAL_SHIELD_FAILED");
    },
    watchDocument: (_page, onChanged) => {
      documentChangedCallback = onChanged;
      return () => undefined;
    },
    readShield: async () => overrides.shield ?? SAFE_SHIELD,
    startSelection: (_page, selectionOptions) => {
      overrides.capturePlan?.(selectionOptions.plan);
      if (overrides.documentChange) documentChangedCallback?.();
      return { armed: Promise.resolve(), result: Promise.resolve(overrides.selection ?? READY_SELECTION) };
    },
    collectEvidence: async () => {
      if (overrides.evidenceFailure) throw new Error("sensitive evidence failure detail");
      return overrides.evidence ?? READY_EVIDENCE;
    }
  });
}

test("a complete contract rehearsal reports only redacted evidence and proves zero submit", async () => {
  await withPrivateInputs(async (input) => {
    let capturedPlan: BrowserSelectionPlan | undefined;
    const report = await syntheticReport(input, { capturePlan: (value) => { capturedPlan = value; } });
    assert.equal(report.outcome, "REVIEW_REQUIRED");
    assert.equal(report.reason, "NO_SUBMIT_REHEARSAL_COMPLETE");
    assert.equal(report.selectionReady, true);
    assert.equal(report.documentStable, true);
    assert.equal(report.zeroSubmit, true);
    assert.equal(report.postSubmitEvidence, "NOT_OBSERVED");
    assert.equal(report.readiness.state, "READY");
    assert.equal(report.attendeeCount, 1);
    assert.deepEqual(capturedPlan?.sessionLabels, [""]);
    assert.deepEqual(capturedPlan?.tierPreferences, [{ label: "", maxUnitPriceFen: 5_800 }]);
    assert.deepEqual(capturedPlan?.attendeeLabels, [""]);
    assert.equal(capturedPlan?.eventId, "");
    assert.equal(capturedPlan?.eventTitle, "");
    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /合成私有|合成运行时|order-confirm|itemId|data-submit|attendee:v1/u);
  });
});

test("origin drift, selector evidence failure, or any blocked irreversible event cannot pass", async () => {
  await withPrivateInputs(async (input) => {
    const wrongOrigin = await syntheticReport(input, {
      evidence: { ...READY_EVIDENCE, origin: "https://detail.damai.cn", originHost: "detail.damai.cn" }
    });
    assert.equal(wrongOrigin.outcome, "BLOCKED");
    assert.equal(wrongOrigin.reason, "CONTRACT_REHEARSAL_FINAL_ORIGIN_MISMATCH");

    const invalidPostSubmitEvidence = await syntheticReport(input, {
      evidence: { ...READY_EVIDENCE, selectorError: true }
    });
    assert.equal(invalidPostSubmitEvidence.outcome, "BLOCKED");
    assert.equal(invalidPostSubmitEvidence.zeroSubmit, false);

    const blockedSubmit = await syntheticReport(input, {
      shield: { ...SAFE_SHIELD, submitEventCount: 1 }
    });
    assert.equal(blockedSubmit.outcome, "BLOCKED");
    assert.equal(blockedSubmit.reason, "CONTRACT_REHEARSAL_IRREVERSIBLE_EVENT_BLOCKED");
    assert.equal(blockedSubmit.zeroSubmit, false);

    const unreadableEvidence = await syntheticReport(input, { evidenceFailure: true });
    assert.equal(unreadableEvidence.outcome, "BLOCKED");
    assert.equal(unreadableEvidence.reason, "CONTRACT_REHEARSAL_EVIDENCE_FAILED");
    assert.equal(unreadableEvidence.zeroSubmit, false);

    const documentChanged = await syntheticReport(input, { documentChange: true });
    assert.equal(documentChanged.outcome, "BLOCKED");
    assert.equal(documentChanged.documentStable, false);
    assert.equal(documentChanged.reason, "CONTRACT_REHEARSAL_DOCUMENT_CHANGED");
    assert.equal(documentChanged.zeroSubmit, false);
  });
});

test("safety events and shield failures outrank timeout or aborted outcomes", async () => {
  await withPrivateInputs(async (input) => {
    const timeoutWithForbiddenClick = await syntheticReport(input, {
      selection: TIMEOUT_SELECTION,
      shield: { ...SAFE_SHIELD, irreversibleClickCount: 1 }
    });
    assert.equal(timeoutWithForbiddenClick.outcome, "BLOCKED");
    assert.equal(timeoutWithForbiddenClick.reason, "CONTRACT_REHEARSAL_IRREVERSIBLE_EVENT_BLOCKED");

    const abortedAfterFakeClick = await syntheticReport(input, {
      selection: { ...ABORTED_SELECTION, fakeClickCount: 1 }
    });
    assert.equal(abortedAfterFakeClick.outcome, "BLOCKED");
    assert.equal(abortedAfterFakeClick.reason, "CONTRACT_REHEARSAL_IRREVERSIBLE_EVENT_BLOCKED");

    const timeoutWithShieldFailure = await syntheticReport(input, {
      selection: TIMEOUT_SELECTION,
      shield: { ...SAFE_SHIELD, installed: false }
    });
    assert.equal(timeoutWithShieldFailure.outcome, "BLOCKED");
    assert.equal(timeoutWithShieldFailure.reason, "CONTRACT_REHEARSAL_SHIELD_FAILED");
  });
});

test("pre-navigation root causes remain visible when no document or shield evidence exists", async () => {
  await withPrivateInputs(async (input) => {
    const topology = await syntheticReport(input, { topologyInvalid: true });
    assert.equal(topology.outcome, "BLOCKED");
    assert.equal(topology.reason, "PAGE_TOPOLOGY_INVALID");
    assert.equal(topology.documentStable, false);

    const target = await syntheticReport(input, { targetUrl: "https://buy.damai.cn/order-confirm?itemId=other" });
    assert.equal(target.outcome, "BLOCKED");
    assert.equal(target.reason, "CONTRACT_REHEARSAL_TARGET_INVALID");

    const shield = await syntheticReport(input, { installFailure: true });
    assert.equal(shield.outcome, "BLOCKED");
    assert.equal(shield.reason, "CONTRACT_REHEARSAL_SHIELD_FAILED");

    const invalidPlan = await syntheticReport(input, { attendeeLabels: [] });
    assert.equal(invalidPlan.outcome, "BLOCKED");
    assert.equal(invalidPlan.reason, "CONTRACT_REHEARSAL_PLAN_INVALID");
  });
});
