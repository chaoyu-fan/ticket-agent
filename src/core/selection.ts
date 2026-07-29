import type { WatchPlan } from "./types.js";

export interface AvailableTier {
  label: string;
  unitPriceFen: number;
  available: boolean;
}

export interface TierChoice extends AvailableTier {
  totalFen: number;
}

const normalizedLabel = (value: string): string => value.trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");

export function chooseTier(plan: WatchPlan, availableTiers: readonly AvailableTier[]): TierChoice | undefined {
  const preferenceByLabel = new Map(
    plan.tiers.map((tier) => [normalizedLabel(tier.label), tier] as const)
  );
  const restrictToConfiguredTiers = preferenceByLabel.size > 0;

  const candidates = availableTiers
    .filter((tier) => tier.available)
    .filter((tier) => Number.isSafeInteger(tier.unitPriceFen) && tier.unitPriceFen >= 0)
    .filter((tier) => !restrictToConfiguredTiers || preferenceByLabel.has(normalizedLabel(tier.label)))
    .map((tier) => ({ ...tier, totalFen: tier.unitPriceFen * plan.quantity }))
    .filter((tier) => Number.isSafeInteger(tier.totalFen))
    .filter((tier) => {
      const configured = preferenceByLabel.get(normalizedLabel(tier.label));
      return configured?.maxUnitPriceFen === undefined || tier.unitPriceFen <= configured.maxUnitPriceFen;
    })
    .filter((tier) => plan.maxTotalFen === undefined || tier.totalFen <= plan.maxTotalFen);

  candidates.sort((left, right) => {
    if (plan.priceStrategy === "CHEAPEST_FIRST") {
      const priceOrder = left.unitPriceFen - right.unitPriceFen;
      if (priceOrder !== 0) return priceOrder;
    }
    const leftPriority = preferenceByLabel.get(normalizedLabel(left.label))?.priority ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = preferenceByLabel.get(normalizedLabel(right.label))?.priority ?? Number.MAX_SAFE_INTEGER;
    const priorityOrder = leftPriority - rightPriority;
    if (priorityOrder !== 0) return priorityOrder;
    return left.unitPriceFen - right.unitPriceFen;
  });

  return candidates[0];
}
