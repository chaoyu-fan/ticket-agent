import { access } from "node:fs/promises";

import { chromium } from "playwright-core";

import {
  assertSameTrustedClickBenchmarkOrigin,
  assertTrustedClickBenchmarkGates,
  assertTrustedClickBenchmarkUrl,
  closeTrustedClickBenchmarkServer,
  runTrustedClickBenchmark,
  serializeTrustedClickBenchmarkReport,
  startTrustedClickBenchmarkServer
} from "../dist/src/performance/trusted-click-benchmark.js";

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
  throw new Error("TRUSTED_CLICK_BENCHMARK_CHROME_NOT_FOUND");
}

async function main() {
  if (process.argv.length !== 2) throw new Error("TRUSTED_CLICK_BENCHMARK_ARGUMENTS_BLOCKED");
  const started = await startTrustedClickBenchmarkServer();
  const benchmark = assertTrustedClickBenchmarkUrl(started.url);
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
        assertSameTrustedClickBenchmarkOrigin(route.request().url(), benchmark.href);
        await route.continue();
      } catch {
        blockedNetwork = true;
        await route.abort("blockedbyclient");
      }
    });
    const page = await context.newPage();
    await page.goto(benchmark.href, { waitUntil: "domcontentloaded", timeout: 15_000 });
    if (blockedNetwork) throw new Error("TRUSTED_CLICK_BENCHMARK_NETWORK_BLOCKED");

    const report = await runTrustedClickBenchmark(page, benchmark.href);
    if (blockedNetwork) throw new Error("TRUSTED_CLICK_BENCHMARK_NETWORK_BLOCKED");
    assertTrustedClickBenchmarkGates(report);
    process.stdout.write(`${serializeTrustedClickBenchmarkReport(report)}\n`);
    await context.close();
  } finally {
    await browser?.close();
    await closeTrustedClickBenchmarkServer(started.server);
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error && /^TRUSTED_CLICK_BENCHMARK_[A-Z_]+$/.test(error.message)
    ? error.message
    : "TRUSTED_CLICK_BENCHMARK_FAILED";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
