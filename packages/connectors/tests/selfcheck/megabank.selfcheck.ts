import assert from "node:assert/strict";
import {
  createCipheriv,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
  constants,
} from "node:crypto";
import {
  parseMegabankConfig,
  parseMegabankData,
  type MegabankPayloads,
} from "../../src/megabank";
import {
  createMegabankConnector,
  encryptLogin,
  MegabankOtpInvalidError,
  MegabankOtpRequiredError,
  MegabankProtocolError,
  MegabankVerificationRequiredError,
  prepareMegabankCaptcha,
} from "../../src/megabank-mobile-api";

const credentials = {
  userId: "A123456789",
  account: "SYNTHETIC",
  password: "synthetic-only",
};
const depositAccountNo = "0000000000012345";
const cardNo = "0000000000006789";
const payloads: MegabankPayloads = {
  deposits: {
    rsData: {
      depositInfoList: [
        { DRACT: depositAccountNo, DRCUR: "TWD", AVLBA: "1,000", NAME: "活存" },
        { DRACT: depositAccountNo, DRCUR: "TWD", AVLBA: "200", NAME: "活存" },
      ],
    },
  },
  depositTransactions: [
    {
      accountNo: depositAccountNo,
      currency: "TWD",
      response: {
        rsData: {
          list: [
            {
              txDate: "2026-09-20",
              serialNo: "S1",
              seq: "1",
              DRCR: "D",
              amount: "250",
              paymentItem: "轉出",
            },
            {
              txDate: "2026-09-21",
              serialNo: "S2",
              seq: "2",
              DRCR: "C",
              amount: "100",
              paymentItem: "入帳",
            },
          ],
        },
      },
    },
  ],
  cardOverview: {
    rsData: {
      creditCardBillInfoList: [
        {
          ACCT_TYPE: "01",
          ACCT_MON: "202609",
          CURR_CODE: "TWD",
          THIS_TTL_AMT: "1000",
          PAYMENT_AMT: "200",
        },
        {
          ACCT_TYPE: "01",
          ACCT_MON: "202608",
          CURR_CODE: "TWD",
          THIS_TTL_AMT: "900",
          PAYMENT_AMT: "0",
        },
        {
          ACCT_TYPE: "01",
          ACCT_MON: "999912",
          CURR_CODE: "TWD",
          THIS_TTL_AMT: "300",
          PAYMENT_AMT: "0",
        },
        {
          ACCT_TYPE: "05",
          ACCT_MON: "202609",
          CURR_CODE: "TWD",
          THIS_TTL_AMT: "200",
          PAYMENT_AMT: "0",
        },
      ],
    },
  },
  cardBills: {
    rsData: {
      generalRecordList: [
        {
          acctMon: "202609",
          currCode: "TWD",
          thisTtlAmt: "1000",
          minPay: "100",
          thisPayAmt: "200",
          lastpayDate: "2026/10/15",
        },
      ],
      fancyRecordList: [
        {
          acctMon: "202609",
          currCode: "TWD",
          thisTtlAmt: "200",
          minPay: "20",
          thisPayAmt: "0",
          lastpayDate: "2026/10/15",
        },
      ],
      ridoRecordList: [
        {
          acctMon: "999912",
          currCode: "TWD",
          thisTtlAmt: "300",
          minPay: "0",
          thisPayAmt: "0",
        },
      ],
    },
  },
  cardHome: { rsData: { cardNumbers: [{ cardNo, cardName: "測試卡" }] } },
  cardTransactions: {
    rsData: {
      detailList: [
        {
          cardNo,
          detailList: [
            {
              cardNo,
              purchaseDate: "2026/09/23",
              merchantChiName: "測試商店",
              sourceAmt: "300",
              sourceCurr: "TWD",
              destinationAmt: "300",
              destinationCurr: "TWD",
              acctMon: "999912",
            },
            {
              cardNo,
              purchaseDate: "2026/09/24",
              merchantChiName: "測試商店退款",
              sourceAmt: "50",
              sourceCurr: "TWD",
              destinationAmt: "50",
              destinationCurr: "TWD",
              acctMon: "202609",
            },
          ],
        },
      ],
    },
  },
};

assert.equal(parseMegabankConfig(credentials).account, "SYNTHETIC");
assert.equal(
  parseMegabankConfig({ ...credentials, captcha: "12345" }).captcha,
  "12345",
);
assert.throws(() => parseMegabankConfig({ ...credentials, captcha: "1234" }));
const parsed = parseMegabankData(payloads, new Date("2026-09-25T00:00:00Z"));
const parsedAgain = parseMegabankData(
  payloads,
  new Date("2026-09-26T00:00:00Z"),
);
assert.equal(parsed.bankAccounts.length, 2);
assert.equal(
  parsed.bankBalanceSnapshots.find((row) =>
    row.accountId.startsWith("bank:megabank:"),
  )?.balance,
  1200,
);
assert.equal(
  parsed.bankBalanceSnapshots.find((row) =>
    row.accountId.startsWith("megabank:credit"),
  )?.balance,
  -1300,
);
assert.equal(
  parsed.bankBalanceSnapshots.find((row) =>
    row.accountId.startsWith("megabank:credit"),
  )?.statementBalance,
  1000,
);
assert.deepEqual(
  parsed.bankTransactions.map((row) => row.amount),
  [-250, 100, -300, 50],
);
assert.equal(parsed.bankTransactions[2]?.status, "pending");
assert.deepEqual(
  parsed.bankTransactions.map((row) => row.sourceId),
  parsedAgain.bankTransactions.map((row) => row.sourceId),
);
assert.equal(parsed.creditCardBills[0]?.statementAmount, 1200);
assert.equal(parsed.creditCardBills.length, 1);
assert.equal(parsed.creditCardBills[0]?.minimumPayment, 120);
assert.equal(parsed.creditCardBills[0]?.paidAmount, 200);
assert.equal(parsed.creditCardBills[0]?.paymentDueDate, "2026-10-15");
assert.equal(
  parsed.creditCardBills[0]?.accountId,
  parsed.bankTransactions[2]?.accountId,
);
assert.equal(JSON.stringify(parsed).includes(cardNo), false);
assert.equal(JSON.stringify(parsed).includes(depositAccountNo), false);
const postedPayloads = structuredClone(payloads);
const posted = (
  postedPayloads.cardTransactions as {
    rsData: {
      detailList: Array<{ detailList: Array<Record<string, unknown>> }>;
    };
  }
).rsData.detailList[0]?.detailList[0];
assert.ok(posted);
posted.acctMon = "202609";
posted.accountDate = "2026/09/24";
const postedResult = parseMegabankData(postedPayloads);
assert.equal(
  postedResult.bankTransactions[2]?.sourceId,
  parsed.bankTransactions[2]?.sourceId,
);
assert.equal(postedResult.bankTransactions[2]?.status, "posted");

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 1024,
});
const jwk = publicKey.export({ format: "jwk" });
assert.ok(jwk.n && jwk.e);
const key = randomBytes(24);
const cipherToken = {
  SessionKey: key.toString("hex"),
  RSAPublicKeyModulus: Buffer.from(jwk.n, "base64url").toString("hex"),
  RSAPublicKeyExponent: Buffer.from(jwk.e, "base64url").toString("hex"),
};
const encrypted = encryptLogin(credentials, cipherToken);
const plaintext = privateDecrypt(
  { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
  Buffer.from(
    encrypted.padStart(Buffer.from(jwk.n, "base64url").length * 2, "0"),
    "hex",
  ),
);
const prefix = Buffer.from(`${credentials.userId}|${credentials.account}/`);
assert.deepEqual(plaintext.subarray(0, prefix.length), prefix);
const paddedPassword =
  credentials.password +
  " ".repeat((16 - (credentials.password.length % 16)) % 16);
const des = createCipheriv("des-ede3-cbc", key, Buffer.alloc(8));
const expected = Buffer.concat([
  des.update(paddedPassword, "utf8"),
  des.final(),
]);
assert.deepEqual(plaintext.subarray(prefix.length), expected);

let oauthCalls = 0;
let loginCode = "0000";
let malformedResource: string | null = null;
let resourceError: { resource: string; code: string } | undefined;
let logoutHttpError = false;
let loginGate: Record<string, unknown> = {};
let otpVerified = false;
let validateCodeResult: { code: string; success?: boolean } = {
  code: "0000",
  success: true,
};
const requests: string[] = [];
const requestDeviceCodes: string[] = [];
let noCards = false;
const fetcher = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const url = String(input);
  const body = init?.body?.toString() ?? "";
  let response: Record<string, unknown> = {};
  if (url.endsWith("/oauth/token")) {
    oauthCalls += 1;
    response = { access_token: "synthetic-token" };
  } else if (url.endsWith("/main/init")) {
    response = { statusCode: "0000" };
  } else if (url.endsWith("/resource/login")) {
    response = {};
  } else if (url.includes("/resource/")) {
    const request = JSON.parse(body) as {
      resource: string;
      rqData: Record<string, unknown>;
      deviceIxd: string;
    };
    requests.push(request.resource);
    requestDeviceCodes.push(request.deviceIxd);
    if (request.resource.endsWith("/initialize")) {
      response = { code: "0000", rsData: {} };
    } else if (request.resource.endsWith("/captcha")) {
      response = {
        code: "0000",
        rsData: { image: Buffer.from("synthetic-image").toString("base64") },
      };
    } else if (request.resource.endsWith("/e2ee")) {
      response = {
        code: "0000",
        rsData: { isE2EE: true, cipherToken: JSON.stringify(cipherToken) },
      };
    } else if (request.resource.endsWith("/login")) {
      assert.equal(request.rqData.captchaCode, "12345");
      otpVerified = false;
      response = { code: loginCode, rsData: { ...loginGate } };
    } else if (request.resource === "/fco/fco00001/getverifycode") {
      assert.equal(request.rqData.type, "sms");
      response = { code: "0000", rsData: { checkCode: "AB12" } };
    } else if (request.resource === "/fco/fco00001/validatecode") {
      assert.equal(request.rqData.code, "654321");
      otpVerified = validateCodeResult.success === true;
      response = {
        code: validateCodeResult.code,
        rsData: { success: validateCodeResult.success },
      };
    } else if (request.resource === "/fco/fco02011/logout") {
      response = { code: "0000" };
      if (logoutHttpError) {
        return new Response(JSON.stringify(response), { status: 503 });
      }
    } else if (request.resource === "/fco/fco10001/home") {
      response =
        loginGate.isHighIpFar === true && !otpVerified
          ? { code: "SYS014", desc: "權限不足" }
          : resourceError?.resource === request.resource
            ? { code: resourceError.code }
            : { code: "0000", ...(payloads.deposits as object) };
    } else if (request.resource === "/fco/fco10007/home" && noCards) {
      response = { code: "0000", rsData: { creditCardBillInfoList: [] } };
    } else if (noCards && request.resource.startsWith("/fao/fao0101")) {
      response = { code: "1120", rsData: {} };
    } else if (request.resource === "/fao/fao01009/home" && noCards) {
      response = { code: "1120", rsData: {} };
    } else if (request.resource === "/fco/fco10007/home") {
      response =
        malformedResource === request.resource
          ? { code: "0000", rsData: {} }
          : { code: "0000", ...(payloads.cardOverview as object) };
    } else if (request.resource === "/fao/fao01009/home") {
      response =
        malformedResource === request.resource
          ? { code: "0000", rsData: { returnCode: "1120" } }
          : { code: "0000", ...(payloads.cardBills as object) };
    } else if (request.resource === "/fao/fao01010/home") {
      response =
        malformedResource === request.resource
          ? { code: "0000", rsData: {} }
          : { code: "0000", ...(payloads.cardHome as object) };
    } else if (request.resource === "/fao/fao01010/query") {
      response =
        malformedResource === request.resource
          ? { code: "0000", rsData: {} }
          : { code: "0000", ...(payloads.cardTransactions as object) };
    } else if (request.resource === "/fao/fao01001/query") {
      response = {
        code: "0000",
        ...(payloads.depositTransactions[0]?.response as object),
      };
    } else {
      throw new Error("Unexpected resource");
    }
  } else {
    throw new Error("Unexpected URL");
  }
  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
const challenge = await prepareMegabankCaptcha(credentials, fetcher);
assert.equal(challenge.imageBytes.byteLength, "synthetic-image".length);
assert.equal(JSON.stringify(challenge).includes(credentials.password), false);
const connector = createMegabankConnector(fetcher);
const result = await connector.sync({
  ...credentials,
  pendingSession: challenge.pendingSession,
  pendingSessionExpiresAt: challenge.pendingSessionExpiresAt,
  captcha: "12345",
});
assert.equal(oauthCalls, 1);
assert.equal(result.bankAccounts?.length, 2);
assert.equal(result.bankTransactions?.length, 4);
assert.equal(result.creditCardBills?.length, 1);
assert.ok(requests.includes("/fao/fao01010/query"));
assert.ok(requests.includes("/fao/fao01001/query"));
assert.equal(requests.at(-1), "/fco/fco02011/logout");
assert.equal(JSON.stringify(result.cursor).includes("token"), false);
logoutHttpError = true;
const resultWithLogoutFailure = await connector.sync({
  ...credentials,
  pendingSession: challenge.pendingSession,
  pendingSessionExpiresAt: challenge.pendingSessionExpiresAt,
  captcha: "12345",
});
assert.equal(resultWithLogoutFailure.bankAccounts?.length, 2);
logoutHttpError = false;
for (const resource of [
  "/fco/fco10007/home",
  "/fao/fao01009/home",
  "/fao/fao01010/home",
  "/fao/fao01010/query",
]) {
  malformedResource = resource;
  await assert.rejects(
    connector.sync({
      ...credentials,
      pendingSession: challenge.pendingSession,
      pendingSessionExpiresAt: challenge.pendingSessionExpiresAt,
      captcha: "12345",
    }),
    MegabankProtocolError,
  );
}
malformedResource = null;
loginCode = "0113";
const logoutCountBeforeLoginFailure = requests.filter(
  (resource) => resource === "/fco/fco02011/logout",
).length;
await assert.rejects(
  connector.sync({
    ...credentials,
    pendingSession: challenge.pendingSession,
    pendingSessionExpiresAt: challenge.pendingSessionExpiresAt,
    captcha: "12345",
  }),
  MegabankVerificationRequiredError,
);
assert.equal(
  requests.filter((resource) => resource === "/fco/fco02011/logout").length,
  logoutCountBeforeLoginFailure,
);
loginCode = "0000";
resourceError = {
  resource: "/fco/fco10001/home",
  code: "SYS014",
};
const logoutCountBeforeResourceFailure = requests.filter(
  (resource) => resource === "/fco/fco02011/logout",
).length;
await assert.rejects(
  connector.sync({
    ...credentials,
    pendingSession: challenge.pendingSession,
    pendingSessionExpiresAt: challenge.pendingSessionExpiresAt,
    captcha: "12345",
  }),
  (error: unknown) => {
    assert.ok(error instanceof MegabankProtocolError);
    assert.match(error.message, /若目前已登入兆豐網銀，請登出後再試。/);
    return true;
  },
);
assert.equal(
  requests.filter((resource) => resource === "/fco/fco02011/logout").length,
  logoutCountBeforeResourceFailure + 1,
);
resourceError = undefined;

// 異地登入：只有允許寄簡訊的手動同步會請銀行寄驗證碼，並保留已登入工作階段。
const logoutCount = () =>
  requests.filter((resource) => resource === "/fco/fco02011/logout").length;
const freshSync = () => ({
  ...credentials,
  pendingSession: challenge.pendingSession,
  pendingSessionExpiresAt: challenge.pendingSessionExpiresAt,
  captcha: "12345",
});
loginGate = { secondFactorFlag: "N", isHighIpFar: true, resultType: "3" };
let logoutsBefore = logoutCount();
await assert.rejects(connector.sync(freshSync()), (error: unknown) => {
  assert.ok(error instanceof MegabankVerificationRequiredError);
  assert.equal(error instanceof MegabankOtpRequiredError, false);
  return true;
});
assert.equal(requests.includes("/fco/fco00001/getverifycode"), false);
assert.equal(logoutCount(), logoutsBefore + 1);

const otpConnector = createMegabankConnector(fetcher, undefined, {
  allowOtpRequest: true,
});
logoutsBefore = logoutCount();
let otpRequired: MegabankOtpRequiredError | undefined;
await assert.rejects(otpConnector.sync(freshSync()), (error: unknown) => {
  assert.ok(error instanceof MegabankOtpRequiredError);
  otpRequired = error;
  return true;
});
assert.ok(otpRequired);
assert.match(otpRequired.message, /簡訊檢核碼 AB12/);
assert.equal(otpRequired.message.includes(credentials.password), false);
assert.equal(JSON.parse(otpRequired.pendingSession).authenticated, true);
// 錯誤要帶出待驗證登入所用的虛擬裝置，service 才能保存。
const requiredSessionState = JSON.parse(otpRequired.pendingSession);
assert.deepEqual(otpRequired.device, {
  deviceCode: requiredSessionState.deviceCode,
  deviceUKey: requiredSessionState.deviceUKey,
  deviceSeed: requiredSessionState.seed,
});
assert.ok(otpRequired.device.deviceCode);
assert.ok(Date.parse(otpRequired.pendingSessionExpiresAt) > Date.now());
assert.equal(logoutCount(), logoutsBefore, "等待簡訊驗證碼時不得登出");

// 驗證碼錯誤：保留工作階段讓使用者重新輸入，不登出。
validateCodeResult = { code: "0000", success: false };
let otpInvalid: MegabankOtpInvalidError | undefined;
await assert.rejects(
  otpConnector.sync({
    ...credentials,
    pendingSession: otpRequired.pendingSession,
    pendingSessionExpiresAt: otpRequired.pendingSessionExpiresAt,
    otp: "654321",
  }),
  (error: unknown) => {
    assert.ok(error instanceof MegabankOtpInvalidError);
    otpInvalid = error;
    return true;
  },
);
assert.ok(otpInvalid);
assert.equal(
  otpInvalid.pendingSessionExpiresAt,
  otpRequired.pendingSessionExpiresAt,
);
assert.deepEqual(otpInvalid.device, otpRequired.device);
assert.equal(logoutCount(), logoutsBefore);

// 驗證碼正確：接續同一個登入抓資料，結束後登出。
validateCodeResult = { code: "0000", success: true };
const verifiedResult = await otpConnector.sync({
  ...credentials,
  pendingSession: otpInvalid.pendingSession,
  pendingSessionExpiresAt: otpInvalid.pendingSessionExpiresAt,
  otp: "654321",
});
assert.equal(verifiedResult.bankAccounts?.length, 2);
assert.equal(requests.at(-1), "/fco/fco02011/logout");
assert.equal(logoutCount(), logoutsBefore + 1);

// 銀行回非 0000：結束這次驗證並登出，需重新取得圖形驗證碼。
validateCodeResult = { code: "9999" };
logoutsBefore = logoutCount();
await assert.rejects(
  otpConnector.sync({
    ...credentials,
    pendingSession: otpRequired.pendingSession,
    pendingSessionExpiresAt: otpRequired.pendingSessionExpiresAt,
    otp: "654321",
  }),
  (error: unknown) => {
    assert.ok(error instanceof MegabankVerificationRequiredError);
    assert.equal(error instanceof MegabankOtpInvalidError, false);
    return true;
  },
);
assert.equal(logoutCount(), logoutsBefore + 1);

// 等待驗證碼的工作階段逾時：盡力登出並要求重新開始。
logoutsBefore = logoutCount();
await assert.rejects(
  otpConnector.sync({
    ...credentials,
    pendingSession: otpRequired.pendingSession,
    pendingSessionExpiresAt: new Date(Date.now() - 1000).toISOString(),
    otp: "654321",
  }),
  /逾時/,
);
assert.equal(logoutCount(), logoutsBefore + 1);

// 雙重驗證（secondFactorFlag=Y）不支援：登出並中止，不寄簡訊。
loginGate = { secondFactorFlag: "Y", isHighIpFar: true };
logoutsBefore = logoutCount();
const verifyCodeRequests = requests.filter(
  (resource) => resource === "/fco/fco00001/getverifycode",
).length;
await assert.rejects(otpConnector.sync(freshSync()), /雙重驗證/);
assert.equal(logoutCount(), logoutsBefore + 1);
assert.equal(
  requests.filter((resource) => resource === "/fco/fco00001/getverifycode")
    .length,
  verifyCodeRequests,
);
loginGate = {};

// 回歸：上一輪留下的已登入待驗證工作階段（沒有輸入簡訊驗證碼）不得當成圖形驗證碼
// session 重用；要先登出，再重新取得圖形驗證碼（有辨識器時自動辨識）並正常登入。
const recognizingConnector = createMegabankConnector(
  fetcher,
  async () => "12345",
  { allowOtpRequest: true },
);
assert.equal(
  JSON.parse(otpRequired.pendingSession).authenticated,
  true,
  "前置條件：待驗證工作階段仍是已登入狀態",
);
assert.ok(Date.parse(otpRequired.pendingSessionExpiresAt) > Date.now());
const staleRequestStart = requests.length;
logoutsBefore = logoutCount();
const staleResult = await recognizingConnector.sync({
  ...credentials,
  pendingSession: otpRequired.pendingSession,
  pendingSessionExpiresAt: otpRequired.pendingSessionExpiresAt,
});
assert.equal(staleResult.bankAccounts?.length, 2);
const staleRequests = requests.slice(staleRequestStart);
const staleLogoutIndex = staleRequests.indexOf("/fco/fco02011/logout");
const staleCaptchaIndex = staleRequests.indexOf("/fco/fco00001/captcha");
assert.ok(staleLogoutIndex >= 0, "舊的已登入工作階段必須先登出");
assert.ok(staleCaptchaIndex >= 0, "必須重新取得圖形驗證碼");
assert.ok(
  staleLogoutIndex < staleCaptchaIndex,
  "先登出舊工作階段再取圖形驗證碼",
);
assert.equal(
  staleRequests.filter((resource) => resource === "/fco/fco00001/captcha")
    .length,
  1,
);
assert.equal(logoutCount(), logoutsBefore + 2, "舊工作階段與新登入各登出一次");
assert.equal(requests.at(-1), "/fco/fco02011/logout");

// 已保存的虛擬裝置：取得驗證碼與後續登入都沿用同一組識別。
assert.ok(challenge.device.deviceCode);
assert.equal(
  JSON.parse(challenge.pendingSession).deviceCode,
  challenge.device.deviceCode,
);
const savedDevice = {
  deviceCode: "synthetic-device-code",
  deviceUKey: "synthetic-device-ukey",
  deviceSeed: "synthetic-device-seed",
};
const deviceChallenge = await prepareMegabankCaptcha(
  { ...credentials, ...savedDevice },
  fetcher,
);
assert.deepEqual(deviceChallenge.device, savedDevice);
const deviceSession = JSON.parse(deviceChallenge.pendingSession);
assert.equal(deviceSession.deviceCode, savedDevice.deviceCode);
assert.equal(deviceSession.deviceUKey, savedDevice.deviceUKey);
assert.equal(deviceSession.seed, savedDevice.deviceSeed);
requestDeviceCodes.length = 0;
await connector.sync({
  ...credentials,
  ...savedDevice,
  pendingSession: deviceChallenge.pendingSession,
  pendingSessionExpiresAt: deviceChallenge.pendingSessionExpiresAt,
  captcha: "12345",
});
assert.ok(requestDeviceCodes.length > 0);
assert.ok(requestDeviceCodes.every((code) => code === savedDevice.deviceCode));
assert.notEqual(challenge.device.deviceCode, savedDevice.deviceCode);

// 沒有信用卡：總覽為空時不查帳單與卡片，只同步存款。
noCards = true;
requests.length = 0;
const noCardResult = await connector.sync(freshSync());
assert.equal(noCardResult.creditCardBills?.length ?? 0, 0);
assert.ok(
  (noCardResult.bankAccounts ?? []).every(
    (account) => account.accountType !== "credit",
  ),
);
assert.ok((noCardResult.bankAccounts ?? []).length > 0);
assert.equal(
  requests.some((resource) => resource.startsWith("/fao/fao0100")),
  true,
  "存款交易仍需查詢",
);
assert.equal(requests.includes("/fao/fao01009/home"), false);
assert.equal(requests.includes("/fao/fao01010/home"), false);
assert.equal(requests.includes("/fao/fao01010/query"), false);
noCards = false;
console.log("megabank selfcheck passed");
