import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestD1 } from "../../../../../packages/db/testing/d1";
import { encryptJson } from "../../../src/platform/crypto";
import type { Env } from "../../../src/platform/env";

const mocks = vi.hoisted(() => ({
  createRakutenConnector: vi.fn(),
}));

vi.mock("../../../src/connectors/rakuten", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/connectors/rakuten")
  >("../../../src/connectors/rakuten");
  return { ...actual, createRakutenConnector: mocks.createRakutenConnector };
});

import { syncRakuten } from "../../../src/features/sync/service";

let harness: Awaited<ReturnType<typeof createTestD1>>;
let env: Env;
const key = "synthetic-test-encryption-key";
const NOW = "2026-09-27T00:00:00.000Z";
const DEPOSIT_SOURCE_ID = "bank:rakuten:0081200000001234:TWD";

const syncResult = {
  records: [],
  bankAccounts: [
    {
      sourceId: DEPOSIT_SOURCE_ID,
      institutionName: "樂天國際銀行",
      accountName: "樂天活儲",
      accountType: "savings" as const,
      currency: "TWD",
    },
  ],
  bankBalanceSnapshots: [
    {
      accountId: DEPOSIT_SOURCE_ID,
      sourceId: "snapshot:rakuten:0081200000001234:TWD:2026-09-27",
      balance: 52_345,
      currency: "TWD",
      asOfAt: NOW,
    },
  ],
  bankTransactions: [
    {
      accountId: DEPOSIT_SOURCE_ID,
      sourceId: "rakuten:deposit:tx:0000000000000001",
      postedDate: "2026-09-17",
      authorizedAt: "2026-09-17T08:30:00+08:00",
      amount: -6_543,
      currency: "TWD",
      description: "自動扣款",
      status: "posted" as const,
    },
    {
      accountId: DEPOSIT_SOURCE_ID,
      sourceId: "rakuten:deposit:tx:0000000000000002",
      postedDate: "2026-09-01",
      authorizedAt: "2026-09-01T09:10:00+08:00",
      amount: 30_000,
      currency: "TWD",
      description: "他行轉入",
      counterparty: "****7890",
      status: "posted" as const,
    },
  ],
};

beforeEach(async () => {
  vi.clearAllMocks();
  harness = await createTestD1();
  env = { DB: harness.binding, CONFIG_ENCRYPTION_KEY: key } as Env;
  const encrypted = await encryptJson(
    { userId: "A123456789", account: "rakuten-user", password: "synthetic" },
    key,
  );
  await env.DB.prepare(
    "INSERT INTO connector_settings(id, connector_id, encrypted_config, created_at, updated_at) VALUES(?, ?, ?, ?, ?)",
  )
    .bind("rakuten", "rakuten", encrypted, NOW, NOW)
    .run();
  mocks.createRakutenConnector.mockReturnValue({
    sync: vi.fn().mockResolvedValue(syncResult),
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
}, 30000);

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.mf.dispose();
}, 30000);

async function transactions() {
  return (
    await env.DB.prepare(
      `SELECT t.source_id AS sourceId, t.amount AS amount, t.description AS description,
              t.posted_date AS postedDate, t.authorized_at AS authorizedAt,
              a.source_id AS accountSourceId, t.connector_id AS connectorId
       FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
       ORDER BY t.source_id`,
    ).all<Record<string, unknown>>()
  ).results;
}

describe("syncRakuten deposit transactions", () => {
  it("persists deposit transactions and counts them in records", async () => {
    const outcome = await syncRakuten(env, "manual");

    // 1 個帳戶 + 1 筆餘額快照 + 2 筆交易
    expect(outcome.records).toBe(4);
    expect(await transactions()).toEqual([
      {
        sourceId: "rakuten:deposit:tx:0000000000000001",
        amount: -6_543,
        description: "自動扣款",
        postedDate: "2026-09-17",
        authorizedAt: "2026-09-17T08:30:00+08:00",
        accountSourceId: DEPOSIT_SOURCE_ID,
        connectorId: "rakuten",
      },
      {
        sourceId: "rakuten:deposit:tx:0000000000000002",
        amount: 30_000,
        description: "他行轉入",
        postedDate: "2026-09-01",
        authorizedAt: "2026-09-01T09:10:00+08:00",
        accountSourceId: DEPOSIT_SOURCE_ID,
        connectorId: "rakuten",
      },
    ]);
  });

  it("is idempotent across repeated syncs", async () => {
    await syncRakuten(env, "manual");
    await syncRakuten(env, "manual");
    expect(await transactions()).toHaveLength(2);
  });
});
