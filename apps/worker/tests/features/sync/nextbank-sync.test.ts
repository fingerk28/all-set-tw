import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestD1 } from "../../../../../packages/db/testing/d1";
import { decryptJson, encryptJson } from "../../../src/platform/crypto";
import type { Env } from "../../../src/platform/env";
import { syncNextbank } from "../../../src/features/sync/service";
import { persistStagedSyncWrite } from "../../../src/features/sync/persistence";
import {
  bankAccountRecord,
  bankBalanceSnapshotRecord,
} from "../../../src/features/sync/record-mapper";

let harness: Awaited<ReturnType<typeof createTestD1>>;
let env: Env;
const key = "synthetic-test-encryption-key";
const credentials = {
  userId: "A123456789",
  account: "sampleuser",
  password: "SyntheticPass1",
};

beforeEach(async () => {
  harness = await createTestD1();
  env = { DB: harness.binding, CONFIG_ENCRYPTION_KEY: key } as Env;
  const encrypted = await encryptJson(
    {
      ...credentials,
      captchaUuid: "synthetic-challenge",
      captchaExpiresAt: Date.now() + 120000,
    },
    key,
  );
  await env.DB.prepare(
    "INSERT INTO connector_settings(id, connector_id, encrypted_config, created_at, updated_at) VALUES(?, ?, ?, ?, ?)",
  )
    .bind("nextbank", "nextbank", encrypted, "2026-09-27", "2026-09-27")
    .run();
}, 30000);
afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.mf.dispose();
}, 30000);

function bank(beforeOverview?: () => Promise<void>) {
  const requests: string[] = [];
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.origin !== "https://api.nextbank.com.tw")
      return realFetch(input, init);
    const action = url.pathname.split("/").at(-1)!;
    requests.push(action);
    let data: unknown;
    if (action === "CaptchaLogin") data = { acstkn: "synthetic-token" };
    else if (action === "AllInOne") {
      await beforeOverview?.();
      data = {
        mainAccount: {
          accountId: "0000000123456789",
          workingBalance: 2000,
          availableBalance: 2000,
        },
      };
    } else if (action === "PocketInfo")
      data = {
        pocketDetails: [],
        depositTotalAmount: 0,
        termDepositTotalAmount: 0,
      };
    else if (action === "CurrentDepositDetail")
      data = {
        trades: [
          {
            tradeID: "synthetic-trade",
            tradeAmount: -50,
            tradeChannel: "TRANSFEROUT",
            tradeDateTime: Date.now(),
            detail: { txnDateTime: null, deductionDate: null, memo: "菜錢" },
          },
        ],
      };
    else if (action === "Logout") data = {};
    else throw new Error("Unexpected synthetic bank operation");
    return Response.json({ success: true, data });
  });
  return requests;
}

describe("Nextbank staged sync with isolated D1", () => {
  it("retires absent deposits without deleting their historical balances", async () => {
    const oldDate = "2026-01-01T00:00:00.000Z";
    const sourceId = "bank:nextbank:term:closed-synthetic:TWD";
    await persistStagedSyncWrite(env.DB, {
      records: [
        bankAccountRecord(
          "nextbank",
          {
            sourceId,
            accountType: "time_deposit",
            currency: "TWD",
          },
          oldDate,
        ),
        bankBalanceSnapshotRecord(
          "nextbank",
          {
            sourceId: `snapshot:${sourceId}`,
            accountId: sourceId,
            balance: 5000,
            currency: "TWD",
            asOfAt: oldDate,
          },
          oldDate,
        ),
      ],
    });
    bank();
    await syncNextbank(env, "manual", { captcha: "12345" });
    const account = await env.DB.prepare(
      "SELECT id, inactive_at FROM bank_accounts WHERE connector_id='nextbank' AND source_id=?",
    )
      .bind(sourceId)
      .first<{ id: string; inactive_at: string }>();
    expect(account?.inactive_at).toEqual(expect.any(String));
    const snapshots = await env.DB.prepare(
      "SELECT balance, as_of_at FROM bank_balance_snapshots WHERE account_id=? ORDER BY as_of_at",
    )
      .bind(account!.id)
      .all();
    expect(snapshots.results).toEqual([
      { balance: 5000, as_of_at: oldDate },
      { balance: 0, as_of_at: account!.inactive_at },
    ]);
  }, 30000);

  it("persists normalized data, consumes challenge and logs out", async () => {
    const requests = bank();
    const outcome = await syncNextbank(env, "manual", { captcha: "12345" });
    expect(outcome.success).toBe(true);
    expect(requests.at(-1)).toBe("Logout");
    expect(requests.filter((name) => name === "CaptchaLogin")).toHaveLength(1);
    const rows = await env.DB.prepare(
      "SELECT amount, description FROM bank_transactions WHERE connector_id='nextbank'",
    ).all();
    expect(rows.results).toEqual([{ amount: -50, description: "菜錢" }]);
    const settings = await env.DB.prepare(
      "SELECT encrypted_config, sync_cursor FROM connector_settings WHERE connector_id='nextbank'",
    ).first<{ encrypted_config: string; sync_cursor: string }>();
    expect(await decryptJson(settings!.encrypted_config, key)).toEqual(
      credentials,
    );
    expect(JSON.parse(settings!.sync_cursor)).toEqual({
      syncedAt: expect.any(String),
    });
  }, 30000);

  it("does not promote old account data when credentials change during queries", async () => {
    const replacement = await encryptJson(
      { ...credentials, account: "changeduser" },
      key,
    );
    const requests = bank(async () => {
      await env.DB.prepare(
        "UPDATE connector_settings SET encrypted_config=?, updated_at=? WHERE connector_id='nextbank'",
      )
        .bind(replacement, "changed-version")
        .run();
    });
    await expect(
      syncNextbank(env, "manual", { captcha: "12345" }),
    ).rejects.toThrow();
    expect(requests.at(-1)).toBe("Logout");
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM bank_accounts WHERE connector_id='nextbank'",
        ).first()
      )?.count,
    ).toBe(0);
    const settings = await env.DB.prepare(
      "SELECT encrypted_config FROM connector_settings WHERE connector_id='nextbank'",
    ).first<{ encrypted_config: string }>();
    expect(settings?.encrypted_config).toBe(replacement);
  }, 30000);

  it("clears an invalid manual challenge without contacting the bank", async () => {
    const requests = bank();
    await expect(
      syncNextbank(env, "manual", { captcha: "invalid-answer" }),
    ).rejects.toThrow("重新驗證");
    expect(requests).toEqual([]);
    const settings = await env.DB.prepare(
      "SELECT encrypted_config FROM connector_settings WHERE connector_id='nextbank'",
    ).first<{ encrypted_config: string }>();
    expect(await decryptJson(settings!.encrypted_config, key)).toEqual(
      credentials,
    );
  }, 30000);
});
