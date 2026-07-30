import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

import type { Platform } from "../core/types.js";
import {
  buildAttendeeRefAudit,
  parseAttendeeRefs,
  type AttendeeRef,
  type AttendeeRefAudit
} from "./attendee-ref.js";

export const ATTENDEE_RESOLUTION_PREWARM_MS = 10 * 60 * 1_000;
export const ATTENDEE_KEYCHAIN_SERVICE_PREFIX = "com.ticket-agent.attendee";
export const MACOS_SECURITY_PATH = "/usr/bin/security";

const execFileAsync = promisify(nodeExecFile);

export interface KeychainExecResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type KeychainExecFile = (
  file: string,
  args: readonly string[],
  options: {
    readonly encoding: "utf8";
    readonly timeout: number;
    readonly maxBuffer: number;
    readonly windowsHide: true;
    readonly shell: false;
  }
) => Promise<KeychainExecResult>;

export interface MacOsKeychainAttendeeResolverOptions {
  readonly platform?: NodeJS.Platform;
  readonly execFile?: KeychainExecFile;
  readonly now?: () => Date;
}

export interface AttendeeResolutionRequest {
  readonly platform: Platform;
  readonly attendeeRefs: unknown;
  /** Resolution is deliberately unavailable during plan creation or storage. */
  readonly phase: "PREWARM";
  readonly saleAt?: string;
}

export interface ValidatedAttendeeResolutionRequest {
  readonly platform: Platform;
  readonly attendeeRefs: readonly AttendeeRef[];
  readonly phase: "PREWARM";
  readonly saleAt?: string;
  readonly now: Date;
}

/**
 * A future Keychain implementation must keep labels private and expose them
 * only for the duration of this callback. Audit and JSON paths receive opaque
 * reference evidence instead.
 */
export interface AttendeeResolution {
  audit(): AttendeeRefAudit;
  withLabels<T>(consumer: (labels: readonly string[]) => T | Promise<T>): Promise<T>;
  dispose(): void;
}

export interface AttendeeResolver {
  resolve(request: AttendeeResolutionRequest): Promise<AttendeeResolution>;
}

export function validateAttendeeResolutionRequest(
  request: AttendeeResolutionRequest,
  now = new Date()
): ValidatedAttendeeResolutionRequest {
  if (request.phase !== "PREWARM") {
    throw new Error("ATTENDEE_RESOLUTION_PHASE_BLOCKED:PREWARM is required");
  }
  if (request.platform !== "damai" && request.platform !== "maoyan") {
    throw new Error("ATTENDEE_RESOLUTION_PLATFORM_INVALID");
  }
  const attendeeRefs = Object.freeze(parseAttendeeRefs(request.attendeeRefs));
  if (Number.isNaN(now.getTime())) throw new Error("ATTENDEE_RESOLUTION_TIME_INVALID");

  if (request.saleAt !== undefined) {
    if (!request.saleAt.includes("T") || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(request.saleAt)) {
      throw new Error("ATTENDEE_RESOLUTION_SALE_TIME_INVALID");
    }
    const saleTime = Date.parse(request.saleAt);
    if (!Number.isFinite(saleTime)) throw new Error("ATTENDEE_RESOLUTION_SALE_TIME_INVALID");
    const earliest = saleTime - ATTENDEE_RESOLUTION_PREWARM_MS;
    if (now.getTime() < earliest) {
      throw new Error("ATTENDEE_RESOLUTION_TOO_EARLY:wait for the T-10 prewarm window");
    }
  }

  return Object.freeze({
    platform: request.platform,
    attendeeRefs,
    phase: "PREWARM",
    ...(request.saleAt === undefined ? {} : { saleAt: request.saleAt }),
    now
  });
}

class MemoryAttendeeResolution implements AttendeeResolution {
  readonly #audit: AttendeeRefAudit;
  #labels: string[] | undefined;
  #inUse = false;

  constructor(refs: readonly AttendeeRef[], labels: string[]) {
    this.#audit = buildAttendeeRefAudit(refs);
    this.#labels = labels;
  }

  /**
   * Exposes a frozen array view whose values are backed by a separately
   * wipeable array. Freezing the backing array itself would make the cleanup
   * in `withLabels` throw in strict mode; after cleanup, an escaped view reads
   * empty strings instead of retaining the resolved labels.
   */
  private static readonlyView(backing: string[]): readonly string[] {
    const view = new Array<string>(backing.length);
    for (let index = 0; index < backing.length; index += 1) {
      Object.defineProperty(view, String(index), {
        configurable: false,
        enumerable: true,
        get: () => backing[index] ?? ""
      });
    }
    return Object.freeze(view);
  }

  audit(): AttendeeRefAudit {
    return this.#audit;
  }

  async withLabels<T>(consumer: (labels: readonly string[]) => T | Promise<T>): Promise<T> {
    if (this.#labels === undefined) throw new Error("ATTENDEE_RESOLUTION_DISPOSED");
    if (this.#inUse) throw new Error("ATTENDEE_RESOLUTION_ALREADY_IN_USE");
    this.#inUse = true;
    try {
      // The backing copy belongs only to this callback and is cleared
      // immediately. The frozen view remains safe even if a consumer retains
      // the reference after the callback returns.
      const backing = [...this.#labels];
      const scoped = MemoryAttendeeResolution.readonlyView(backing);
      try {
        return await consumer(scoped);
      } finally {
        backing.fill("");
      }
    } finally {
      this.#inUse = false;
    }
  }

  dispose(): void {
    if (this.#inUse) throw new Error("ATTENDEE_RESOLUTION_ALREADY_IN_USE");
    if (this.#labels !== undefined) this.#labels.fill("");
    this.#labels = undefined;
  }
}

function keychainService(platform: Platform): string {
  return `${ATTENDEE_KEYCHAIN_SERVICE_PREFIX}.${platform}`;
}

async function defaultKeychainExecFile(
  file: string,
  args: readonly string[],
  options: Parameters<KeychainExecFile>[2]
): Promise<KeychainExecResult> {
  return execFileAsync(file, [...args], options);
}

/** Reads only explicitly named generic-password items from the Mac Keychain. */
export class MacOsKeychainAttendeeResolver implements AttendeeResolver {
  readonly #platform: NodeJS.Platform;
  readonly #execFile: KeychainExecFile;
  readonly #now: () => Date;

  constructor(options: MacOsKeychainAttendeeResolverOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#execFile = options.execFile ?? defaultKeychainExecFile;
    this.#now = options.now ?? (() => new Date());
  }

  async resolve(request: AttendeeResolutionRequest): Promise<AttendeeResolution> {
    // Uses the Mac's own clock. Callers cannot supply a future timestamp to
    // cause early Keychain access before PREWARM.
    const validated = validateAttendeeResolutionRequest(request, this.#now());
    if (this.#platform !== "darwin") {
      throw new Error("MACOS_KEYCHAIN_ONLY:attendee resolution must run on the user's Mac");
    }
    const labels: string[] = [];
    try {
      for (const attendeeRef of validated.attendeeRefs) {
        let output: KeychainExecResult;
        try {
          output = await this.#execFile(
            MACOS_SECURITY_PATH,
            ["find-generic-password", "-s", keychainService(validated.platform), "-a", attendeeRef, "-w"],
            { encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024, windowsHide: true, shell: false }
          );
        } catch {
          throw new Error("ATTENDEE_KEYCHAIN_LOOKUP_FAILED");
        }
        if (output.stderr.trim() !== "") throw new Error("ATTENDEE_KEYCHAIN_LOOKUP_FAILED");
        const label = output.stdout.replace(/[\r\n]+$/, "");
        if (label.trim() === "" || label !== label.trim() || /[\r\n\0]/.test(label) || label.length > 200) {
          throw new Error("ATTENDEE_KEYCHAIN_VALUE_INVALID");
        }
        labels.push(label);
      }
      const normalizedLabels = labels.map((label) => label.normalize("NFKC").replace(/\s+/g, ""));
      try {
        if (new Set(normalizedLabels).size !== normalizedLabels.length) {
          throw new Error("ATTENDEE_KEYCHAIN_VALUE_DUPLICATE");
        }
      } finally {
        normalizedLabels.fill("");
      }
      return new MemoryAttendeeResolution(validated.attendeeRefs, labels);
    } catch (error) {
      labels.fill("");
      throw error;
    }
  }
}
