import type { Page } from "playwright-core";

import type { AdapterContext, AdapterPhase, AdapterStepResult, ApprovedSubmitContext, GuardDecision, PageSignals, TicketPlatformAdapter } from "./types.js";

/**
 * Explicit placeholder until the Maoyan UI has a separately reviewed adapter.
 * It intentionally has no selectors, network calls, or fallback behavior.
 */
export class MaoyanAdapter implements TicketPlatformAdapter {
  readonly platform = "maoyan" as const;
  readonly implemented = false;
  readonly liveReady = false;
  readonly fastPathReady = false;
  readonly fastPathContractDigest = undefined;
  readonly fastPathContract = undefined;

  supportsOfficialUrl(url: URL): boolean {
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    return url.protocol === "https:" && (hostname === "maoyan.com" || hostname.endsWith(".maoyan.com")) && !url.username && !url.password && (url.port === "" || url.port === "443");
  }

  private unavailable(): never {
    throw new Error("ADAPTER_NOT_IMPLEMENTED:maoyan");
  }

  async navigate(_page: Page, _url: string): Promise<void> {
    this.unavailable();
  }

  async inspect(_context: AdapterContext, _phase: AdapterPhase): Promise<PageSignals> {
    this.unavailable();
  }

  guard(_signals: PageSignals, _phase: AdapterPhase, _plan: AdapterContext["plan"]): GuardDecision {
    return { blocked: true, state: "PAGE_CHANGED", message: "Maoyan adapter is not implemented yet" };
  }

  async selectSession(_context: AdapterContext): Promise<AdapterStepResult> {
    this.unavailable();
  }

  async selectTier(_context: AdapterContext): Promise<AdapterStepResult> {
    this.unavailable();
  }

  async selectQuantity(_context: AdapterContext): Promise<AdapterStepResult> {
    this.unavailable();
  }

  async selectAttendees(_context: AdapterContext): Promise<AdapterStepResult> {
    this.unavailable();
  }

  async submitOrder(_context: ApprovedSubmitContext): Promise<AdapterStepResult> {
    this.unavailable();
  }
}

export const maoyanAdapter = new MaoyanAdapter();
