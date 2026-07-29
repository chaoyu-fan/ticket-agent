import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { isMockScenario, renderIndex, renderScenario, scenarioNames } from "./pages.js";

export const MOCK_HOST = "127.0.0.1";
export const DEFAULT_MOCK_PORT = 4173;

export interface StartedMockServer {
  server: Server;
  url: string;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

function sendHtml(response: ServerResponse, status: number, value: string): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    "content-type": "text/html; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  });
  response.end(value);
}

function normalizeScenario(value: string): string {
  return value.trim().toLowerCase().replaceAll("_", "-");
}

function hasValidUriEncoding(value: string): boolean {
  try {
    // URL accepts malformed percent escapes and replaces malformed UTF-8 in
    // search parameters. Decode only to validate; routing still uses URL.
    decodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

function requestedScenario(request: IncomingMessage, url: URL): string | undefined {
  const pathMatch = /^\/damai\/([^/]+)\/?$/.exec(url.pathname);
  if (pathMatch?.[1] !== undefined) return normalizeScenario(decodeURIComponent(pathMatch[1]));
  if (url.pathname === "/damai" || url.pathname === "/damai/") {
    const queryScenario = url.searchParams.get("scenario");
    return queryScenario === null ? "normal" : normalizeScenario(queryScenario);
  }
  void request;
  return undefined;
}

export function createMockServer(): Server {
  return createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
      return;
    }

    const requestTarget = request.url ?? "/";
    if (!hasValidUriEncoding(requestTarget)) {
      sendJson(response, 400, { error: "MALFORMED_URI" });
      return;
    }
    let url: URL;
    try {
      url = new URL(requestTarget, `http://${MOCK_HOST}`);
    } catch {
      sendJson(response, 400, { error: "MALFORMED_URI" });
      return;
    }
    if (url.pathname === "/healthz") {
      sendJson(response, 200, { ok: true, host: MOCK_HOST, service: "ticket-agent-mock" });
      return;
    }
    if (url.pathname === "/api/scenarios") {
      sendJson(response, 200, { platform: "damai", scenarios: scenarioNames });
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      sendHtml(response, 200, request.method === "HEAD" ? "" : renderIndex());
      return;
    }

    const scenario = requestedScenario(request, url);
    if (scenario !== undefined && isMockScenario(scenario)) {
      sendHtml(response, 200, request.method === "HEAD" ? "" : renderScenario(scenario));
      return;
    }

    sendJson(response, 404, {
      error: "NOT_FOUND",
      hint: "Use /damai/<scenario>",
      scenarios: scenarioNames
    });
  });
}

export async function startMockServer(port = DEFAULT_MOCK_PORT): Promise<StartedMockServer> {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("MOCK_PORT must be an integer between 0 and 65535");
  const server = createMockServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, MOCK_HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Mock server did not bind to a TCP address");
  }
  return { server, url: `http://${MOCK_HOST}:${address.port}` };
}

function configuredPort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_MOCK_PORT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) throw new Error("MOCK_PORT must be an integer between 0 and 65535");
  return parsed;
}

const entryUrl = process.argv[1] === undefined ? undefined : pathToFileURL(process.argv[1]).href;
if (entryUrl === import.meta.url) {
  const { server, url } = await startMockServer(configuredPort(process.env.MOCK_PORT));
  process.stdout.write(`Ticket Agent mock listening on ${url}\n`);

  const stop = (): void => {
    server.close((error) => {
      if (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
