import { access } from "node:fs/promises";

import { chromium } from "playwright-core";

import {
  assertLoopbackBenchmarkGates,
  assertLoopbackBenchmarkUrl,
  assertSameBenchmarkOrigin,
  closeLoopbackBenchmarkServer,
  runLoopbackHotPathBenchmark,
  startLoopbackBenchmarkServer
} from "../dist/src/performance/loopback-benchmark.js";
import { serializePerformanceReport } from "../dist/src/performance/metrics.js";

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
      // Continue through fixed local executable candidates without printing paths.
    }
  }
  throw new Error("BENCHMARK_CHROME_NOT_FOUND");
}

async function main() {
  if (process.argv.length !== 2) throw new Error("BENCHMARK_ARGUMENTS_BLOCKED");
  const started = await startLoopbackBenchmarkServer();
  const benchmark = assertLoopbackBenchmarkUrl(started.url);
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
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block"
    });
    let blockedNetwork = false;
    await context.route("**/*", async (route) => {
      try {
        assertSameBenchmarkOrigin(route.request().url(), benchmark.href);
        await route.continue();
      } catch {
        blockedNetwork = true;
        await route.abort("blockedbyclient");
      }
    });
    const page = await context.newPage();
    await page.goto(benchmark.href, { waitUntil: "domcontentloaded", timeout: 15_000 });
    if (blockedNetwork) throw new Error("BENCHMARK_NETWORK_BLOCKED");

    const report = await runLoopbackHotPathBenchmark(page, benchmark.href);
    if (blockedNetwork) throw new Error("BENCHMARK_NETWORK_BLOCKED");
    assertLoopbackBenchmarkGates(report);
    process.stdout.write(`${serializePerformanceReport(report)}\n`);
    await context.close();
  } finally {
    await browser?.close();
    await closeLoopbackBenchmarkServer(started.server);
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error && /^BENCHMARK_[A-Z_]+(?::[a-z_]+)?$/.test(error.message)
    ? error.message
    : "BENCHMARK_FAILED";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
