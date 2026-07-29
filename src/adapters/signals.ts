import type { Locator, Page } from "playwright-core";

import type { WatchPlan } from "../core/types.js";
import type { AdapterPhase, GuardDecision, PageSignals, PriceObservation } from "./types.js";

const CAPTCHA_TEXT = /(?:请(?:完成|进行|通过)?(?:安全|身份|人机|访问|智能)?验证|请验证(?:您|你)?(?:是|为)?真人|正在验证(?:您|你)?(?:是|为)?真人|安全验证|人机验证|滑动验证|拖动滑块|点选验证|验证码|访问过于频繁|captcha|cloudflare\s+turnstile|verify (?:that )?you are human|confirm (?:that )?you are human|checking (?:your browser|if (?:the )?site connection is secure)|security check|complete the challenge|performing security verification|unusual traffic|just a moment)/i;
const LOGIN_TEXT = /^(?:请先登录|登录后购买|您尚未登录|登录已失效|立即登录)$/im;
const SOLD_OUT_TEXT = /(?:已售罄|暂时无票|缺货登记|本场次无票|该票档无票|已停售)/i;
const QUEUE_TEXT = /(?:正在排队|排队中|前方还有.+人|请耐心等待)/i;
const TOTAL_LABEL = /(?:合计|应付|总价|订单金额|实付款)/i;
const CURRENCY = /(?:[￥¥]\s*([0-9]{1,7}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)(?![0-9.,])|(?<![0-9.,])([0-9]{1,7}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)(?![0-9.,])\s*元)/g;

function parseYuanNumber(raw: string): number | undefined {
  const normalized = raw.replaceAll(",", "");
  const match = /^([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(normalized);
  if (!match?.[1]) return undefined;
  const yuan = Number(match[1]);
  if (!Number.isSafeInteger(yuan) || yuan < 0) return undefined;
  const fractionalFen = Number((match[2] ?? "").padEnd(2, "0"));
  const fen = yuan * 100 + fractionalFen;
  return Number.isSafeInteger(fen) ? fen : undefined;
}

function normalizeIdentity(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\p{P}\p{S}\p{Z}]+/gu, "")
    .trim();
}

function normalizeOpaqueEventId(value: string): string {
  return value.normalize("NFKC").trim();
}

export function extractFen(text: string): number[] {
  const values: number[] = [];
  for (const match of text.matchAll(CURRENCY)) {
    const raw = match[1] ?? match[2];
    if (raw === undefined) continue;
    const value = parseYuanNumber(raw);
    if (value !== undefined) values.push(value);
  }
  return values;
}

async function anyVisible(locator: Locator): Promise<boolean> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

async function visibleCount(locator: Locator): Promise<number> {
  const count = await locator.count();
  let visible = 0;
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) visible += 1;
  }
  return visible;
}

async function uniqueVisibleText(locator: Locator): Promise<string | undefined> {
  const count = await locator.count();
  let result: string | undefined;
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const value = (await candidate.innerText().catch(() => "")).trim();
    if (!value) continue;
    if (result !== undefined) return undefined;
    result = value.slice(0, 300);
  }
  return result;
}

function toPriceObservation(values: number[], invalid: boolean): PriceObservation {
  if (invalid) return { kind: "invalid", valuesFen: [...new Set(values)] };
  const unique = [...new Set(values)];
  if (unique.length === 0) return { kind: "missing", valuesFen: [] };
  if (unique.length === 1) {
    const totalFen = unique[0];
    if (totalFen === undefined) return { kind: "invalid", valuesFen: [] };
    return { kind: "unique", valuesFen: [totalFen], totalFen };
  }
  return { kind: "ambiguous", valuesFen: unique };
}

async function readTotal(page: Page, bodyText: string): Promise<PriceObservation> {
  const values: number[] = [];
  let invalid = false;
  const explicitTotals = page.locator('[data-testid="order-total"], [data-order-total-fen]');
  const explicitCount = await explicitTotals.count();

  for (let index = 0; index < explicitCount; index += 1) {
    const candidate = explicitTotals.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const fenAttribute = await candidate.getAttribute("data-order-total-fen");
    const textValues = extractFen(await candidate.innerText().catch(() => ""));
    // Number("") is zero. Require a present, non-empty canonical integer
    // string and exactly one matching visible currency amount.
    if (fenAttribute === null || !/^(?:0|[1-9][0-9]*)$/.test(fenAttribute)) {
      invalid = true;
      continue;
    }
    const fen = Number(fenAttribute);
    if (!Number.isSafeInteger(fen) || fen < 0) {
      invalid = true;
      continue;
    }
    // Visible text is the user's source of truth. Metadata may corroborate it,
    // never contradict or silently override it.
    if (textValues.length !== 1 || textValues[0] !== fen) {
      invalid = true;
      values.push(fen, ...textValues);
      continue;
    }
    values.push(fen);
  }

  if (values.length === 0 && !invalid) {
    for (const line of bodyText.split(/\r?\n/)) {
      if (TOTAL_LABEL.test(line)) values.push(...extractFen(line));
    }
  }

  return toPriceObservation(values, invalid);
}

function eventIdsFromUrl(urlValue: string): string[] {
  try {
    const url = new URL(urlValue);
    const values: string[] = [];
    for (const key of ["id", "itemId", "projectId", "showId"]) {
      const value = url.searchParams.get(key);
      if (value?.trim()) values.push(value.trim());
    }
    const pathMatch = /(?:item|show|project)[\/-]([A-Za-z0-9_-]{2,})/i.exec(url.pathname);
    if (pathMatch?.[1]) values.push(pathMatch[1]);
    return values;
  } catch {
    return [];
  }
}

export async function collectPageSignals(page: Page): Promise<PageSignals> {
  const body = page.locator("body");
  const readable = await body.isVisible().catch(() => false);
  const bodyText = readable ? await body.innerText({ timeout: 3_000 }).catch(() => "") : "";
  const url = page.url();
  const title = await page.title().catch(() => "");

  const captchaSelector = page.locator(
    'iframe[src*="captcha" i], iframe[src*="turnstile" i], iframe[src*="challenge" i], iframe[src*="geetest" i], iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[title*="challenge" i], iframe[title*="验证" i], .cf-turnstile, [class*="captcha" i], [class*="geetest" i], [id*="captcha" i], [id*="turnstile" i], [data-testid="captcha"], [data-testid="turnstile"], [data-sitekey]'
  );
  const loginSelector = page.locator('[data-testid="login-required"], form[action*="login" i]');
  const soldOutSelector = page.locator('[data-testid="sold-out"], [aria-label*="售罄"]');

  const captchaRequired =
    CAPTCHA_TEXT.test(bodyText) ||
    /(?:\/cdn-cgi\/challenge-platform|captcha|turnstile|geetest|recaptcha|hcaptcha)/i.test(url) ||
    (await anyVisible(captchaSelector));
  const loginRequired =
    /(?:login|passport)/i.test(new URL(url, "http://localhost").pathname) ||
    LOGIN_TEXT.test(bodyText) ||
    (await anyVisible(loginSelector));
  const soldOut = SOLD_OUT_TEXT.test(bodyText) || (await anyVisible(soldOutSelector));
  const inOfficialQueue = QUEUE_TEXT.test(bodyText) || (await anyVisible(page.locator('[data-testid="official-queue"]')));

  const visibleEventTitle = await uniqueVisibleText(
    page.locator('[data-testid="event-title"]')
  );
  const eventIdCandidates = new Map<string, string>();
  const addEventId = (value: string | null | undefined): void => {
    const raw = value?.trim();
    if (!raw) return;
    eventIdCandidates.set(normalizeOpaqueEventId(raw), raw);
  };
  const eventIdElements = page.locator("[data-event-id]");
  const eventIdElementCount = await eventIdElements.count();
  for (let index = 0; index < eventIdElementCount; index += 1) {
    addEventId(await eventIdElements.nth(index).getAttribute("data-event-id").catch(() => null));
  }
  for (const candidate of eventIdsFromUrl(url)) addEventId(candidate);
  for (const match of bodyText.matchAll(/活动\s*ID\s*[：:]\s*([A-Za-z0-9_-]+)/gi)) addEventId(match[1]);
  const eventId = eventIdCandidates.size === 1 ? eventIdCandidates.values().next().value as string : undefined;
  const adjacentAvailable =
    (await visibleCount(page.locator('[data-testid="adjacent-confirmed"][data-adjacent="true"]'))) === 1;
  const paymentLocator = page.locator('[data-testid="order-result"][data-state="PAY_REQUIRED"], [data-payment-required="true"]');
  let visiblePaymentCount = 0;
  let soleOrderReference: string | undefined;
  const paymentCount = await paymentLocator.count();
  for (let index = 0; index < paymentCount; index += 1) {
    const candidate = paymentLocator.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    visiblePaymentCount += 1;
    const reference = (await candidate.getAttribute("data-order-reference").catch(() => null))?.trim();
    if (visiblePaymentCount === 1 && reference) soleOrderReference = reference;
  }
  const paymentRequired = visiblePaymentCount === 1 && soleOrderReference !== undefined;
  const orderReference = paymentRequired ? soleOrderReference : undefined;

  const evidence: string[] = [];
  if (!readable) evidence.push("body-unreadable");
  if (captchaRequired) evidence.push("captcha-visible");
  if (loginRequired) evidence.push("login-required");
  if (soldOut) evidence.push("sold-out");
  if (inOfficialQueue) evidence.push("official-queue");
  if (paymentRequired) evidence.push("payment-required");
  else if (visiblePaymentCount > 0) evidence.push("payment-evidence-invalid");

  return {
    url,
    title,
    ...(visibleEventTitle === undefined ? {} : { eventTitle: visibleEventTitle }),
    ...(eventId === undefined ? {} : { eventId }),
    readable,
    captchaRequired,
    loginRequired,
    soldOut,
    inOfficialQueue,
    adjacentAvailable,
    paymentRequired,
    ...(orderReference === undefined ? {} : { orderReference }),
    price: await readTotal(page, bodyText),
    evidence
  };
}

function guardEventIdentity(signals: PageSignals, plan: WatchPlan): GuardDecision | undefined {
  if (plan.eventId) {
    if (!signals.eventId || normalizeOpaqueEventId(signals.eventId) !== normalizeOpaqueEventId(plan.eventId)) {
      return { blocked: true, state: "PAGE_CHANGED", message: "Visible event ID does not match the armed plan" };
    }
  }
  if (plan.eventTitle) {
    const expected = normalizeIdentity(plan.eventTitle);
    const observed = signals.eventTitle === undefined ? "" : normalizeIdentity(signals.eventTitle);
    if (!expected || !observed || observed !== expected) {
      return { blocked: true, state: "PAGE_CHANGED", message: "Visible event title does not match the armed plan" };
    }
  }
  return undefined;
}

export function guardPage(signals: PageSignals, phase: AdapterPhase, plan: WatchPlan): GuardDecision {
  if (!signals.readable) return { blocked: true, state: "PAGE_CHANGED", message: "Page body is not readable" };
  const identityGuard = guardEventIdentity(signals, plan);
  if (identityGuard) return identityGuard;
  if (signals.captchaRequired) {
    return { blocked: true, state: "CAPTCHA_REQUIRED", message: "Verification is visible; human takeover required" };
  }
  if (signals.loginRequired) {
    return { blocked: true, state: "LOGIN_EXPIRED", message: "Login is missing or expired; human login required" };
  }
  if (signals.soldOut) return { blocked: true, state: "SOLD_OUT", message: "The visible page reports sold out" };

  if (phase !== "verify" && phase !== "submit") return { blocked: false };
  if (plan.requireAdjacent && plan.quantity > 1 && signals.adjacentAvailable !== true) {
    return { blocked: true, state: "PAGE_CHANGED", message: "Adjacent seating was required but could not be verified" };
  }
  if (signals.price.kind === "missing") {
    return { blocked: true, state: "PAGE_CHANGED", message: "A unique visible order total is required before submit" };
  }
  if (signals.price.kind === "ambiguous") {
    return { blocked: true, state: "PAGE_CHANGED", message: "Multiple visible order totals disagree" };
  }
  if (signals.price.kind === "invalid") {
    return { blocked: true, state: "PAGE_CHANGED", message: "The visible order total is malformed or contradicts metadata" };
  }

  const observedTotalFen = signals.price.totalFen;
  if (plan.maxTotalFen !== undefined && observedTotalFen > plan.maxTotalFen) {
    return {
      blocked: true,
      state: "PRICE_LIMIT_EXCEEDED",
      message: `Visible total ${observedTotalFen} fen exceeds configured maximum ${plan.maxTotalFen} fen`,
      observedTotalFen
    };
  }
  return { blocked: false, observedTotalFen };
}
