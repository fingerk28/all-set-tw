import { describe, expect, it } from "vitest";
import {
  parseRakutenConfig,
  parseRakutenData,
} from "@taiwan-fin-hub/connectors";

const depositPageText = `
臺幣存款
活存

定存
活存總額 0081200000001234
$52,345
2026/09 活存明細
`;

describe("Rakuten config schema", () => {
  it("parses valid credentials and challenge state", () => {
    expect(
      parseRakutenConfig({
        userId: "A123456789",
        account: "rakuten-user",
        password: "testpass12",
        browserSessionId: "session-1",
        browserSessionExpiresAt: "2026-09-27T00:00:00.000Z",
        captcha: "36CY",
      }),
    ).toMatchObject({
      userId: "A123456789",
      account: "rakuten-user",
      captcha: "36CY",
    });
  });

  it("allows an empty config for a not-yet-configured connector", () => {
    expect(parseRakutenConfig({})).toEqual({});
  });

  it("rejects a captcha that is not exactly 4 alphanumeric characters", () => {
    expect(() => parseRakutenConfig({ captcha: "123" })).toThrow();
    expect(() => parseRakutenConfig({ captcha: "123456" })).toThrow();
    expect(() => parseRakutenConfig({ captcha: "!@#$" })).toThrow();
  });

  it("never declares a reusable session field", () => {
    const schema = parseRakutenConfig({});
    expect(schema).not.toHaveProperty("sessionCookies");
    expect(schema).not.toHaveProperty("sessionCreatedAt");
  });
});

describe("Rakuten connector parser", () => {
  it("parses the TWD deposit account and balance", () => {
    const result = parseRakutenData(
      { depositPageText },
      new Date("2026-09-27T00:00:00.000Z"),
    );

    expect(result.bankAccounts).toHaveLength(1);
    expect(result.bankAccounts[0]).toMatchObject({
      sourceId: "bank:rakuten:0081200000001234:TWD",
      institutionName: "樂天國際銀行",
      accountType: "savings",
      currency: "TWD",
    });
    expect(result.bankBalanceSnapshots).toHaveLength(1);
    expect(result.bankBalanceSnapshots[0]).toMatchObject({
      accountId: "bank:rakuten:0081200000001234:TWD",
      balance: 52_345,
      currency: "TWD",
    });
  });

  it("parses single account directly from depositInfo object without depAccounts array", () => {
    const result = parseRakutenData({
      dashboardPayload: {
        depositInfo: {
          acctNo: "0081200000001234",
          totalBal: 52345,
          termBal: 0,
        },
      },
    });

    expect(result.bankAccounts).toHaveLength(1);
    expect(result.bankAccounts[0]).toMatchObject({
      sourceId: "bank:rakuten:0081200000001234:TWD",
      institutionName: "樂天國際銀行",
      accountType: "savings",
      currency: "TWD",
    });
    expect(result.bankBalanceSnapshots).toHaveLength(1);
    expect(result.bankBalanceSnapshots[0]?.balance).toBe(52345);
  });

  it("parses account number rendered before balance label in DOM text", () => {
    const text = `
    帳號 0081200000001234
    存款總額 $52,345
    活存總額
    $52,345
    `;
    const result = parseRakutenData({ depositPageText: text });
    expect(result.bankAccounts).toHaveLength(1);
    expect(result.bankAccounts[0]?.sourceId).toBe(
      "bank:rakuten:0081200000001234:TWD",
    );
    expect(result.bankBalanceSnapshots[0]?.balance).toBe(52345);
  });

  it("filters out external bank accounts from depAccounts array by bank code and bank name", () => {
    const result = parseRakutenData({
      dashboardPayload: {
        depositInfo: {
          depAccounts: [
            {
              acctNo: "0010123456789012",
              bankNo: "826",
              showAcctNo: "0010-***-9012",
              balance: 50000,
            },
            {
              acctNo: "99988877766655",
              bankNo: "807",
              bankName: "外部商業銀行",
              showAcctNo: "999-***-6655",
              balance: 10000,
            },
            {
              acctNo: "88877766655544",
              isOtherBank: true,
              balance: 5000,
            },
          ],
        },
      },
    });

    expect(result.bankAccounts).toHaveLength(1);
    expect(result.bankAccounts[0]?.sourceId).toBe(
      "bank:rakuten:0010123456789012:TWD",
    );
    expect(result.bankBalanceSnapshots).toHaveLength(1);
    expect(result.bankBalanceSnapshots[0]?.balance).toBe(50000);
  });

  it("ignores counterparty transfer-in account in DOM text and keeps Rakuten account", () => {
    const text = `
    帳號 0010123456789012
    活存總額
    $52,345
    活存明細
    跨行轉入
    帳號 99988877766655
    本次交易金額 $1,000
    `;
    const result = parseRakutenData({ depositPageText: text });
    expect(result.bankAccounts).toHaveLength(1);
    expect(result.bankAccounts[0]?.sourceId).toBe(
      "bank:rakuten:0010123456789012:TWD",
    );
    expect(result.bankBalanceSnapshots[0]?.balance).toBe(52345);
  });

  it("keeps only the primary account when an unmarked transfer-in account is listed", () => {
    // 永豐轉入的對手帳戶：沒有 bankNo／bankName／任何他行旗標
    const result = parseRakutenData({
      dashboardPayload: {
        depositInfo: {
          acctNo: "0081200000001234",
          depAccounts: [
            { acctNo: "0081200000001234", ntdCurrBal: 52345 },
            { acctNo: "12300000009999", ntdCurrBal: 1000 },
          ],
        },
      },
    });

    expect(result.bankAccounts.map((account) => account.sourceId)).toEqual([
      "bank:rakuten:0081200000001234:TWD",
    ]);
    expect(result.bankBalanceSnapshots).toHaveLength(1);
    expect(result.bankBalanceSnapshots[0]?.balance).toBe(52345);
  });

  it("does not record an unmarked single depAccount that differs from the primary account", () => {
    const result = parseRakutenData({
      dashboardPayload: {
        depositInfo: {
          acctNo: "0081200000001234",
          totalBal: 52345,
          depAccount: { acctNo: "12300000009999", ntdCurrBal: 1000 },
        },
      },
    });

    expect(result.bankAccounts.map((account) => account.sourceId)).toEqual([
      "bank:rakuten:0081200000001234:TWD",
    ]);
    expect(result.bankBalanceSnapshots[0]?.balance).toBe(52345);
  });

  it("records nothing when the list only has another account and the primary has no balance", () => {
    const result = parseRakutenData({
      dashboardPayload: {
        depositInfo: {
          acctNo: "0081200000001234",
          depAccounts: [{ acctNo: "12300000009999", ntdCurrBal: 1000 }],
        },
      },
    });

    expect(result.bankAccounts).toHaveLength(0);
    expect(result.bankBalanceSnapshots).toHaveLength(0);
  });

  it("parses a thousands-separated string balance", () => {
    const result = parseRakutenData({
      dashboardPayload: {
        depositInfo: { acctNo: "0081200000001234", balance: "52,345" },
      },
    });

    expect(result.bankBalanceSnapshots).toHaveLength(1);
    expect(result.bankBalanceSnapshots[0]?.balance).toBe(52345);
  });

  it("falls through an invalid balance key to a later valid one", () => {
    const result = parseRakutenData({
      dashboardPayload: {
        depositInfo: {
          acctNo: "0081200000001234",
          balance: "--",
          ntdCurrBal: "N/A",
          acctBal: "52,345",
        },
      },
    });

    expect(result.bankBalanceSnapshots).toHaveLength(1);
    expect(result.bankBalanceSnapshots[0]?.balance).toBe(52345);
  });

  it("skips an entry without any valid balance instead of storing 0", () => {
    const result = parseRakutenData({
      dashboardPayload: {
        depositInfo: {
          acctNo: "0081200000001234",
          balance: "--",
          totalBal: "abc",
        },
      },
    });

    expect(result.bankAccounts).toHaveLength(0);
    expect(result.bankBalanceSnapshots).toHaveLength(0);
  });

  it("uses a later valid candidate when the same account's first candidate has no valid balance", () => {
    const result = parseRakutenData({
      dashboardPayload: {
        depositInfo: {
          depAccounts: [
            { acctNo: "0010123456789012", bankNo: "826", balance: "--" },
            { acctNo: "0010123456789012", bankNo: "826", balance: "52,345" },
          ],
        },
      },
    });

    expect(result.bankAccounts).toHaveLength(1);
    expect(result.bankBalanceSnapshots).toHaveLength(1);
    expect(result.bankBalanceSnapshots[0]?.balance).toBe(52345);
  });

  it("refuses to guess between several unmarked accounts without a primary account", () => {
    const result = parseRakutenData({
      dashboardPayload: {
        depAccounts: [
          { acctNo: "0081200000001234", ntdCurrBal: 52345 },
          { acctNo: "12300000009999", ntdCurrBal: 1000 },
        ],
      },
    });

    expect(result.bankAccounts).toHaveLength(0);
  });

  it("accepts explicitly Rakuten-coded accounts when there is no primary account", () => {
    const result = parseRakutenData({
      dashboardPayload: {
        depAccounts: [
          { acctNo: "0081200000001234", bankNo: "826", ntdCurrBal: 52345 },
          { acctNo: "12300000009999", ntdCurrBal: 1000 },
        ],
      },
    });

    expect(result.bankAccounts.map((account) => account.sourceId)).toEqual([
      "bank:rakuten:0081200000001234:TWD",
    ]);
  });

  it("skips foreign-currency entries even when they belong to Rakuten", () => {
    const result = parseRakutenData({
      dashboardPayload: {
        depositInfo: {
          acctNo: "0081200000001234",
          depAccounts: [
            { acctNo: "0081200000001234", ntdCurrBal: 52345 },
            {
              acctNo: "0081200000005678",
              bankNo: "826",
              currency: "USD",
              balance: 100,
            },
            // 樂天實際回應的幣別欄位名稱是 cur
            {
              acctNo: "0081200000009012",
              bankNo: "826",
              cur: "JPY",
              balance: 500,
            },
          ],
        },
      },
    });

    expect(result.bankAccounts.map((account) => account.sourceId)).toEqual([
      "bank:rakuten:0081200000001234:TWD",
    ]);
  });

  it("does not take a transfer-in account from the text when the Rakuten account is not shown", () => {
    const text = `
    臺幣存款
    活存總額
    $52,345
    活存明細
    跨行轉入
    12300000009999
    `;
    const result = parseRakutenData({ depositPageText: text });
    expect(result.bankAccounts).toHaveLength(0);
  });

  it("skips an account number labelled with another bank near the balance", () => {
    const withoutRakuten = parseRakutenData({
      depositPageText: `
      永豐商業銀行
      12300000009999
      活存總額
      $52,345
      `,
    });
    expect(withoutRakuten.bankAccounts).toHaveLength(0);

    const withRakuten = parseRakutenData({
      depositPageText: `
      帳號 0081200000001234
      永豐商業銀行 (807)
      12300000009999
      活存總額
      $52,345
      `,
    });
    expect(withRakuten.bankAccounts.map((a) => a.sourceId)).toEqual([
      "bank:rakuten:0081200000001234:TWD",
    ]);
  });

  it("does not search the whole page for an account number far from the balance label", () => {
    const text = [
      "帳號 12300000009999",
      ...Array.from({ length: 10 }, (_, index) => `說明文字 ${index}`),
      "活存總額",
      "$52,345",
    ].join("\n");
    const result = parseRakutenData({ depositPageText: text });
    expect(result.bankAccounts).toHaveLength(0);
  });

  it("returns no accounts when the deposit page text is missing the balance label", () => {
    const result = parseRakutenData({ depositPageText: "無法解析的頁面" });
    expect(result.bankAccounts).toHaveLength(0);
    expect(result.bankBalanceSnapshots).toHaveLength(0);
  });

  it("falls back to deposit text when the deposit JSON has no usable account", () => {
    const result = parseRakutenData({
      dashboardPayload: { depositInfo: {} },
      depositPageText,
    });

    expect(result.bankAccounts.map((account) => account.sourceId)).toEqual([
      "bank:rakuten:0081200000001234:TWD",
    ]);
  });

  it("keeps one balance snapshot per day so the net-worth history has daily values", () => {
    const payload = {
      dashboardPayload: {
        depositInfo: {
          depAccounts: [{ acctNo: "0081200000001234", ntdCurrBal: 52345 }],
        },
      },
    };
    const morning = parseRakutenData(
      payload,
      new Date("2026-09-28T01:00:00.000Z"),
    );
    const evening = parseRakutenData(
      payload,
      new Date("2026-09-28T12:00:00.000Z"),
    );
    const nextDay = parseRakutenData(
      payload,
      new Date("2026-09-29T01:00:00.000Z"),
    );

    const ids = (result: typeof morning) =>
      result.bankBalanceSnapshots.map((snapshot) => snapshot.sourceId);
    expect(ids(morning)).toEqual([
      "snapshot:rakuten:0081200000001234:TWD:2026-09-28",
    ]);
    // 同一天再同步覆寫同一筆；隔天另起一筆
    expect(ids(evening)).toEqual(ids(morning));
    expect(ids(nextDay)).toEqual([
      "snapshot:rakuten:0081200000001234:TWD:2026-09-29",
    ]);
    // 帳戶本身的 ID 不隨日期改變
    expect(nextDay.bankAccounts.map((account) => account.sourceId)).toEqual(
      morning.bankAccounts.map((account) => account.sourceId),
    );
  });

  it("returns nothing when neither deposit payload nor text is available", () => {
    const result = parseRakutenData({});
    expect(result.bankAccounts).toHaveLength(0);
    expect(result.bankBalanceSnapshots).toHaveLength(0);
  });
});
