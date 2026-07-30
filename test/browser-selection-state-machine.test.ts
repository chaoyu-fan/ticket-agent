import assert from "node:assert/strict";
import test from "node:test";

import type { Page } from "playwright-core";

import {
  browserSelectionTask,
  MAX_SELECTION_RESIDENCY_MS,
  runBrowserSelectionStateMachine,
  type BrowserSelectionContract,
  type BrowserSelectionPlan
} from "../src/runner/browser-selection-state-machine.js";

interface FakeStyle {
  display: string;
  visibility: string;
  opacity: string;
}

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly style: FakeStyle = { display: "block", visibility: "visible", opacity: "1" };
  readonly tagName: string;
  parentElement: FakeElement | null = null;
  isConnected = true;
  hidden = false;
  disabled = false;
  clickCount = 0;
  onClick: (() => void) | undefined;

  constructor(
    readonly ownerDocument: FakeDocument,
    tagName: string,
    public innerText: string,
    attributes: Record<string, string> = {}
  ) {
    this.tagName = tagName.toUpperCase();
    for (const [name, value] of Object.entries(attributes)) this.attributes.set(name, value);
  }

  append(...children: FakeElement[]): this {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    this.ownerDocument.notifySoon();
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  getClientRects(): DOMRectList {
    return { length: 1 } as DOMRectList;
  }

  matches(selector: string): boolean {
    const alternatives = selector.split(",").map((value) => value.trim()).filter(Boolean);
    return alternatives.some((candidate) => {
      if (candidate === "form") return this.tagName === "FORM";
      if (/^[a-z]+$/i.test(candidate)) return this.tagName === candidate.toUpperCase();
      const attribute = /^\[([A-Za-z_][A-Za-z0-9_.:-]*)(?:="([^"]*)")?\]$/.exec(candidate);
      if (!attribute?.[1]) return false;
      const actual = this.getAttribute(attribute[1]);
      return attribute[2] === undefined ? actual !== null : actual === attribute[2];
    });
  }

  querySelectorAll(selector: string): NodeListOf<Element> {
    const result: FakeElement[] = [];
    const visit = (element: FakeElement): void => {
      for (const child of element.children) {
        if (child.matches(selector)) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result as unknown as NodeListOf<Element>;
  }

  querySelector(selector: string): Element | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  closest(selector: string): Element | null {
    let current: FakeElement | null = this;
    while (current !== null) {
      if (current.matches(selector)) return current as unknown as Element;
      current = current.parentElement;
    }
    return null;
  }

  click(): void {
    this.clickCount += 1;
    this.onClick?.();
  }
}

class FakeRoot {
  constructor(readonly document: FakeDocument) {}
}

class FakeDocument {
  readonly documentElement = new FakeRoot(this);
  readonly body: FakeElement;
  readonly observers = new Set<FakeMutationObserver>();
  readonly defaultView = {
    getComputedStyle: (element: Element): CSSStyleDeclaration =>
      (element as unknown as FakeElement).style as unknown as CSSStyleDeclaration
  };
  private readonly routes = new Map<string, FakeElement[]>();

  constructor() {
    this.body = new FakeElement(this, "body", "整页敏感文本不得读取");
  }

  querySelectorAll(selector: string): NodeListOf<Element> {
    if (selector === "[") throw new Error("synthetic invalid selector detail must not escape");
    return [...(this.routes.get(selector) ?? [])] as unknown as NodeListOf<Element>;
  }

  set(selector: string, elements: FakeElement[], notify = true): void {
    this.routes.set(selector, elements);
    if (notify) this.notifySoon();
  }

  notifySoon(): void {
    queueMicrotask(() => {
      for (const observer of [...this.observers]) observer.notify();
    });
  }
}

class FakeMutationObserver {
  private document: FakeDocument | undefined;

  constructor(private readonly callback: MutationCallback) {}

  observe(target: Node): void {
    const root = target as unknown as FakeRoot;
    this.document = root.document;
    this.document.observers.add(this);
  }

  disconnect(): void {
    this.document?.observers.delete(this);
    this.document = undefined;
  }

  notify(): void {
    this.callback([], this as unknown as MutationObserver);
  }
}

class InProcessPage {
  readonly inputs: unknown[] = [];

  async evaluate(pageFunction: unknown, argument: unknown): Promise<unknown> {
    this.inputs.push(argument);
    if (typeof pageFunction !== "function") throw new Error("expected page function");
    // Playwright does not preserve Node lexical closures. Reconstruct the
    // callback so an accidental module-level dependency fails this test.
    const reconstructed = Function(`"use strict"; return (${pageFunction.toString()});`)() as
      (value: unknown) => unknown;
    return reconstructed(argument);
  }

  asPage(): Pick<Page, "evaluate"> {
    return this as unknown as Pick<Page, "evaluate">;
  }
}

class DelayedFirstEvaluatePage extends InProcessPage {
  private calls = 0;

  override async evaluate(pageFunction: unknown, argument: unknown): Promise<unknown> {
    this.calls += 1;
    if (this.calls === 1) await new Promise<void>((resolve) => setTimeout(resolve, 20));
    return super.evaluate(pageFunction, argument);
  }
}

class FakeLocation {
  href = "https://selection.test/buy?itemId=event-1";

  get origin(): string {
    return new URL(this.href).origin;
  }
}

function restoreProperty(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[name];
  else Object.defineProperty(globalThis, name, descriptor);
}

async function withFakeDom(
  run: (document: FakeDocument, location: FakeLocation, page: InProcessPage) => Promise<void>,
  page: InProcessPage = new InProcessPage()
): Promise<void> {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const observerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "MutationObserver");
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  const registryDescriptor = Object.getOwnPropertyDescriptor(globalThis, "__ticketAgentSelectionMachines_v1");
  const document = new FakeDocument();
  const location = new FakeLocation();
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  Object.defineProperty(globalThis, "MutationObserver", { configurable: true, value: FakeMutationObserver });
  Object.defineProperty(globalThis, "location", { configurable: true, value: location });
  try {
    await run(document, location, page);
  } finally {
    restoreProperty("document", documentDescriptor);
    restoreProperty("MutationObserver", observerDescriptor);
    restoreProperty("location", locationDescriptor);
    restoreProperty("__ticketAgentSelectionMachines_v1", registryDescriptor);
  }
}

const SELECTORS = {
  eventTitle: "[data-contract-event-title]",
  eventId: "[data-contract-event-id]",
  session: "[data-contract-session]",
  sessionSummary: "[data-contract-session-summary]",
  tier: "[data-contract-tier]",
  tierSummary: "[data-contract-tier-summary]",
  quantity: "[data-contract-quantity]",
  quantitySummary: "[data-contract-quantity-summary]",
  attendee: "[data-contract-attendee]",
  total: "[data-contract-total]",
  adjacency: "[data-contract-adjacent]",
  label: "[data-choice-label]",
  price: "[data-price-text]",
  selected: '[data-selected="true"]',
  submit: '[data-testid="submit-order"]',
  sink: '[data-ticket-agent-test-sink="browser-selection-v1"]'
} as const;

const BLOCKERS = [
  { key: "captcha-visible", selector: "[data-block-captcha]" },
  { key: "login-required-visible", selector: "[data-block-login]" },
  { key: "sold-out-visible", selector: "[data-block-sold-out]" },
  { key: "official-queue-visible", selector: "[data-block-queue]" }
] as const;

function choiceContract(optionSelector: string, withPrice = false) {
  return {
    optionSelector,
    labelSelector: SELECTORS.label,
    labelAttribute: "data-visible-label",
    selectedSelector: SELECTORS.selected,
    ...(withPrice
      ? { priceTextSelector: SELECTORS.price, priceFenAttribute: "data-price-fen" }
      : {})
  };
}

const contract: BrowserSelectionContract = {
  platform: "damai",
  allowedOrigins: ["https://selection.test"],
  blockingPredicates: BLOCKERS,
  eventTitleSelector: SELECTORS.eventTitle,
  eventIdSelector: SELECTORS.eventId,
  eventIdAttribute: "data-event-id",
  session: choiceContract(SELECTORS.session),
  sessionSummarySelector: SELECTORS.sessionSummary,
  tier: choiceContract(SELECTORS.tier, true),
  tierSummarySelector: SELECTORS.tierSummary,
  quantity: {
    summarySelector: SELECTORS.quantitySummary,
    option: choiceContract(SELECTORS.quantity)
  },
  attendee: choiceContract(SELECTORS.attendee),
  adjacencySelector: SELECTORS.adjacency,
  totalSelector: SELECTORS.total,
  totalFenAttribute: "data-order-total-fen",
  forbiddenActionSelectors: [SELECTORS.submit]
};

const plan: BrowserSelectionPlan = {
  eventId: "event-1",
  eventTitle: "合成测试演出",
  sessionLabels: ["周六晚场"],
  tierPreferences: [
    { label: "VIP", maxUnitPriceFen: 10_000 },
    { label: "看台", maxUnitPriceFen: 6_000 }
  ],
  quantity: 1,
  attendeeLabels: ["本地合成观演人-A"],
  maxTotalFen: 6_000,
  requireAdjacent: false
};

function label(document: FakeDocument, value: string): FakeElement {
  return new FakeElement(document, "span", value, { "data-choice-label": "" });
}

function choice(
  document: FakeDocument,
  selectorAttribute: string,
  value: string,
  selected = false
): FakeElement {
  return new FakeElement(document, "button", value, {
    [selectorAttribute]: "",
    "data-visible-label": value,
    "data-selected": String(selected),
    type: "button"
  }).append(label(document, value));
}

function tier(document: FakeDocument, value: string, priceFen: number, selected = false): FakeElement {
  const option = choice(document, "data-contract-tier", value, selected);
  option.attributes.set("data-price-fen", String(priceFen));
  return option.append(
    new FakeElement(document, "span", `¥${(priceFen / 100).toFixed(2)}`, { "data-price-text": "" })
  );
}

interface Fixture {
  session: FakeElement;
  vip: FakeElement;
  stand: FakeElement;
  quantity: FakeElement;
  attendee: FakeElement;
  total: FakeElement;
  sink: FakeElement;
  realSubmit: FakeElement;
  sessionSummary: FakeElement;
  tierSummary: FakeElement;
}

function installFixture(document: FakeDocument, options: { sessionInitiallyVisible?: boolean; sinkConfirms?: boolean } = {}): Fixture {
  const eventTitle = new FakeElement(document, "h1", plan.eventTitle, { "data-contract-event-title": "" });
  const eventId = new FakeElement(document, "main", "公开活动容器", {
    "data-contract-event-id": "",
    "data-event-id": plan.eventId
  });
  const sessionSummary = new FakeElement(document, "output", "", { "data-contract-session-summary": "" });
  const tierSummary = new FakeElement(document, "output", "", { "data-contract-tier-summary": "" });
  const quantitySummary = new FakeElement(document, "output", "", { "data-contract-quantity-summary": "" });
  const session = choice(document, "data-contract-session", plan.sessionLabels[0]!, false);
  const vip = tier(document, "VIP", 12_000, false);
  const stand = tier(document, "看台", 5_800, false);
  const quantity = choice(document, "data-contract-quantity", "1", false);
  const attendee = choice(document, "data-contract-attendee", plan.attendeeLabels[0]!, false);
  const total = new FakeElement(document, "strong", "¥58.00", {
    "data-contract-total": "",
    "data-order-total-fen": "5800"
  });
  const sink = new FakeElement(document, "button", "本地假点击", {
    "data-ticket-agent-test-sink": "browser-selection-v1",
    "data-ticket-agent-test-click-count": "0",
    type: "button"
  });
  const realSubmit = new FakeElement(document, "button", "真实提交控件不可触碰", {
    "data-testid": "submit-order",
    type: "button"
  });

  session.onClick = () => {
    session.setAttribute("data-selected", "true");
    sessionSummary.innerText = plan.sessionLabels[0]!;
    document.notifySoon();
  };
  stand.onClick = () => {
    vip.setAttribute("data-selected", "false");
    stand.setAttribute("data-selected", "true");
    tierSummary.innerText = "看台";
    document.notifySoon();
  };
  vip.onClick = () => {
    vip.setAttribute("data-selected", "true");
    stand.setAttribute("data-selected", "false");
    tierSummary.innerText = "VIP";
    document.notifySoon();
  };
  quantity.onClick = () => {
    quantity.setAttribute("data-selected", "true");
    quantitySummary.innerText = "1张";
    document.notifySoon();
  };
  attendee.onClick = () => attendee.setAttribute("data-selected", "true");
  sink.onClick = options.sinkConfirms === false
    ? () => document.notifySoon()
    : () => sink.setAttribute("data-ticket-agent-test-click-count", "1");

  document.set(SELECTORS.eventTitle, [eventTitle], false);
  document.set(SELECTORS.eventId, [eventId], false);
  document.set(SELECTORS.session, options.sessionInitiallyVisible === false ? [] : [session], false);
  document.set(SELECTORS.sessionSummary, [sessionSummary], false);
  document.set(SELECTORS.tier, [vip, stand], false);
  document.set(SELECTORS.tierSummary, [tierSummary], false);
  document.set(SELECTORS.quantity, [quantity], false);
  document.set(SELECTORS.quantitySummary, [quantitySummary], false);
  document.set(SELECTORS.attendee, [attendee], false);
  document.set(SELECTORS.total, [total], false);
  document.set(SELECTORS.adjacency, [], false);
  document.set(SELECTORS.sink, [sink], false);
  document.set(SELECTORS.submit, [realSubmit], false);
  for (const blocker of BLOCKERS) document.set(blocker.selector, [], false);
  return { session, vip, stand, quantity, attendee, total, sink, realSubmit, sessionSummary, tierSummary };
}

test("one serialized page task waits, selects first permitted tier, verifies, and clicks only the fake sink", async () => {
  await withFakeDom(async (document, _location, page) => {
    const fixture = installFixture(document, { sessionInitiallyVisible: false });
    const running = runBrowserSelectionStateMachine(page.asPage(), {
      contract,
      plan,
      timeoutMs: 1_000,
      fallbackIntervalMs: 20,
      testOnlyFakeSubmit: true
    });
    setTimeout(() => document.set(SELECTORS.session, [fixture.session]), 15);

    const result = await running;
    assert.equal(result.outcome, "test-clicked", JSON.stringify(result));
    if (result.outcome !== "test-clicked") return;
    assert.equal(result.selectedSession, "周六晚场");
    assert.equal(result.selectedTier, "看台");
    assert.equal(result.selectedTierUnitPriceFen, 5_800);
    assert.equal(result.observedTotalFen, 5_800);
    assert.equal(result.quantity, 1);
    assert.equal(result.attendeeCount, 1);
    assert.equal(result.fakeClickCount, 1);
    assert.equal(result.reversibleActionCount, 4);
    assert.equal(page.inputs.length, 1, "normal hot path must cross one page.evaluate boundary");
    assert.equal(fixture.vip.clickCount, 0, "over-budget first preference must be skipped");
    assert.equal(fixture.stand.clickCount, 1);
    assert.equal(fixture.sink.clickCount, 1);
    assert.equal(fixture.realSubmit.clickCount, 0);
    assert.equal(document.observers.size, 0);
    assert.doesNotMatch(JSON.stringify(result), /本地合成观演人/);
  });
});

test("immediate abort leaves a pre-registration state-machine task cancelled", async () => {
  const page = new DelayedFirstEvaluatePage();
  await withFakeDom(async (document, _location, runningPage) => {
    installFixture(document, { sessionInitiallyVisible: false });
    const controller = new AbortController();
    const waiting = runBrowserSelectionStateMachine(runningPage.asPage(), {
      contract,
      plan,
      timeoutMs: 1_000,
      testOnlyFakeSubmit: true,
      signal: controller.signal
    });
    controller.abort();
    const result = await waiting;
    assert.equal(result.outcome, "aborted", JSON.stringify(result));
    assert.equal(result.reversibleActionCount, 0);
    assert.equal(result.fakeClickCount, 0);
    assert.equal(document.observers.size, 0);
    assert.equal(page.inputs.length, 2);
  }, page);
});

test("resident timeout covers T-10 through the bounded post-sale capability window", async () => {
  const controller = new AbortController();
  controller.abort();
  const accepted = await runBrowserSelectionStateMachine(new InProcessPage().asPage(), {
    contract,
    plan,
    timeoutMs: MAX_SELECTION_RESIDENCY_MS,
    testOnlyFakeSubmit: true,
    signal: controller.signal
  });
  assert.equal(accepted.outcome, "aborted");
  await assert.rejects(
    () => runBrowserSelectionStateMachine(new InProcessPage().asPage(), {
      contract,
      plan,
      timeoutMs: MAX_SELECTION_RESIDENCY_MS + 1,
      testOnlyFakeSubmit: true
    }),
    /SELECTION_TIMEOUT_INVALID/
  );
});

test("test-only fake mode accepts an explicit ephemeral HTTP loopback origin", async () => {
  await withFakeDom(async (document, location, page) => {
    const fixture = installFixture(document);
    location.href = "http://127.0.0.1:43127/selection";
    const loopbackContract: BrowserSelectionContract = {
      ...contract,
      allowedOrigins: ["http://127.0.0.1:43127"]
    };
    const result = await runBrowserSelectionStateMachine(page.asPage(), {
      contract: loopbackContract,
      plan,
      timeoutMs: 500,
      testOnlyFakeSubmit: true
    });
    assert.equal(result.outcome, "test-clicked", JSON.stringify(result));
    assert.equal(fixture.sink.clickCount, 1);
    assert.equal(page.inputs.length, 1);
  });
});

test("the serialized browser callback has no full-body text scan or Node closure dependency", async () => {
  const source = browserSelectionTask.toString();
  assert.doesNotMatch(source, /document\s*\.\s*body\s*\.\s*innerText/);
  assert.doesNotMatch(source, /textOf\s*\(\s*document\s*\.\s*body/);
  await withFakeDom(async (document, location, page) => {
    installFixture(document);
    location.href = "https://detail.damai.cn/buy?itemId=event-1";
    const officialContract: BrowserSelectionContract = {
      ...contract,
      allowedOrigins: ["https://detail.damai.cn"]
    };
    const result = await runBrowserSelectionStateMachine(page.asPage(), {
      contract: officialContract,
      plan,
      timeoutMs: 1_000
    });
    assert.equal(result.outcome, "ready", JSON.stringify(result));
    assert.equal(page.inputs.length, 1);
  });
});

test("a misconfigured evidence selector resolving to body is blocked before any whole-page text is returned", async () => {
  await withFakeDom(async (document, _location, page) => {
    const fixture = installFixture(document);
    document.body.innerText = `${plan.eventTitle} 整页敏感文本不得返回`;
    document.set(SELECTORS.eventTitle, [document.body], false);
    const result = await runBrowserSelectionStateMachine(page.asPage(), {
      contract,
      plan,
      timeoutMs: 500,
      testOnlyFakeSubmit: true
    });
    assert.equal(result.outcome, "blocked");
    if (result.outcome !== "blocked") return;
    assert.equal(result.reason, "PAGE_CONTEXT_INVALID");
    assert.equal(result.reversibleActionCount, 0);
    assert.equal(fixture.sink.clickCount, 0);
    assert.doesNotMatch(JSON.stringify(result), /整页敏感文本/);
  });
});

test("immutable native denylist rejects a submit-type option even with a useless contract denylist", async () => {
  await withFakeDom(async (document, _location, page) => {
    const fixture = installFixture(document);
    fixture.session.attributes.set("type", "submit");
    const weakContract: BrowserSelectionContract = {
      ...contract,
      forbiddenActionSelectors: ["[data-never-forbidden]"]
    };
    const result = await runBrowserSelectionStateMachine(page.asPage(), {
      contract: weakContract,
      plan,
      timeoutMs: 500,
      testOnlyFakeSubmit: true
    });
    assert.equal(result.outcome, "blocked", JSON.stringify(result));
    if (result.outcome !== "blocked") return;
    assert.equal(result.reason, "REVERSIBLE_ACTION_FAILED");
    assert.equal(result.reversibleActionCount, 0);
    assert.equal(fixture.session.clickCount, 0);
    assert.equal(fixture.realSubmit.clickCount, 0);
    assert.equal(fixture.sink.clickCount, 0);
  });
});

for (const blocker of BLOCKERS) {
  test(`blocks ${blocker.key} before any reversible or fake click`, async () => {
    await withFakeDom(async (document, _location, page) => {
      const fixture = installFixture(document);
      document.set(blocker.selector, [new FakeElement(document, "div", "sensitive blocker body")], false);
      const result = await runBrowserSelectionStateMachine(page.asPage(), {
        contract,
        plan,
        timeoutMs: 500,
        testOnlyFakeSubmit: true
      });
      assert.equal(result.outcome, "blocked");
      if (result.outcome !== "blocked") return;
      assert.equal(result.reason, "BLOCKING_STATE_VISIBLE");
      assert.equal(result.blockingKey, blocker.key);
      assert.equal(result.reversibleActionCount, 0);
      assert.equal(result.fakeClickCount, 0);
      assert.equal(fixture.sink.clickCount, 0);
      assert.doesNotMatch(JSON.stringify(result), /sensitive blocker body/);
    });
  });
}

test("queue-resident mode waits for the official queue to clear in the same page task", async () => {
  await withFakeDom(async (document, _location, page) => {
    const fixture = installFixture(document);
    const queue = new FakeElement(document, "div", "官方排队中");
    document.set("[data-block-queue]", [queue], false);
    const running = runBrowserSelectionStateMachine(page.asPage(), {
      contract,
      plan,
      timeoutMs: 500,
      fallbackIntervalMs: 20,
      waitInOfficialQueue: true,
      testOnlyFakeSubmit: true
    });

    assert.equal(fixture.session.clickCount, 0);
    assert.equal(fixture.sink.clickCount, 0);
    setTimeout(() => document.set("[data-block-queue]", []), 15);

    const result = await running;
    assert.equal(result.outcome, "test-clicked", JSON.stringify(result));
    assert.equal(page.inputs.length, 1, "queue exit must not reinstall the browser task");
    assert.equal(fixture.sink.clickCount, 1);
  });
});

test("queue-resident mode never masks a captcha blocker", async () => {
  await withFakeDom(async (document, _location, page) => {
    const fixture = installFixture(document);
    document.set("[data-block-queue]", [new FakeElement(document, "div", "官方排队中")], false);
    document.set("[data-block-captcha]", [new FakeElement(document, "div", "人工验证")], false);
    const result = await runBrowserSelectionStateMachine(page.asPage(), {
      contract,
      plan,
      timeoutMs: 500,
      waitInOfficialQueue: true,
      testOnlyFakeSubmit: true
    });
    assert.equal(result.outcome, "blocked", JSON.stringify(result));
    if (result.outcome !== "blocked") return;
    assert.equal(result.reason, "BLOCKING_STATE_VISIBLE");
    assert.equal(result.blockingKey, "captcha-visible");
    assert.equal(fixture.session.clickCount, 0);
    assert.equal(fixture.sink.clickCount, 0);
  });
});

test("missing event evidence waits without action and resumes when the bound event appears", async () => {
  await withFakeDom(async (document, _location, page) => {
    const fixture = installFixture(document);
    document.set(SELECTORS.eventTitle, [], false);
    document.set(SELECTORS.eventId, [], false);
    const running = runBrowserSelectionStateMachine(page.asPage(), {
      contract,
      plan,
      timeoutMs: 500,
      fallbackIntervalMs: 20,
      testOnlyFakeSubmit: true
    });

    assert.equal(fixture.session.clickCount, 0);
    assert.equal(fixture.sink.clickCount, 0);
    setTimeout(() => {
      document.set(
        SELECTORS.eventTitle,
        [new FakeElement(document, "h1", plan.eventTitle, { "data-contract-event-title": "" })],
        false
      );
      document.set(
        SELECTORS.eventId,
        [new FakeElement(document, "main", "公开活动容器", {
          "data-contract-event-id": "",
          "data-event-id": plan.eventId
        })]
      );
    }, 15);

    const result = await running;
    assert.equal(result.outcome, "test-clicked", JSON.stringify(result));
    assert.equal(page.inputs.length, 1, "event hydration must not reinstall the browser task");
    assert.equal(fixture.sink.clickCount, 1);
  });
});

test("ambiguous total evidence blocks the final fake click", async () => {
  await withFakeDom(async (document, _location, page) => {
    const fixture = installFixture(document);
    const duplicate = new FakeElement(document, "strong", "¥58.00", {
      "data-order-total-fen": "5800"
    });
    document.set(SELECTORS.total, [fixture.total, duplicate], false);
    const result = await runBrowserSelectionStateMachine(page.asPage(), {
      contract,
      plan,
      timeoutMs: 500,
      testOnlyFakeSubmit: true
    });
    assert.equal(result.outcome, "blocked");
    if (result.outcome !== "blocked") return;
    assert.equal(result.reason, "TOTAL_EVIDENCE_INVALID");
    assert.equal(fixture.sink.clickCount, 0);
    assert.equal(result.fakeClickCount, 0);
  });
});

test("a visible total above the maximum blocks the final fake click", async () => {
  await withFakeDom(async (document, _location, page) => {
    const fixture = installFixture(document);
    fixture.total.innerText = "¥60.01";
    fixture.total.attributes.set("data-order-total-fen", "6001");
    const result = await runBrowserSelectionStateMachine(page.asPage(), {
      contract,
      plan,
      timeoutMs: 500,
      testOnlyFakeSubmit: true
    });
    assert.equal(result.outcome, "blocked");
    if (result.outcome !== "blocked") return;
    assert.equal(result.reason, "PRICE_LIMIT_EXCEEDED");
    assert.equal(fixture.sink.clickCount, 0);
  });
});

test("unexpected selected attendee blocks without changing attendee choices", async () => {
  await withFakeDom(async (document, _location, page) => {
    const fixture = installFixture(document);
    const unexpected = choice(document, "data-contract-attendee", "未批准观演人", true);
    document.set(SELECTORS.attendee, [fixture.attendee, unexpected], false);
    const result = await runBrowserSelectionStateMachine(page.asPage(), {
      contract,
      plan,
      timeoutMs: 500,
      testOnlyFakeSubmit: true
    });
    assert.equal(result.outcome, "blocked");
    if (result.outcome !== "blocked") return;
    assert.equal(result.reason, "UNEXPECTED_ATTENDEE_SELECTED");
    assert.equal(fixture.attendee.clickCount, 0);
    assert.equal(unexpected.clickCount, 0);
    assert.equal(fixture.sink.clickCount, 0);
  });
});

test("navigation during a reversible click stops the task and never retries the click", async () => {
  await withFakeDom(async (document, location, page) => {
    const fixture = installFixture(document);
    fixture.session.onClick = () => {
      location.href = "https://changed.test/unknown";
      document.notifySoon();
    };
    const result = await runBrowserSelectionStateMachine(page.asPage(), {
      contract,
      plan,
      timeoutMs: 500,
      testOnlyFakeSubmit: true
    });
    assert.equal(result.outcome, "blocked");
    if (result.outcome !== "blocked") return;
    assert.equal(result.reason, "PAGE_ORIGIN_CHANGED");
    assert.equal(fixture.session.clickCount, 1);
    assert.equal(fixture.stand.clickCount, 0);
    assert.equal(fixture.sink.clickCount, 0);
  });
});

test("replacement of a clicked option is uncertain and never causes a click on the replacement", async () => {
  await withFakeDom(async (document, _location, page) => {
    const fixture = installFixture(document);
    const replacement = choice(document, "data-contract-session", plan.sessionLabels[0]!, false);
    fixture.session.onClick = () => document.set(SELECTORS.session, [replacement]);
    const result = await runBrowserSelectionStateMachine(page.asPage(), {
      contract,
      plan,
      timeoutMs: 500,
      testOnlyFakeSubmit: true
    });
    assert.equal(result.outcome, "blocked");
    if (result.outcome !== "blocked") return;
    assert.equal(result.reason, "SELECTION_TARGET_CHANGED_AFTER_CLICK");
    assert.equal(fixture.session.clickCount, 1);
    assert.equal(replacement.clickCount, 0);
    assert.equal(fixture.stand.clickCount, 0);
    assert.equal(fixture.sink.clickCount, 0);
  });
});

test("final verification rejects a different selected quantity even when the summary is stale", async () => {
  await withFakeDom(async (document, _location, page) => {
    const fixture = installFixture(document);
    const wrongQuantity = choice(document, "data-contract-quantity", "2", false);
    document.set(SELECTORS.quantity, [fixture.quantity, wrongQuantity], false);
    fixture.attendee.onClick = () => {
      fixture.attendee.setAttribute("data-selected", "true");
      fixture.quantity.setAttribute("data-selected", "false");
      wrongQuantity.setAttribute("data-selected", "true");
    };
    const result = await runBrowserSelectionStateMachine(page.asPage(), {
      contract,
      plan,
      timeoutMs: 500,
      testOnlyFakeSubmit: true
    });
    assert.equal(result.outcome, "blocked");
    if (result.outcome !== "blocked") return;
    assert.equal(result.reason, "QUANTITY_EVIDENCE_INVALID");
    assert.equal(fixture.quantity.clickCount, 1);
    assert.equal(wrongQuantity.clickCount, 0);
    assert.equal(fixture.sink.clickCount, 0);
  });
});

test("final verification rereads the selected tier price and reapplies unit and total limits", async () => {
  await withFakeDom(async (document, _location, page) => {
    const fixture = installFixture(document);
    const visiblePrice = fixture.stand.children[1]!;
    fixture.attendee.onClick = () => {
      fixture.attendee.setAttribute("data-selected", "true");
      fixture.stand.setAttribute("data-price-fen", "6100");
      visiblePrice.innerText = "¥61.00";
      document.notifySoon();
    };
    const result = await runBrowserSelectionStateMachine(page.asPage(), {
      contract,
      plan,
      timeoutMs: 500,
      testOnlyFakeSubmit: true
    });
    assert.equal(result.outcome, "blocked");
    if (result.outcome !== "blocked") return;
    assert.equal(result.reason, "PRICE_LIMIT_EXCEEDED");
    assert.equal(fixture.stand.clickCount, 1);
    assert.equal(fixture.sink.clickCount, 0);
  });
});

test("ambiguous event evidence blocks before every selection and fake click", async () => {
  await withFakeDom(async (document, _location, page) => {
    const fixture = installFixture(document);
    const duplicateTitle = new FakeElement(document, "h1", plan.eventTitle, { "data-contract-event-title": "" });
    const originalTitle = new FakeElement(document, "h1", plan.eventTitle, { "data-contract-event-title": "" });
    document.set(SELECTORS.eventTitle, [originalTitle, duplicateTitle], false);
    const result = await runBrowserSelectionStateMachine(page.asPage(), {
      contract,
      plan,
      timeoutMs: 500,
      testOnlyFakeSubmit: true
    });
    assert.equal(result.outcome, "blocked");
    if (result.outcome !== "blocked") return;
    assert.equal(result.reason, "EVENT_EVIDENCE_AMBIGUOUS");
    assert.equal(result.reversibleActionCount, 0);
    assert.equal(fixture.sink.clickCount, 0);
  });
});

test("unknown fake-click outcome is reported after exactly one click and is never retried", async () => {
  await withFakeDom(async (document, _location, page) => {
    const fixture = installFixture(document, { sinkConfirms: false });
    const result = await runBrowserSelectionStateMachine(page.asPage(), {
      contract,
      plan,
      timeoutMs: 500,
      testOnlyFakeSubmit: true
    });
    assert.equal(result.outcome, "blocked");
    if (result.outcome !== "blocked") return;
    assert.equal(result.reason, "FAKE_SINK_CLICK_OUTCOME_UNKNOWN");
    assert.equal(result.fakeClickCount, 1);
    assert.equal(fixture.sink.clickCount, 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fixture.sink.clickCount, 1);
  });
});

test("invalid selector and production-origin fake mode fail closed", async () => {
  await withFakeDom(async (document, _location, page) => {
    installFixture(document);
    const invalidContract: BrowserSelectionContract = { ...contract, eventTitleSelector: "[" };
    const invalid = await runBrowserSelectionStateMachine(page.asPage(), {
      contract: invalidContract,
      plan,
      timeoutMs: 500,
      testOnlyFakeSubmit: true
    });
    assert.equal(invalid.outcome, "blocked");
    if (invalid.outcome === "blocked") assert.equal(invalid.reason, "CONTRACT_SELECTOR_INVALID");
  });

  const productionContract: BrowserSelectionContract = {
    ...contract,
    allowedOrigins: ["https://trade.damai.cn"]
  };
  await assert.rejects(
    () => runBrowserSelectionStateMachine({ evaluate: async () => undefined } as unknown as Pick<Page, "evaluate">, {
      contract: productionContract,
      plan,
      timeoutMs: 500,
      testOnlyFakeSubmit: true
    }),
    /SELECTION_FAKE_SUBMIT_ORIGIN_BLOCKED/
  );

  for (const allowedOrigins of [
    ["https://evil.example"],
    ["https://damai.cn.evil.example"],
    ["https://detail.maoyan.com"]
  ]) {
    await assert.rejects(
      () => runBrowserSelectionStateMachine({ evaluate: async () => undefined } as unknown as Pick<Page, "evaluate">, {
        contract: { ...contract, allowedOrigins },
        plan,
        timeoutMs: 500
      }),
      /SELECTION_PLATFORM_ORIGIN_BLOCKED/
    );
  }

  for (const allowedOrigins of [
    ["http://127.0.0.1"],
    ["https://127.0.0.1"],
    ["http://selection.test:4173"]
  ]) {
    await assert.rejects(
      () => runBrowserSelectionStateMachine({ evaluate: async () => undefined } as unknown as Pick<Page, "evaluate">, {
        contract: { ...contract, allowedOrigins },
        plan,
        timeoutMs: 500,
        testOnlyFakeSubmit: true
      }),
      /SELECTION_FAKE_SUBMIT_ORIGIN_BLOCKED/
    );
  }

  await assert.rejects(
    () => runBrowserSelectionStateMachine({ evaluate: async () => undefined } as unknown as Pick<Page, "evaluate">, {
      contract: { ...contract, allowedOrigins: ["http://detail.damai.cn:443"] },
      plan,
      timeoutMs: 500
    }),
    /SELECTION_PLATFORM_ORIGIN_BLOCKED/
  );
});
