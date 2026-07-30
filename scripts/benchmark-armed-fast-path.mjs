import { access } from "node:fs/promises";

import { chromium } from "playwright-core";

import {
  ARMED_FAST_PATH_BENCHMARK_HTML,
  ARMED_FAST_PATH_BENCHMARK_URL,
  assertArmedFastPathBenchmarkGates,
  runArmedFastPathBenchmark,
  serializeArmedFastPathBenchmarkReport
} from "../dist/src/performance/armed-fast-path-benchmark.js";

async function chromeExecutable() {
  const configured = process.env.TICKET_AGENT_CHROME;
  const candidates = [
    configured,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome"
  ].filter((value) => typeof value === "string" && value.length > 0);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Fixed local candidates only; never print a configured path.
    }
  }
  throw new Error("ARMED_FAST_PATH_BENCHMARK_CHROME_NOT_FOUND");
}

async function main() {
  if (process.argv.length !== 2) throw new Error("ARMED_FAST_PATH_BENCHMARK_ARGUMENTS_BLOCKED");
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: await chromeExecutable(),
      headless: true,
      args: [
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-domain-reliability",
        "--disable-sync",
        "--metrics-recording-only",
        "--no-first-run"
      ]
    });
    // Ephemeral context only: never a live, sandbox, or daily profile.
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block"
    });
    let unexpectedNetwork = false;
    let fulfilledDocuments = 0;
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (
        request.url() === ARMED_FAST_PATH_BENCHMARK_URL &&
        request.method() === "GET" &&
        request.resourceType() === "document"
      ) {
        fulfilledDocuments += 1;
        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          headers: {
            "cache-control": "no-store",
            "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff"
          },
          body: ARMED_FAST_PATH_BENCHMARK_HTML
        });
        return;
      }
      unexpectedNetwork = true;
      await route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    await page.goto(ARMED_FAST_PATH_BENCHMARK_URL, {
      waitUntil: "domcontentloaded",
      timeout: 15_000
    });
    if (unexpectedNetwork || fulfilledDocuments !== 1) {
      throw new Error("ARMED_FAST_PATH_BENCHMARK_NETWORK_BLOCKED");
    }
    const report = await runArmedFastPathBenchmark(page);
    if (unexpectedNetwork || fulfilledDocuments < 5) {
      throw new Error("ARMED_FAST_PATH_BENCHMARK_NETWORK_BLOCKED");
    }
    assertArmedFastPathBenchmarkGates(report);
    process.stdout.write(`${serializeArmedFastPathBenchmarkReport(report)}\n`);
    await context.close();
  } finally {
    await browser?.close();
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error && /^ARMED_FAST_PATH_BENCHMARK_[A-Z_]+$/.test(error.message)
    ? error.message
    : "ARMED_FAST_PATH_BENCHMARK_FAILED";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
