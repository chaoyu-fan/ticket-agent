import type { Locator, Page } from "playwright-core";

import { collectPageSignals, extractFen, guardPage } from "./signals.js";
import type {
  AdapterContext,
  AdapterDomPredicate,
  AdapterDomWaitPhase,
  AdapterPhase,
  AdapterStepResult,
  ApprovedSubmitContext,
  GuardDecision,
  PageSignals,
  TicketPlatformAdapter,
  VisibleCandidate
} from "./types.js";

type ChoiceKind = "session" | "tier" | "quantity" | "attendee";

type ChoiceMatch =
  | { kind: "none" }
  | { kind: "many" }
  | { kind: "one"; locator: Locator };

const DAMAI_BLOCKING_DOM_PREDICATES = [
  {
    key: "captcha-visible",
    selector: [
      'iframe[src*="captcha" i]',
      'iframe[src*="turnstile" i]',
      'iframe[src*="challenge" i]',
      'iframe[src*="geetest" i]',
      '.cf-turnstile',
      '[class*="captcha" i]',
      '[class*="geetest" i]',
      '[id*="captcha" i]',
      '[id*="turnstile" i]',
      '[data-testid="captcha"]',
      '[data-testid="turnstile"]',
      '[data-sitekey]'
    ].join(", ")
  },
  {
    key: "login-required-visible",
    selector: '[data-testid="login-required"], form[action*="login" i]'
  },
  {
    key: "sold-out-visible",
    selector: '[data-testid="sold-out"], [aria-label*="售罄"]'
  }
] as const satisfies readonly AdapterDomPredicate[];

const DAMAI_SALE_DOM_PREDICATES = [
  ...DAMAI_BLOCKING_DOM_PREDICATES,
  { key: "official-queue-visible", selector: '[data-testid="official-queue"]' }
] as const satisfies readonly AdapterDomPredicate[];

const DAMAI_QUEUE_DOM_PREDICATES = [
  ...DAMAI_BLOCKING_DOM_PREDICATES,
  {
    key: "purchase-controls-visible",
    selector: [
      '[data-testid="session-option"]:not([disabled]):not([aria-disabled="true"])',
      '[data-testid="tier-option"]:not([disabled]):not([aria-disabled="true"])',
      '[data-testid="submit-order"]:not([disabled]):not([aria-disabled="true"])'
    ].join(", ")
  }
] as const satisfies readonly AdapterDomPredicate[];

function isDamaiHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^www\./, "");
  return normalized === "damai.cn" || normalized.endsWith(".damai.cn");
}

function normalizeLabel(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").trim();
}

function visibleText(locator: Locator): Promise<string> {
  return locator.innerText({ timeout: 2_000 }).catch(() => "");
}

async function enabledVisible(locator: Locator): Promise<Locator[]> {
  const result: Locator[] = [];
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    if (await candidate.isDisabled().catch(() => false)) continue;
    if ((await candidate.getAttribute("aria-disabled").catch(() => null)) === "true") continue;
    result.push(candidate);
  }
  return result;
}

function choiceSelector(kind: ChoiceKind): string {
  switch (kind) {
    case "session":
      return '[data-testid="session-option"]';
    case "tier":
      return '[data-testid="tier-option"]';
    case "quantity":
      return '[data-testid="quantity-option"], [data-role="quantity-option"]';
    case "attendee":
      return '[data-testid="attendee-option"]';
  }
}

function labelAttribute(kind: Exclude<ChoiceKind, "quantity">): string {
  return kind === "session" ? "data-session-label" : kind === "tier" ? "data-tier-label" : "data-attendee-alias";
}

async function findChoice(
  page: Page,
  label: string,
  kind: Exclude<ChoiceKind, "quantity">
): Promise<ChoiceMatch> {
  const options = await enabledVisible(page.locator(choiceSelector(kind)));
  const matches: Locator[] = [];
  const attribute = labelAttribute(kind);
  const expected = normalizeLabel(label);
  if (!expected) return { kind: "none" };
  for (const option of options) {
    const configured = await option.getAttribute(attribute);
    if (configured === null || normalizeLabel(configured) !== expected) continue;
    const text = normalizeLabel(await visibleText(option));
    if (text === expected || text.startsWith(expected)) matches.push(option);
  }
  const match = matches[0];
  if (matches.length === 1 && match !== undefined) return { kind: "one", locator: match };
  return matches.length > 1 ? { kind: "many" } : { kind: "none" };
}

async function checked(locator: Locator): Promise<boolean> {
  if (await locator.isChecked().catch(() => false)) return true;
  const inputs = locator.locator('input[type="checkbox"], input[type="radio"]');
  if ((await inputs.count()) !== 1) return false;
  return inputs.first().isChecked().catch(() => false);
}

async function positivelySelected(locator: Locator, kind: ChoiceKind): Promise<boolean> {
  if (kind === "attendee") return checked(locator);
  if ((await locator.getAttribute("aria-pressed").catch(() => null)) === "true") return true;
  if ((await locator.getAttribute("aria-selected").catch(() => null)) === "true") return true;
  if ((await locator.getAttribute("data-selected").catch(() => null)) === "true") return true;
  const inputs = locator.locator('input[type="radio"]');
  return (await inputs.count()) === 1 && inputs.first().isChecked().catch(() => false);
}

async function waitForPositiveSelection(locator: Locator, kind: ChoiceKind): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await positivelySelected(locator, kind)) return true;
    if (attempt < 4) await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function selectedChoiceCount(page: Page, kind: "session" | "tier"): Promise<number> {
  const options = await enabledVisible(page.locator(choiceSelector(kind)));
  let count = 0;
  for (const option of options) if (await positivelySelected(option, kind)) count += 1;
  return count;
}

async function clickAndVerify(
  page: Page,
  locator: Locator,
  label: string,
  kind: "session" | "tier" | "attendee"
): Promise<AdapterStepResult> {
  try {
    if (!(await positivelySelected(locator, kind))) await locator.click();
  } catch {
    return { ok: false, message: `${kind} option could not be clicked: ${label}`, blockedState: "PAGE_CHANGED" };
  }
  if (!(await waitForPositiveSelection(locator, kind))) {
    return { ok: false, message: `${kind} selection did not become visibly active: ${label}`, blockedState: "PAGE_CHANGED" };
  }
  if (kind !== "attendee" && (await selectedChoiceCount(page, kind)) !== 1) {
    return { ok: false, message: `${kind} selection is not unique after click: ${label}`, blockedState: "PAGE_CHANGED" };
  }
  return { ok: true, message: `${kind} selected and verified`, selectedLabel: label };
}

async function clickPreferred(page: Page, labels: readonly string[], kind: "session" | "attendee"):
  Promise<AdapterStepResult> {
  for (const label of labels) {
    const candidate = await findChoice(page, label, kind);
    if (candidate.kind === "many") {
      return { ok: false, message: `Ambiguous ${kind} option: ${label}`, blockedState: "PAGE_CHANGED" };
    }
    if (candidate.kind === "one") return clickAndVerify(page, candidate.locator, label, kind);
  }
  return { ok: false, message: `No requested ${kind} option is visible`, blockedState: "PAGE_CHANGED" };
}

interface PricedCandidate extends VisibleCandidate {
  priceFen: number;
}

async function tierCandidates(page: Page): Promise<{ candidates: PricedCandidate[]; invalid: boolean }> {
  const options = await enabledVisible(page.locator(choiceSelector("tier")));
  const candidates: PricedCandidate[] = [];
  let invalid = false;
  for (let index = 0; index < options.length; index += 1) {
    const locator = options[index]!;
    const text = await visibleText(locator);
    if (/(?:售罄|无票|缺货|停售)/i.test(text)) continue;
    const attr = await locator.getAttribute("data-price-fen");
    const textPrices = extractFen(text);
    // This adapter intentionally uses a strict, visible-DOM contract. A
    // missing/blank/non-canonical data price must never silently fall back to
    // guessing from arbitrary text, and metadata may only corroborate the
    // single visible currency value.
    if (attr === null || !/^(?:0|[1-9][0-9]*)$/.test(attr)) {
      invalid = true;
      continue;
    }
    const priceFen = Number(attr);
    if (!Number.isSafeInteger(priceFen) || priceFen < 0 || textPrices.length !== 1 || textPrices[0] !== priceFen) {
      invalid = true;
      continue;
    }
    const configuredLabel = (await locator.getAttribute("data-tier-label"))?.trim();
    if (!configuredLabel || !normalizeLabel(text).startsWith(normalizeLabel(configuredLabel))) {
      invalid = true;
      continue;
    }
    candidates.push({
      locator,
      label: configuredLabel,
      priceFen
    });
  }
  return { candidates, invalid };
}

function withinTierLimit(
  candidate: PricedCandidate,
  maxUnitPriceFen: number | undefined,
  maxTotalFen: number | undefined,
  quantity: number
): boolean {
  if (!Number.isSafeInteger(candidate.priceFen) || candidate.priceFen < 0) return false;
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 6) return false;
  if (maxUnitPriceFen !== undefined && (!Number.isSafeInteger(maxUnitPriceFen) || maxUnitPriceFen < 0)) return false;
  if (maxTotalFen !== undefined && (!Number.isSafeInteger(maxTotalFen) || maxTotalFen < 0)) return false;
  if (maxUnitPriceFen !== undefined && candidate.priceFen > maxUnitPriceFen) return false;
  const estimatedTotalFen = candidate.priceFen * quantity;
  if (!Number.isSafeInteger(estimatedTotalFen)) return false;
  if (maxTotalFen !== undefined && estimatedTotalFen > maxTotalFen) return false;
  return true;
}

async function chooseTier(context: AdapterContext): Promise<AdapterStepResult> {
  if (!Number.isSafeInteger(context.plan.quantity) || context.plan.quantity < 1 || context.plan.quantity > 6) {
    return { ok: false, message: "Ticket quantity must be an integer between 1 and 6", blockedState: "PAGE_CHANGED" };
  }
  const { candidates, invalid } = await tierCandidates(context.page);
  if (invalid) return { ok: false, message: "A visible tier price is malformed or contradicts metadata", blockedState: "PAGE_CHANGED" };
  if (candidates.length === 0) return { ok: false, message: "No safely priced visible tier option", blockedState: "SOLD_OUT" };

  const preferences = [...context.plan.tiers].sort((a, b) => a.priority - b.priority);
  let chosen: PricedCandidate | undefined;
  if (context.plan.priceStrategy === "PREFERRED_ORDER") {
    for (const preference of preferences) {
      const matches = candidates.filter((candidate) => normalizeLabel(candidate.label) === normalizeLabel(preference.label));
      if (matches.length > 1) return { ok: false, message: `Ambiguous tier option: ${preference.label}`, blockedState: "PAGE_CHANGED" };
      const match = matches[0];
      if (match && withinTierLimit(match, preference.maxUnitPriceFen, context.plan.maxTotalFen, context.plan.quantity)) {
        chosen = match;
        break;
      }
    }
  } else {
    const configured = preferences.length === 0
      ? candidates
      : candidates.filter((candidate) => preferences.some((preference) => normalizeLabel(preference.label) === normalizeLabel(candidate.label)));
    const allowed = configured.filter((candidate) => {
      const preference = preferences.find((item) => normalizeLabel(item.label) === normalizeLabel(candidate.label));
      return withinTierLimit(candidate, preference?.maxUnitPriceFen, context.plan.maxTotalFen, context.plan.quantity);
    });
    const cheapest = allowed.length === 0 ? undefined : Math.min(...allowed.map((candidate) => candidate.priceFen));
    const matches = cheapest === undefined ? [] : allowed.filter((candidate) => candidate.priceFen === cheapest);
    if (matches.length > 1) return { ok: false, message: "Cheapest permitted tier is ambiguous", blockedState: "PAGE_CHANGED" };
    chosen = matches[0];
  }

  if (!chosen) {
    return { ok: false, message: "No requested tier is within the configured unit/total price limit", blockedState: "PRICE_LIMIT_EXCEEDED" };
  }
  const selected = await clickAndVerify(context.page, chosen.locator, chosen.label, "tier");
  return selected.ok
    ? { ...selected, message: `Selected verified tier at ${chosen.priceFen} fen`, selectedLabel: chosen.label }
    : selected;
}

async function verifyQuantitySummary(page: Page, quantity: number): Promise<boolean> {
  const summary = await enabledVisible(page.locator('[data-testid="selected-quantity"]'));
  if (summary.length !== 1) return false;
  const text = await visibleText(summary[0]!);
  return new RegExp(`^\\s*${quantity}(?:\\s*张)?\\s*$`).test(text);
}

async function verifyAdjacency(page: Page, quantity: number, required: boolean): Promise<boolean> {
  if (!required || quantity <= 1) return true;
  const evidence = await enabledVisible(
    page.locator('[data-testid="adjacent-confirmed"][data-adjacent="true"]')
  );
  return evidence.length === 1;
}

async function setQuantity(page: Page, quantity: number, requireAdjacent: boolean): Promise<AdapterStepResult> {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 6) {
    return { ok: false, message: "Ticket quantity must be an integer between 1 and 6", blockedState: "PAGE_CHANGED" };
  }
  const controls = await enabledVisible(page.locator('[data-testid="quantity"], [data-role="ticket-quantity"]'));
  if (controls.length > 1) return { ok: false, message: "Ambiguous quantity controls", blockedState: "PAGE_CHANGED" };
  if (controls.length === 1) {
    const control = controls[0]!;
    const tag = await control.evaluate((node) => node.tagName.toLowerCase()).catch(() => "");
    try {
      if (tag === "select") {
        const selected = await control.selectOption(String(quantity));
        if (selected.length !== 1 || selected[0] !== String(quantity)) {
          return { ok: false, message: "Requested quantity is not a unique selectable option", blockedState: "PAGE_CHANGED" };
        }
      } else if (tag === "input" && (await control.getAttribute("type")) === "number") {
        await control.fill(String(quantity));
      } else {
        return { ok: false, message: "Quantity control has an unsupported type", blockedState: "PAGE_CHANGED" };
      }
    } catch {
      return { ok: false, message: "Quantity control could not be changed", blockedState: "PAGE_CHANGED" };
    }
    if ((await control.inputValue().catch(() => "")) !== String(quantity)) {
      return { ok: false, message: "Quantity could not be positively verified", blockedState: "PAGE_CHANGED" };
    }
  } else {
    const options = await enabledVisible(page.locator(choiceSelector("quantity")));
    const matches: Locator[] = [];
    for (const option of options) {
      if (new RegExp(`^\\s*${quantity}(?:\\s*张)?\\s*$`).test(await visibleText(option))) matches.push(option);
    }
    if (matches.length > 1) {
      return { ok: false, message: "Requested quantity option is ambiguous", blockedState: "PAGE_CHANGED" };
    }
    if (matches.length === 0) {
      if (!(quantity === 1 && await verifyQuantitySummary(page, quantity))) {
        return { ok: false, message: "Quantity control/default is not safely verifiable", blockedState: "PAGE_CHANGED" };
      }
    } else {
      try {
        await matches[0]!.click();
      } catch {
        return { ok: false, message: "Quantity option could not be clicked", blockedState: "PAGE_CHANGED" };
      }
      if (!(await waitForPositiveSelection(matches[0]!, "quantity"))) {
        return { ok: false, message: "Quantity selection did not become active", blockedState: "PAGE_CHANGED" };
      }
    }
  }
  if (!(await verifyQuantitySummary(page, quantity))) {
    return { ok: false, message: "Selected quantity does not match the visible order summary", blockedState: "PAGE_CHANGED" };
  }
  const adjacentVerified = await verifyAdjacency(page, quantity, requireAdjacent);
  if (!adjacentVerified) {
    return { ok: false, message: "Adjacent seats are required but were not positively verified", blockedState: "PAGE_CHANGED" };
  }
  return { ok: true, message: "Quantity selected and verified", selectedLabel: String(quantity), adjacentVerified };
}

async function countCheckedAttendees(page: Page): Promise<number> {
  const options = await enabledVisible(page.locator('[data-testid="attendee-option"]'));
  let count = 0;
  for (const option of options) if (await checked(option)) count += 1;
  return count;
}

interface AtomicSubmitInput {
  approvedTotalFen: number;
  eventId: string;
  eventTitle: string;
  quantity: number;
  requireAdjacent: boolean;
  adjacentVerified: boolean;
  selectedSession: string;
  selectedTier: string;
  attendeeAliases: string[];
  maxTotalFen?: number;
  maxUnitPriceFen?: number;
}

type AtomicSubmitResult =
  | { clicked: true }
  | { clicked: false; reason: string };

function atomicInput(context: ApprovedSubmitContext): AtomicSubmitInput | AdapterStepResult {
  const approved = context.approvedTotalFen;
  if (!Number.isSafeInteger(approved) || approved < 0) {
    return { ok: false, message: "Controller-approved total is invalid", blockedState: "PAGE_CHANGED" };
  }
  if (context.plan.maxTotalFen !== undefined && approved > context.plan.maxTotalFen) {
    return { ok: false, message: "Controller-approved total exceeds the configured maximum", blockedState: "PRICE_LIMIT_EXCEEDED" };
  }
  const eventId = context.plan.eventId?.trim() ?? "";
  const eventTitle = context.plan.eventTitle?.trim() ?? "";
  if (!eventId || !eventTitle) {
    return { ok: false, message: "Submit requires strong event ID and title evidence", blockedState: "PAGE_CHANGED" };
  }
  const selectedSession = context.selectedSession.trim();
  const selectedTier = context.selectedTier.trim();
  if (!selectedSession || !selectedTier) {
    return { ok: false, message: "Submit requires recorded session and tier evidence", blockedState: "PAGE_CHANGED" };
  }
  const configuredSessions = context.plan.sessions.filter(
    (preference) => normalizeLabel(preference.label) === normalizeLabel(selectedSession)
  );
  if (context.plan.sessions.length > 0 && configuredSessions.length !== 1) {
    return { ok: false, message: "Recorded session is not uniquely allowed by the plan", blockedState: "PAGE_CHANGED" };
  }
  const configuredTiers = context.plan.tiers.filter(
    (preference) => normalizeLabel(preference.label) === normalizeLabel(selectedTier)
  );
  if (context.plan.tiers.length > 0 && configuredTiers.length !== 1) {
    return { ok: false, message: "Recorded tier is not uniquely allowed by the plan", blockedState: "PAGE_CHANGED" };
  }
  const aliases = context.plan.attendeeAliases;
  const normalizedAliases = aliases.map(normalizeLabel);
  if (
    aliases.length !== context.plan.quantity ||
    normalizedAliases.some((alias) => !alias) ||
    new Set(normalizedAliases).size !== aliases.length
  ) {
    return { ok: false, message: "Submit requires one unique attendee alias per ticket", blockedState: "PAGE_CHANGED" };
  }
  if (context.plan.requireAdjacent && context.plan.quantity > 1 && context.adjacentVerified !== true) {
    return { ok: false, message: "Recorded adjacent-seat evidence is missing", blockedState: "PAGE_CHANGED" };
  }
  const maxUnitPriceFen = configuredTiers[0]?.maxUnitPriceFen;
  return {
    approvedTotalFen: approved,
    eventId,
    eventTitle,
    quantity: context.plan.quantity,
    requireAdjacent: context.plan.requireAdjacent,
    adjacentVerified: context.adjacentVerified,
    selectedSession,
    selectedTier,
    attendeeAliases: [...aliases],
    ...(context.plan.maxTotalFen === undefined ? {} : { maxTotalFen: context.plan.maxTotalFen }),
    ...(maxUnitPriceFen === undefined ? {} : { maxUnitPriceFen })
  };
}

/**
 * The final evidence check and native DOM click intentionally live inside one
 * synchronous browser task. No Locator is retained across awaits, and every
 * failure return happens before `click()` is invoked.
 */
async function atomicallyVerifyAndClick(context: ApprovedSubmitContext): Promise<AtomicSubmitResult | AdapterStepResult> {
  const input = atomicInput(context);
  if ("ok" in input) return input;

  try {
    return await context.page.locator("body").evaluate(
      (body, expected: AtomicSubmitInput): AtomicSubmitResult => {
        const fail = (reason: string): AtomicSubmitResult => ({ clicked: false, reason });
        const document = body.ownerDocument;
        const view = document.defaultView;
        if (!view || document.body !== body || !body.isConnected) return fail("BODY_NOT_CURRENT");

        let currentUrl: URL;
        try {
          currentUrl = new URL(view.location.href);
        } catch {
          return fail("URL_UNREADABLE");
        }
        const hostname = currentUrl.hostname.toLowerCase().replace(/^www\./, "");
        if (
          currentUrl.protocol !== "https:" ||
          (hostname !== "damai.cn" && !hostname.endsWith(".damai.cn")) ||
          currentUrl.username !== "" ||
          currentUrl.password !== "" ||
          (currentUrl.port !== "" && currentUrl.port !== "443")
        ) {
          return fail("URL_NOT_OFFICIAL_DAMAI_HTTPS");
        }

        const visible = (element: Element): boolean => {
          const html = element as HTMLElement;
          if (!element.isConnected || html.hidden || element.getAttribute("aria-hidden") === "true") return false;
          const style = view.getComputedStyle(element);
          if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) {
            return false;
          }
          return html.getClientRects().length > 0;
        };
        const enabled = (element: Element): boolean =>
          !element.hasAttribute("disabled") &&
          element.getAttribute("aria-disabled") !== "true" &&
          (element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement).disabled !== true;
        const renderedText = (element: Element): string => (element as HTMLElement).innerText;
        const normalized = (value: string): string => value.normalize("NFKC").replace(/\s+/g, "").trim();
        const normalizedIdentity = (value: string): string => value
          .normalize("NFKC")
          .toLocaleLowerCase("zh-CN")
          .replace(/[\p{P}\p{S}\p{Z}]+/gu, "")
          .trim();
        const normalizedEventId = (value: string): string => value.normalize("NFKC").trim();
        const visibleElements = (selector: string): Element[] =>
          Array.from(document.querySelectorAll(selector)).filter(visible);
        const isSelected = (element: Element): boolean => {
          if (
            element.getAttribute("aria-pressed") === "true" ||
            element.getAttribute("aria-selected") === "true" ||
            element.getAttribute("data-selected") === "true"
          ) return true;
          if (element.matches('input[type="checkbox"], input[type="radio"]')) {
            return (element as HTMLInputElement).checked;
          }
          const controls = Array.from(element.querySelectorAll('input[type="checkbox"], input[type="radio"]'));
          return controls.length === 1 && (controls[0] as HTMLInputElement).checked;
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

        if (
          !Number.isSafeInteger(expected.approvedTotalFen) ||
          expected.approvedTotalFen < 0 ||
          !normalizedEventId(expected.eventId) ||
          !normalizedIdentity(expected.eventTitle) ||
          !Number.isSafeInteger(expected.quantity) ||
          expected.quantity < 1 ||
          expected.quantity > 6 ||
          (expected.maxTotalFen !== undefined && expected.approvedTotalFen > expected.maxTotalFen)
        ) return fail("APPROVED_POLICY_INVALID");

        const eventTitles = visibleElements('[data-testid="event-title"]');
        if (
          eventTitles.length !== 1 ||
          normalizedIdentity(renderedText(eventTitles[0]!)) !== normalizedIdentity(expected.eventTitle)
        ) return fail("EVENT_TITLE_CHANGED_FROM_APPROVAL");

        const eventIds = new Set<string>();
        const addEventId = (value: string | null | undefined): void => {
          const candidate = value === null || value === undefined ? "" : normalizedEventId(value);
          if (candidate) eventIds.add(candidate);
        };
        for (const element of Array.from(document.querySelectorAll("[data-event-id]"))) {
          addEventId(element.getAttribute("data-event-id"));
        }
        for (const key of ["id", "itemId", "projectId", "showId"]) addEventId(currentUrl.searchParams.get(key));
        addEventId(/(?:item|show|project)[\/-]([A-Za-z0-9_-]{2,})/i.exec(currentUrl.pathname)?.[1]);
        addEventId(/活动\s*ID\s*[：:]\s*([A-Za-z0-9_-]+)/i.exec(renderedText(body))?.[1]);
        if (eventIds.size !== 1 || !eventIds.has(normalizedEventId(expected.eventId))) {
          return fail("EVENT_ID_CHANGED_FROM_APPROVAL");
        }

        const blockingSelector = [
          'iframe[src*="captcha" i]',
          'iframe[src*="turnstile" i]',
          'iframe[src*="challenge" i]',
          'iframe[src*="geetest" i]',
          'iframe[src*="recaptcha" i]',
          'iframe[src*="hcaptcha" i]',
          '.cf-turnstile',
          '[class*="captcha" i]',
          '[class*="geetest" i]',
          '[id*="captcha" i]',
          '[id*="turnstile" i]',
          '[data-testid="captcha"]',
          '[data-testid="turnstile"]',
          '[data-sitekey]',
          '[data-testid="login-required"]',
          'form[action*="login" i]',
          '[data-testid="sold-out"]',
          '[aria-label*="售罄"]',
          '[data-testid="official-queue"]'
        ].join(", ");
        const bodyText = renderedText(body);
        const blockingText = /(?:请(?:完成|进行|通过)?(?:安全|身份|人机|访问|智能)?验证|请验证(?:您|你)?(?:是|为)?真人|安全验证|人机验证|滑动验证|验证码|captcha|turnstile|verify (?:that )?you are human|checking (?:your browser|if (?:the )?site connection is secure)|已售罄|暂时无票|缺货登记|正在排队|排队中|请耐心等待)/i;
        if (
          visibleElements(blockingSelector).length > 0 ||
          blockingText.test(bodyText) ||
          /(?:login|passport)/i.test(currentUrl.pathname)
        ) {
          return fail("BLOCKING_PAGE_STATE_VISIBLE");
        }
        if (
          visibleElements('[data-testid="order-result"][data-state="PAY_REQUIRED"], [data-payment-required="true"]').length > 0 ||
          Array.from(document.querySelectorAll("[data-order-reference]"))
            .some((element) => (element.getAttribute("data-order-reference") ?? "").trim() !== "")
        ) {
          return fail("PREEXISTING_PAYMENT_EVIDENCE");
        }

        const sessionSummary = visibleElements('[data-testid="selected-session"]');
        const selectedSessions = visibleElements('[data-testid="session-option"]')
          .filter((element) => enabled(element) && isSelected(element));
        if (
          sessionSummary.length !== 1 ||
          normalized(renderedText(sessionSummary[0]!)) !== normalized(expected.selectedSession) ||
          selectedSessions.length !== 1
        ) return fail("SESSION_EVIDENCE_CHANGED");
        const selectedSession = selectedSessions[0]!;
        const sessionLabel = selectedSession.getAttribute("data-session-label");
        if (
          !sessionLabel ||
          normalized(sessionLabel) !== normalized(expected.selectedSession) ||
          !normalized(renderedText(selectedSession)).startsWith(normalized(expected.selectedSession))
        ) return fail("SESSION_EVIDENCE_CHANGED");

        const tierSummary = visibleElements('[data-testid="selected-tier"]');
        const selectedTiers = visibleElements('[data-testid="tier-option"]')
          .filter((element) => enabled(element) && isSelected(element));
        if (
          tierSummary.length !== 1 ||
          normalized(renderedText(tierSummary[0]!)) !== normalized(expected.selectedTier) ||
          selectedTiers.length !== 1
        ) return fail("TIER_EVIDENCE_CHANGED");
        const selectedTier = selectedTiers[0]!;
        const tierLabel = selectedTier.getAttribute("data-tier-label");
        const tierFenAttribute = selectedTier.getAttribute("data-price-fen");
        if (
          !tierLabel ||
          normalized(tierLabel) !== normalized(expected.selectedTier) ||
          !normalized(renderedText(selectedTier)).startsWith(normalized(expected.selectedTier)) ||
          tierFenAttribute === null ||
          !/^(?:0|[1-9][0-9]*)$/.test(tierFenAttribute)
        ) return fail("TIER_EVIDENCE_CHANGED");
        const tierFen = Number(tierFenAttribute);
        const visibleTierPrices = parseFen(renderedText(selectedTier));
        if (
          !Number.isSafeInteger(tierFen) ||
          tierFen < 0 ||
          visibleTierPrices.length !== 1 ||
          visibleTierPrices[0] !== tierFen ||
          (expected.maxUnitPriceFen !== undefined && tierFen > expected.maxUnitPriceFen) ||
          (expected.maxTotalFen !== undefined && tierFen * expected.quantity > expected.maxTotalFen)
        ) return fail("TIER_PRICE_POLICY_CHANGED");

        const quantitySummary = visibleElements('[data-testid="selected-quantity"]');
        const quantityText = quantitySummary.length === 1 ? normalized(renderedText(quantitySummary[0]!)) : "";
        if (quantityText !== String(expected.quantity) && quantityText !== `${expected.quantity}张`) {
          return fail("QUANTITY_EVIDENCE_CHANGED");
        }
        const quantityControls = visibleElements('[data-testid="quantity"], [data-role="ticket-quantity"]');
        if (quantityControls.length === 1) {
          const control = quantityControls[0] as HTMLInputElement | HTMLSelectElement;
          if (!enabled(control) || control.value !== String(expected.quantity)) return fail("QUANTITY_EVIDENCE_CHANGED");
        } else if (quantityControls.length === 0) {
          const selectedQuantities = visibleElements('[data-testid="quantity-option"], [data-role="quantity-option"]')
            .filter((element) => enabled(element) && isSelected(element));
          if (
            selectedQuantities.length !== 1 ||
            ![String(expected.quantity), `${expected.quantity}张`].includes(normalized(renderedText(selectedQuantities[0]!)))
          ) return fail("QUANTITY_EVIDENCE_CHANGED");
        } else {
          return fail("QUANTITY_EVIDENCE_CHANGED");
        }

        const normalizedAliases = expected.attendeeAliases.map(normalized);
        if (
          normalizedAliases.length !== expected.quantity ||
          normalizedAliases.some((alias) => !alias) ||
          new Set(normalizedAliases).size !== normalizedAliases.length
        ) return fail("ATTENDEE_POLICY_INVALID");
        const attendeeOptions = visibleElements('[data-testid="attendee-option"]');
        for (let index = 0; index < expected.attendeeAliases.length; index += 1) {
          const alias = normalizedAliases[index]!;
          const matches = attendeeOptions.filter((element) => {
            const configured = element.getAttribute("data-attendee-alias");
            if (!configured || normalized(configured) !== alias) return false;
            const label = element.matches("input") ? element.closest("label") : element;
            return label !== null && visible(label) && normalized(renderedText(label)).startsWith(alias);
          });
          if (matches.length !== 1 || !enabled(matches[0]!) || !isSelected(matches[0]!)) {
            return fail("ATTENDEE_EVIDENCE_CHANGED");
          }
        }
        if (attendeeOptions.filter(isSelected).length !== expected.quantity) {
          return fail("ATTENDEE_EVIDENCE_CHANGED");
        }

        if (expected.requireAdjacent && expected.quantity > 1) {
          const adjacent = visibleElements('[data-testid="adjacent-confirmed"][data-adjacent="true"]');
          if (expected.adjacentVerified !== true || adjacent.length !== 1) return fail("ADJACENCY_EVIDENCE_CHANGED");
        }

        const totals = visibleElements('[data-testid="order-total"], [data-order-total-fen]');
        if (totals.length !== 1) return fail("ORDER_TOTAL_MISSING_OR_AMBIGUOUS");
        const totalAttribute = totals[0]!.getAttribute("data-order-total-fen");
        if (totalAttribute === null || !/^(?:0|[1-9][0-9]*)$/.test(totalAttribute)) {
          return fail("ORDER_TOTAL_ATTRIBUTE_INVALID");
        }
        const attributeFen = Number(totalAttribute);
        const visibleTotals = parseFen(renderedText(totals[0]!));
        if (
          !Number.isSafeInteger(attributeFen) ||
          attributeFen !== expected.approvedTotalFen ||
          visibleTotals.length !== 1 ||
          visibleTotals[0] !== expected.approvedTotalFen
        ) return fail("ORDER_TOTAL_CHANGED_FROM_APPROVAL");

        const submitControls = Array.from(document.querySelectorAll('[data-testid="submit-order"]'));
        if (submitControls.length !== 1) return fail("SUBMIT_CONTROL_MISSING_OR_AMBIGUOUS");
        const submit = submitControls[0]!;
        if (!visible(submit) || !enabled(submit) || typeof (submit as HTMLElement).click !== "function") {
          return fail("SUBMIT_CONTROL_NOT_ACTIONABLE");
        }

        // This is the only irreversible action in the task. Every return
        // above is a zero-click path, and no await can interleave here.
        (submit as HTMLElement).click();
        return { clicked: true };
      },
      input
    );
  } catch {
    return { ok: false, message: "Atomic submit verification could not run", blockedState: "PAGE_CHANGED" };
  }
}

export class DamaiAdapter implements TicketPlatformAdapter {
  readonly platform = "damai" as const;
  readonly implemented = true;
  readonly liveReady = false;
  readonly fastPathReady = false;
  readonly fastPathContractDigest = undefined;
  readonly fastPathContract = undefined;

  supportsOfficialUrl(url: URL): boolean {
    return url.protocol === "https:" && isDamaiHost(url.hostname) && !url.username && !url.password && (url.port === "" || url.port === "443");
  }

  domWaitPredicates(phase: AdapterDomWaitPhase): readonly AdapterDomPredicate[] {
    return phase === "sale" ? DAMAI_SALE_DOM_PREDICATES : DAMAI_QUEUE_DOM_PREDICATES;
  }

  async navigate(page: Page, url: string): Promise<void> {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  }

  async inspect(context: AdapterContext, _phase: AdapterPhase): Promise<PageSignals> {
    return collectPageSignals(context.page);
  }

  guard(signals: PageSignals, phase: AdapterPhase, plan: AdapterContext["plan"]): GuardDecision {
    return guardPage(signals, phase, plan);
  }

  async selectSession(context: AdapterContext): Promise<AdapterStepResult> {
    const preferences = [...context.plan.sessions].sort((a, b) => a.priority - b.priority);
    if (preferences.length === 0) {
      const available = await enabledVisible(context.page.locator('[data-testid="session-option"]'));
      if (available.length === 0) {
        const summary = await enabledVisible(context.page.locator('[data-testid="selected-session"]'));
        return summary.length === 1 && (await visibleText(summary[0]!)).trim()
          ? { ok: true, message: "Single/default session is visible in the order summary", selectedLabel: await visibleText(summary[0]!) }
          : { ok: false, message: "Session default cannot be positively verified", blockedState: "PAGE_CHANGED" };
      }
      if (available.length === 1) {
        const label = (await available[0]!.getAttribute("data-session-label"))?.trim();
        const text = normalizeLabel(await visibleText(available[0]!));
        if (!label || !text.startsWith(normalizeLabel(label))) {
          return { ok: false, message: "The only visible session has no verifiable label", blockedState: "PAGE_CHANGED" };
        }
        return clickAndVerify(context.page, available[0]!, label, "session");
      }
      return { ok: false, message: "Multiple sessions are visible without a preference", blockedState: "PAGE_CHANGED" };
    }
    return clickPreferred(context.page, preferences.map((item) => item.label), "session");
  }

  async selectTier(context: AdapterContext): Promise<AdapterStepResult> {
    return chooseTier(context);
  }

  async selectQuantity(context: AdapterContext): Promise<AdapterStepResult> {
    return setQuantity(context.page, context.plan.quantity, context.plan.requireAdjacent);
  }

  async selectAttendees(context: AdapterContext): Promise<AdapterStepResult> {
    const aliases = context.plan.attendeeAliases;
    if (aliases.length === 0) {
      return context.plan.autoSubmitOrder
        ? { ok: false, message: "Automatic submission requires local attendee aliases", blockedState: "PAGE_CHANGED" }
        : { ok: true, message: "No attendees configured; execution will stop before submission" };
    }
    const normalizedAliases = aliases.map(normalizeLabel);
    if (normalizedAliases.some((alias) => alias === "") || new Set(normalizedAliases).size !== aliases.length) {
      return { ok: false, message: "Attendee aliases must be non-empty and unique", blockedState: "PAGE_CHANGED" };
    }
    if (aliases.length !== context.plan.quantity) {
      return {
        ok: false,
        message: "Attendee alias count must exactly match ticket quantity",
        blockedState: "PAGE_CHANGED"
      };
    }
    const selected: string[] = [];
    for (const alias of aliases) {
      const candidate = await findChoice(context.page, alias, "attendee");
      if (candidate.kind !== "one") {
        return { ok: false, message: `Attendee option is missing or ambiguous: ${alias}`, blockedState: "PAGE_CHANGED" };
      }
      const result = await clickAndVerify(context.page, candidate.locator, alias, "attendee");
      if (!result.ok) return result;
      selected.push(alias);
    }
    if ((await countCheckedAttendees(context.page)) !== context.plan.quantity) {
      return { ok: false, message: "Visible selected attendee count does not match ticket quantity", blockedState: "PAGE_CHANGED" };
    }
    return { ok: true, message: "Attendees selected and verified", selectedLabel: selected.join(", ") };
  }

  async submitOrder(context: ApprovedSubmitContext): Promise<AdapterStepResult> {
    if (!context.plan.autoSubmitOrder) {
      return { ok: false, message: "Submission is disabled by plan policy", blockedState: "HUMAN_TAKEOVER" };
    }
    const atomic = await atomicallyVerifyAndClick(context);
    if ("ok" in atomic) return atomic;
    if (!atomic.clicked) {
      return {
        ok: false,
        message: `ATOMIC_SUBMIT_BLOCKED:${atomic.reason}`,
        blockedState: atomic.reason === "APPROVED_POLICY_INVALID" || atomic.reason === "TIER_PRICE_POLICY_CHANGED"
          ? "PRICE_LIMIT_EXCEEDED"
          : "PAGE_CHANGED"
      };
    }
    await context.page
      .locator('[data-testid="order-result"][data-state="PAY_REQUIRED"], [data-payment-required="true"], [data-testid="captcha"], [data-testid="login-required"]')
      .first()
      .waitFor({ state: "visible", timeout: 5_000 })
      .catch(() => undefined);
    const signals = await collectPageSignals(context.page);
    const outcomeGuard = guardPage(signals, "queue", context.plan);
    if (outcomeGuard.blocked) {
      return {
        ok: false,
        message: `Post-submit page no longer proves the armed event: ${outcomeGuard.message ?? "unknown page state"}`,
        blockedState: outcomeGuard.state ?? "HUMAN_TAKEOVER"
      };
    }
    if (signals.price.kind !== "unique" || signals.price.totalFen !== context.approvedTotalFen) {
      return {
        ok: false,
        message: "Post-submit visible payable total does not match the controller-approved total",
        blockedState: "PAGE_CHANGED"
      };
    }
    if (!signals.paymentRequired || !signals.orderReference) {
      return { ok: false, message: "Submit was clicked but no unique order/payment confirmation is visible", blockedState: "HUMAN_TAKEOVER" };
    }
    return {
      ok: true,
      message: "Visible order confirmation reached; payment remains manual",
      paymentRequired: true,
      orderReference: signals.orderReference
    };
  }
}

export const damaiAdapter = new DamaiAdapter();
