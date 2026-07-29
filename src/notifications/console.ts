import type { Notifier, TicketNotification } from "./types.js";
import { renderNotification } from "./types.js";

export class ConsoleNotifier implements Notifier {
  async send(notification: TicketNotification): Promise<void> {
    process.stdout.write(`${renderNotification(notification)}\n`);
  }
}
