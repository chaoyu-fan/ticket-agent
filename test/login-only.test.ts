import assert from "node:assert/strict";
import test from "node:test";

import { loginOnlyTarget, parseRunnerArgs } from "../src/runner/cli.js";

const DAMAI_HOME = "https://www.damai.cn/";

test("login-only requires an explicit supported platform and target URL", () => {
  assert.throws(
    () => parseRunnerArgs(["--login-only", "--url", DAMAI_HOME]),
    /--login-only requires --platform damai/
  );
  assert.throws(
    () => parseRunnerArgs(["--login-only", "--platform", "damai"]),
    /--login-only requires --url/
  );

  const parsed = parseRunnerArgs([
    "--login-only",
    "--platform",
    "damai",
    "--url",
    DAMAI_HOME
  ]);
  assert.equal(parsed.mode, "login-only");
  assert.equal(parsed.platform, "damai");
  assert.equal(parsed.targetUrl, DAMAI_HOME);
});

test("login-only target accepts only credential-free official Damai HTTPS URLs", () => {
  assert.equal(loginOnlyTarget("damai", DAMAI_HOME).href, DAMAI_HOME);
  assert.equal(
    loginOnlyTarget("damai", "https://detail.damai.cn/item.htm?id=123").hostname,
    "detail.damai.cn"
  );

  for (const target of [
    "not a URL",
    "http://www.damai.cn/",
    "https://example.com/",
    "https://damai.cn.example.com/",
    "https://fixture-user:fixture-password@www.damai.cn/",
    "https://www.damai.cn:444/"
  ]) {
    assert.throws(
      () => loginOnlyTarget("damai", target),
      /LOGIN_TARGET_BLOCKED/,
      target
    );
  }
});

test("login-only rejects Maoyan until its dedicated flow is ready", () => {
  assert.throws(
    () => parseRunnerArgs([
      "--login-only",
      "--platform",
      "maoyan",
      "--url",
      "https://www.maoyan.com/"
    ]),
    /LOGIN_ONLY_NOT_READY:only damai is currently supported/
  );
});

test("login-only rejects purchase and controller flags", () => {
  const incompatible: readonly (readonly string[])[] = [
    ["--plan", "examples/default-damai-plan.json"],
    ["--controller-url", "http://127.0.0.1:4317"],
    ["--run-id", "run-1"],
    ["--confirm-live"]
  ];

  for (const extra of incompatible) {
    assert.throws(
      () => parseRunnerArgs([
        "--login-only",
        "--platform",
        "damai",
        "--url",
        DAMAI_HOME,
        ...extra
      ]),
      /--login-only cannot be combined/,
      extra.join(" ")
    );
  }

  for (const conflictingMode of ["--dry-run", "--mock", "--live"] as const) {
    assert.throws(
      () => parseRunnerArgs([
        "--login-only",
        conflictingMode,
        "--platform",
        "damai",
        "--url",
        DAMAI_HOME,
        ...(conflictingMode === "--live" ? ["--confirm-live"] : [])
      ]),
      /Choose exactly one runner mode/,
      conflictingMode
    );
  }
});

test("existing dry-run, mock, and live argument parsing remains unchanged", () => {
  assert.equal(parseRunnerArgs(["--dry-run"]).mode, "dry-run");
  assert.equal(
    parseRunnerArgs([
      "--mock",
      "--plan",
      "examples/default-damai-plan.json",
      "--url",
      "http://127.0.0.1:4173/damai/normal"
    ]).mode,
    "mock"
  );
  assert.equal(
    parseRunnerArgs([
      "--live",
      "--confirm-live",
      "--controller-url",
      "http://127.0.0.1:4317",
      "--run-id",
      "run-1"
    ]).mode,
    "live"
  );
  assert.throws(() => parseRunnerArgs(["--live"]), /--live requires --confirm-live/);
  assert.throws(
    () => parseRunnerArgs(["--dry-run", "--platform", "damai"]),
    /--platform is only valid with --login-only/
  );
});
