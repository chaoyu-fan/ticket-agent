import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { Page } from "playwright-core";

// MutationObserver is the primary trigger. A frame-sized fallback bounds
// missed/non-observed property changes without busy-spinning the page.
export const DEFAULT_DOM_FALLBACK_INTERVAL_MS = 16;
const DOM_WAIT_CANCEL_ACK_TIMEOUT_MS = 250;

export type DomVisibility = "visible" | "hidden";

export interface DomPredicate {
  /** A caller-defined, non-sensitive identifier returned when this predicate matches. */
  key: string;
  selector: string;
  visibility?: DomVisibility;
}

export interface WaitForDomPredicateOptions {
  predicates: readonly DomPredicate[];
  timeoutMs: number;
  fallbackIntervalMs?: number;
  signal?: AbortSignal;
}

export type DomPredicateResult =
  | {
      outcome: "matched";
      key: string;
      visibility: DomVisibility;
      source: "initial" | "mutation" | "fallback";
      /** End-to-end latency measured with Node's monotonic performance clock. */
      latencyMs: number;
    }
  | {
      outcome: "timeout";
      source: "timeout";
      /** End-to-end latency measured with Node's monotonic performance clock. */
      latencyMs: number;
    }
  | {
      outcome: "aborted";
      source: "abort";
      /** End-to-end latency measured with Node's monotonic performance clock. */
      latencyMs: number;
    };

type BrowserWaitResult =
  | { outcome: "matched"; key: string; visibility: DomVisibility; source: "initial" | "mutation" | "fallback" }
  | { outcome: "timeout"; source: "timeout" }
  | { outcome: "cancelled"; source: "abort" };

interface BrowserWaitInput {
  waitId: string;
  predicates: { key: string; selector: string; visibility: DomVisibility }[];
  timeoutMs: number;
  fallbackIntervalMs: number;
}

interface BrowserWaitRegistry {
  [waitId: string]: (() => void) | "cancelled" | undefined;
}

function validateOptions(options: WaitForDomPredicateOptions): BrowserWaitInput["predicates"] {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error("DOM_WAIT_TIMEOUT_INVALID:timeoutMs must be a positive integer");
  }
  const fallbackIntervalMs = options.fallbackIntervalMs ?? DEFAULT_DOM_FALLBACK_INTERVAL_MS;
  if (!Number.isSafeInteger(fallbackIntervalMs) || fallbackIntervalMs < 1) {
    throw new Error("DOM_WAIT_FALLBACK_INVALID:fallbackIntervalMs must be a positive integer");
  }
  if (!Array.isArray(options.predicates) || options.predicates.length === 0) {
    throw new Error("DOM_WAIT_PREDICATES_REQUIRED:at least one predicate is required");
  }

  const keys = new Set<string>();
  return options.predicates.map((predicate) => {
    const key = predicate.key.trim();
    const selector = predicate.selector.trim();
    if (!key || key.length > 100) throw new Error("DOM_WAIT_KEY_INVALID:keys must contain 1-100 characters");
    if (keys.has(key)) throw new Error(`DOM_WAIT_KEY_DUPLICATE:${key}`);
    keys.add(key);
    if (!selector) throw new Error(`DOM_WAIT_SELECTOR_INVALID:${key}`);
    const visibility = predicate.visibility ?? "visible";
    if (visibility !== "visible" && visibility !== "hidden") {
      throw new Error(`DOM_WAIT_VISIBILITY_INVALID:${key}`);
    }
    return { key, selector, visibility };
  });
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
}

/**
 * Waits for one of a small set of caller-defined visibility predicates.
 *
 * The page task observes DOM mutations and uses a 16 ms fallback scan by
 * default. It does not click, navigate, reload, read text, or issue requests.
 * Only the configured predicate key and visibility are returned to Node.
 */
export async function waitForDomPredicate(
  page: Pick<Page, "evaluate">,
  options: WaitForDomPredicateOptions
): Promise<DomPredicateResult> {
  const startedAt = performance.now();
  const predicates = validateOptions(options);
  const fallbackIntervalMs = options.fallbackIntervalMs ?? DEFAULT_DOM_FALLBACK_INTERVAL_MS;

  if (options.signal?.aborted) {
    return { outcome: "aborted", source: "abort", latencyMs: elapsedSince(startedAt) };
  }

  const waitId = randomUUID();
  const browserWait = page.evaluate(
    ({ waitId, predicates, timeoutMs, fallbackIntervalMs }: BrowserWaitInput): Promise<BrowserWaitResult> => {
      const registryName = "__ticketAgentVisibleDomWaiters_v1";
      const scope = globalThis as typeof globalThis & { __ticketAgentVisibleDomWaiters_v1?: BrowserWaitRegistry };
      const registry = scope[registryName] ??= Object.create(null) as BrowserWaitRegistry;

      if (registry[waitId] === "cancelled") {
        delete registry[waitId];
        return Promise.resolve({ outcome: "cancelled", source: "abort" });
      }

      const visible = (element: Element): boolean => {
        const html = element as HTMLElement;
        if (!element.isConnected || html.hidden || element.getAttribute("aria-hidden") === "true") return false;
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

      const matches = (predicate: BrowserWaitInput["predicates"][number]): boolean => {
        let anyVisible = false;
        for (const element of Array.from(document.querySelectorAll(predicate.selector))) {
          if (visible(element)) {
            anyVisible = true;
            break;
          }
        }
        return predicate.visibility === "visible" ? anyVisible : !anyVisible;
      };

      // Validate every selector before installing a long-lived observer. The
      // error contains only the caller's key, never page content.
      for (const predicate of predicates) {
        try {
          document.querySelectorAll(predicate.selector);
        } catch {
          throw new Error(`DOM_WAIT_SELECTOR_INVALID:${predicate.key}`);
        }
      }

      return new Promise<BrowserWaitResult>((resolve) => {
        let settled = false;
        let observer: MutationObserver | undefined;
        let fallbackTimer: ReturnType<typeof setInterval> | undefined;
        let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

        const finish = (result: BrowserWaitResult): void => {
          if (settled) return;
          settled = true;
          observer?.disconnect();
          if (fallbackTimer !== undefined) clearInterval(fallbackTimer);
          if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
          delete registry[waitId];
          resolve(result);
        };

        const inspect = (source: "initial" | "mutation" | "fallback"): void => {
          if (settled) return;
          for (const predicate of predicates) {
            if (matches(predicate)) {
              finish({
                outcome: "matched",
                key: predicate.key,
                visibility: predicate.visibility,
                source
              });
              return;
            }
          }
        };

        if (registry[waitId] === "cancelled") {
          finish({ outcome: "cancelled", source: "abort" });
          return;
        }
        registry[waitId] = () => finish({ outcome: "cancelled", source: "abort" });
        observer = new MutationObserver(() => inspect("mutation"));
        observer.observe(document.documentElement ?? document, {
          attributes: true,
          childList: true,
          subtree: true
        });
        fallbackTimer = setInterval(() => inspect("fallback"), fallbackIntervalMs);
        timeoutTimer = setTimeout(() => finish({ outcome: "timeout", source: "timeout" }), timeoutMs);
        inspect("initial");
      });
    },
    { waitId, predicates, timeoutMs: options.timeoutMs, fallbackIntervalMs }
  );

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
    // Browser timers can be throttled for a background tab. A Node-side timer
    // preserves the deadline while the in-page timer remains a cleanup-safe
    // second line of defense.
    nodeTimeout = setTimeout(() => resolve("timeout"), options.timeoutMs);
  });

  const cancelPageWait = async (): Promise<void> => {
    const cancellation = page.evaluate(
      ({ waitId }: { waitId: string }): void => {
        const registryName = "__ticketAgentVisibleDomWaiters_v1";
        const scope = globalThis as typeof globalThis & { __ticketAgentVisibleDomWaiters_v1?: BrowserWaitRegistry };
        const registry = scope[registryName] ??= Object.create(null) as BrowserWaitRegistry;
        const current = registry[waitId];
        if (typeof current === "function") {
          current();
          return;
        }
        registry[waitId] = "cancelled";
        const cleanupTimer = setTimeout(() => {
          if (registry[waitId] === "cancelled") delete registry[waitId];
        }, 30_000);
        (cleanupTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
      },
      { waitId }
    ).then(() => true, () => false);
    let acknowledgementTimer: ReturnType<typeof setTimeout> | undefined;
    const acknowledged = await Promise.race([
      cancellation,
      new Promise<false>((resolve) => {
        acknowledgementTimer = setTimeout(() => resolve(false), DOM_WAIT_CANCEL_ACK_TIMEOUT_MS);
      })
    ]);
    if (acknowledgementTimer !== undefined) clearTimeout(acknowledgementTimer);
    if (!acknowledged) {
      void browserWait.catch(() => undefined);
      return;
    }
    let settlementTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        browserWait.catch(() => undefined),
        new Promise<void>((resolve) => {
          settlementTimer = setTimeout(resolve, DOM_WAIT_CANCEL_ACK_TIMEOUT_MS);
        })
      ]);
    } finally {
      if (settlementTimer !== undefined) clearTimeout(settlementTimer);
    }
  };

  try {
    type WaitWinner =
      | { kind: "browser"; result: BrowserWaitResult }
      | { kind: "timeout" }
      | { kind: "abort" };
    const candidates: Promise<WaitWinner>[] = [
      browserWait.then((result): WaitWinner => ({ kind: "browser", result })),
      timeoutWait.then((): WaitWinner => ({ kind: "timeout" }))
    ];
    if (abortWait !== undefined) candidates.push(abortWait.then(() => ({ kind: "abort" as const })));
    const winner = await Promise.race(candidates);

    if (winner.kind === "abort") {
      // A bounded acknowledgement closes the pre-registration race without
      // allowing a closing/unresponsive page to block AbortSignal forever.
      await cancelPageWait();
      return { outcome: "aborted", source: "abort", latencyMs: elapsedSince(startedAt) };
    }
    if (winner.kind === "timeout") {
      await cancelPageWait();
      return { outcome: "timeout", source: "timeout", latencyMs: elapsedSince(startedAt) };
    }

    const result = winner.result;
    if (result.outcome === "matched") {
      return { ...result, latencyMs: elapsedSince(startedAt) };
    }
    if (result.outcome === "timeout") {
      return { outcome: "timeout", source: "timeout", latencyMs: elapsedSince(startedAt) };
    }
    return { outcome: "aborted", source: "abort", latencyMs: elapsedSince(startedAt) };
  } finally {
    if (nodeTimeout !== undefined) clearTimeout(nodeTimeout);
    detachAbort?.();
  }
}
