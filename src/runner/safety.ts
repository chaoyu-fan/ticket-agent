import type { Platform, WatchPlan } from "../core/types.js";

import type { RunnerMode } from "./types.js";

export interface TargetCheck {
  ok: boolean;
  message: string;
  url?: URL;
}

function isLoopback(url: URL): boolean {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isOfficialHost(platform: Platform, hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^www\./, "");
  const root = platform === "damai" ? "damai.cn" : "maoyan.com";
  return normalized === root || normalized.endsWith(`.${root}`);
}

export function isOfficialUrl(platform: Platform, url: URL): boolean {
  return url.protocol === "https:" && isOfficialHost(platform, url.hostname) && !url.username && !url.password && (url.port === "" || url.port === "443");
}

export function checkRunTarget(plan: WatchPlan, mode: RunnerMode, targetUrl: string | undefined): TargetCheck {
  if (mode !== "dry-run" && mode !== "mock" && mode !== "live") {
    return { ok: false, message: "Runner mode must be explicitly dry-run, mock, or live" };
  }
  if (!targetUrl) {
    if (mode === "dry-run") return { ok: true, message: "No target supplied; dry-run remains read-only" };
    return { ok: false, message: `${mode} mode requires a target URL` };
  }

  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return { ok: false, message: "Target URL is malformed" };
  }
  if (parsed.username || parsed.password) return { ok: false, message: "Target URL must not contain credentials" };

  const loopbackHttp = (parsed.protocol === "http:" || parsed.protocol === "https:") && isLoopback(parsed);
  const official = isOfficialUrl(plan.platform, parsed);
  if (mode === "mock") {
    if (!loopbackHttp) {
      return { ok: false, message: "Mock mode only permits localhost/loopback HTTP(S) targets" };
    }
  } else if (mode === "live" && !official) {
    return {
      ok: false,
      message: `Only an HTTPS official ${plan.platform} URL is permitted outside mock mode`
    };
  } else if (mode === "dry-run" && !official && !loopbackHttp) {
    return { ok: false, message: "Dry-run permits only an official platform URL or a loopback mock target" };
  }

  if (mode === "live" && plan.officialUrl && parsed.href !== new URL(plan.officialUrl).href) {
    return { ok: false, message: "Live target must exactly match plan.officialUrl" };
  }
  return { ok: true, message: "Target accepted", url: parsed };
}

/**
 * Check the URL actually visible after a navigation or redirect.  This is
 * deliberately less strict than the initial live target (legitimate login,
 * detail and checkout paths can differ), but it never permits leaving the
 * platform's official host or the loopback mock boundary.
 */
export function checkObservedTarget(plan: WatchPlan, mode: RunnerMode, observedUrl: string): TargetCheck {
  let parsed: URL;
  try {
    parsed = new URL(observedUrl);
  } catch {
    return { ok: false, message: "Observed page URL is malformed" };
  }
  if (parsed.username || parsed.password) return { ok: false, message: "Observed page URL contains credentials" };
  const loopbackHttp = (parsed.protocol === "http:" || parsed.protocol === "https:") && isLoopback(parsed);
  const official = isOfficialUrl(plan.platform, parsed);
  if (mode === "mock" && !loopbackHttp) return { ok: false, message: "Mock page redirected away from loopback" };
  if (mode !== "mock" && !official && !(mode === "dry-run" && loopbackHttp)) {
    return { ok: false, message: `Observed page left the official ${plan.platform} host` };
  }
  return { ok: true, message: "Observed page URL accepted", url: parsed };
}

export function assertTarget(plan: WatchPlan, mode: RunnerMode, targetUrl: string | undefined): URL | undefined {
  const result = checkRunTarget(plan, mode, targetUrl);
  if (!result.ok) throw new Error(`TARGET_BLOCKED:${result.message}`);
  return result.url;
}
