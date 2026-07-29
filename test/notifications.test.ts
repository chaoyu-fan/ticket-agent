import assert from "node:assert/strict";
import test from "node:test";
import { renderNotification } from "../src/notifications/types.js";

test("notification includes action severity and references", () => {
  assert.equal(
    renderNotification({
      severity: "ACTION_REQUIRED",
      title: "需要人工接管",
      body: "页面出现验证码",
      planId: "p1",
      runId: "r1"
    }),
    "[ACTION_REQUIRED] 需要人工接管\n页面出现验证码\nplan=p1 run=r1"
  );
});
