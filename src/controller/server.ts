import { pathToFileURL } from "node:url";

import { closeController, createControllerHttpServer, listenController } from "./http.js";
import { ControllerStore } from "./store.js";

export async function main(): Promise<void> {
  const token = process.env.TICKET_AGENT_TOKEN;
  if (token === undefined || Buffer.byteLength(token, "utf8") < 32) {
    throw new Error("TICKET_AGENT_TOKEN must contain at least 32 bytes");
  }
  const rawPort = process.env.TICKET_AGENT_PORT ?? "4317";
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid TICKET_AGENT_PORT: ${rawPort}`);
  }

  const store = new ControllerStore(process.env.TICKET_AGENT_DB ?? "ticket-agent.sqlite");
  const server = createControllerHttpServer({ store, token });
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
