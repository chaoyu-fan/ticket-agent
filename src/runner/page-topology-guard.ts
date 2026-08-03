import type { BrowserContext, Page } from "playwright-core";

/** Stable, mode-neutral failure used when the runner loses its canonical page. */
export const PAGE_TOPOLOGY_INVALID = "PAGE_TOPOLOGY_INVALID";

export interface ExactPageTopologyGuard {
  /** The one page this run is allowed to use. */
  readonly page: Page;
  /** Aborts long-running browser work after the first topology violation. */
  readonly signal: AbortSignal;
  /** Re-checks the exact page identity. A violation remains sticky. */
  recheck(): boolean;
  /** Throws a stable error when the guard is no longer usable. */
  assertValid(): void;
  /** Idempotently removes listeners after all automation has stopped. */
  dispose(): void;
}

function topologyError(): Error {
  return new Error(PAGE_TOPOLOGY_INVALID);
}

/**
 * Starts a listener-first, exact-page guard.
 *
 * The listeners are installed before the first pages() snapshot. That closes
 * the check-then-subscribe race: a popup which opens and closes between two
 * snapshots still aborts the run permanently. The guard is intentionally
 * independent of a runner mode so rehearsal and live can share the exact
 * same lifecycle protection.
 */
export function startExactPageTopologyGuard(page: Page): ExactPageTopologyGuard {
  let context: BrowserContext;
  try {
    context = page.context();
  } catch {
    throw topologyError();
  }

  const abortController = new AbortController();
  let violated = false;
  let disposed = false;

  const violate = (): void => {
    if (violated) return;
    violated = true;
    abortController.abort(topologyError());
  };
  const onNewPage = (): void => violate();
  const onContextClose = (): void => violate();
  const onCanonicalPageClose = (): void => violate();

  // Listener-first is deliberate. Do not move the snapshot above these.
  context.on("page", onNewPage);
  context.on("close", onContextClose);
  page.on("close", onCanonicalPageClose);

  const cleanup = (): void => {
    context.off("page", onNewPage);
    context.off("close", onContextClose);
    page.off("close", onCanonicalPageClose);
  };

  const recheck = (): boolean => {
    if (disposed || violated) return false;
    try {
      const pages = context.pages();
      if (
        context.isClosed() ||
        page.isClosed() ||
        pages.length !== 1 ||
        pages[0] !== page
      ) {
        violate();
      }
    } catch {
      violate();
    }
    return !violated && !disposed;
  };

  const guard: ExactPageTopologyGuard = {
    page,
    signal: abortController.signal,
    recheck,
    assertValid(): void {
      if (!recheck()) throw topologyError();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cleanup();
    }
  };

  // Fail immediately for a pre-existing extra/closed page. This also leaves
  // no listeners behind when construction itself cannot establish a guard.
  if (!recheck()) {
    cleanup();
    disposed = true;
    throw topologyError();
  }
  return guard;
}
