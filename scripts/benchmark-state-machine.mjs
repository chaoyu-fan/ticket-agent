import { access } from "node:fs/promises";

import { chromium } from "playwright-core";

import {
  assertSameStateMachineBenchmarkOrigin,
  assertStateMachineBenchmarkUrl,
  closeStateMachineBenchmarkServer,
  runStateMachineBenchmark,
  serializeStateMachineBenchmarkReport,
  startStateMachineBenchmarkServer
} from "../dist/src/performance/state-machine-benchmark.js";

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
  throw new Error("STATE_MACHINE_BENCHMARK_CHROME_NOT_FOUND");
}

async function main() {
  if (process.argv.length !== 2) throw new Error("STATE_MACHINE_BENCHMARK_ARGUMENTS_BLOCKED");
  const started = await startStateMachineBenchmarkServer();
  const benchmark = assertStateMachineBenchmarkUrl(started.url);
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
    // newContext is ephemeral and never points at a live/sandbox/daily profile.
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block"
    });
    let blockedNetwork = false;
    await context.route("**/*", async (route) => {
      try {
        assertSameStateMachineBenchmarkOrigin(route.request().url(), benchmark.href);
        await route.continue();
      } catch {
        blockedNetwork = true;
        await route.abort("blockedbyclient");
      }
    });
    const page = await context.newPage();
    await page.goto(benchmark.href, { waitUntil: "domcontentloaded", timeout: 15_000 });
    if (blockedNetwork) throw new Error("STATE_MACHINE_BENCHMARK_NETWORK_BLOCKED");

    const report = await runStateMachineBenchmark(page, benchmark.href);
    if (blockedNetwork) throw new Error("STATE_MACHINE_BENCHMARK_NETWORK_BLOCKED");
    process.stdout.write(`${serializeStateMachineBenchmarkReport(report)}\n`);
    await context.close();
  } finally {
    await browser?.close();
    await closeStateMachineBenchmarkServer(started.server);
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error && /^STATE_MACHINE_BENCHMARK_[A-Z_]+$/.test(error.message)
    ? error.message
    : "STATE_MACHINE_BENCHMARK_FAILED";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

