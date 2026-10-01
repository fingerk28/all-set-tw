import { describe, expect, it } from "vitest";
import {
  parseRakutenData,
  parseRakutenDepositTransactions,
} from "@taiwan-fin-hub/connectors";

const ACCOUNT_NO = "0081200000001234";
const ACCOUNT_SOURCE_ID = `bank:rakuten:${ACCOUNT_NO}:TWD`;
const deposits = [{ sourceId: ACCOUNT_SOURCE_ID, accountNo: ACCOUNT_NO }];

type Row = {
  sysDate: string;
  sysTime: string;
  /** 收入或支出（由測試以 signBy 決定 amtSign 的布林語意）。 */
  credit: boolean;
  amt: string;
  balance: string;
  txDesc: string;
  memo?: string;
  acctNo?: string;
  nickNameOrAcct?: string;
  pk?: string | null;
};

/** 網頁回應的欄位形狀（值皆為合成資料）；amtSign 的語意由 trueMeansCredit 決定。 */
function detail(row: Row, trueMeansCredit: boolean) {
  return {
    sysDate: row.sysDate,
    sysTime: row.sysTime,
    amtSign: trueMeansCredit ? row.credit : !row.credit,
    amt: row.amt,
    memo: row.memo ?? "",
    txDesc: row.txDesc,
    nickNameOrAcct: row.nickNameOrAcct ?? "",
    displayAccount: "",
    acctNo: row.acctNo ?? "",
    bankId: "",
    balance: row.balance,
    txPk: "",
    ...(row.pk === null ? {} : { pk: row.pk }),
    showAcctNo: "",
    commonAcct: false,
  };
}

function month(
  rowsOldestFirst: Row[],
  options: {
    trueMeansCredit?: boolean;
    order?: "newestFirst" | "oldestFirst";
    display?: Record<string, boolean>;
    queryAccountNo?: string;
  } = {},
) {
  const rows =
    (options.order ?? "newestFirst") === "newestFirst"
      ? [...rowsOldestFirst].reverse()
      : rowsOldestFirst;
  return {
    display: {
      dataEnd: true,
      dataLimit: false,
      noData: false,
      ...options.display,
    },
    accounts: [{ acctNo: ACCOUNT_NO, balance: "123,469" }],
    queryAccountNo: options.queryAccountNo ?? ACCOUNT_NO,
    txDetails: rows.map((row) => detail(row, options.trueMeansCredit ?? true)),
  };
}

// 合成的一個月：期初 100,000 → 轉入 30,000 → 利息 12 → 自動扣款 6,543
const SEPTEMBER: Row[] = [
  {
    sysDate: "2026/09/01",
    sysTime: "09:10",
    credit: true,
    amt: "30,000",
    balance: "130,000",
    txDesc: "他行轉入",
    memo: "薪資",
    acctNo: "0071234567890",
    nickNameOrAcct: "0071234567890",
    pk: "20260901091000001",
  },
  {
    sysDate: "2026/09/04",
    sysTime: "00:05",
    credit: true,
    amt: "12",
    balance: "130,012",
    txDesc: "存款利息",
    pk: "20260904000500002",
  },
  {
    sysDate: "2026/09/17",
    sysTime: "08:30",
    credit: false,
    amt: "6,543",
    balance: "123,469",
    txDesc: "自動扣款",
    acctNo: "9990001",
    pk: "20260917083000003",
  },
];

// 上個月：期初 90,000 → 轉入 20,000 → 自動扣款 6,543 → 餘額 103,457 → 消費 3,457 → 100,000
const AUGUST: Row[] = [
  {
    sysDate: "2026/08/03",
    sysTime: "10:00",
    credit: true,
    amt: "20,000",
    balance: "110,000",
    txDesc: "他行轉入",
    pk: "20260803100000011",
  },
  {
    sysDate: "2026/08/17",
    sysTime: "08:30",
    credit: false,
    amt: "6,543",
    balance: "103,457",
    txDesc: "自動扣款",
    pk: "20260817083000012",
  },
  {
    sysDate: "2026/08/25",
    sysTime: "13:45",
    credit: false,
    amt: "3,457",
    balance: "100,000",
    txDesc: "轉帳",
    pk: "20260825134500013",
  },
];

function summarize(result: ReturnType<typeof parseRakutenDepositTransactions>) {
  return result.transactions.map((tx) => [
    tx.postedDate,
    tx.amount,
    tx.description,
  ]);
}

describe("parseRakutenDepositTransactions direction", () => {
  it("derives direction from balance deltas when true means credit (newest first)", () => {
    const result = parseRakutenDepositTransactions(
      [month(SEPTEMBER, { trueMeansCredit: true })],
      deposits,
    );
    expect(summarize(result)).toEqual([
      ["2026-09-17", -6543, "自動扣款"],
      ["2026-09-04", 12, "存款利息"],
      ["2026-09-01", 30_000, "他行轉入 · 薪資"],
    ]);
    // 最新兩筆靠餘額差，最舊那筆靠同月學到的 amtSign 對應
    expect(result.stats.directionByBalance).toBe(2);
    expect(result.stats.directionByAmtSign).toBe(1);
    expect(result.stats.monthsSkipped).toBe(0);
  });

  it("does not assume the amtSign convention: the same rows with true meaning debit and oldest-first order give the same result", () => {
    const result = parseRakutenDepositTransactions(
      [month(SEPTEMBER, { trueMeansCredit: false, order: "oldestFirst" })],
      deposits,
    );
    expect(
      result.transactions.map((tx) => tx.amount).sort((a, b) => a - b),
    ).toEqual([-6543, 12, 30_000]);
    expect(result.stats.directionByBalance).toBe(2);
    expect(result.stats.directionByAmtSign).toBe(1);
  });

  it("learns the amtSign mapping across months for the oldest row of a month", () => {
    const result = parseRakutenDepositTransactions(
      [month(SEPTEMBER), month([AUGUST[0]!], { trueMeansCredit: true })],
      deposits,
    );
    // 只有一筆的月份沒有餘額差可比，靠 9 月學到的對應（true = 收入）
    const single = result.transactions.find(
      (tx) =>
        tx.raw &&
        (tx.raw as { balanceAfter?: number }).balanceAfter === 110_000,
    );
    expect(single?.amount).toBe(20_000);
    expect((single?.raw as { directionSource?: string }).directionSource).toBe(
      "amtSign",
    );
  });

  it("skips the month (and reports it) when direction cannot be determined", () => {
    const result = parseRakutenDepositTransactions(
      [month([AUGUST[0]!])],
      deposits,
    );
    expect(result.transactions).toEqual([]);
    expect(result.stats).toMatchObject({
      monthsProvided: 1,
      monthsSkipped: 1,
      skipReasons: { direction_unknown: 1 },
    });
  });

  it("does not trust amtSign when the evidence contradicts itself", () => {
    // 9 月 true = 收入；8 月把 amtSign 全部反過來 → 對應互相矛盾，最舊那筆無法判斷
    const result = parseRakutenDepositTransactions(
      [month(SEPTEMBER), month(AUGUST, { trueMeansCredit: false })],
      deposits,
    );
    expect(result.stats.skipReasons).toEqual({ direction_unknown: 2 });
    expect(result.transactions).toEqual([]);
  });

  it("does not use rows whose balance chain does not add up", () => {
    const broken = month(SEPTEMBER);
    // 中間那筆的交易後餘額被改壞：兩筆相鄰差都對不上，退回 amtSign，但沒有對應可學 → 整月略過
    broken.txDetails[1]!.balance = "999,999";
    const result = parseRakutenDepositTransactions([broken], deposits);
    expect(result.transactions).toEqual([]);
    expect(result.stats.skipReasons).toEqual({ direction_unknown: 1 });
  });

  it("resolves same-minute rows by trying both orders and accepting only one consistent chain", () => {
    const sameMinute: Row[] = [
      {
        sysDate: "2026/09/05",
        sysTime: "10:00",
        credit: true,
        amt: "500",
        balance: "1,500",
        txDesc: "他行轉入",
        pk: "20260905100000021",
      },
      {
        sysDate: "2026/09/05",
        sysTime: "10:00",
        credit: false,
        amt: "200",
        balance: "1,300",
        txDesc: "轉帳",
        pk: "20260905100000022",
      },
    ];
    const result = parseRakutenDepositTransactions(
      [month(sameMinute, { order: "oldestFirst" })],
      deposits,
    );
    expect(
      result.transactions.map((tx) => tx.amount).sort((a, b) => a - b),
    ).toEqual([-200, 500]);
  });
});

describe("parseRakutenDepositTransactions fields", () => {
  const result = parseRakutenDepositTransactions([month(SEPTEMBER)], deposits);
  const byDescription = (text: string) =>
    result.transactions.find((tx) => tx.description?.startsWith(text))!;

  it("maps rows to bank transactions of the deposit account", () => {
    expect(result.transactions).toHaveLength(3);
    for (const tx of result.transactions) {
      expect(tx.accountId).toBe(ACCOUNT_SOURCE_ID);
      expect(tx.currency).toBe("TWD");
      expect(tx.status).toBe("posted");
      expect(tx.sourceId).toMatch(/^rakuten:deposit:tx:[0-9a-f]{16}$/);
    }
    expect(new Set(result.transactions.map((tx) => tx.sourceId)).size).toBe(3);
  });

  it("uses Taipei date for postedDate and a +08:00 timestamp for authorizedAt", () => {
    const autoDebit = byDescription("自動扣款");
    expect(autoDebit.postedDate).toBe("2026-09-17");
    expect(autoDebit.authorizedAt).toBe("2026-09-17T08:30:00+08:00");
    expect(byDescription("存款利息").authorizedAt).toBe(
      "2026-09-04T00:05:00+08:00",
    );
  });

  it("keeps short memos in the description and drops long ones", () => {
    expect(byDescription("他行轉入").description).toBe("他行轉入 · 薪資");
    const long = month([
      {
        ...SEPTEMBER[0]!,
        memo: "這是一段很長很長很長很長很長很長很長很長很長很長的轉帳留言內容",
      },
    ]);
    const longResult = parseRakutenDepositTransactions([long], deposits);
    expect(longResult.stats.monthsSkipped).toBe(1);
    const withMapping = parseRakutenDepositTransactions(
      [
        month(SEPTEMBER),
        month([
          {
            ...AUGUST[0]!,
            memo: "這是一段很長很長很長很長很長很長很長很長很長很長的轉帳留言內容",
          },
        ]),
      ],
      deposits,
    );
    expect(
      withMapping.transactions.some((tx) => tx.description === "他行轉入"),
    ).toBe(true);
  });

  it("stores only the last four digits of the counterparty account, never the full number", () => {
    expect(byDescription("他行轉入").counterparty).toBe("****7890");
    expect(JSON.stringify(result.transactions)).not.toContain("0071234567890");
    // 暱稱空白時同樣只留末四碼；對手就是自己的帳號時不記對手
    expect(byDescription("自動扣款").counterparty).toBe("****0001");
    expect(byDescription("存款利息").counterparty).toBeUndefined();
    // accountId 是帳戶自己的 sourceId（既有慣例）；其餘欄位不得出現任何完整帳號
    const withoutAccountId = JSON.stringify(
      result.transactions.map(({ accountId: _accountId, ...rest }) => rest),
    );
    expect(withoutAccountId).not.toContain(ACCOUNT_NO);
  });

  it("prefers a non-numeric nickname over the account digits", () => {
    const nick = parseRakutenDepositTransactions(
      [month([{ ...SEPTEMBER[0]!, nickNameOrAcct: "房東" }, SEPTEMBER[1]!])],
      deposits,
    );
    expect(
      nick.transactions.find((tx) => tx.amount === 30_000)?.counterparty,
    ).toBe("房東");
  });

  it("derives a stable sourceId from pk and falls back to a field hash when pk is missing", () => {
    const again = parseRakutenDepositTransactions([month(SEPTEMBER)], deposits);
    expect(again.transactions.map((tx) => tx.sourceId)).toEqual(
      result.transactions.map((tx) => tx.sourceId),
    );
    const noPk = parseRakutenDepositTransactions(
      [month(SEPTEMBER.map((row) => ({ ...row, pk: null })))],
      deposits,
    );
    expect(noPk.transactions).toHaveLength(3);
    expect(noPk.transactions[0]!.sourceId).not.toBe(
      result.transactions[0]!.sourceId,
    );
    const noPkAgain = parseRakutenDepositTransactions(
      [month(SEPTEMBER.map((row) => ({ ...row, pk: null })))],
      deposits,
    );
    expect(noPkAgain.transactions.map((tx) => tx.sourceId)).toEqual(
      noPk.transactions.map((tx) => tx.sourceId),
    );
  });

  it("dedupes rows that appear in more than one month response", () => {
    const overlapping = parseRakutenDepositTransactions(
      [month(SEPTEMBER), month(SEPTEMBER)],
      deposits,
    );
    expect(overlapping.transactions).toHaveLength(3);
  });

  it("keeps only whitelisted raw fields", () => {
    for (const tx of result.transactions) {
      const keys = Object.entries(tx.raw as Record<string, unknown>)
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key)
        .sort();
      expect(keys).toEqual(["balanceAfter", "directionSource", "txDesc"]);
    }
  });
});

describe("parseRakutenDepositTransactions robustness", () => {
  it("skips months of another account and invalid payloads without throwing", () => {
    const result = parseRakutenDepositTransactions(
      [
        month(SEPTEMBER, { queryAccountNo: "0081299999999999" }),
        null,
        { display: {}, txDetails: "oops", queryAccountNo: ACCOUNT_NO },
        month(SEPTEMBER),
      ],
      deposits,
    );
    expect(result.transactions).toHaveLength(3);
    expect(result.stats).toMatchObject({
      monthsProvided: 4,
      monthsParsed: 1,
      monthsSkipped: 3,
      skipReasons: { account_mismatch: 1, invalid_payload: 2 },
    });
  });

  it("treats noData months as parsed and counts truncated months", () => {
    const result = parseRakutenDepositTransactions(
      [
        {
          display: { dataEnd: true, dataLimit: false, noData: true },
          accounts: [],
          queryAccountNo: ACCOUNT_NO,
        },
        month(SEPTEMBER, { display: { dataEnd: false, dataLimit: true } }),
      ],
      deposits,
    );
    expect(result.stats).toMatchObject({
      monthsParsed: 2,
      monthsSkipped: 0,
      monthsTruncated: 1,
      rowsParsed: 3,
    });
  });

  it("does not count empty months as truncated", () => {
    const result = parseRakutenDepositTransactions(
      [
        {
          display: { dataEnd: false, dataLimit: false, noData: true },
          accounts: [],
          queryAccountNo: ACCOUNT_NO,
          txDetails: [],
        },
        {
          display: { dataEnd: false, dataLimit: false, noData: false },
          accounts: [],
          queryAccountNo: ACCOUNT_NO,
          txDetails: [],
        },
      ],
      deposits,
    );
    expect(result.stats).toMatchObject({
      monthsParsed: 2,
      monthsSkipped: 0,
      monthsTruncated: 0,
    });
    expect(result.transactions).toHaveLength(0);
  });

  it("counts malformed rows instead of dropping the whole month", () => {
    const payload = month(SEPTEMBER);
    payload.txDetails.push({ sysDate: "not a date", amt: "x" } as never);
    const result = parseRakutenDepositTransactions([payload], deposits);
    expect(result.stats.rowsSkipped).toBe(1);
    expect(result.transactions).toHaveLength(3);
  });

  it("matches the account by its comparable number and falls back to the only deposit when the response has no number", () => {
    const dashed = parseRakutenDepositTransactions(
      [month(SEPTEMBER, { queryAccountNo: "0081-2000-0000-1234" })],
      deposits,
    );
    expect(dashed.transactions).toHaveLength(3);
    const noNumber = month(SEPTEMBER);
    delete (noNumber as { queryAccountNo?: string }).queryAccountNo;
    noNumber.accounts = [];
    expect(
      parseRakutenDepositTransactions([noNumber], deposits).transactions,
    ).toHaveLength(3);
  });
});

describe("parseRakutenData with deposit transactions", () => {
  const dashboardPayload = {
    depositInfo: {
      depAccounts: [
        { acctNo: ACCOUNT_NO, showAcctNo: "008-***-1234", ntdCurrBal: 123_469 },
      ],
    },
  };

  it("returns transactions for the deposit account next to balances", () => {
    const data = parseRakutenData({
      dashboardPayload,
      depositTxnPayloads: [month(SEPTEMBER), month(AUGUST)],
    });
    expect(data.bankAccounts).toHaveLength(1);
    expect(data.bankBalanceSnapshots).toHaveLength(1);
    expect(data.bankTransactions).toHaveLength(6);
    expect(
      data.bankTransactions.every((tx) => tx.accountId === ACCOUNT_SOURCE_ID),
    ).toBe(true);
    expect(data.transactionStats.monthsParsed).toBe(2);
  });

  it("keeps balances when the transaction payloads are unusable", () => {
    const data = parseRakutenData({
      dashboardPayload,
      depositTxnPayloads: [{ nonsense: true }, null],
    });
    expect(data.bankAccounts).toHaveLength(1);
    expect(data.bankBalanceSnapshots).toHaveLength(1);
    expect(data.bankTransactions).toEqual([]);
    expect(data.transactionStats.monthsSkipped).toBe(2);
  });

  it("produces no transactions without payloads", () => {
    const data = parseRakutenData({ dashboardPayload });
    expect(data.bankTransactions).toEqual([]);
    expect(data.transactionStats.monthsProvided).toBe(0);
  });
});
