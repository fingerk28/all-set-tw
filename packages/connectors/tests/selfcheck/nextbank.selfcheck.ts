import assert from "node:assert/strict";
import {
  NextbankApiClient,
  NextbankApiError,
  collectNextbankDepositPayloads,
} from "../../src/nextbank-api";
import {
  parseNextbankMainAccount,
  parseNextbankPocketTransactions,
  parseNextbankTermPocket,
  parseNextbankDemandPocket,
  parseNextbankDeposits,
  normalizeNextbankTime,
  nextbankConfigSchema,
} from "../../src/nextbank";

const credentials = {
  identity: "A123456789",
  userId: "sampleuser",
  password: "SyntheticPass1",
  captchaResult: "12345",
};
const captcha = { uuid: "synthetic-uuid", captchaImage: "c3ludGhldGlj" };
const ok = (data: unknown) => Response.json({ success: true, data });
const rejectsKind = (kind: string) => (error: unknown) =>
  error instanceof NextbankApiError && error.kind === kind;

async function main() {
  const logoutClient = new NextbankApiClient({
    fetcher: async (url, init) => {
      assert.equal(
        new URL(String(url)).pathname,
        "/ap2/api/v1.0/membership/Logout",
      );
      assert.equal(new Headers(init?.headers).get("Acstkn"), "synthetic-token");
      return Response.json({ success: true });
    },
  });
  await logoutClient.logout("synthetic-token");
  const termPocket = {
    depositType: "TERMDEPOSIT",
    arrngId: "synthetic-term",
    name: "定存 012345678901",
    amount: "10000",
  };
  const term = parseNextbankTermPocket(termPocket, {
    startDate: "2026/07/01",
    endDate: "2027/07/01",
    accruAmt: 20,
  });
  assert.equal(
    term.bankBalanceSnapshots[0].balance,
    10000,
    "do not double count unpaid accrued interest",
  );
  assert.equal(
    term.bankTransactions.length,
    0,
    "do not fabricate an opening transfer",
  );
  assert.equal(term.bankAccounts[0].accountType, "time_deposit");
  assert.equal(term.bankAccounts[0].openedDate, "2026-07-01");
  assert.equal(term.bankAccounts[0].maturityDate, "2027-07-01");
  assert.equal(JSON.stringify(term).includes("012345678901"), false);
  const renamed = parseNextbankTermPocket(
    { ...termPocket, name: "旅遊基金" },
    {},
  );
  assert.equal(renamed.bankAccounts[0].sourceId, term.bankAccounts[0].sourceId);
  assert.throws(
    () => parseNextbankTermPocket({ ...termPocket, amount: -1 }, {}),
    rejectsKind("protocol"),
  );
  assert.throws(
    () =>
      parseNextbankTermPocket(termPocket, {
        startDate: "2027-01-01",
        endDate: "2026-01-01",
      }),
    rejectsKind("protocol"),
  );
  let restoredRequests = 0;
  const restored = new NextbankApiClient({
    now: () => 1_000,
    fetcher: async (_url, init) => {
      restoredRequests++;
      assert.equal(
        JSON.parse(String(init?.body)).captchaUuid,
        "saved-challenge",
      );
      return ok({ acstkn: "synthetic-restored-token" });
    },
  });
  restored.restoreCaptcha({ uuid: "saved-challenge", expiresAt: 61_000 });
  assert.deepEqual(await restored.login(credentials), {
    accessToken: "synthetic-restored-token",
  });
  await assert.rejects(
    () => restored.login(credentials),
    rejectsKind("captcha"),
  );
  for (const expiresAt of [1_000, 999, 121_001, NaN, Infinity]) {
    assert.throws(
      () => restored.restoreCaptcha({ uuid: "saved-challenge", expiresAt }),
      rejectsKind("captcha"),
    );
  }
  assert.equal(restoredRequests, 1);
  const overview = {
    mainAccount: {
      accountId: "0000000123456789",
      workingBalance: "2500.50",
      availableBalance: 2400,
    },
    customerInfo: { secret: "must-not-be-copied" },
  };
  const trade = {
    tradeID: "test-trade-1",
    tradeAmount: "-125.50",
    tradeChannel: "TRANSFEROUT",
    detail: {
      txnDateTime: "2026-09-27 14:12:30",
      descript: "轉帳 012345678901",
      summary: "生活支出",
      memo: "菜錢",
    },
  };
  const data = parseNextbankMainAccount(overview, [{ trades: [trade, trade] }]);
  const completePayload = {
    overview,
    mainTransactions: [{ trades: [trade] }],
    pocketSummary: { depositTotalAmount: 250, termDepositTotalAmount: 0 },
    pockets: [
      {
        depositType: "DEPOSIT",
        accNo: "synthetic-pocket",
        amount: 250,
        name: "菜錢",
      },
    ],
    pocketTransactions: [
      { accNo: "synthetic-pocket", pages: [{ trades: [trade] }] },
    ],
    termDeposits: [],
  };
  const merged = parseNextbankDeposits(completePayload, new Date("2026-09-27"));
  assert.equal(merged.bankAccounts.length, 2);
  assert.equal(merged.bankTransactions.length, 2);
  assert.throws(
    () =>
      parseNextbankDeposits({
        ...completePayload,
        pocketSummary: { depositTotalAmount: 251, termDepositTotalAmount: 0 },
      }),
    rejectsKind("protocol"),
  );
  assert.throws(
    () => parseNextbankDeposits({ ...completePayload, pocketTransactions: [] }),
    rejectsKind("protocol"),
  );
  assert.throws(
    () =>
      parseNextbankDeposits({
        ...completePayload,
        pockets: [...completePayload.pockets, ...completePayload.pockets],
      }),
    rejectsKind("protocol"),
  );
  const sparseDetail = {
    ...trade,
    tradeDateTime: Date.parse("2026-08-15T10:12:00+08:00"),
    detail: {
      txnDateTime: null,
      deductionDate: null,
      descript: null,
      summary: null,
      memo: "菜錢",
    },
  };
  const fallbackTime = parseNextbankMainAccount(overview, [
    { trades: [sparseDetail] },
  ]);
  assert.equal(
    fallbackTime.bankTransactions[0].authorizedAt,
    "2026-08-15T02:12:00.000Z",
  );
  assert.equal(fallbackTime.bankTransactions[0].description, "菜錢");
  assert.notEqual(
    fallbackTime.bankTransactions[0].sourceId,
    data.bankTransactions[0].sourceId,
  );
  const demandPocket = {
    depositType: "DEPOSIT",
    accNo: "synthetic-pocket",
    name: "菜錢口袋",
    amount: 2000,
    openDate: Date.parse("2026-01-01T00:00:00+08:00"),
  };
  const demand = parseNextbankDemandPocket(
    demandPocket,
    [{ trades: [sparseDetail] }],
    new Date("2026-09-27"),
  );
  assert.equal(demand.bankAccounts[0].openedDate, "2026-01-01");
  assert.equal(demand.bankBalanceSnapshots[0].balance, 2000);
  assert.equal(
    demand.bankTransactions[0].accountId,
    demand.bankAccounts[0].sourceId,
  );
  assert.equal(
    parseNextbankDemandPocket({ ...demandPocket, name: "旅行" }, [
      { trades: [] },
    ]).bankAccounts[0].sourceId,
    demand.bankAccounts[0].sourceId,
  );
  assert.equal(data.bankTransactions.length, 1);
  assert.equal(data.bankTransactions[0].amount, -125.5);
  const pocketNow = new Date("2026-09-27T02:00:00Z");
  const pocketRows = [
    {
      ...trade,
      tradeID: "old",
      detail: { ...trade.detail, txnDateTime: "2026-06-30" },
    },
    {
      ...trade,
      tradeID: "start",
      detail: { ...trade.detail, txnDateTime: "2026-06-30T16:00:00Z" },
    },
    trade,
    {
      ...trade,
      tradeID: "future",
      detail: { ...trade.detail, txnDateTime: "2026-09-28" },
    },
  ];
  const pocket = parseNextbankPocketTransactions(
    "synthetic-pocket",
    [{ trades: pocketRows }, { trades: [trade] }],
    pocketNow,
  );
  assert.equal(
    pocket.length,
    2,
    "filter by Taiwan date even with unordered rows and repeated pages",
  );
  assert.match(pocket[1].description!, /菜錢/);
  assert.notEqual(
    pocket[1].sourceId,
    data.bankTransactions[0].sourceId,
    "same trade ID in different accounts must not collide",
  );
  const promotedWithDateOnly = parseNextbankMainAccount(overview, [
    {
      trades: [
        { ...trade, tradeChannel: "UNBILLED" },
        { ...trade, detail: { ...trade.detail, txnDateTime: "2026-09-27" } },
      ],
    },
  ]);
  assert.equal(
    promotedWithDateOnly.bankTransactions[0].authorizedAt,
    "2026-09-27T14:12:30+08:00",
  );
  assert.throws(
    () => normalizeNextbankTime("2026-09-27 24:00:00"),
    rejectsKind("protocol"),
  );
  assert.equal(
    data.bankTransactions[0].description,
    "轉帳 ***8901 · 生活支出 · 菜錢",
  );
  const monthlyTrades = parseNextbankMainAccount(overview, [
    { trades: [trade] },
    {
      trades: [
        {
          ...trade,
          detail: { ...trade.detail, txnDateTime: "2026-08-27 14:12:30" },
        },
      ],
    },
    {
      trades: [
        {
          ...trade,
          detail: { ...trade.detail, txnDateTime: "2026-07-27 14:12:30" },
        },
      ],
    },
    { trades: [trade] },
  ]);
  assert.equal(
    monthlyTrades.bankTransactions.length,
    3,
    "reused trade IDs in different months must not overwrite outgoing transfers; identical rows still deduplicate",
  );
  assert.equal(
    new Set(monthlyTrades.bankTransactions.map((t) => t.sourceId)).size,
    3,
  );
  assert.ok(monthlyTrades.bankTransactions.every((t) => t.amount === -125.5));
  const changedMemo = parseNextbankMainAccount(overview, [
    {
      trades: [{ ...trade, detail: { ...trade.detail, memo: "晚餐菜錢" } }],
    },
  ]);
  assert.equal(
    changedMemo.bankTransactions[0].sourceId,
    data.bankTransactions[0].sourceId,
  );
  assert.match(changedMemo.bankTransactions[0].description!, /晚餐菜錢/);
  assert.equal(
    data.bankTransactions[0].authorizedAt,
    "2026-09-27T14:12:30+08:00",
  );
  assert.equal(data.bankTransactions[0].postedDate, "2026-09-27");
  assert.equal(data.bankBalanceSnapshots[0].balance, 2500.5);
  assert.equal(
    data.bankTransactions[0].accountId,
    data.bankAccounts[0].sourceId,
  );
  assert.equal(JSON.stringify(data).includes("012345678901"), false);
  assert.equal(JSON.stringify(data).includes("must-not-be-copied"), false);
  assert.equal(
    JSON.stringify(data).includes(overview.mainAccount.accountId),
    false,
  );
  const pending = { ...trade, tradeChannel: "UNBILLED" };
  const promoted = parseNextbankMainAccount(overview, [
    { trades: [pending, trade, pending] },
  ]);
  assert.equal(
    promoted.bankTransactions[0].sourceId,
    data.bankTransactions[0].sourceId,
  );
  assert.equal(promoted.bankTransactions[0].status, "posted");
  const repeated = parseNextbankMainAccount(
    overview,
    [{ trades: [trade] }],
    new Date("2026-10-01"),
  );
  assert.equal(
    repeated.bankTransactions[0].sourceId,
    data.bankTransactions[0].sourceId,
  );
  assert.equal(normalizeNextbankTime("2026/09/27"), "2026-09-27");
  assert.throws(
    () => normalizeNextbankTime("2026-02-30"),
    rejectsKind("protocol"),
  );
  assert.throws(
    () => parseNextbankMainAccount(overview, [{}]),
    rejectsKind("protocol"),
  );
  assert.throws(
    () => parseNextbankMainAccount({}, [{ trades: [] }]),
    rejectsKind("protocol"),
  );
  assert.throws(
    () =>
      parseNextbankMainAccount(overview, [
        { trades: [{ ...trade, tradeAmount: "" }] },
      ]),
    rejectsKind("protocol"),
  );
  assert.equal(
    parseNextbankMainAccount(overview, [{ trades: [] }]).bankTransactions
      .length,
    0,
  );
  assert.equal(
    nextbankConfigSchema.safeParse({ captchaExpiresAt: "invalid" }).success,
    false,
  );
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let now = 1_000;
  const client = new NextbankApiClient({
    now: () => now,
    fetcher: async (url, init) => {
      requests.push({ url: String(url), init: init! });
      return requests.length % 2 === 1
        ? ok(captcha)
        : ok({ acstkn: "synthetic-token" });
    },
  });
  await assert.rejects(() => client.login(credentials), rejectsKind("captcha"));
  assert.equal(requests.length, 0);
  const challenge = await client.prepareCaptcha();
  assert.equal(challenge.uuid, captcha.uuid);
  assert.equal(challenge.expiresAt, 121_000);
  const session = await client.login(credentials);
  assert.equal(session.accessToken, "synthetic-token");
  assert.equal(
    requests[0].url,
    "https://api.nextbank.com.tw/ap2/open/common/v1.0/Captcha",
  );
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
    isAudio: false,
  });
  assert.equal(
    requests[1].url,
    "https://api.nextbank.com.tw/ap2/api/v1.1/membership/CaptchaLogin",
  );
  const body = JSON.parse(String(requests[1].init.body));
  assert.equal(body.identity, credentials.identity);
  assert.equal(body.userId, btoa(credentials.userId));
  assert.match(body.passwd, /^[0-9A-F]{512}$/);
  assert.equal(
    String(requests[1].init.body).includes(credentials.password),
    false,
  );
  assert.equal(body.captchaUuid, captcha.uuid);
  assert.equal(body.isAbnormalLogout, false);
  assert.equal(requests[1].init.redirect, "manual");
  await assert.rejects(() => client.login(credentials), rejectsKind("captcha"));
  assert.equal(requests.length, 2);
  await client.prepareCaptcha();
  now = 121_000;
  await assert.rejects(() => client.login(credentials), rejectsKind("captcha"));
  assert.equal(requests.length, 3);

  for (const [code, kind] of [
    ["CAPTCHA_ERROR", "captcha"],
    ["CAPTCHA_EXPIRED", "captcha"],
    ["OTHER_DEVICE_LOGIN", "session_conflict"],
    ["ABNORMAL_LOGOUT", "session_conflict"],
    ["MEMBER_LOCKED", "account_unavailable"],
    ["LOGIN_ERROR", "credentials"],
    ["CONTINUOUSLY_LOGIN_ERROR_1_TIMES", "credentials"],
    ["unrecognized-secret-value", "protocol"],
  ]) {
    let calls = 0;
    const rejected = new NextbankApiClient({
      fetcher: async () =>
        ++calls === 1
          ? ok(captcha)
          : Response.json({
              success: false,
              error: { errorCode: code, message: "private bank response" },
            }),
    });
    await rejected.prepareCaptcha();
    await assert.rejects(() => rejected.login(credentials), rejectsKind(kind));
    await assert.rejects(
      () => rejected.login(credentials),
      rejectsKind("captcha"),
    );
    assert.equal(calls, 2, "failed login must not retry");
  }
  for (const [response, kind] of [
    [new Response("", { status: 429 }), "rate_limit"],
    [new Response("", { status: 500 }), "transport"],
    [new Response("not-json"), "protocol"],
    [ok({}), "protocol"],
    [Response.json({ data: captcha }), "protocol"],
  ] as const) {
    const invalid = new NextbankApiClient({ fetcher: async () => response });
    await assert.rejects(() => invalid.prepareCaptcha(), rejectsKind(kind));
  }
  const network = new NextbankApiClient({
    fetcher: async () => {
      throw new Error("secret request body");
    },
  });
  await assert.rejects(
    () => network.prepareCaptcha(),
    (error: unknown) =>
      rejectsKind("transport")(error) && !String(error).includes("secret"),
  );
  const queries: Array<{ url: string; body: unknown; headers: Headers }> = [];
  const reader = new NextbankApiClient({
    fetcher: async (url, init) => {
      queries.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        headers: new Headers(init?.headers),
      });
      return ok({ trades: [] });
    },
  });
  await reader.getMainAccountTransactions("synthetic-token", 1000, 2000);
  assert.equal(
    queries[0].url,
    "https://api.nextbank.com.tw/ap1/api/v3.0/AppMainPage/CurrentDepositDetail",
  );
  assert.deepEqual(queries[0].body, { startDateTime: 1000, endDateTime: 2000 });
  assert.equal(queries[0].headers.get("Acstkn"), "synthetic-token");
  assert.equal(queries[0].headers.get("Channel"), "WEB");
  await reader.getPocketTransactions("synthetic-token", "synthetic-account");
  assert.deepEqual(queries[1].body, {
    accNo: "synthetic-account",
    paging: { pageToken: "", startTradeID: "", pageSize: 10 },
  });
  await assert.rejects(
    () => reader.getMainAccountTransactions("synthetic-token", 2000, 1000),
    rejectsKind("protocol"),
  );
  assert.equal(queries.length, 2);
  let pocketPage = 0;
  const ranges: Array<{ startDateTime: number; endDateTime: number }> = [];
  const collector = new NextbankApiClient({
    fetcher: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(init?.body));
      if (path.endsWith("/AllInOne")) return ok(overview);
      if (path.endsWith("/PocketInfo"))
        return ok({
          pocketDetails: [
            { depositType: "DEPOSIT", accNo: "pocket-1", name: "生活費" },
            { depositType: "TERMDEPOSIT", arrngId: "term-1", amount: 1000 },
          ],
        });
      if (path.endsWith("/CurrentDepositDetail")) {
        ranges.push(body);
        return ok({ trades: [] });
      }
      if (path.endsWith("/GetTermDepositDetail")) {
        assert.equal(body.arrngId, "term-1");
        return ok({ rate: 1.5 });
      }
      assert.equal(path, "/ap1/api/v1.0/demandDeposit/GetPocketTxDetail");
      pocketPage++;
      if (pocketPage === 1) {
        assert.equal(body.paging.pageToken, "");
        return ok({
          trades: [trade],
          pageInfo: {
            hasNext: true,
            pageToken: "page-2",
            lastTradeID: "trade-1",
          },
        });
      }
      assert.equal(body.paging.startTradeID, "trade-1");
      assert.equal(body.paging.pageToken, "page-2");
      return ok({ trades: [], pageInfo: { hasNext: false } });
    },
  });
  const snapshot = await collectNextbankDepositPayloads(
    collector,
    "synthetic-token",
    new Date("2026-09-27T02:00:00Z"),
  );
  assert.equal(snapshot.pocketTransactions[0].pages.length, 2);
  assert.equal(snapshot.termDeposits.length, 1);
  assert.equal(ranges.length, 3);
  assert.equal(
    new Date(ranges[0].startDateTime).toISOString(),
    "2026-08-31T16:00:00.000Z",
  );
  assert.equal(
    new Date(ranges[2].startDateTime).toISOString(),
    "2026-06-30T16:00:00.000Z",
  );
  const looping = new NextbankApiClient({
    fetcher: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/AllInOne")) return ok(overview);
      if (path.endsWith("/PocketInfo"))
        return ok({
          pocketDetails: [{ depositType: "DEPOSIT", accNo: "loop" }],
        });
      if (path.endsWith("/CurrentDepositDetail")) return ok({ trades: [] });
      return ok({
        trades: [trade],
        pageInfo: { hasNext: true, pageToken: "same", lastTradeID: "same" },
      });
    },
  });
  await assert.rejects(
    () => collectNextbankDepositPayloads(looping, "synthetic-token"),
    rejectsKind("protocol"),
  );
  console.log(
    "Nextbank authentication contract self-check passed (synthetic, no live login).",
  );
}
await main();
