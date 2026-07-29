import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";

import type { Page } from "playwright-core";

import { DamaiAdapter } from "../src/adapters/damai.js";
import { collectPageSignals, extractFen, guardPage } from "../src/adapters/signals.js";
import type { PageSignals } from "../src/adapters/types.js";
import type { WatchPlan } from "../src/core/types.js";
import { createMockServer } from "../mock/server.js";

interface FakeElement {
  text: string;
  tag: string;
  visible: boolean;
  disabled: boolean;
  checked: boolean;
  value: string;
  attrs: Map<string, string>;
  children: FakeElement[];
  options: string[];
  onClick?: () => void;
  onChange?: (value: string) => void;
}

function element(overrides: Partial<FakeElement> = {}): FakeElement {
  return {
    text: "",
    tag: "button",
    visible: true,
    disabled: false,
    checked: false,
    value: "",
    attrs: new Map(),
    children: [],
    options: [],
    ...overrides
  };
}

function attrs(values: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(values));
}

class FakeLocator {
  constructor(private readonly nodes: FakeElement[]) {}

  async count(): Promise<number> { return this.nodes.length; }
  nth(index: number): FakeLocator { return new FakeLocator(this.nodes[index] ? [this.nodes[index]!] : []); }
  first(): FakeLocator { return this.nth(0); }
  async isVisible(): Promise<boolean> { return this.nodes[0]?.visible ?? false; }
  async isDisabled(): Promise<boolean> { return this.nodes[0]?.disabled ?? false; }
  async innerText(): Promise<string> { return this.nodes[0]?.text ?? ""; }
  async getAttribute(name: string): Promise<string | null> { return this.nodes[0]?.attrs.get(name) ?? null; }
  async isChecked(): Promise<boolean> {
    const node = this.nodes[0];
    return node?.tag === "input" && (node.attrs.get("type") === "checkbox" || node.attrs.get("type") === "radio")
      ? node.checked
      : false;
  }
  locator(selector: string): FakeLocator {
    if (selector !== 'input[type="checkbox"], input[type="radio"]' && selector !== 'input[type="radio"]') {
      return new FakeLocator([]);
    }
    const accepted = selector === 'input[type="radio"]' ? new Set(["radio"]) : new Set(["checkbox", "radio"]);
    return new FakeLocator(
      this.nodes.flatMap((node) => node.children.filter((child) => child.tag === "input" && accepted.has(child.attrs.get("type") ?? "")))
    );
  }
  async click(): Promise<void> {
    const node = this.nodes[0];
    if (!node || node.disabled) throw new Error("not clickable");
    if (node.onClick) node.onClick();
    else if (node.tag === "input") node.checked = !node.checked;
  }
  async evaluate<T>(fn: (node: { tagName: string }) => T): Promise<T> {
    const node = this.nodes[0];
    if (!node) throw new Error("missing node");
    return fn({ tagName: node.tag.toUpperCase() });
  }
  async selectOption(value: string): Promise<string[]> {
    const node = this.nodes[0];
    if (!node || !node.options.includes(value)) return [];
    node.value = value;
    node.onChange?.(value);
    return [value];
  }
  async fill(value: string): Promise<void> {
    const node = this.nodes[0];
    if (!node) throw new Error("missing node");
    node.value = value;
    node.onChange?.(value);
  }
  async inputValue(): Promise<string> { return this.nodes[0]?.value ?? ""; }
  async waitFor(): Promise<void> {}
}

class FakePage {
  readonly routes = new Map<string, FakeElement[]>();
  body = element({ tag: "body", text: "测试活动" });
  captchaMarkers: FakeElement[] = [];
  currentUrl = "http://127.0.0.1:4173/damai/normal";
  currentTitle = "测试活动";

  locator(selector: string): FakeLocator {
    if (selector === "body") return new FakeLocator([this.body]);
    if (selector.includes(".cf-turnstile") && this.captchaMarkers.length > 0) {
      return new FakeLocator(this.captchaMarkers);
    }
    return new FakeLocator(this.routes.get(selector) ?? []);
  }
  url(): string { return this.currentUrl; }
  async title(): Promise<string> { return this.currentTitle; }
  asPage(): Page { return this as unknown as Page; }
}

class AtomicElement {
  ownerDocument!: AtomicDocument;
  parentElement: AtomicElement | null = null;
  readonly children: AtomicElement[] = [];
  readonly tagName: string;
  readonly attrs: Map<string, string>;
  innerText: string;
  isConnected = true;
  hidden = false;
  disabled = false;
  checked = false;
  value = "";
  clickCount = 0;
  onClick: (() => void) | undefined;

  constructor(tag: string, text = "", attributeValues: Record<string, string> = {}) {
    this.tagName = tag.toUpperCase();
    this.innerText = text;
    this.attrs = attrs(attributeValues);
  }

  append(child: AtomicElement): void {
    child.parentElement = this;
    child.ownerDocument = this.ownerDocument;
    this.children.push(child);
  }

  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  hasAttribute(name: string): boolean { return this.attrs.has(name); }
  getClientRects(): object[] { return this.isConnected && !this.hidden ? [{}] : []; }
  matches(selector: string): boolean {
    if (selector === "input") return this.tagName === "INPUT";
    if (selector === 'input[type="checkbox"], input[type="radio"]') {
      return this.tagName === "INPUT" && ["checkbox", "radio"].includes(this.getAttribute("type") ?? "");
    }
    return false;
  }
  querySelectorAll(selector: string): AtomicElement[] {
    const descendants = this.children.flatMap((child) => [child, ...child.querySelectorAll(selector)]);
    if (selector === 'input[type="checkbox"], input[type="radio"]') {
      return descendants.filter((element) => element.matches(selector));
    }
    return [];
  }
  closest(selector: string): AtomicElement | null {
    if (selector !== "label") return null;
    let current: AtomicElement | null = this;
    while (current) {
      if (current.tagName === "LABEL") return current;
      current = current.parentElement;
    }
    return null;
  }
  click(): void {
    this.clickCount += 1;
    this.onClick?.();
  }
}

class AtomicDocument {
  readonly body: AtomicElement;
  readonly routes = new Map<string, AtomicElement[]>();
  readonly defaultView: {
    location: { href: string };
    getComputedStyle: (_element: unknown) => { display: string; visibility: string; opacity: string };
  };

  constructor(url: string) {
    this.body = new AtomicElement("body");
    this.body.ownerDocument = this;
    this.defaultView = {
      location: { href: url },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" })
    };
  }

  set(selector: string, nodes: AtomicElement[]): void {
    for (const node of nodes) node.ownerDocument = this;
    this.routes.set(selector, nodes);
  }

  querySelectorAll(selector: string): AtomicElement[] { return this.routes.get(selector) ?? []; }
}

class AtomicPage {
  beforeEvaluate: (() => void) | undefined;
  evaluateCount = 0;

  constructor(readonly document: AtomicDocument) {}

  locator(selector: string): AtomicLocator {
    return new AtomicLocator(this, selector === "body" ? [this.document.body] : this.document.querySelectorAll(selector));
  }

  url(): string { return this.document.defaultView.location.href; }
  async title(): Promise<string> {
    return this.document.querySelectorAll('[data-testid="event-title"]')[0]?.innerText ?? "";
  }

  asPage(): Page { return this as unknown as Page; }
}

class AtomicLocator {
  constructor(private readonly page: AtomicPage, private readonly nodes: AtomicElement[]) {}

  async count(): Promise<number> { return this.nodes.length; }
  nth(index: number): AtomicLocator { return new AtomicLocator(this.page, this.nodes[index] ? [this.nodes[index]!] : []); }
  first(): AtomicLocator { return this.nth(0); }
  async isVisible(): Promise<boolean> {
    const node = this.nodes[0];
    return node !== undefined && node.isConnected && !node.hidden;
  }
  async innerText(): Promise<string> { return this.nodes[0]?.innerText ?? ""; }
  async getAttribute(name: string): Promise<string | null> { return this.nodes[0]?.getAttribute(name) ?? null; }
  async waitFor(): Promise<void> {
    if (!(await this.isVisible())) throw new Error("not visible");
  }
  async evaluate<Result, Argument>(
    fn: (body: AtomicElement, argument: Argument) => Result,
    argument: Argument
  ): Promise<Result> {
    const body = this.nodes[0];
    if (body !== this.page.document.body) throw new Error("Atomic evaluate requires the current body");
    this.page.evaluateCount += 1;
    this.page.beforeEvaluate?.();
    return fn(body, argument);
  }
}

function atomicFixture(): {
  page: AtomicPage;
  eventTitle: AtomicElement;
  total: AtomicElement;
  submit: AtomicElement;
} {
  const document = new AtomicDocument("https://buy.damai.cn/order/confirm?id=123");
  const page = new AtomicPage(document);
  const eventTitle = new AtomicElement("h1", "测试活动");
  const sessionSummary = new AtomicElement("strong", "8月18日 周二 19:30");
  const session = new AtomicElement("button", "8月18日 周二 19:30", {
    "data-session-label": "8月18日 周二 19:30",
    "aria-pressed": "true"
  });
  const tierSummary = new AtomicElement("strong", "高层看台");
  const selectedTier = new AtomicElement("button", "高层看台 ¥380.00", {
    "data-tier-label": "高层看台",
    "data-price-fen": "38000",
    "aria-pressed": "true"
  });
  const quantitySummary = new AtomicElement("strong", "1 张");
  const quantity = new AtomicElement("select");
  quantity.value = "1";
  const attendeeLabel = new AtomicElement("label", "本人（仿真）");
  attendeeLabel.ownerDocument = document;
  const attendee = new AtomicElement("input", "", {
    type: "checkbox",
    "data-attendee-alias": "本人"
  });
  attendee.checked = true;
  attendeeLabel.append(attendee);
  const total = new AtomicElement("strong", "¥380.00", { "data-order-total-fen": "38000" });
  const submit = new AtomicElement("button", "提交订单", { "data-testid": "submit-order" });
  const payment = new AtomicElement("div", "");
  payment.hidden = true;
  submit.onClick = () => {
    payment.hidden = false;
    payment.attrs.set("data-state", "PAY_REQUIRED");
    payment.attrs.set("data-order-reference", "ORDER-ATOMIC-1");
    payment.innerText = "待支付 ORDER-ATOMIC-1";
  };

  document.set('[data-testid="event-title"]', [eventTitle]);
  document.set('[data-testid="selected-session"]', [sessionSummary]);
  document.set('[data-testid="session-option"]', [session]);
  document.set('[data-testid="selected-tier"]', [tierSummary]);
  document.set('[data-testid="tier-option"]', [selectedTier]);
  document.set('[data-testid="selected-quantity"]', [quantitySummary]);
  document.set('[data-testid="quantity"], [data-role="ticket-quantity"]', [quantity]);
  document.set('[data-testid="attendee-option"]', [attendee]);
  document.set('[data-testid="order-total"], [data-order-total-fen]', [total]);
  document.set('[data-testid="submit-order"]', [submit]);
  document.set('[data-testid="order-result"][data-state="PAY_REQUIRED"], [data-payment-required="true"]', [payment]);
  document.set('[data-testid="order-result"][data-state="PAY_REQUIRED"], [data-payment-required="true"], [data-testid="captcha"], [data-testid="login-required"]', [payment]);
  document.set("[data-order-reference]", [payment]);
  return { page, eventTitle, total, submit };
}

function plan(overrides: Partial<WatchPlan> = {}): WatchPlan {
  const now = "2026-07-30T00:00:00.000Z";
  return {
    id: "adapter-plan",
    platform: "damai",
    quantity: 1,
    requireAdjacent: false,
    sessions: [],
    tiers: [],
    priceStrategy: "CHEAPEST_FIRST",
    attendeeAliases: [],
    autoSubmitOrder: false,
    status: "ARMED",
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function tier(label: string, dataPriceFen: string | undefined, visiblePrice = "¥380.00"): FakeElement {
  const values: Record<string, string> = {
    "data-tier-label": label,
    "aria-pressed": "false"
  };
  if (dataPriceFen !== undefined) values["data-price-fen"] = dataPriceFen;
  return element({ text: `${label} ${visiblePrice}`, attrs: attrs(values) });
}

test("currency parsing rejects partial matches with more than two decimals", () => {
  assert.deepEqual(extractFen("合计 ¥380.00"), [38_000]);
  assert.deepEqual(extractFen("合计 ¥380.001"), []);
  assert.deepEqual(extractFen("合计 380.001元"), []);
});

test("order total metadata must be a canonical integer matching one visible amount", async () => {
  for (const [attribute, text, expected] of [
    ["38000", "¥380.00", "unique"],
    ["", "¥0.00", "invalid"],
    ["38000.0", "¥380.00", "invalid"],
    ["038000", "¥380.00", "invalid"],
    ["38000", "¥381.00", "invalid"]
  ] as const) {
    const page = new FakePage();
    page.routes.set('[data-testid="order-total"], [data-order-total-fen]', [
      element({ text, attrs: attrs({ "data-order-total-fen": attribute }) })
    ]);
    const signals = await collectPageSignals(page.asPage());
    assert.equal(signals.price.kind, expected, `${JSON.stringify({ attribute, text })}`);
  }

  const missing = new FakePage();
  missing.routes.set('[data-testid="order-total"], [data-order-total-fen]', [element({ text: "¥380.00" })]);
  assert.equal((await collectPageSignals(missing.asPage())).price.kind, "invalid");
});

test("captcha signals include Chinese/English human checks and a visible Turnstile widget", async () => {
  for (const bodyText of ["请验证您是真人", "Checking if the site connection is secure"]) {
    const page = new FakePage();
    page.body.text = bodyText;
    assert.equal((await collectPageSignals(page.asPage())).captchaRequired, true, bodyText);
  }

  const turnstile = new FakePage();
  turnstile.captchaMarkers = [element({ tag: "iframe" })];
  assert.equal((await collectPageSignals(turnstile.asPage())).captchaRequired, true);
});

test("event title identity is strict and requires the explicit visible event-title signal", () => {
  const baseSignals: PageSignals = {
    url: "https://detail.damai.cn/item.htm?id=123",
    title: "周杰伦演唱会 - 大麦网",
    readable: true,
    captchaRequired: false,
    loginRequired: false,
    soldOut: false,
    inOfficialQueue: false,
    price: { kind: "missing", valuesFen: [] },
    evidence: []
  };
  const titlePlan = plan({ eventTitle: "周杰伦" });

  assert.equal(guardPage({ ...baseSignals, eventTitle: "周杰伦" }, "queue", titlePlan).blocked, false);
  assert.equal(guardPage({ ...baseSignals, eventTitle: "周杰伦模仿秀" }, "queue", titlePlan).state, "PAGE_CHANGED");
  assert.equal(guardPage(baseSignals, "queue", titlePlan).state, "PAGE_CHANGED");

  const idPlan = plan({ eventId: "AB-12" });
  assert.equal(guardPage({ ...baseSignals, eventId: "AB-12" }, "queue", idPlan).blocked, false);
  assert.equal(guardPage({ ...baseSignals, eventId: "AB12" }, "queue", idPlan).state, "PAGE_CHANGED");
  assert.equal(guardPage({ ...baseSignals, eventId: "ab-12" }, "queue", idPlan).state, "PAGE_CHANGED");
});

test("page identity and payment evidence must each be visible and unambiguous", async () => {
  const ambiguousIdentity = new FakePage();
  ambiguousIdentity.currentUrl = "https://detail.damai.cn/item.htm?id=AB12";
  ambiguousIdentity.routes.set("[data-event-id]", [
    element({ visible: false, attrs: attrs({ "data-event-id": "AB-12" }) })
  ]);
  ambiguousIdentity.routes.set('[data-testid="event-title"]', [
    element({ text: "活动甲" }),
    element({ text: "活动乙" })
  ]);
  const identitySignals = await collectPageSignals(ambiguousIdentity.asPage());
  assert.equal(identitySignals.eventId, undefined);
  assert.equal(identitySignals.eventTitle, undefined);

  const paymentSelector = '[data-testid="order-result"][data-state="PAY_REQUIRED"], [data-payment-required="true"]';
  const hiddenFirst = new FakePage();
  hiddenFirst.routes.set(paymentSelector, [
    element({ visible: false, attrs: attrs({ "data-order-reference": "STALE" }) }),
    element({ attrs: attrs({ "data-order-reference": "ORDER-NEW" }) })
  ]);
  const uniquePayment = await collectPageSignals(hiddenFirst.asPage());
  assert.equal(uniquePayment.paymentRequired, true);
  assert.equal(uniquePayment.orderReference, "ORDER-NEW");

  const ambiguousPayment = new FakePage();
  ambiguousPayment.routes.set(paymentSelector, [
    element({ attrs: attrs({ "data-order-reference": "ORDER-1" }) }),
    element({ attrs: attrs({ "data-order-reference": "ORDER-2" }) })
  ]);
  const ambiguousPaymentSignals = await collectPageSignals(ambiguousPayment.asPage());
  assert.equal(ambiguousPaymentSignals.paymentRequired, false);
  assert.equal(ambiguousPaymentSignals.orderReference, undefined);
  assert.ok(ambiguousPaymentSignals.evidence.includes("payment-evidence-invalid"));
});

test("tier selection requires strict price metadata and a unique post-click selected state", async () => {
  const adapter = new DamaiAdapter();

  for (const badPrice of [undefined, "", "38000.0", "038000"] as const) {
    const page = new FakePage();
    page.routes.set('[data-testid="tier-option"]', [tier("高层看台", badPrice)]);
    const result = await adapter.selectTier({ page: page.asPage(), plan: plan() });
    assert.equal(result.blockedState, "PAGE_CHANGED", String(badPrice));
  }

  const mismatch = new FakePage();
  mismatch.routes.set('[data-testid="tier-option"]', [tier("高层看台", "38000", "¥381.00")]);
  assert.equal((await adapter.selectTier({ page: mismatch.asPage(), plan: plan() })).blockedState, "PAGE_CHANGED");

  const noSelectedState = new FakePage();
  noSelectedState.routes.set('[data-testid="tier-option"]', [tier("高层看台", "38000")]);
  const notVerified = await adapter.selectTier({ page: noSelectedState.asPage(), plan: plan() });
  assert.equal(notVerified.ok, false);
  assert.match(notVerified.message, /did not become visibly active/);

  const selected = new FakePage();
  const selectedTier = tier("高层看台", "38000");
  selectedTier.onClick = () => selectedTier.attrs.set("aria-pressed", "true");
  selected.routes.set('[data-testid="tier-option"]', [selectedTier]);
  assert.equal((await adapter.selectTier({ page: selected.asPage(), plan: plan() })).ok, true);
});

test("tier maxUnitPriceFen is enforced and attendee lookup never falls through to another choice kind", async () => {
  const adapter = new DamaiAdapter();
  const pricePage = new FakePage();
  pricePage.routes.set('[data-testid="tier-option"]', [tier("高层看台", "38000")]);
  const limited = await adapter.selectTier({
    page: pricePage.asPage(),
    plan: plan({ tiers: [{ label: "高层看台", priority: 1, maxUnitPriceFen: 37_999 }] })
  });
  assert.equal(limited.blockedState, "PRICE_LIMIT_EXCEEDED");

  let sessionClicked = false;
  const kindPage = new FakePage();
  kindPage.routes.set('[data-testid="session-option"]', [
    element({
      text: "本人",
      attrs: attrs({ "data-session-label": "本人", "aria-pressed": "false" }),
      onClick: () => { sessionClicked = true; }
    })
  ]);
  const attendeeResult = await adapter.selectAttendees({
    page: kindPage.asPage(),
    plan: plan({ attendeeAliases: ["本人"] })
  });
  assert.equal(attendeeResult.ok, false);
  assert.equal(sessionClicked, false);
});

test("quantity and attendee safety checks require exact summaries, adjacency evidence, and counts", async () => {
  const adapter = new DamaiAdapter();
  const invalidQuantity = await adapter.selectQuantity({ page: new FakePage().asPage(), plan: plan({ quantity: 7 }) });
  assert.equal(invalidQuantity.blockedState, "PAGE_CHANGED");

  const quantityPage = new FakePage();
  const summary = element({ tag: "strong", text: "1 张" });
  const control = element({ tag: "select", value: "1", options: ["1", "2"] });
  control.onChange = (value) => { summary.text = `${value} 张`; };
  quantityPage.routes.set('[data-testid="quantity"], [data-role="ticket-quantity"]', [control]);
  quantityPage.routes.set('[data-testid="selected-quantity"]', [summary]);
  assert.equal((await adapter.selectQuantity({ page: quantityPage.asPage(), plan: plan({ quantity: 2 }) })).ok, true);
  assert.equal(
    (await adapter.selectQuantity({
      page: quantityPage.asPage(),
      plan: plan({ quantity: 2, requireAdjacent: true })
    })).blockedState,
    "PAGE_CHANGED"
  );
  quantityPage.routes.set('[data-testid="adjacent-confirmed"][data-adjacent="true"]', [element()]);
  assert.equal(
    (await adapter.selectQuantity({
      page: quantityPage.asPage(),
      plan: plan({ quantity: 2, requireAdjacent: true })
    })).ok,
    true
  );

  const attendeePage = new FakePage();
  const attendeeInput = element({ tag: "input", attrs: attrs({ type: "checkbox" }) });
  const attendee = element({
    tag: "label",
    text: "本人（仿真）",
    attrs: attrs({ "data-attendee-alias": "本人" }),
    children: [attendeeInput],
    onClick: () => { attendeeInput.checked = true; }
  });
  attendeePage.routes.set('[data-testid="attendee-option"]', [attendee]);
  const countMismatch = await adapter.selectAttendees({
    page: attendeePage.asPage(),
    plan: plan({ quantity: 2, attendeeAliases: ["本人"] })
  });
  assert.equal(countMismatch.blockedState, "PAGE_CHANGED");
  assert.equal(attendeeInput.checked, false, "count is validated before clicking");
  assert.equal(
    (await adapter.selectAttendees({ page: attendeePage.asPage(), plan: plan({ attendeeAliases: ["本人"] }) })).ok,
    true
  );
});

test("Damai atomic submit detects price or URL changes inside evaluate and performs zero clicks", async (t) => {
  const adapter = new DamaiAdapter();
  const submitPlan = plan({
    officialUrl: "https://detail.damai.cn/item.htm?id=123",
    eventId: "123",
    eventTitle: "测试活动",
    canonicalEventKey: "test-event-123",
    maxTotalFen: 50_000,
    sessions: [{ label: "8月18日 周二 19:30", priority: 1 }],
    tiers: [{ label: "高层看台", priority: 1, maxUnitPriceFen: 50_000 }],
    attendeeAliases: ["本人"],
    autoSubmitOrder: true
  });
  const runCase = async (
    mutateInsideEvaluate: (fixture: ReturnType<typeof atomicFixture>) => void
  ): Promise<{ result: Awaited<ReturnType<DamaiAdapter["submitOrder"]>>; fixture: ReturnType<typeof atomicFixture> }> => {
    const fixture = atomicFixture();
    fixture.page.beforeEvaluate = () => mutateInsideEvaluate(fixture);
    const result = await adapter.submitOrder({
      page: fixture.page.asPage(),
      plan: submitPlan,
      approvedTotalFen: 38_000,
      selectedSession: "8月18日 周二 19:30",
      selectedTier: "高层看台",
      adjacentVerified: true
    });
    return { result, fixture };
  };

  await t.test("a fully verified fixture performs exactly one click", async () => {
    const { result, fixture } = await runCase(() => undefined);
    assert.equal(result.ok, true);
    assert.equal(result.paymentRequired, true);
    assert.equal(result.orderReference, "ORDER-ATOMIC-1");
    assert.equal(fixture.page.evaluateCount, 1);
    assert.equal(fixture.submit.clickCount, 1);
  });

  await t.test("price changes after approval but before the atomic task checks DOM", async () => {
    const { result, fixture } = await runCase(({ total }) => {
      total.attrs.set("data-order-total-fen", "39000");
      total.innerText = "¥390.00";
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /ORDER_TOTAL_CHANGED_FROM_APPROVAL/);
    assert.equal(fixture.page.evaluateCount, 1);
    assert.equal(fixture.submit.clickCount, 0);
  });

  await t.test("URL changes to a non-Damai host at atomic-task entry", async () => {
    const { result, fixture } = await runCase(({ page }) => {
      page.document.defaultView.location.href = "https://damai.cn.example.com/order/confirm";
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /URL_NOT_OFFICIAL_DAMAI_HTTPS/);
    assert.equal(fixture.page.evaluateCount, 1);
    assert.equal(fixture.submit.clickCount, 0);
  });

  await t.test("event title changes inside the final browser task", async () => {
    const { result, fixture } = await runCase(({ eventTitle }) => {
      eventTitle.innerText = "另一个活动";
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /EVENT_TITLE_CHANGED_FROM_APPROVAL/);
    assert.equal(fixture.page.evaluateCount, 1);
    assert.equal(fixture.submit.clickCount, 0);
  });

  await t.test("opaque event ID punctuation cannot be normalized away", async () => {
    const { result, fixture } = await runCase(({ page }) => {
      page.document.defaultView.location.href = "https://buy.damai.cn/order/confirm?id=1-23";
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /EVENT_ID_CHANGED_FROM_APPROVAL/);
    assert.equal(fixture.page.evaluateCount, 1);
    assert.equal(fixture.submit.clickCount, 0);
  });

  await t.test("a hidden stale order reference present before click is rejected", async () => {
    const { result, fixture } = await runCase(({ page }) => {
      const stale = new AtomicElement("div", "旧订单", { "data-order-reference": "OLD-ORDER" });
      stale.hidden = true;
      page.document.set("[data-order-reference]", [stale]);
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /PREEXISTING_PAYMENT_EVIDENCE/);
    assert.equal(fixture.page.evaluateCount, 1);
    assert.equal(fixture.submit.clickCount, 0);
  });

  await t.test("a verification prompt appearing at atomic-task entry blocks the click", async () => {
    const { result, fixture } = await runCase(({ page }) => {
      page.document.body.innerText = "请验证您是真人";
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /BLOCKING_PAGE_STATE_VISIBLE/);
    assert.equal(fixture.page.evaluateCount, 1);
    assert.equal(fixture.submit.clickCount, 0);
  });

  await t.test("a payable total change after click is never reported as PAY_REQUIRED", async () => {
    const { result, fixture } = await runCase(({ submit, total }) => {
      const showPayment = submit.onClick;
      submit.onClick = () => {
        showPayment?.();
        total.attrs.set("data-order-total-fen", "39000");
        total.innerText = "¥390.00";
      };
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /payable total does not match/i);
    assert.equal(fixture.submit.clickCount, 1);
  });
});

test("Damai adapter remains disabled for live execution", () => {
  assert.equal(new DamaiAdapter().liveReady, false);
});

function invokeMockRequest(path: string): { body: string; status: number | undefined } {
  const server = createMockServer();
  const result: { body: string; status: number | undefined } = { body: "", status: undefined };
  const response = {
    setHeader: () => undefined,
    writeHead: (status: number) => { result.status = status; },
    end: (body?: string) => { result.body = body ?? ""; }
  } as unknown as ServerResponse;
  server.emit("request", { method: "GET", url: path } as IncomingMessage, response);
  return result;
}

test("mock server returns 400 for malformed URI encoding and remains healthy", () => {
  const malformed = invokeMockRequest("/damai/%E0%A4");
  assert.equal(malformed.status, 400);
  assert.deepEqual(JSON.parse(malformed.body), { error: "MALFORMED_URI" });

  const health = invokeMockRequest("/healthz");
  assert.equal(health.status, 200);
  assert.equal((JSON.parse(health.body) as { ok: boolean }).ok, true);
});
