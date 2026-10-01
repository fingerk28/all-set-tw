import assert from "node:assert/strict";
import { parseRakutenConfig, parseRakutenData } from "../../src/rakuten";

assert.deepEqual(
  parseRakutenConfig({
    userId: "A123456789",
    account: "rakuten-user",
    password: "password",
  }),
  {
    userId: "A123456789",
    account: "rakuten-user",
    password: "password",
  },
);

assert.throws(() => parseRakutenConfig({ captcha: "123" }));
assert.throws(() => parseRakutenConfig({ captcha: "toolong" }));

const depositPageText = `
臺幣存款
活存總額 0081200000001234
$52,345
`;

const result = parseRakutenData({ depositPageText });

assert.equal(result.bankAccounts.length, 1);
const savings = result.bankAccounts[0];
assert.equal(savings?.sourceId, "bank:rakuten:0081200000001234:TWD");
assert.equal(savings?.accountType, "savings");

assert.equal(result.bankBalanceSnapshots.length, 1);
assert.equal(result.bankBalanceSnapshots[0]?.accountId, savings?.sourceId);
assert.equal(result.bankBalanceSnapshots[0]?.balance, 52_345);

// No deposit payload or text: nothing should be produced.
assert.equal(parseRakutenData({}).bankAccounts.length, 0);

// Deposit transactions: direction comes from balance deltas, not from a guessed
// amtSign convention (synthetic rows, newest first).
const depositTxn = (
  sysDate: string,
  sysTime: string,
  amtSign: boolean,
  amt: string,
  balance: string,
  txDesc: string,
  pk: string,
) => ({
  sysDate,
  sysTime,
  amtSign,
  amt,
  balance,
  txDesc,
  memo: "",
  nickNameOrAcct: "",
  acctNo: "",
  bankId: "",
  pk,
});
const withTransactions = parseRakutenData({
  depositPageText,
  depositTxnPayloads: [
    {
      display: { dataEnd: true, dataLimit: false, noData: false },
      accounts: [{ acctNo: "0081200000001234", balance: "52,345" }],
      queryAccountNo: "0081200000001234",
      txDetails: [
        depositTxn(
          "2026/09/17",
          "08:30",
          false,
          "6,543",
          "52,345",
          "自動扣款",
          "20260917083000001",
        ),
        depositTxn(
          "2026/09/01",
          "09:10",
          true,
          "10,000",
          "58,888",
          "他行轉入",
          "20260901091000002",
        ),
      ],
    },
  ],
});
assert.equal(withTransactions.bankTransactions.length, 2);
assert.deepEqual(
  withTransactions.bankTransactions.map((tx) => tx.amount),
  [-6_543, 10_000],
);
assert.equal(
  withTransactions.bankTransactions[0]?.accountId,
  "bank:rakuten:0081200000001234:TWD",
);
assert.equal(withTransactions.transactionStats.monthsSkipped, 0);

// Unusable transaction payloads never drop the balance.
const badTransactions = parseRakutenData({
  depositPageText,
  depositTxnPayloads: [{ nonsense: true }],
});
assert.equal(badTransactions.bankBalanceSnapshots.length, 1);
assert.equal(badTransactions.bankTransactions.length, 0);
assert.equal(badTransactions.transactionStats.monthsSkipped, 1);

console.log("Rakuten connector self-check passed.");
