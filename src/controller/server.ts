import { pathToFileURL } from "node:url";

import { closeController, createControllerHttpServer, listenController } from "./http.js";
import { ControllerStore } from "./store.js";
import { SubmitCapabilityService } from "./submit-capability-service.js";

export interface ControllerServerSecrets {
  readonly token: string;
  readonly capabilityKey: string;
}

export function loadControllerServerSecrets(
  environment: Readonly<Record<string, string | undefined>> = process.env
): ControllerServerSecrets {
  const token = environment.TICKET_AGENT_TOKEN;
  if (token === undefined || Buffer.byteLength(token, "utf8") < 32) {
    throw new Error("TICKET_AGENT_TOKEN must contain at least 32 bytes");
  }
  const capabilityKey = environment.TICKET_AGENT_CAPABILITY_KEY;
  if (capabilityKey === undefined || Buffer.byteLength(capabilityKey, "utf8") < 32) {
    throw new Error("TICKET_AGENT_CAPABILITY_KEY must contain at least 32 bytes");
  }
  if (Buffer.from(token, "utf8").equals(Buffer.from(capabilityKey, "utf8"))) {
    throw new Error("TICKET_AGENT_CAPABILITY_KEY must not reuse TICKET_AGENT_TOKEN");
  }
  return Object.freeze({ token, capabilityKey });
}

export async function main(): Promise<void> {
  const { token, capabilityKey } = loadControllerServerSecrets();
  const rawPort = process.env.TICKET_AGENT_PORT ?? "4317";
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid TICKET_AGENT_PORT: ${rawPort}`);
  }

  const store = new ControllerStore(process.env.TICKET_AGENT_DB ?? "ticket-agent.sqlite");
  const submitCapabilityService = new SubmitCapabilityService(store, capabilityKey);
  const server = createControllerHttpServer({ store, token, submitCapabilityService });
  const address = await listenController(server, { host: "127.0.0.1", port });
  process.stdout.write(`ticket-agent controller listening on http://${address.host}:${address.port}\n`);

  const shutdown = async (): Promise<void> => {
    await closeController(server);
    store.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
