import assert from "node:assert/strict";
import test from "node:test";

import {
  ATTENDEE_KEYCHAIN_SERVICE_PREFIX,
  ATTENDEE_RESOLUTION_PREWARM_MS,
  MACOS_SECURITY_PATH,
  MacOsKeychainAttendeeResolver,
  type KeychainExecFile,
  validateAttendeeResolutionRequest
} from "../src/identity/attendee-resolver.js";

const ref = "attendee:v1:550e8400-e29b-41d4-a716-446655440000";
const secondRef = "attendee:v1:d9428888-122b-4c26-9f8b-6f2f1175e1f4";
const saleAt = "2026-08-01T10:00:00+08:00";
const saleTime = Date.parse(saleAt);

test("观演人映射只能在 T-10 预热窗口内请求", () => {
  assert.throws(
    () => validateAttendeeResolutionRequest(
      { platform: "damai", attendeeRefs: [ref], phase: "PREWARM", saleAt },
      new Date(saleTime - ATTENDEE_RESOLUTION_PREWARM_MS - 1)
    ),
    /ATTENDEE_RESOLUTION_TOO_EARLY/
  );

  const accepted = validateAttendeeResolutionRequest(
    { platform: "damai", attendeeRefs: [ref], phase: "PREWARM", saleAt },
    new Date(saleTime - ATTENDEE_RESOLUTION_PREWARM_MS)
  );
  assert.deepEqual(accepted.attendeeRefs, [ref]);
  assert.throws(
    () => validateAttendeeResolutionRequest(
      { platform: "damai", attendeeRefs: [ref], phase: "PREWARM", saleAt: "2026-08-01T10:00:00" },
      new Date(saleTime - ATTENDEE_RESOLUTION_PREWARM_MS)
    ),
    /ATTENDEE_RESOLUTION_SALE_TIME_INVALID/
  );
});

test("解析请求拒绝非 opaque 值且不在错误中回显", () => {
  const unsafe = "LOCAL_DISPLAY_VALUE";
  let thrown: unknown;
  try {
    validateAttendeeResolutionRequest(
      { platform: "damai", attendeeRefs: [unsafe], phase: "PREWARM" },
      new Date("2026-08-01T02:00:00Z")
    );
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error);
  assert.match(thrown.message, /ATTENDEE_REF_INVALID/);
  assert.equal(thrown.message.includes(unsafe), false);
});

test("非 Darwin 在执行任何 Keychain 命令前 fail-closed", async () => {
  let executed = false;
  const resolver = new MacOsKeychainAttendeeResolver({
    platform: "linux",
    execFile: async () => {
      executed = true;
      return { stdout: "DISPLAY_VALUE_ONE\n", stderr: "" };
    }
  });
  await assert.rejects(
    () => resolver.resolve({ platform: "damai", attendeeRefs: [ref], phase: "PREWARM" }),
    /MACOS_KEYCHAIN_ONLY/
  );
  assert.equal(executed, false);
});

test("Darwin resolver 只用固定 security 查询且 label 只在 withLabels 内可用", async () => {
  const calls: Array<{ file: string; args: readonly string[]; options: Parameters<KeychainExecFile>[2] }> = [];
  const resolver = new MacOsKeychainAttendeeResolver({
    platform: "darwin",
    execFile: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: "DISPLAY_VALUE_ONE\n", stderr: "" };
    }
  });
  const resolution = await resolver.resolve({
    platform: "damai",
    attendeeRefs: [ref],
    phase: "PREWARM"
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.file, MACOS_SECURITY_PATH);
  assert.deepEqual(calls[0]?.args, [
    "find-generic-password",
    "-s",
    `${ATTENDEE_KEYCHAIN_SERVICE_PREFIX}.damai`,
    "-a",
    ref,
    "-w"
  ]);
  assert.equal(calls[0]?.options.shell, false);
  assert.equal(calls[0]?.options.timeout, 60_000);

  let callbackRan = false;
  let escapedLabels: readonly string[] | undefined;
  const consumerResult = await resolution.withLabels((labels) => {
    callbackRan = true;
    escapedLabels = labels;
    assert.deepEqual(labels, ["DISPLAY_VALUE_ONE"]);
    assert.equal(Object.isFrozen(labels), true);
    return "CONSUMER_COMPLETED";
  });
  assert.equal(consumerResult, "CONSUMER_COMPLETED");
  assert.equal(callbackRan, true);
  assert.deepEqual(escapedLabels, [""]);
  const safeEvidence = JSON.stringify(resolution.audit());
  assert.equal(safeEvidence.includes(ref), false);
  assert.equal(safeEvidence.includes("DISPLAY_VALUE_ONE"), false);
  assert.equal(JSON.stringify(resolution), "{}");

  resolution.dispose();
  await assert.rejects(() => resolution.withLabels(() => undefined), /ATTENDEE_RESOLUTION_DISPOSED/);
});

test("Keychain 命令失败和非法值均不回显 label 或 ref", async () => {
  const secret = "DISPLAY_VALUE_ONE";
  const resolver = new MacOsKeychainAttendeeResolver({
    platform: "darwin",
    execFile: async () => {
      throw new Error(`injected failure ${secret} ${ref}`);
    }
  });
  let thrown: unknown;
  try {
    await resolver.resolve({ platform: "damai", attendeeRefs: [ref], phase: "PREWARM" });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error);
  assert.equal(thrown.message, "ATTENDEE_KEYCHAIN_LOOKUP_FAILED");
  assert.equal(thrown.message.includes(secret), false);
  assert.equal(thrown.message.includes(ref), false);

  const duplicate = new MacOsKeychainAttendeeResolver({
    platform: "darwin",
    execFile: async () => ({ stdout: `${secret}\n`, stderr: "" })
  });
  await assert.rejects(
    () => duplicate.resolve({ platform: "damai", attendeeRefs: [ref, secondRef], phase: "PREWARM" }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "ATTENDEE_KEYCHAIN_VALUE_DUPLICATE" &&
      !error.message.includes(secret) &&
      !error.message.includes(ref)
  );
});
