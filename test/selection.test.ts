import assert from "node:assert/strict";
import test from "node:test";
import { chooseTier } from "../src/core/selection.js";
import type { WatchPlan } from "../src/core/types.js";

const basePlan = (overrides: Partial<WatchPlan> = {}): WatchPlan => ({
  id: "plan-1",
  platform: "damai",
  quantity: 1,
  requireAdjacent: false,
  sessions: [],
  tiers: [],
  priceStrategy: "CHEAPEST_FIRST",
  attendeeAliases: [],
  autoSubmitOrder: false,
  status: "DRAFT",
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
  ...overrides
});

test("cheapest-first chooses the lowest available total", () => {
  const choice = chooseTier(basePlan({ quantity: 2 }), [
    { label: "A", unitPriceFen: 88_000, available: true },
    { label: "B", unitPriceFen: 58_000, available: true },
    { label: "C", unitPriceFen: 38_000, available: false }
  ]);
  assert.deepEqual(choice, { label: "B", unitPriceFen: 58_000, totalFen: 116_000, available: true });
});

test("max total filters out otherwise valid tiers", () => {
  const choice = chooseTier(basePlan({ quantity: 2, maxTotalFen: 100_000 }), [
    { label: "A", unitPriceFen: 58_000, available: true },
    { label: "B", unitPriceFen: 48_000, available: true }
  ]);
  assert.equal(choice?.label, "B");
});

test("configured tiers prevent an unexpected fallback zone", () => {
  const choice = chooseTier(
    basePlan({ tiers: [{ label: "看台", priority: 1 }] }),
    [
      { label: "内场", unitPriceFen: 18_000, available: true },
      { label: "看台", unitPriceFen: 28_000, available: true }
    ]
  );
  assert.equal(choice?.label, "看台");
});

test("per-tier unit price ceiling is enforced before selection", () => {
  const choice = chooseTier(
    basePlan({ tiers: [{ label: "看台", priority: 1, maxUnitPriceFen: 30_000 }] }),
    [{ label: "看台", unitPriceFen: 38_000, available: true }]
  );
  assert.equal(choice, undefined);
});
