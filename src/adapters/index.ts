import type { Platform } from "../core/types.js";

import { damaiAdapter } from "./damai.js";
import { maoyanAdapter } from "./maoyan.js";
import type { TicketPlatformAdapter } from "./types.js";

export * from "./types.js";
export * from "./signals.js";
export { DamaiAdapter, damaiAdapter } from "./damai.js";
export { MaoyanAdapter, maoyanAdapter } from "./maoyan.js";

export function adapterFor(platform: Platform): TicketPlatformAdapter {
  return platform === "damai" ? damaiAdapter : maoyanAdapter;
}
