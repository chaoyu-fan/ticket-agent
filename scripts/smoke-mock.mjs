import assert from "node:assert/strict";
import { startMockServer } from "../dist/mock/server.js";

const expectedMarkers = new Map([
  ["normal", 'data-testid="submit-order"'],
  ["queue", 'data-testid="official-queue"'],
  ["sold-out", 'data-testid="sold-out"'],
  ["captcha", 'data-testid="captcha"'],
  ["login-expired", 'data-testid="login-required"'],
  ["price-limit", 'data-testid="price-warning"'],
  ["page-changed", 'data-testid="mock-page-changed"']
]);

const { server, url } = await startMockServer(0);
try {
  const health = await fetch(`${url}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, host: "127.0.0.1", service: "ticket-agent-mock" });

  for (const [scenario, marker] of expectedMarkers) {
    const response = await fetch(`${url}/damai/${scenario}`);
    assert.equal(response.status, 200, scenario);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
    assert.ok((await response.text()).includes(marker), `${scenario} is missing ${marker}`);
  }

  process.stdout.write(`Mock smoke check passed for ${expectedMarkers.size} scenarios on ${url}\n`);
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
