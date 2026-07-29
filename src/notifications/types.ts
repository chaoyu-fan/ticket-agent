export type NotificationSeverity = "INFO" | "ACTION_REQUIRED" | "SUCCESS" | "ERROR";

export interface TicketNotification {
  severity: NotificationSeverity;
  title: string;
  body: string;
  planId?: string;
  runId?: string;
}

export interface Notifier {
  send(notification: TicketNotification): Promise<void>;
}

export function renderNotification(notification: TicketNotification): string {
  const references = [
    notification.planId ? `plan=${notification.planId}` : undefined,
    notification.runId ? `run=${notification.runId}` : undefined
  ].filter((value): value is string => value !== undefined);
  const suffix = references.length > 0 ? `\n${references.join(" ")}` : "";
  return `[${notification.severity}] ${notification.title}\n${notification.body}${suffix}`;
}
