import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserSelectionContract } from "../src/runner/browser-selection-state-machine.js";
import {
  FAST_PATH_CONTRACT_VERSION,
  digestFastPathContract,
  validateFastPathContract,
  type FastPathContract
} from "../src/runner/fast-path-contract.js";

function choice(optionSelector: string, priced = false) {
  return {
    optionSelector,
    labelSelector: "[data-label]",
    labelAttribute: "data-visible-label",
    selectedSelector: '[data-selected="true"]',
    ...(priced
      ? { priceTextSelector: "[data-price]", priceFenAttribute: "data-price-fen" }
      : {})
  };
}

function selection(): BrowserSelectionContract {
  return {
    platform: "damai",
    allowedOrigins: ["https://detail.damai.cn", "https://buy.damai.cn"],
    blockingPredicates: [
      { key: "captcha-visible", selector: "[data-captcha]" },
      { key: "login-required-visible", selector: "[data-login]" },
      { key: "sold-out-visible", selector: "[data-sold-out]" },
      { key: "official-queue-visible", selector: "[data-queue]" }
    ],
    eventTitleSelector: "[data-event-title]",
    eventIdSelector: "[data-event-id]",
    eventIdAttribute: "data-event-id",
    session: choice("[data-session]"),
    sessionSummarySelector: "[data-session-summary]",
    tier: choice("[data-tier]", true),
    tierSummarySelector: "[data-tier-summary]",
    quantity: {
      summarySelector: "[data-quantity-summary]",
      option: choice("[data-quantity]")
    },
    attendee: choice("[data-attendee]"),
    adjacencySelector: "[data-adjacent]",
    totalSelector: "[data-total]",
    totalFenAttribute: "data-total-fen",
    forbiddenActionSelectors: ["[data-submit]", "[data-payment-action]"]
  };
}

function contract(): FastPathContract {
  return {
    version: FAST_PATH_CONTRACT_VERSION,
    platform: "damai",
    finalOfficialOrigin: "https://buy.damai.cn",
    selection: selection(),
    submitReadiness: {
      selector: "[data-submit]",
      labelSelector: "[data-submit-label]",
      allowedLabels: ["确认订单", "立即购买"]
    },
    postSubmitPredicates: [
      { key: "payment-visible", selector: "[data-payment-visible]" },
      { key: "order-reference-visible", selector: "[data-order-reference]" }
    ]
  };
}

test("fast-path contract digest binds selectors and is stable for unordered predicate sets", () => {
  const base = contract();
  const normalized = validateFastPathContract(base);
  assert.equal(normalized.finalOfficialOrigin, "https://buy.damai.cn");
  assert.match(digestFastPathContract(base), /^sha256:[0-9a-f]{64}$/);

  const reordered: FastPathContract = {
    ...base,
    selection: {
      ...base.selection,
      allowedOrigins: [...base.selection.allowedOrigins].reverse(),
      blockingPredicates: [...base.selection.blockingPredicates].reverse(),
      forbiddenActionSelectors: [...base.selection.forbiddenActionSelectors].reverse()
    },
    submitReadiness: {
      ...base.submitReadiness,
      allowedLabels: [...base.submitReadiness.allowedLabels].reverse()
    },
    postSubmitPredicates: [...base.postSubmitPredicates].reverse()
  };
  assert.equal(digestFastPathContract(reordered), digestFastPathContract(base));

  const changed = contract();
  changed.selection.totalSelector = "[data-total-v2]";
  assert.notEqual(digestFastPathContract(changed), digestFastPathContract(base));
});

test("fast-path contract rejects unreviewed origins, action selectors, fields, and post-submit evidence", () => {
  const base = contract();
  assert.throws(
    () => validateFastPathContract({ ...base, finalOfficialOrigin: "https://buy.damai.cn.evil.test" }),
    /SUBMIT_CAPABILITY_INPUT_INVALID/
  );
  assert.throws(
    () => validateFastPathContract({ ...base, platform: "maoyan" }),
    /PLATFORM_MISMATCH/
  );
  assert.throws(
    () => validateFastPathContract({
      ...base,
      submitReadiness: { ...base.submitReadiness, selector: "[data-not-forbidden]" }
    }),
    /NOT_FORBIDDEN/
  );
  assert.throws(
    () => validateFastPathContract({
      ...base,
      postSubmitPredicates: [{ key: "payment-visible", selector: "[data-payment-visible]" }]
    }),
    /POST_SUBMIT/
  );
  assert.throws(
    () => validateFastPathContract({ ...base, debug: true }),
    /FAST_PATH_CONTRACT_INVALID/
  );
});
