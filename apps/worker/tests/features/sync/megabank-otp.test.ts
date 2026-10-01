import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestD1 } from "../../../../../packages/db/testing/d1";
import { decryptJson, encryptJson } from "../../../src/platform/crypto";
import type { Env } from "../../../src/platform/env";

const mocks = vi.hoisted(() => ({
  createMegabankConnector: vi.fn(),
}));

vi.mock("@taiwan-fin-hub/connectors", async () => {
  const actual = await vi.importActual<
    typeof import("@taiwan-fin-hub/connectors")
  >("@taiwan-fin-hub/connectors");
  return {
    ...actual,
    createMegabankConnector: mocks.createMegabankConnector,
  };
});

import {
  MegabankOtpInvalidError,
  MegabankOtpRequiredError,
  MegabankVerificationRequiredError,
} from "@taiwan-fin-hub/connectors";
import {
  NeedsUserActionError,
  syncMegabank,
} from "../../../src/features/sync/service";

let harness: Awaited<ReturnType<typeof createTestD1>>;
let env: Env;
const key = "synthetic-test-encryption-key";
const credentials = {
  userId: "A123456789",
  account: "syntheticacct",
  password: "synthetic-only",
};
const device = {
  deviceCode: "synthetic-device-code",
  deviceUKey: "synthetic-device-ukey",
  deviceSeed: "synthetic-device-seed",
};

beforeEach(async () => {
  vi.clearAllMocks();
  harness = await createTestD1();
  env = { DB: harness.binding, CONFIG_ENCRYPTION_KEY: key } as Env;
  const encrypted = await encryptJson(credentials, key);
  await env.DB.prepare(
    "INSERT INTO connector_settings(id, connector_id, encrypted_config, created_at, updated_at) VALUES(?, ?, ?, ?, ?)",
  )
    .bind("megabank", "megabank", encrypted, "2026-09-27", "2026-09-27")
    .run();
}, 30000);

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.mf.dispose();
}, 30000);

async function storedConfig() {
  const row = await env.DB.prepare(
    "SELECT encrypted_config FROM connector_settings WHERE connector_id='megabank'",
  ).first<{ encrypted_config: string }>();
  return decryptJson<Record<string, unknown>>(row!.encrypted_config, key);
}

describe("syncMegabank OTP handling", () => {
  it("rethrows MegabankOtpRequiredError and persists the pendingSession from the error", async () => {
    const expiresAt = new Date(Date.now() + 120_000).toISOString();
    const otpError = new MegabankOtpRequiredError(
      "兆豐銀行已寄出簡訊驗證碼，請於三分鐘內輸入。",
      "pending-state",
      expiresAt,
      device,
    );
    mocks.createMegabankConnector.mockReturnValue({
      sync: vi.fn().mockRejectedValue(otpError),
    });

    await expect(syncMegabank(env, "manual")).rejects.toBe(otpError);

    const stored = await storedConfig();
    expect(stored).toEqual({
      ...credentials,
      ...device,
      pendingSession: "pending-state",
      pendingSessionExpiresAt: expiresAt,
    });
    expect(stored).not.toHaveProperty("captcha");
    expect(stored).not.toHaveProperty("otp");
    expect(stored.deviceCode).toBe(device.deviceCode);
    expect(stored.deviceUKey).toBe(device.deviceUKey);
    expect(stored.deviceSeed).toBe(device.deviceSeed);
  });

  it("rethrows MegabankOtpInvalidError and replaces the pendingSession, without storing otp", async () => {
    const expiresAt = new Date(Date.now() + 120_000).toISOString();
    const otpError = new MegabankOtpInvalidError(
      "兆豐銀行簡訊驗證碼錯誤，請重新輸入。",
      "refreshed-pending-state",
      expiresAt,
      device,
    );
    mocks.createMegabankConnector.mockReturnValue({
      sync: vi.fn().mockRejectedValue(otpError),
    });

    await expect(syncMegabank(env, "manual", { otp: "654321" })).rejects.toBe(
      otpError,
    );

    const stored = await storedConfig();
    expect(stored).toEqual({
      ...credentials,
      ...device,
      pendingSession: "refreshed-pending-state",
      pendingSessionExpiresAt: expiresAt,
    });
    expect(stored).not.toHaveProperty("otp");
    expect(stored).not.toHaveProperty("captcha");
    expect(stored.deviceCode).toBe(device.deviceCode);
    expect(stored.deviceUKey).toBe(device.deviceUKey);
    expect(stored.deviceSeed).toBe(device.deviceSeed);
  });

  it("wraps a plain MegabankVerificationRequiredError into NeedsUserActionError and clears transient fields", async () => {
    // Simulate leftover transient fields from a prior aborted attempt, to prove
    // the cleanup actually strips them rather than merely never adding them.
    const dirty = await encryptJson(
      {
        ...credentials,
        captcha: "12345",
        otp: "654321",
        pendingSession: "stale-session",
        pendingSessionExpiresAt: "2020-01-01T00:00:00.000Z",
      },
      key,
    );
    await env.DB.prepare(
      "UPDATE connector_settings SET encrypted_config=? WHERE connector_id='megabank'",
    )
      .bind(dirty)
      .run();

    const verificationError = new MegabankVerificationRequiredError(
      "兆豐銀行要求雙重驗證，連接器尚未支援，請改用官方 App 查詢。",
    );
    mocks.createMegabankConnector.mockReturnValue({
      sync: vi.fn().mockRejectedValue(verificationError),
    });

    await expect(syncMegabank(env, "manual")).rejects.toBeInstanceOf(
      NeedsUserActionError,
    );

    const stored = await storedConfig();
    expect(stored).toEqual(credentials);
    expect(stored).not.toHaveProperty("pendingSession");
    expect(stored).not.toHaveProperty("pendingSessionExpiresAt");
    expect(stored).not.toHaveProperty("captcha");
    expect(stored).not.toHaveProperty("otp");
  });
});

describe("syncMegabank createMegabankConnector invocation", () => {
  function rejectingSync(
    message = "兆豐銀行要求雙重驗證，連接器尚未支援，請改用官方 App 查詢。",
  ) {
    return vi
      .fn()
      .mockRejectedValue(new MegabankVerificationRequiredError(message));
  }

  it("requests allowOtpRequest for a manual trigger, with a captcha recognizer function", async () => {
    mocks.createMegabankConnector.mockReturnValue({ sync: rejectingSync() });

    await expect(syncMegabank(env, "manual")).rejects.toBeInstanceOf(
      NeedsUserActionError,
    );

    expect(mocks.createMegabankConnector).toHaveBeenCalledTimes(1);
    const [, recognizer, options] =
      mocks.createMegabankConnector.mock.calls[0]!;
    expect(options).toEqual({ allowOtpRequest: true });
    expect(typeof recognizer).toBe("function");
  });

  it("disables allowOtpRequest for a scheduled trigger", async () => {
    mocks.createMegabankConnector.mockReturnValue({ sync: rejectingSync() });

    await expect(syncMegabank(env, "scheduled")).rejects.toBeInstanceOf(
      NeedsUserActionError,
    );

    const [, , options] = mocks.createMegabankConnector.mock.calls[0]!;
    expect(options).toEqual({ allowOtpRequest: false });
  });

  it("omits the captcha recognizer when overrides include otp", async () => {
    mocks.createMegabankConnector.mockReturnValue({ sync: rejectingSync() });

    await expect(
      syncMegabank(env, "manual", { otp: "654321" }),
    ).rejects.toBeInstanceOf(NeedsUserActionError);

    const [, recognizer] = mocks.createMegabankConnector.mock.calls[0]!;
    expect(recognizer).toBeUndefined();
  });

  it("omits the captcha recognizer when overrides include captcha", async () => {
    mocks.createMegabankConnector.mockReturnValue({ sync: rejectingSync() });

    await expect(
      syncMegabank(env, "manual", { captcha: "12345" }),
    ).rejects.toBeInstanceOf(NeedsUserActionError);

    const [, recognizer] = mocks.createMegabankConnector.mock.calls[0]!;
    expect(recognizer).toBeUndefined();
  });
});
