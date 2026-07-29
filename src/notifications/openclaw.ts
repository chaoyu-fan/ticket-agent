import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Notifier, TicketNotification } from "./types.js";
import { renderNotification } from "./types.js";

const execFileAsync = promisify(execFile);

export interface OpenClawNotifierOptions {
  target: string;
  channel?: string;
  executable?: string;
  timeoutMs?: number;
}

export class OpenClawNotifier implements Notifier {
  readonly #options: OpenClawNotifierOptions;

  constructor(options: OpenClawNotifierOptions) {
    if (!options.target.trim()) throw new Error("OPENCLAW_TARGET_REQUIRED");
    this.#options = options;
  }

  async send(notification: TicketNotification): Promise<void> {
    const args = ["message", "send"];
    if (this.#options.channel) args.push("--channel", this.#options.channel);
    args.push("--target", this.#options.target, "--message", renderNotification(notification));
    await execFileAsync(this.#options.executable ?? "openclaw", args, {
      timeout: this.#options.timeoutMs ?? 15_000,
      maxBuffer: 256 * 1024,
      windowsHide: true
    });
  }
}
