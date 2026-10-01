import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const puppeteerMock = vi.hoisted(() => ({
  connect: vi.fn(),
  launch: vi.fn(),
  limits: vi.fn(),
  sessions: vi.fn(),
}));

vi.mock("@cloudflare/puppeteer", () => ({ default: puppeteerMock }));

import { BrowserRunCapacityError } from "../../src/connectors/browser";
import {
  classifyRakutenLoginText,
  createRakutenConnector,
  dataUriToBuffer,
  installRakutenResponseTap,
  normalizeRakutenCaptchaAnswer,
  prepareRakutenCaptcha,
  RakutenAutoCaptchaFailedError,
  RakutenBrowserCapacityError,
  RakutenCaptchaRecognizerError,
  RakutenCaptchaRejectedError,
  RakutenConnectionError,
  RakutenCredentialRejectedError,
  RakutenDeviceBindingRequiredError,
  RakutenSessionConflictError,
  RakutenVerificationRequiredError,
  runRakutenOcrAttempts,
  shiftRakutenMonthLabel,
} from "../../src/connectors/rakuten";

const LOGIN_URL = "https://www.rakuten-bank.com.tw/ebank/cgn/cgnot0001/010";
const HOME_URL = "https://www.rakuten-bank.com.tw/ebank/chm/chmqu0001/010";
const TWD_DEPOSIT_URL =
  "https://www.rakuten-bank.com.tw/ebank/ctw/ctwqu0001/010";

const credentials = {
  userId: "A123456789",
  account: "rakuten-user",
  password: "testpass12",
};

const depositPageText = `
臺幣存款
活存

活存總額 0081200000001234
$52,345
`;

/** 網頁自己解密後的首頁（CHMQU0001）回應內容。 */
const DEFAULT_DASHBOARD_RS_DATA = {
  depositInfo: {
    depAccounts: [
      {
        acctNo: "0081200000001234",
        showAcctNo: "008-***-1234",
        ntdCurrBal: 52345,
      },
    ],
  },
};

const DEPOSIT_ACCOUNT_NO = "0081200000001234";

/** 臺幣活存明細（CTWQU0001）回應：欄位形狀同正式環境，值為合成資料。 */
function depositTxnRsData(
  txDetails: Array<{
    sysDate: string;
    sysTime: string;
    credit: boolean;
    amt: string;
    balance: string;
    txDesc: string;
    pk: string;
  }>,
  display: Record<string, boolean> = {},
) {
  return {
    display: { dataEnd: true, dataLimit: false, noData: false, ...display },
    accounts: [{ acctNo: DEPOSIT_ACCOUNT_NO, balance: "52,345" }],
    queryAccountNo: DEPOSIT_ACCOUNT_NO,
    // 新的在前；amtSign true 代表收入（測試假設，解析器由餘額差確認）
    txDetails: txDetails.map((row) => ({
      sysDate: row.sysDate,
      sysTime: row.sysTime,
      amtSign: row.credit,
      amt: row.amt,
      memo: "",
      txDesc: row.txDesc,
      nickNameOrAcct: "",
      acctNo: "",
      bankId: "",
      balance: row.balance,
      pk: row.pk,
    })),
  };
}

function monthRows(month: string, opening: number, pkSeed: number) {
  const autoDebit = {
    sysDate: `${month}/17`,
    sysTime: "08:30",
    credit: false,
    amt: "6,543",
    balance: (opening - 6_543).toLocaleString("en-US"),
    txDesc: "自動扣款",
    pk: `${pkSeed}0000000000002`,
  };
  const transfer = {
    sysDate: `${month}/03`,
    sysTime: "10:00",
    credit: true,
    amt: "10,000",
    balance: opening.toLocaleString("en-US"),
    txDesc: "他行轉入",
    pk: `${pkSeed}0000000000001`,
  };
  return [autoDebit, transfer];
}

const DEFAULT_DEPOSIT_TXN_CURRENT = depositTxnRsData(
  monthRows("2026/09", 58_888, 9),
);
const DEFAULT_DEPOSIT_TXN_MONTHS: Record<string, unknown> = {
  "2026/08 活存明細": depositTxnRsData(monthRows("2026/08", 35_431, 8)),
  "2026/07 活存明細": depositTxnRsData(monthRows("2026/07", 21_974, 7)),
};

type PageState = {
  navClicks?: Array<{ exact?: string }>;
  sessionExpired?: boolean;
  currentUrl: string;
  captchaDataUri?: string;
  modalText?: string;
  modalTexts?: string[];
  depositText?: string;
  loginClicked: number;
  onLoginClick?: (attempt: number) => void;
  /** 解密後的首頁資料；null 表示網頁沒有送出／攔截不到。 */
  tapDashboard?: unknown;
  logoutClicked?: boolean;
  logoutConfirmed?: boolean;
  /** 臺幣存款頁當月明細（CTWQU0001/010）；null 表示網頁沒有送出。 */
  tapDepositCurrent?: unknown;
  /** 月份下拉選單的選項（「YYYY/MM 活存明細」→ CTWQU0001/011 回應）。 */
  tapDepositMonths?: Record<string, unknown>;
  /** 下拉按鈕目前顯示的月份文字。 */
  depositMonthLabel?: string;
  /** 已送出的活存明細回應（依送出順序）。 */
  depositResponses?: Array<{ path: string; rsData: unknown }>;
  monthClicks?: Array<{ action: string; label?: string }>;
  /** 頁面內執行的月份下拉函式（測試用假 DOM 直接執行它）。 */
  monthSelectFn?: (spec: unknown) => unknown;
  /** 月份下拉按鈕前 N 次 toggle 還沒渲染（模擬 Angular 延遲渲染）。 */
  monthToggleMisses?: number;
  /** 讀到首頁存款回應（首頁存款步驟完成）之後呼叫（測試用來推進時間）。 */
  onDashboardRead?: () => void;
  /** 點下「臺幣存款」之後呼叫（測試用來推進時間）。 */
  onDepositOpened?: () => void;
};

function makePage(overrides?: Partial<PageState>) {
  const state: PageState = {
    currentUrl: LOGIN_URL,
    captchaDataUri: "data:image/png;base64,AQID",
    loginClicked: 0,
    tapDashboard: DEFAULT_DASHBOARD_RS_DATA,
    tapDepositCurrent: DEFAULT_DEPOSIT_TXN_CURRENT,
    tapDepositMonths: DEFAULT_DEPOSIT_TXN_MONTHS,
    depositMonthLabel: "2026/09 活存明細",
    depositResponses: [],
    monthClicks: [],
    ...overrides,
  };

  const bodyTextForCurrentUrl = () => {
    if (state.currentUrl.includes("ctwqu0001")) return state.depositText ?? "";
    return "";
  };

  const evaluate = vi
    .fn()
    .mockImplementation(
      async (fn: (...args: never[]) => unknown, arg?: unknown) => {
        const source = String(fn);
        if (source.includes("__tfhRakutenTap")) {
          // 讀取頁面內攔截到的解密後回應（依網頁送出順序排列）
          if (state.sessionExpired && state.currentUrl !== LOGIN_URL) {
            state.currentUrl = LOGIN_URL;
          }
          if (state.currentUrl === LOGIN_URL) return { count: 0, rsData: null };
          const input = (arg ?? {}) as {
            suffix?: string;
            afterIndex?: number;
          };
          const entries: Array<{ path: string; rsData: unknown }> = [];
          if (state.tapDashboard != null) {
            entries.push({ path: "CHMQU0001", rsData: state.tapDashboard });
          }
          // 臺幣存款頁的活存明細回應：依點擊順序附在最後
          entries.push(...(state.depositResponses ?? []));
          const suffix = String(input.suffix ?? "");
          const afterIndex = input.afterIndex ?? 0;
          for (let i = entries.length - 1; i >= afterIndex; i -= 1) {
            if (!suffix.includes(entries[i]!.path)) continue;
            if (entries[i]!.path === "CHMQU0001") state.onDashboardRead?.();
            return { count: entries.length, rsData: entries[i]!.rsData };
          }
          return { count: entries.length, rsData: null };
        }
        if (source.includes("確認登出")) {
          if (!state.logoutClicked) return "no_modal";
          state.logoutConfirmed = true;
          state.currentUrl = LOGIN_URL;
          return "clicked";
        }
        if (source.includes("captcha-image")) {
          return state.captchaDataUri ?? "";
        }
        if (source.includes("modal-title")) {
          if (state.loginClicked === 0) {
            return /維護/.test(state.modalText ?? "")
              ? (state.modalText ?? "")
              : "";
          }
          if (state.modalTexts && state.modalTexts.length > 0) {
            return state.modalTexts.shift() ?? "";
          }
          return state.modalText ?? "";
        }
        if (source.includes("btn-primary")) {
          state.loginClicked += 1;
          state.onLoginClick?.(state.loginClicked);
          return undefined;
        }
        if (source.includes("rakuten-month-select")) {
          // 月份下拉選單：toggle 點開按鈕，choose 點選項（送出 CTWQU0001/011）
          state.monthSelectFn = fn as (spec: unknown) => unknown;
          const spec = (arg ?? {}) as { action: string; label?: string };
          state.monthClicks = [...(state.monthClicks ?? []), spec];
          const onDepositPage = state.currentUrl === TWD_DEPOSIT_URL;
          if (spec.action === "toggle") {
            if ((state.monthToggleMisses ?? 0) > 0) {
              state.monthToggleMisses = (state.monthToggleMisses ?? 0) - 1;
              return { label: "", clicked: false, labelShapedCount: 0 };
            }
            return {
              label: onDepositPage
                ? (/\d{4}\/\d{2}/.exec(state.depositMonthLabel ?? "")?.[0] ??
                  "")
                : "",
              clicked: onDepositPage,
              labelShapedCount: onDepositPage ? 4 : 0,
            };
          }
          const options = state.tapDepositMonths ?? {};
          const label = String(spec.label ?? "");
          if (!onDepositPage || !(label in options)) {
            return { label: "", clicked: false, labelShapedCount: 4 };
          }
          state.depositMonthLabel = label;
          if (options[label] != null) {
            state.depositResponses = [
              ...(state.depositResponses ?? []),
              { path: "CTWQU0001/011", rsData: options[label] },
            ];
          }
          return { label: "", clicked: true, labelShapedCount: 4 };
        }
        if (source.includes("rakuten-nav-click")) {
          // SPA 選單點擊：依使用者操作路徑切頁，不整頁重載。
          const spec = (arg ?? {}) as { exact?: string };
          state.navClicks = [...(state.navClicks ?? []), spec];
          // 已被導回登入頁時，選單連結都不存在
          if (state.currentUrl === LOGIN_URL) return false;
          if (spec.exact === "登出") {
            state.logoutClicked = true;
            return true;
          }
          if (spec.exact === "臺幣存款" || spec.exact === "存款") {
            state.currentUrl = TWD_DEPOSIT_URL;
            if (spec.exact === "臺幣存款") state.onDepositOpened?.();
            if (spec.exact === "臺幣存款" && state.tapDepositCurrent != null) {
              state.depositResponses = [
                ...(state.depositResponses ?? []),
                { path: "CTWQU0001/010", rsData: state.tapDepositCurrent },
              ];
            }
            return true;
          }
          return false;
        }
        if (source.includes("innerText")) {
          return bodyTextForCurrentUrl();
        }
        if (source.includes("focus")) {
          return undefined;
        }
        return undefined;
      },
    );

  return {
    state,
    evaluate,
    evaluateOnNewDocument: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockImplementation(async (url: string) => {
      state.currentUrl = url;
      state.loginClicked = 0;
      return { status: () => 200 };
    }),
    on: vi.fn(),
    off: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    setUserAgent: vi.fn().mockResolvedValue(undefined),
    setViewport: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockImplementation(() => state.currentUrl),
    waitForFunction: vi
      .fn()
      .mockImplementation(async (fn: (...args: never[]) => unknown) => {
        const source = String(fn);
        if (source.includes("custNo")) return undefined;
        if (source.includes("captcha-image")) {
          if (!state.captchaDataUri) {
            throw new Error(
              "waiting for function failed: timeout 10000ms exceeded",
            );
          }
          return undefined;
        }
        return undefined;
      }),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
  };
}

function browser(browserPage: ReturnType<typeof makePage>) {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    pages: vi.fn().mockResolvedValue([browserPage]),
    newPage: vi.fn().mockResolvedValue(browserPage),
    sessionId: vi.fn().mockReturnValue("rakuten-session"),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  puppeteerMock.sessions.mockResolvedValue([]);
  puppeteerMock.limits.mockResolvedValue({
    activeSessions: [],
    maxConcurrentSessions: 3,
    allowedBrowserAcquisitions: 1,
    timeUntilNextAllowedBrowserAcquisition: 0,
  });
});

describe("Rakuten CAPTCHA preparation", () => {
  it("launches a browser, fills the login form, captures the CAPTCHA data URI, and preserves the session", async () => {
    const browserPage = makePage();
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);

    const result = await prepareRakutenCaptcha({} as Fetcher, credentials);

    expect(puppeteerMock.launch).toHaveBeenCalledOnce();
    expect(browserPage.goto).toHaveBeenCalledWith(
      LOGIN_URL,
      expect.objectContaining({ waitUntil: "domcontentloaded" }),
    );
    expect(browserPage.type).toHaveBeenCalledWith(
      "#custNo",
      credentials.userId,
      expect.any(Object),
    );
    expect(browserPage.type).toHaveBeenCalledWith(
      "#userNo",
      credentials.account,
      expect.any(Object),
    );
    expect(browserPage.type).toHaveBeenCalledWith(
      "#pcode",
      credentials.password,
      expect.any(Object),
    );
    expect(browserInstance.sessionId).toHaveBeenCalledOnce();
    expect(browserInstance.disconnect).toHaveBeenCalledOnce();
    expect(browserInstance.close).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      browserSessionId: "rakuten-session",
      captchaLength: 4,
      captchaImage: "data:image/png;base64,AQID",
    });
  });

  it("accepts alerts but dismisses confirms, logging only the dialog shape", async () => {
    const browserPage = makePage();
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await prepareRakutenCaptcha({} as Fetcher, credentials);

      const dialogHandler = browserPage.on.mock.calls.find(
        ([event]) => event === "dialog",
      )?.[1] as ((dialog: unknown) => void) | undefined;
      expect(dialogHandler).toBeTypeOf("function");
      const dialog = (type: string, message: string) => ({
        type: () => type,
        message: () => message,
        accept: vi.fn().mockResolvedValue(undefined),
        dismiss: vi.fn().mockResolvedValue(undefined),
      });

      const alert = dialog("alert", "測試客戶 您好，系統將於今晚維護");
      dialogHandler?.(alert);
      expect(alert.accept).toHaveBeenCalledOnce();
      expect(alert.dismiss).not.toHaveBeenCalled();

      const confirm = dialog("confirm", "您已在其他裝置登入，是否繼續登入？");
      dialogHandler?.(confirm);
      expect(confirm.dismiss).toHaveBeenCalledOnce();
      expect(confirm.accept).not.toHaveBeenCalled();

      const logged = [...log.mock.calls, ...warn.mock.calls].map(([value]) =>
        String(value),
      );
      expect(logged.join("\n")).not.toContain("測試客戶");
      expect(logged.join("\n")).not.toContain("其他裝置");
      expect(
        log.mock.calls.map(([value]) => JSON.parse(String(value))),
      ).toContainEqual({
        event: "rakuten_dialog_handled",
        type: "alert",
        action: "accepted",
        category: "maintenance",
        messageLength: 16,
      });
      expect(
        warn.mock.calls.map(([value]) => JSON.parse(String(value))),
      ).toContainEqual({
        event: "rakuten_dialog_handled",
        type: "confirm",
        action: "dismissed",
        category: "session_conflict",
        messageLength: 17,
      });
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it("reuses a pending CAPTCHA browser instead of launching another one", async () => {
    const browserPage = makePage();
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "rakuten-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    const result = await prepareRakutenCaptcha({} as Fetcher, {
      ...credentials,
      browserSessionId: "rakuten-session",
    });

    expect(puppeteerMock.connect).toHaveBeenCalledWith({}, "rakuten-session");
    expect(puppeteerMock.launch).not.toHaveBeenCalled();
    expect(result.browserSessionId).toBe("rakuten-session");
  });

  it("does not launch when the pending CAPTCHA browser is still connected", async () => {
    puppeteerMock.sessions.mockResolvedValue([
      {
        sessionId: "rakuten-session",
        startTime: Date.now(),
        connectionId: "busy-connection",
      },
    ]);

    await expect(
      prepareRakutenCaptcha({} as Fetcher, {
        ...credentials,
        browserSessionId: "rakuten-session",
      }),
    ).rejects.toBeInstanceOf(RakutenBrowserCapacityError);
    expect(puppeteerMock.launch).not.toHaveBeenCalled();
  });
});

describe("Rakuten sync without OCR callback or when manual session is invalid", () => {
  it("rejects without touching the browser when no captcha or session id is present", async () => {
    await expect(
      createRakutenConnector({} as Fetcher).sync({ ...credentials }),
    ).rejects.toBeInstanceOf(RakutenVerificationRequiredError);
    expect(puppeteerMock.launch).not.toHaveBeenCalled();
    expect(puppeteerMock.connect).not.toHaveBeenCalled();
    expect(puppeteerMock.sessions).not.toHaveBeenCalled();
  });

  it("rejects without touching the browser when a session id exists but no captcha was typed", async () => {
    await expect(
      createRakutenConnector({} as Fetcher).sync({
        ...credentials,
        browserSessionId: "rakuten-session",
      }),
    ).rejects.toBeInstanceOf(RakutenVerificationRequiredError);
    expect(puppeteerMock.launch).not.toHaveBeenCalled();
    expect(puppeteerMock.connect).not.toHaveBeenCalled();
  });

  it("rejects an expired CAPTCHA session without reconnecting to the browser", async () => {
    await expect(
      createRakutenConnector({} as Fetcher).sync({
        ...credentials,
        browserSessionId: "rakuten-session",
        browserSessionExpiresAt: new Date(Date.now() - 1_000).toISOString(),
        captcha: "36CY",
      }),
    ).rejects.toBeInstanceOf(RakutenVerificationRequiredError);
    expect(puppeteerMock.connect).not.toHaveBeenCalled();
  });

  it("accepts a recognizeCaptcha-style callback as the second argument", () => {
    expect(createRakutenConnector.length).toBe(2);
  });
});

describe("Rakuten automated OCR login", () => {
  it("automatically launches browser, recognizes CAPTCHA, logs in and parses data on first attempt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage({
      depositText: depositPageText,
      onLoginClick: () => {
        browserPage.state.currentUrl = HOME_URL;
      },
    });
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi.fn().mockResolvedValue("36CY");

    const result = await createRakutenConnector({} as Fetcher, recognize).sync(
      credentials,
    );

    expect(puppeteerMock.launch).toHaveBeenCalledOnce();
    expect(puppeteerMock.connect).not.toHaveBeenCalled();
    expect(recognize).toHaveBeenCalledOnce();
    expect(browserPage.type).toHaveBeenCalledWith(
      "#captcha",
      "36CY",
      expect.any(Object),
    );
    expect(result.bankAccounts?.length).toBeGreaterThan(0);
    expect(browserInstance.close).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("retries up to 3 times on CAPTCHA error, succeeding on second attempt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let clickCount = 0;
    const browserPage = makePage({
      modalText: "驗證碼錯誤",
      depositText: depositPageText,
      onLoginClick: () => {
        clickCount += 1;
        if (clickCount >= 2) {
          browserPage.state.currentUrl = HOME_URL;
        }
      },
    });
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi
      .fn()
      .mockResolvedValueOnce("WRNG")
      .mockResolvedValueOnce("36CY");

    const result = await createRakutenConnector({} as Fetcher, recognize).sync(
      credentials,
    );

    expect(recognize).toHaveBeenCalledTimes(2);
    expect(browserPage.goto).toHaveBeenCalledTimes(2);
    expect(result.bankAccounts?.length).toBeGreaterThan(0);
    expect(browserInstance.close).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("fails after 3 consecutive CAPTCHA rejections and closes browser", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage({
      modalText: "驗證碼錯誤",
    });
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi.fn().mockResolvedValue("WRNG");

    await expect(
      createRakutenConnector({} as Fetcher, recognize).sync(credentials),
    ).rejects.toThrow("連續失敗 3 次");

    expect(recognize).toHaveBeenCalledTimes(3);
    expect(browserInstance.close).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("stops immediately on credential rejection without retrying", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage({
      modalText: "使用者代號或密碼錯誤",
    });
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi.fn().mockResolvedValue("36CY");

    await expect(
      createRakutenConnector({} as Fetcher, recognize).sync(credentials),
    ).rejects.toBeInstanceOf(RakutenCredentialRejectedError);

    expect(recognize).toHaveBeenCalledOnce();
    expect(browserInstance.close).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("stops immediately on session conflict without retrying", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage({
      modalText: "重複登入",
    });
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi.fn().mockResolvedValue("36CY");

    await expect(
      createRakutenConnector({} as Fetcher, recognize).sync(credentials),
    ).rejects.toBeInstanceOf(RakutenSessionConflictError);

    expect(recognize).toHaveBeenCalledOnce();
    expect(browserInstance.close).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("prioritizes manual verification and skips OCR when browserSessionId and captcha are provided", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage({
      depositText: depositPageText,
      onLoginClick: () => {
        browserPage.state.currentUrl = HOME_URL;
      },
    });
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "rakuten-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);
    const recognize = vi.fn().mockResolvedValue("9999");

    const result = await createRakutenConnector({} as Fetcher, recognize).sync({
      ...credentials,
      browserSessionId: "rakuten-session",
      browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      captcha: "36CY",
    });

    expect(puppeteerMock.connect).toHaveBeenCalledOnce();
    expect(puppeteerMock.launch).not.toHaveBeenCalled();
    expect(recognize).not.toHaveBeenCalled();
    expect(result.bankAccounts?.length).toBeGreaterThan(0);
    expect(browserInstance.close).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("Rakuten Browser Run capacity", () => {
  it("reports the shared acquisition rate limit without launching a browser", async () => {
    puppeteerMock.limits.mockResolvedValue({
      activeSessions: [],
      maxConcurrentSessions: 3,
      allowedBrowserAcquisitions: 0,
      timeUntilNextAllowedBrowserAcquisition: 8_000,
    });

    await expect(
      createRakutenConnector(
        {} as Fetcher,
        vi.fn().mockResolvedValue("36CY"),
      ).sync(credentials),
    ).rejects.toMatchObject({
      name: "BrowserRunCapacityError",
      kind: "acquisition_rate_limit",
      retryAfterSeconds: 8,
    });
    expect(puppeteerMock.launch).not.toHaveBeenCalled();
  });

  it("classifies a daily quota failure from the browser launch", async () => {
    puppeteerMock.launch.mockRejectedValue(
      new Error("Browser time limit exceeded for today"),
    );

    const error = await createRakutenConnector(
      {} as Fetcher,
      vi.fn().mockResolvedValue("36CY"),
    )
      .sync(credentials)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BrowserRunCapacityError);
    expect(error).toMatchObject({ kind: "daily_quota" });
  });
});

describe("Rakuten browser session lifecycle", () => {
  it("submits the prepared CAPTCHA, logs in, and parses the deposit data", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage({
      depositText: depositPageText,
      onLoginClick: () => undefined,
    });
    browserPage.state.onLoginClick = () => {
      browserPage.state.currentUrl = HOME_URL;
    };
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "rakuten-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    const result = await createRakutenConnector({} as Fetcher).sync({
      ...credentials,
      browserSessionId: "rakuten-session",
      browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      captcha: "36CY",
    });

    expect(puppeteerMock.connect).toHaveBeenCalledWith({}, "rakuten-session");
    expect(puppeteerMock.launch).not.toHaveBeenCalled();
    expect(browserPage.type).toHaveBeenCalledWith(
      "#captcha",
      "36CY",
      expect.any(Object),
    );
    expect(result.bankAccounts?.length).toBeGreaterThan(0);
    expect(result.bankBalanceSnapshots?.length).toBeGreaterThan(0);
    expect(result.cursor).toBeUndefined();
    expect(browserInstance.close).toHaveBeenCalledOnce();
    expect(browserInstance.disconnect).not.toHaveBeenCalled();
  });

  it("reports a lost session when the bank sends the page back to login", async () => {
    const browserPage = makePage({
      sessionExpired: true,
    });
    browserPage.state.onLoginClick = () => {
      browserPage.state.currentUrl = HOME_URL;
    };
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "rakuten-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    await expect(
      createRakutenConnector({} as Fetcher).sync({
        ...credentials,
        browserSessionId: "rakuten-session",
        browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        captcha: "36CY",
      }),
    ).rejects.toThrow("樂天網銀 session 已失效，請重新登入。");
    expect(browserInstance.close).toHaveBeenCalledOnce();
  });

  it("classifies a multi-device login modal as a session conflict and never clicks a takeover button", async () => {
    const browserPage = makePage({
      modalText:
        "帳號重複登入\n您已在其他裝置登入，繼續登入將會登出前一個裝置，是否以此裝置登入？",
    });
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "rakuten-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    await expect(
      createRakutenConnector({} as Fetcher).sync({
        ...credentials,
        browserSessionId: "rakuten-session",
        browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        captcha: "36CY",
      }),
    ).rejects.toBeInstanceOf(RakutenSessionConflictError);

    const loginClicks = browserPage.evaluate.mock.calls.filter(([fn]) =>
      String(fn).includes("btn-primary"),
    );
    expect(loginClicks).toHaveLength(1);
  });

  it("classifies a captcha error modal as a captcha rejection", async () => {
    const browserPage = makePage({ modalText: "驗證碼錯誤，請重新輸入" });
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "rakuten-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    await expect(
      createRakutenConnector({} as Fetcher).sync({
        ...credentials,
        browserSessionId: "rakuten-session",
        browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        captcha: "36CY",
      }),
    ).rejects.toBeInstanceOf(RakutenCaptchaRejectedError);
  });

  it("classifies a credential error modal as a credential rejection", async () => {
    const browserPage = makePage({ modalText: "使用者代號或密碼錯誤" });
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "rakuten-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    await expect(
      createRakutenConnector({} as Fetcher).sync({
        ...credentials,
        browserSessionId: "rakuten-session",
        browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        captcha: "36CY",
      }),
    ).rejects.toBeInstanceOf(RakutenCredentialRejectedError);
  });

  it("classifies a maintenance modal as a temporary connection error", async () => {
    const browserPage = makePage({ modalText: "系統維護中，暫時停止服務。" });
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "rakuten-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    await expect(
      createRakutenConnector({} as Fetcher).sync({
        ...credentials,
        browserSessionId: "rakuten-session",
        browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        captcha: "36CY",
      }),
    ).rejects.toBeInstanceOf(RakutenConnectionError);
  });

  it("classifies a device-binding prompt as needing manual handling", async () => {
    const browserPage = makePage({
      modalText: "本次登入需要進行裝置綁定（晶片金融卡）",
    });
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "rakuten-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    await expect(
      createRakutenConnector({} as Fetcher).sync({
        ...credentials,
        browserSessionId: "rakuten-session",
        browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        captcha: "36CY",
      }),
    ).rejects.toBeInstanceOf(RakutenDeviceBindingRequiredError);
  });

  it("classifies an SMS verification prompt as device verification, not a captcha error", async () => {
    const browserPage = makePage({
      modalText: "驗證手機號碼\n請輸入簡訊驗證碼以完成本裝置驗證",
    });
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "rakuten-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    await expect(
      createRakutenConnector({} as Fetcher).sync({
        ...credentials,
        browserSessionId: "rakuten-session",
        browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        captcha: "36CY",
      }),
    ).rejects.toBeInstanceOf(RakutenDeviceBindingRequiredError);
  });

  it("treats an unresolved login result as a connection error and masks long digit runs in the log", async () => {
    vi.useFakeTimers();
    const browserPage = makePage();
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "rakuten-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const pending = createRakutenConnector({} as Fetcher).sync({
      ...credentials,
      browserSessionId: "rakuten-session",
      browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      captcha: "36CY",
    });
    // Attach a handler immediately so advancing fake timers below cannot
    // surface this as an unhandled rejection before the assertion runs.
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(pending).rejects.toBeInstanceOf(RakutenConnectionError);

    const events = warn.mock.calls.flatMap(([value]) => {
      try {
        const parsed: unknown = JSON.parse(String(value));
        return parsed && typeof parsed === "object" ? [parsed] : [];
      } catch {
        return [];
      }
    }) as Array<Record<string, unknown>>;
    const unresolved = events.find(
      (event) => event.event === "rakuten_login_outcome_unknown",
    );
    expect(unresolved).toBeDefined();
    warn.mockRestore();
    vi.useRealTimers();
  });

  it("closes the browser (never disconnects) after a rejected sync", async () => {
    const browserPage = makePage({ modalText: "使用者代號或密碼錯誤" });
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "rakuten-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    await expect(
      createRakutenConnector({} as Fetcher).sync({
        ...credentials,
        browserSessionId: "rakuten-session",
        browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        captcha: "36CY",
      }),
    ).rejects.toBeInstanceOf(RakutenCredentialRejectedError);

    expect(browserInstance.close).toHaveBeenCalledOnce();
    expect(browserInstance.disconnect).not.toHaveBeenCalled();
  });
});

describe("Rakuten OCR login hardening", () => {
  it("normalizes whitespace and punctuation in the OCR answer before typing it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage({
      depositText: depositPageText,
      onLoginClick: () => {
        browserPage.state.currentUrl = HOME_URL;
      },
    });
    puppeteerMock.launch.mockResolvedValue(browser(browserPage));
    const recognize = vi.fn().mockResolvedValue(' "36 CY".\n');

    await createRakutenConnector({} as Fetcher, recognize).sync(credentials);

    expect(browserPage.type).toHaveBeenCalledWith(
      "#captcha",
      "36CY",
      expect.any(Object),
    );
    warn.mockRestore();
  });

  it("retries with a fresh CAPTCHA when the OCR answer has the wrong length", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage({
      depositText: depositPageText,
      onLoginClick: () => {
        browserPage.state.currentUrl = HOME_URL;
      },
    });
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi
      .fn()
      .mockResolvedValueOnce("36C")
      .mockResolvedValueOnce("36CY");

    const result = await createRakutenConnector({} as Fetcher, recognize).sync(
      credentials,
    );

    expect(recognize).toHaveBeenCalledTimes(2);
    expect(browserPage.goto).toHaveBeenCalledTimes(2);
    // 格式不符的答案不應送出登入
    expect(browserPage.state.loginClicked).toBe(1);
    expect(result.bankAccounts?.length).toBeGreaterThan(0);
    expect(browserInstance.close).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("reports exhausted OCR attempts with a dedicated error carrying the last cause", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage({ modalText: "驗證碼錯誤" });
    puppeteerMock.launch.mockResolvedValue(browser(browserPage));
    const recognize = vi.fn().mockResolvedValue("WRNG");

    const error = await createRakutenConnector({} as Fetcher, recognize)
      .sync(credentials)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RakutenAutoCaptchaFailedError);
    expect(error).toBeInstanceOf(RakutenVerificationRequiredError);
    expect((error as RakutenAutoCaptchaFailedError).reason).toBe("exhausted");
    expect((error as Error).cause).toBeInstanceOf(RakutenCaptchaRejectedError);
    warn.mockRestore();
  });

  it("does not retry when the recognizer service fails, and asks for manual verification", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage();
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi.fn().mockRejectedValue(new Error("AI quota exceeded"));

    const error = await createRakutenConnector({} as Fetcher, recognize)
      .sync(credentials)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RakutenAutoCaptchaFailedError);
    expect((error as RakutenAutoCaptchaFailedError).reason).toBe(
      "recognizer_unavailable",
    );
    expect(recognize).toHaveBeenCalledOnce();
    expect(browserPage.state.loginClicked).toBe(0);
    expect(browserInstance.close).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("times out a hanging recognizer instead of stalling the sync", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage();
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi.fn().mockImplementation(() => new Promise(() => {}));

    const pending = createRakutenConnector({} as Fetcher, recognize).sync(
      credentials,
    );
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(15_000);

    const error = await pending.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RakutenAutoCaptchaFailedError);
    expect((error as RakutenAutoCaptchaFailedError).reason).toBe(
      "recognizer_unavailable",
    );
    expect(browserInstance.close).toHaveBeenCalledOnce();
    warn.mockRestore();
    vi.useRealTimers();
  });

  it("does not retry an unresolved login outcome in OCR mode (avoids lockout)", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage();
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi.fn().mockResolvedValue("36CY");

    const pending = createRakutenConnector({} as Fetcher, recognize).sync(
      credentials,
    );
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(20_000);

    const error = await pending.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RakutenConnectionError);
    expect(error).not.toBeInstanceOf(RakutenAutoCaptchaFailedError);
    expect(recognize).toHaveBeenCalledOnce();
    expect(browserPage.state.loginClicked).toBe(1);
    warn.mockRestore();
    vi.useRealTimers();
  });

  it("does not classify login-page field labels as a credential error while waiting", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // 整頁文字含「身分證字號」「密碼」「驗證碼」等欄位標籤，但沒有錯誤 modal
    const browserPage = makePage({
      depositText: "身分證字號\n使用者代號\n密碼\n圖形驗證碼\n約定條款",
    });
    browserPage.state.currentUrl = TWD_DEPOSIT_URL;
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "rakuten-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    const pending = createRakutenConnector({} as Fetcher).sync({
      ...credentials,
      browserSessionId: "rakuten-session",
      browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      captcha: "36CY",
    });
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(20_000);

    const error = await pending.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RakutenConnectionError);
    expect(error).not.toBeInstanceOf(RakutenCredentialRejectedError);
    expect(error).not.toBeInstanceOf(RakutenCaptchaRejectedError);
    expect(error).not.toBeInstanceOf(RakutenDeviceBindingRequiredError);
    warn.mockRestore();
    vi.useRealTimers();
  });

  it("recognizes the refreshed CAPTCHA when the image changes after credentials are filled", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage({
      depositText: depositPageText,
      onLoginClick: () => {
        browserPage.state.currentUrl = HOME_URL;
      },
    });
    browserPage.type.mockImplementation(async (selector: string) => {
      if (selector === "#pcode") {
        browserPage.state.captchaDataUri = "data:image/png;base64,BAUG";
      }
    });
    puppeteerMock.launch.mockResolvedValue(browser(browserPage));
    const recognize = vi
      .fn()
      .mockResolvedValueOnce("OLD1")
      .mockResolvedValueOnce("NEW2");

    await createRakutenConnector({} as Fetcher, recognize).sync(credentials);

    expect(recognize).toHaveBeenCalledTimes(2);
    expect(browserPage.type).toHaveBeenCalledWith(
      "#captcha",
      "NEW2",
      expect.any(Object),
    );
    expect(browserPage.type).not.toHaveBeenCalledWith(
      "#captcha",
      "OLD1",
      expect.any(Object),
    );
    warn.mockRestore();
  });

  it("returns the refreshed CAPTCHA image from prepare when it changes after filling credentials", async () => {
    const browserPage = makePage();
    browserPage.type.mockImplementation(async (selector: string) => {
      if (selector === "#pcode") {
        browserPage.state.captchaDataUri = "data:image/png;base64,BAUG";
      }
    });
    puppeteerMock.launch.mockResolvedValue(browser(browserPage));

    const result = await prepareRakutenCaptcha({} as Fetcher, credentials);

    expect(result.captchaImage).toBe("data:image/png;base64,BAUG");
  });

  it("falls back to OCR when the manual CAPTCHA expired and releases the stale browser", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const staleBrowser = browser(makePage());
    const browserPage = makePage({
      depositText: depositPageText,
      onLoginClick: () => {
        browserPage.state.currentUrl = HOME_URL;
      },
    });
    const freshBrowser = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "rakuten-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(staleBrowser);
    puppeteerMock.launch.mockResolvedValue(freshBrowser);
    const recognize = vi.fn().mockResolvedValue("36CY");

    const result = await createRakutenConnector({} as Fetcher, recognize).sync({
      ...credentials,
      browserSessionId: "rakuten-session",
      browserSessionExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      captcha: "ABCD",
    });

    expect(staleBrowser.close).toHaveBeenCalledOnce();
    expect(puppeteerMock.launch).toHaveBeenCalledOnce();
    expect(recognize).toHaveBeenCalledOnce();
    expect(browserPage.type).not.toHaveBeenCalledWith(
      "#captcha",
      "ABCD",
      expect.any(Object),
    );
    expect(result.bankAccounts?.length).toBeGreaterThan(0);
    warn.mockRestore();
  });

  it("does not log page text when the parsed result is empty", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const browserPage = makePage({
      depositText: "帳號 0081200000009999 王小明 無法解析",
      // 解密後的首頁資料沒有可用的存款，迫使流程走到文字備援
      tapDashboard: {},
      onLoginClick: () => {
        browserPage.state.currentUrl = HOME_URL;
      },
    });
    puppeteerMock.launch.mockResolvedValue(browser(browserPage));
    const recognize = vi.fn().mockResolvedValue("36CY");

    await expect(
      createRakutenConnector({} as Fetcher, recognize).sync(credentials),
    ).rejects.toBeInstanceOf(RakutenConnectionError);

    const logged = [...warn.mock.calls, ...log.mock.calls]
      .map(([value]) => String(value))
      .join("\n");
    expect(logged).toContain("rakuten_sync_empty_result");
    expect(logged).not.toContain("0081200000009999");
    expect(logged).not.toContain("王小明");
    warn.mockRestore();
    log.mockRestore();
  }, 15_000);
});

describe("Rakuten log levels and sync summary", () => {
  function parsedEvents(spy: { mock: { calls: unknown[][] } }) {
    return spy.mock.calls.flatMap(([value]) => {
      try {
        const parsed: unknown = JSON.parse(String(value));
        return parsed && typeof parsed === "object"
          ? [parsed as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
  }

  it("logs one info-level summary for a successful sync and no warnings", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const browserPage = makePage({
      onLoginClick: () => {
        browserPage.state.currentUrl = HOME_URL;
      },
    });
    puppeteerMock.launch.mockResolvedValue(browser(browserPage));

    await createRakutenConnector(
      {} as Fetcher,
      vi.fn().mockResolvedValue("36CY"),
    ).sync(credentials);

    expect(warn).not.toHaveBeenCalled();
    const summaries = parsedEvents(log).filter(
      (event) => event.event === "rakuten_sync_summary",
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual({
      event: "rakuten_sync_summary",
      outcome: "success",
      loginMode: "ocr",
      ocrAttempts: 1,
      depositSource: "tap",
      depositAccountCount: 1,
      depositTxnMonthsFetched: 3,
      depositTxnCount: 6,
      durationMs: expect.any(Number),
      loginMs: expect.any(Number),
      dashboardMs: expect.any(Number),
      depositTxnMs: expect.any(Number),
      logoutMs: expect.any(Number),
    });
    for (const key of ["loginMs", "dashboardMs", "depositTxnMs", "logoutMs"]) {
      const value = summaries[0][key];
      expect(Number.isInteger(value)).toBe(true);
      expect(value as number).toBeGreaterThanOrEqual(0);
    }
    warn.mockRestore();
    log.mockRestore();
  });

  it("summarizes a failed sync with the error name, stage and OCR attempts", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let clicks = 0;
    const browserPage = makePage({
      modalTexts: ["驗證碼錯誤", "使用者代號或密碼錯誤"],
      onLoginClick: () => {
        clicks += 1;
      },
    });
    puppeteerMock.launch.mockResolvedValue(browser(browserPage));

    await expect(
      createRakutenConnector(
        {} as Fetcher,
        vi.fn().mockResolvedValue("36CY"),
      ).sync(credentials),
    ).rejects.toBeInstanceOf(RakutenCredentialRejectedError);

    expect(clicks).toBe(2);
    const summary = parsedEvents(log).find(
      (event) => event.event === "rakuten_sync_summary",
    );
    expect(summary).toMatchObject({
      outcome: "RakutenCredentialRejectedError",
      stage: "login",
      loginMode: "ocr",
      ocrAttempts: 2,
      depositSource: "none",
      // 沒走到的階段維持 0；沒登入成功就不登出
      dashboardMs: 0,
      depositTxnMs: 0,
      logoutMs: 0,
    });
    expect(summary?.loginMs).toEqual(expect.any(Number));
    // 只有 OCR 驗證碼錯誤那一次是 warn
    expect(parsedEvents(warn).map((event) => event.event)).toEqual([
      "rakuten_ocr_attempt_failed",
    ]);
    warn.mockRestore();
    log.mockRestore();
  });
});

describe("Rakuten deposit parsing failure", () => {
  it("fails without logging page content when no deposit can be parsed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const browserPage = makePage({
      depositText: "臺幣存款\n載入中",
      tapDashboard: {},
      onLoginClick: () => {
        browserPage.state.currentUrl = HOME_URL;
      },
    });
    puppeteerMock.launch.mockResolvedValue(browser(browserPage));

    await expect(
      createRakutenConnector(
        {} as Fetcher,
        vi.fn().mockResolvedValue("36CY"),
      ).sync(credentials),
    ).rejects.toThrow("解析不到臺幣存款資料");

    const logged = warn.mock.calls.map(([value]) => String(value)).join("\n");
    expect(logged).toContain('"accountCount":0');
    expect(logged).not.toContain("載入中");
    warn.mockRestore();
    log.mockRestore();
  }, 15_000);
});

describe("Rakuten native dialogs and lost-session detection", () => {
  it("dismisses a take-over confirm during login and stops with a session conflict", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const confirm = {
      type: () => "confirm",
      message: () => "帳號重複登入，是否登出其他裝置並繼續？",
      accept: vi.fn().mockResolvedValue(undefined),
      dismiss: vi.fn().mockResolvedValue(undefined),
    };
    const browserPage = makePage({
      onLoginClick: () => {
        const handler = browserPage.on.mock.calls.find(
          ([event]) => event === "dialog",
        )?.[1] as ((dialog: unknown) => void) | undefined;
        handler?.(confirm);
      },
    });
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi.fn().mockResolvedValue("36CY");

    await expect(
      createRakutenConnector({} as Fetcher, recognize).sync(credentials),
    ).rejects.toBeInstanceOf(RakutenSessionConflictError);

    expect(confirm.dismiss).toHaveBeenCalledOnce();
    expect(confirm.accept).not.toHaveBeenCalled();
    expect(recognize).toHaveBeenCalledOnce();
    expect(browserInstance.close).toHaveBeenCalledOnce();
    log.mockRestore();
    warn.mockRestore();
  });
});

describe("Rakuten decrypted response tap and logout", () => {
  it("installs the response tap before loading the bank page", async () => {
    const browserPage = makePage();
    puppeteerMock.launch.mockResolvedValue(browser(browserPage));

    await prepareRakutenCaptcha({} as Fetcher, credentials);

    expect(browserPage.evaluateOnNewDocument).toHaveBeenCalledOnce();
    expect(
      browserPage.evaluateOnNewDocument.mock.invocationCallOrder[0],
    ).toBeLessThan(browserPage.goto.mock.invocationCallOrder[0]!);
  });

  it("logs out through the logout confirmation after a successful sync", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage({
      onLoginClick: () => {
        browserPage.state.currentUrl = HOME_URL;
      },
    });
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);

    await createRakutenConnector(
      {} as Fetcher,
      vi.fn().mockResolvedValue("36CY"),
    ).sync(credentials);

    expect(browserPage.state.navClicks).toContainEqual({ exact: "登出" });
    expect(browserPage.state.logoutConfirmed).toBe(true);
    expect(browserInstance.close).toHaveBeenCalledOnce();
    expect(log.mock.calls.map(([value]) => String(value)).join("\n")).toContain(
      '"event":"rakuten_logout","result":"logged_out"',
    );
    log.mockRestore();
    warn.mockRestore();
  });

  it("still logs out when parsing fails after a successful login", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage({
      tapDashboard: {},
      onLoginClick: () => {
        browserPage.state.currentUrl = HOME_URL;
      },
    });
    puppeteerMock.launch.mockResolvedValue(browser(browserPage));

    await expect(
      createRakutenConnector(
        {} as Fetcher,
        vi.fn().mockResolvedValue("36CY"),
      ).sync(credentials),
    ).rejects.toBeInstanceOf(RakutenConnectionError);

    expect(browserPage.state.logoutConfirmed).toBe(true);
    log.mockRestore();
    warn.mockRestore();
  }, 15_000);

  it("does not try to log out when login itself failed", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage({ modalText: "使用者代號或密碼錯誤" });
    puppeteerMock.launch.mockResolvedValue(browser(browserPage));

    await expect(
      createRakutenConnector(
        {} as Fetcher,
        vi.fn().mockResolvedValue("36CY"),
      ).sync(credentials),
    ).rejects.toBeInstanceOf(RakutenCredentialRejectedError);

    expect(browserPage.state.navClicks ?? []).not.toContainEqual({
      exact: "登出",
    });
    log.mockRestore();
    warn.mockRestore();
  });

  it("keeps the sync result and warns when the logout confirmation never appears", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage({
      onLoginClick: () => {
        browserPage.state.currentUrl = HOME_URL;
      },
    });
    const originalEvaluate = browserPage.evaluate.getMockImplementation();
    browserPage.evaluate.mockImplementation(
      async (fn: (...args: never[]) => unknown, arg?: unknown) =>
        String(fn).includes("確認登出")
          ? "no_modal"
          : originalEvaluate?.(fn, arg),
    );
    puppeteerMock.launch.mockResolvedValue(browser(browserPage));

    const result = await createRakutenConnector(
      {} as Fetcher,
      vi.fn().mockResolvedValue("36CY"),
    ).sync(credentials);

    expect(result.bankAccounts?.length).toBeGreaterThan(0);
    expect(
      warn.mock.calls.map(([value]) => String(value)).join("\n"),
    ).toContain('"event":"rakuten_logout","result":"no_confirm_modal"');
    log.mockRestore();
    warn.mockRestore();
  }, 15_000);
});

describe("installRakutenResponseTap (runs inside the bank page)", () => {
  type Tap = {
    lastPath: string;
    responses: Array<{ path: string; statusCode: string; rsData: unknown }>;
  };

  it("records decrypted responses with the path of the XHR that produced them", () => {
    const originalParse = JSON.parse;
    const globals = globalThis as unknown as Record<string, unknown>;
    const previousWindow = globals.window;
    const previousXhr = globals.XMLHttpRequest;
    class FakeXhr {
      listeners: Array<() => void> = [];
      open(_method: string, _url: string) {}
      addEventListener(_event: string, listener: () => void) {
        this.listeners.push(listener);
      }
      finish() {
        for (const listener of this.listeners) listener();
      }
    }
    globals.XMLHttpRequest = FakeXhr;
    globals.window = {
      location: {
        href: "https://www.rakuten-bank.com.tw/ebank/chm/chmqu0001/010",
      },
    };
    try {
      installRakutenResponseTap();
      installRakutenResponseTap(); // 重複安裝不會包兩層
      const tap = (globals.window as { __tfhRakutenTap: Tap }).__tfhRakutenTap;

      const dashboard = new FakeXhr();
      dashboard.open(
        "POST",
        "/ixtein/adapters/ebank/txns/channel-chm/CHMQU0001/010?t=1",
      );
      dashboard.finish();
      // 網路層的外層（rsData 為密文字串）不記錄
      JSON.parse('{"rsData":"U2FsdGVkX19encrypted"}');
      // 網頁自己解密後的內容才記錄
      const decrypted = JSON.parse(
        '{"statusCode":"0000","rsData":{"depositInfo":{"depAccounts":[]}}}',
      );
      expect(decrypted.rsData.depositInfo).toEqual({ depAccounts: [] });

      const other = new FakeXhr();
      other.open(
        "POST",
        "/ixtein/adapters/ebank/txns/channel-chm/CHMQU0002/010",
      );
      other.finish();
      JSON.parse('{"statusCode":"E001","rsData":{"items":[]}}');
      // reviver 等一般用法不受影響
      expect(JSON.parse('{"a":1}', (_key, value) => value)).toEqual({ a: 1 });

      expect(tap.responses).toEqual([
        {
          path: "/ixtein/adapters/ebank/txns/channel-chm/CHMQU0001/010",
          statusCode: "0000",
          rsData: { depositInfo: { depAccounts: [] } },
        },
        {
          path: "/ixtein/adapters/ebank/txns/channel-chm/CHMQU0002/010",
          statusCode: "E001",
          rsData: { items: [] },
        },
      ]);
    } finally {
      JSON.parse = originalParse;
      globals.window = previousWindow;
      globals.XMLHttpRequest = previousXhr;
    }
  });
});

describe("Rakuten OCR helpers", () => {
  it("classifies login modal texts", () => {
    expect(classifyRakutenLoginText("")).toBe("unknown");
    expect(classifyRakutenLoginText("圖形驗證碼錯誤，請重新輸入")).toBe(
      "captcha",
    );
    expect(classifyRakutenLoginText("身分證字號、使用者代號或密碼錯誤")).toBe(
      "credential",
    );
    expect(classifyRakutenLoginText("您的帳號已在其他裝置登入")).toBe(
      "session_conflict",
    );
    expect(classifyRakutenLoginText("系統維護中")).toBe("maintenance");
    expect(classifyRakutenLoginText("請輸入簡訊 OTP 驗證碼完成裝置綁定")).toBe(
      "device_binding",
    );
  });

  it("normalizes OCR answers and rejects wrong lengths as CAPTCHA errors", () => {
    expect(normalizeRakutenCaptchaAnswer(" aB 3x\n")).toBe("aB3x");
    expect(normalizeRakutenCaptchaAnswer('"7K2p".')).toBe("7K2p");
    expect(() => normalizeRakutenCaptchaAnswer("abc")).toThrow(
      RakutenCaptchaRejectedError,
    );
    expect(() => normalizeRakutenCaptchaAnswer("abcde")).toThrow(
      RakutenCaptchaRejectedError,
    );
    expect(() => normalizeRakutenCaptchaAnswer(undefined)).toThrow(
      RakutenCaptchaRejectedError,
    );
  });

  it("decodes CAPTCHA data URIs", () => {
    const { bytes, contentType } = dataUriToBuffer(
      "data:image/png;base64,AAEC",
    );
    expect(contentType).toBe("image/png");
    expect([...new Uint8Array(bytes)]).toEqual([0, 1, 2]);
    expect(() => dataUriToBuffer("not-a-data-uri")).toThrow(
      RakutenConnectionError,
    );
  });
});

describe("runRakutenOcrAttempts", () => {
  const always = { maxAttempts: 3, hasTimeForAttempt: () => true };

  it("retries after a CAPTCHA rejection and stops on success", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new RakutenCaptchaRejectedError("wrong"))
      .mockResolvedValueOnce(undefined);

    await runRakutenOcrAttempts(attempt, always);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("reports every failed attempt and ends with an exhausted error", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValue(new RakutenCaptchaRejectedError("wrong"));
    const onAttemptFailed = vi.fn();

    const error = await runRakutenOcrAttempts(attempt, {
      ...always,
      onAttemptFailed,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RakutenAutoCaptchaFailedError);
    expect((error as RakutenAutoCaptchaFailedError).reason).toBe("exhausted");
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(onAttemptFailed.mock.calls.map(([n]) => n)).toEqual([1, 2, 3]);
  });

  it("rethrows credential rejections immediately", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValue(new RakutenCredentialRejectedError("bad password"));

    await expect(runRakutenOcrAttempts(attempt, always)).rejects.toBeInstanceOf(
      RakutenCredentialRejectedError,
    );
    expect(attempt).toHaveBeenCalledOnce();
  });

  it("rethrows connection errors immediately", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValue(new RakutenConnectionError("unknown outcome"));

    const error = await runRakutenOcrAttempts(attempt, always).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(RakutenConnectionError);
    expect(error).not.toBeInstanceOf(RakutenAutoCaptchaFailedError);
    expect(attempt).toHaveBeenCalledOnce();
  });

  it("maps recognizer failures to recognizer_unavailable without retrying", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValue(new RakutenCaptchaRecognizerError("AI down"));

    const error = await runRakutenOcrAttempts(attempt, always).catch(
      (reason: unknown) => reason,
    );
    expect((error as RakutenAutoCaptchaFailedError).reason).toBe(
      "recognizer_unavailable",
    );
    expect(attempt).toHaveBeenCalledOnce();
  });

  it("reports out_of_time when no attempt fits in the remaining budget", async () => {
    const attempt = vi.fn();

    const error = await runRakutenOcrAttempts(attempt, {
      maxAttempts: 3,
      hasTimeForAttempt: () => false,
    }).catch((reason: unknown) => reason);

    expect((error as RakutenAutoCaptchaFailedError).reason).toBe("out_of_time");
    expect(attempt).not.toHaveBeenCalled();
  });

  it("counts only attempts actually made when time runs out mid-way", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValue(new RakutenCaptchaRejectedError("wrong"));
    let budget = 1;

    const error = await runRakutenOcrAttempts(attempt, {
      maxAttempts: 3,
      hasTimeForAttempt: () => budget-- > 0,
    }).catch((reason: unknown) => reason);

    expect((error as RakutenAutoCaptchaFailedError).reason).toBe("exhausted");
    expect((error as Error).message).toContain("1 次");
    expect(attempt).toHaveBeenCalledOnce();
  });
});

describe("shiftRakutenMonthLabel", () => {
  it("moves back across month and year boundaries", () => {
    expect(shiftRakutenMonthLabel("2026/09 活存明細", 1)).toBe("2026/08");
    expect(shiftRakutenMonthLabel("2026/09 活存明細", 2)).toBe("2026/07");
    expect(shiftRakutenMonthLabel("2026/01 活存明細", 1)).toBe("2025/12");
    expect(shiftRakutenMonthLabel("2026/02", 3)).toBe("2025/11");
    expect(shiftRakutenMonthLabel("活存明細", 1)).toBeUndefined();
  });
});

describe("Rakuten month dropdown (runs inside the bank page)", () => {
  type FakeEl = {
    tag: string;
    className: string;
    textContent: string;
    innerText?: string;
    attrs: Record<string, string>;
    inMenu: boolean;
    inModal: boolean;
    expanded: boolean;
    clicked: number;
    children: FakeEl[];
    parent?: FakeEl;
    matches: (selector: string) => boolean;
    closest: (selector: string) => FakeEl | null;
    contains: (other: FakeEl) => boolean;
    querySelector: (selector: string) => FakeEl | null;
    getAttribute: (name: string) => string | null;
    click: () => void;
  };

  function el(
    tag: string,
    text: string,
    options: {
      className?: string;
      attrs?: Record<string, string>;
      inMenu?: boolean;
      inModal?: boolean;
      expanded?: boolean;
      children?: FakeEl[];
    } = {},
  ): FakeEl {
    const element: FakeEl = {
      tag,
      className: options.className ?? "",
      textContent: text,
      attrs: options.attrs ?? {},
      inMenu: options.inMenu ?? false,
      inModal: options.inModal ?? false,
      expanded: options.expanded ?? false,
      clicked: 0,
      children: options.children ?? [],
      matches: (selector) =>
        selector.split(",").some((part) => {
          const trimmed = part.trim();
          return trimmed === tag || trimmed === `.${element.className}`;
        }),
      closest: (selector) => {
        // 依序往上找：自己、父層…（模擬 DOM closest）
        for (let node: FakeEl | undefined = element; node; node = node.parent) {
          if (selector === ".modal" && node.inModal) return node;
          if (selector.includes(".dropdown-menu") && node.inMenu) return node;
          if (
            selector.includes("button") &&
            (node.matches(selector) || node.attrs.role === "option")
          ) {
            return node;
          }
        }
        return null;
      },
      contains: (other) => {
        for (let node: FakeEl | undefined = other; node; node = node.parent) {
          if (node === element) return true;
        }
        return false;
      },
      querySelector: () => element.children[0] ?? null,
      getAttribute: (name) =>
        name === "aria-expanded"
          ? String(element.expanded)
          : (element.attrs[name] ?? null),
      click: () => {
        element.clicked += 1;
      },
    };
    for (const child of element.children) child.parent = element;
    return element;
  }

  async function captureFn() {
    const browserPage = makePage({
      onLoginClick: () => {
        browserPage.state.currentUrl = HOME_URL;
      },
    });
    puppeteerMock.launch.mockResolvedValue(browser(browserPage));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await createRakutenConnector(
      {} as Fetcher,
      vi.fn().mockResolvedValue("36CY"),
    ).sync(credentials);
    log.mockRestore();
    return browserPage.state.monthSelectFn!;
  }

  it("opens the toggle and picks the wanted option inside the menu, never one in a modal", async () => {
    const run = await captureFn();
    const toggle = el("button", " 2026/09  活存明細 ");
    const optionLink = el("a", "2026/08 活存明細", { inMenu: true });
    const optionItem = el("li", "2026/08 活存明細", {
      inMenu: true,
      children: [optionLink],
    });
    const otherOption = el("a", "2026/07 活存明細", { inMenu: true });
    const modalOption = el("a", "2026/08 活存明細", { inModal: true });
    const unrelated = el("a", "臺幣存款");
    const globals = globalThis as unknown as Record<string, unknown>;
    const previous = globals.document;
    globals.document = {
      querySelectorAll: () => [
        toggle,
        optionItem,
        otherOption,
        modalOption,
        unrelated,
      ],
    };
    try {
      expect(run({ action: "toggle" })).toEqual({
        label: "2026/09",
        clicked: true,
        labelShapedCount: 3,
      });
      expect(toggle.clicked).toBe(1);
      expect(run({ action: "choose", label: "2026/08 活存明細" })).toEqual({
        label: "",
        clicked: true,
        labelShapedCount: 3,
      });
      // li 內有連結時點連結；彈出視窗與其他月份都不會被點
      expect(optionLink.clicked).toBe(1);
      expect(optionItem.clicked).toBe(0);
      expect(modalOption.clicked).toBe(0);
      expect(otherOption.clicked).toBe(0);
      expect(toggle.clicked).toBe(1);
      expect(
        run({ action: "choose", label: "2025/01 活存明細" }),
      ).toMatchObject({ clicked: false });
    } finally {
      globals.document = previous;
    }
  });

  it("does not click a toggle that is already expanded and reports a missing toggle", async () => {
    const run = await captureFn();
    const toggle = el("button", "2026/09 活存明細", { expanded: true });
    const globals = globalThis as unknown as Record<string, unknown>;
    const previous = globals.document;
    try {
      globals.document = { querySelectorAll: () => [toggle] };
      expect(run({ action: "toggle" })).toMatchObject({ clicked: true });
      expect(toggle.clicked).toBe(0);
      globals.document = { querySelectorAll: () => [] };
      expect(run({ action: "toggle" })).toEqual({
        label: "",
        clicked: false,
        labelShapedCount: 0,
      });
    } finally {
      globals.document = previous;
    }
  });
  async function withDocument<T>(
    elements: () => FakeEl[],
    body: (run: (spec: unknown) => unknown) => T,
  ) {
    const run = await captureFn();
    const globals = globalThis as unknown as Record<string, unknown>;
    const previous = globals.document;
    globals.document = { querySelectorAll: () => elements() };
    try {
      return body(run);
    } finally {
      globals.document = previous;
    }
  }

  it("finds nothing until the button renders, then clicks it (caller polls)", async () => {
    const toggle = el("button", "2026/09 活存明細");
    let rendered = false;
    await withDocument(
      () => (rendered ? [toggle] : []),
      (run) => {
        expect(run({ action: "toggle" })).toEqual({
          label: "",
          clicked: false,
          labelShapedCount: 0,
        });
        expect(toggle.clicked).toBe(0);
        rendered = true;
        expect(run({ action: "toggle" })).toEqual({
          label: "2026/09",
          clicked: true,
          labelShapedCount: 1,
        });
        expect(toggle.clicked).toBe(1);
      },
    );
  });

  it("matches a toggle whose text has caret/icon text, zero-width chars and a nested label", async () => {
    const inner = el("span", "2026/09\u200b 活存明細");
    const toggle = el("button", "\ue5cf 2026/09 活存明細 ▼", {
      children: [inner],
    });
    const labelled = el("button", "", {
      attrs: { "aria-label": "2026/09 活存明細" },
    });
    await withDocument(
      () => [toggle, inner],
      (run) => {
        expect(run({ action: "toggle" })).toEqual({
          label: "2026/09",
          clicked: true,
          labelShapedCount: 1,
        });
        // 內層 span 才是最內層符合者，點的是它所屬的 button，而且只點一次
        expect(toggle.clicked).toBe(1);
        expect(inner.clicked).toBe(0);
      },
    );
    await withDocument(
      () => [labelled],
      (run) => {
        expect(run({ action: "toggle" })).toMatchObject({
          label: "2026/09",
          clicked: true,
        });
        expect(labelled.clicked).toBe(1);
      },
    );
  });

  it("picks options rendered as <a class=combo-item> and never re-clicks the toggle", async () => {
    const toggle = el("button", "2026/09 活存明細");
    const options = ["2026/09", "2026/08", "2026/07"].map((month) =>
      el("a", `${month} 活存明細`, {
        className: "combo-item",
        attrs: { role: "combo-item" },
      }),
    );
    await withDocument(
      () => [toggle, ...options],
      (run) => {
        expect(run({ action: "choose", label: "2026/08 活存明細" })).toEqual({
          label: "",
          clicked: true,
          labelShapedCount: 4,
        });
        expect(options[1]!.clicked).toBe(1);
        expect(options[0]!.clicked).toBe(0);
        expect(options[2]!.clicked).toBe(0);
        expect(toggle.clicked).toBe(0);
        // 目標與按鈕同月份時也不會點按鈕本身
        expect(
          run({ action: "choose", label: "2026/09 活存明細" }),
        ).toMatchObject({ clicked: true });
        expect(toggle.clicked).toBe(0);
        expect(options[0]!.clicked).toBe(1);
      },
    );
  });
});

describe("Rakuten TWD deposit transactions (CTWQU0001)", () => {
  function events(spy: { mock: { calls: unknown[][] } }) {
    return spy.mock.calls.flatMap(([value]) => {
      try {
        const parsed: unknown = JSON.parse(String(value));
        return parsed && typeof parsed === "object"
          ? [parsed as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
  }

  async function syncWith(overrides: Partial<PageState> = {}) {
    const browserPage = makePage({
      onLoginClick: () => {
        browserPage.state.currentUrl = HOME_URL;
      },
      ...overrides,
    });
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const result = await createRakutenConnector(
      {} as Fetcher,
      vi.fn().mockResolvedValue("36CY"),
    ).sync(credentials);
    return { browserPage, browserInstance, result };
  }

  it("opens 存款 → 臺幣存款 after the dashboard step and reads three months through the dropdown", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { browserPage, browserInstance, result } = await syncWith();

    const clicks = (browserPage.state.navClicks ?? []).map(
      (click) => click.exact,
    );
    const deposit = clicks.indexOf("存款");
    expect(deposit).toBeGreaterThanOrEqual(0);
    expect(clicks[deposit + 1]).toBe("臺幣存款");
    // 首頁存款讀到之後才進入明細，登出排在最後
    expect(clicks.at(-1)).toBe("登出");
    // 下拉按鈕顯示 2026/09，往前選 2026/08、2026/07
    expect(
      (browserPage.state.monthClicks ?? []).filter(
        (click) => click.action === "choose",
      ),
    ).toEqual([
      { action: "choose", label: "2026/08 活存明細" },
      { action: "choose", label: "2026/07 活存明細" },
    ]);

    expect(result.bankTransactions).toHaveLength(6);
    expect(
      result.bankTransactions?.every(
        (tx) => tx.accountId === `bank:rakuten:${DEPOSIT_ACCOUNT_NO}:TWD`,
      ),
    ).toBe(true);
    const autoDebits = result.bankTransactions?.filter(
      (tx) => tx.description === "自動扣款",
    );
    expect(autoDebits).toHaveLength(3);
    expect(autoDebits?.every((tx) => tx.amount === -6_543)).toBe(true);
    // 餘額照常
    expect(result.bankAccounts?.map((account) => account.accountType)).toEqual([
      "savings",
    ]);
    expect(result).not.toHaveProperty("transactionStats");
    expect(warn).not.toHaveBeenCalled();
    // 一律 close，不 disconnect
    expect(browserInstance.close).toHaveBeenCalledOnce();
    expect(browserInstance.disconnect).not.toHaveBeenCalled();
    // 存款頁登出前的確認也照常
    expect(browserPage.state.logoutConfirmed).toBe(true);
    warn.mockRestore();
    log.mockRestore();
  }, 20_000);

  it("never logs account numbers, balances or amounts while syncing transactions", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await syncWith();
    const output = [...log.mock.calls, ...warn.mock.calls]
      .map(([value]) => String(value))
      .join("\n");
    for (const secret of [DEPOSIT_ACCOUNT_NO, "52,345", "52345", "6,543"]) {
      expect(output).not.toContain(secret);
    }
    warn.mockRestore();
    log.mockRestore();
  }, 20_000);

  it("keeps the months it has when a dropdown option is missing and logs count-only events", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { result, browserInstance } = await syncWith({
      tapDepositMonths: {},
    });
    expect(result.bankTransactions).toHaveLength(2);
    expect(result.bankAccounts?.length).toBe(1);
    expect(events(warn)).toContainEqual({
      event: "rakuten_tx_fetch_skipped",
      reason: "month_option_missing",
      labelShapedCount: 4,
    });
    expect(browserInstance.close).toHaveBeenCalledOnce();
    warn.mockRestore();
    log.mockRestore();
  }, 20_000);

  it("keeps polling for a month dropdown that renders late instead of giving up", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { browserPage, result } = await syncWith({ monthToggleMisses: 3 });
    const toggles = (browserPage.state.monthClicks ?? []).filter(
      (click) => click.action === "toggle",
    );
    // 前 3 次沒找到，之後的 2 個月份各 1 次
    expect(toggles).toHaveLength(5);
    expect(result.bankTransactions).toHaveLength(6);
    expect(
      events(warn).filter((event) => event.reason === "month_dropdown_missing"),
    ).toEqual([]);
    warn.mockRestore();
    log.mockRestore();
  }, 20_000);

  it("gives up with a count-only event when the month dropdown never renders", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { result } = await syncWith({ monthToggleMisses: 1_000 });
    expect(result.bankTransactions).toHaveLength(2);
    expect(events(warn)).toContainEqual({
      event: "rakuten_tx_fetch_skipped",
      reason: "month_dropdown_missing",
      labelShapedCount: 0,
    });
    warn.mockRestore();
    log.mockRestore();
  }, 20_000);

  it("stops fetching older months when time is short instead of failing the sync", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockImplementation(() => realNow() + offset);
    try {
      const { result, browserPage } = await syncWith({
        // 當月讀到之後，時間已接近明細專用的 75 秒上限（扣掉登出保留的 8 秒）
        onDepositOpened: () => {
          offset = 68_000;
        },
      });
      expect(result.bankTransactions).toHaveLength(2);
      expect(browserPage.state.monthClicks ?? []).toEqual([]);
      expect(events(warn)).toContainEqual({
        event: "rakuten_tx_fetch_skipped",
        reason: "out_of_time",
        monthsFetched: 1,
        monthsWanted: 3,
      });
      expect(result.bankAccounts?.length).toBe(1);
    } finally {
      nowSpy.mockRestore();
      warn.mockRestore();
      log.mockRestore();
    }
  }, 20_000);

  it("still fetches transactions when login and dashboard already used more than 55 - 8 - 5 seconds", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockImplementation(() => realNow() + offset);
    try {
      const { result, browserPage } = await syncWith({
        // 首頁存款步驟後已過 45 秒：若明細沿用 55 秒期限，只剩 2 秒而被略過
        onDashboardRead: () => {
          offset = 45_000;
        },
      });
      expect(result.bankTransactions).toHaveLength(6);
      expect(
        (browserPage.state.monthClicks ?? []).filter(
          (click) => click.action === "choose",
        ),
      ).toHaveLength(2);
      expect(
        events(warn).filter(
          (event) => event.event === "rakuten_tx_fetch_skipped",
        ),
      ).toEqual([]);
      expect(browserPage.state.logoutConfirmed).toBe(true);
    } finally {
      nowSpy.mockRestore();
      warn.mockRestore();
      log.mockRestore();
    }
  }, 20_000);

  it("does not throw a deadline error when parsing fallbacks run after a long transaction step", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockImplementation(() => realNow() + offset);
    try {
      const { result } = await syncWith({
        // 首頁回應沒有存款帳戶：解析階段要切回臺幣存款重讀文字（會呼叫 remainingMs）
        tapDashboard: { depositInfo: { depAccounts: [] } },
        depositText: depositPageText,
        // 明細步驟結束時已 70 秒：超過 55 秒，但仍在 75 秒內
        onDepositOpened: () => {
          offset = 70_000;
        },
      });
      expect(result.bankAccounts?.map((a) => a.accountType)).toContain(
        "savings",
      );
      expect(events(warn)).toContainEqual({
        event: "rakuten_fallback",
        target: "deposit",
        step: "text_reread",
      });
    } finally {
      nowSpy.mockRestore();
      warn.mockRestore();
      log.mockRestore();
    }
  }, 20_000);

  it("does not fail the sync when the transaction response never arrives", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { result } = await syncWith({ tapDepositCurrent: null });
    expect(result.bankTransactions).toEqual([]);
    expect(result.bankBalanceSnapshots?.length).toBe(1);
    expect(events(warn)).toContainEqual({
      event: "rakuten_tx_fetch_skipped",
      reason: "no_response",
    });
    warn.mockRestore();
    log.mockRestore();
  }, 20_000);

  it("skips unusable transaction payloads with a count-only event and keeps balances", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { result } = await syncWith({
      tapDepositCurrent: {
        display: {},
        queryAccountNo: DEPOSIT_ACCOUNT_NO,
        txDetails: "oops",
      },
      tapDepositMonths: {},
    });
    expect(result.bankTransactions).toEqual([]);
    expect(result.bankAccounts?.length).toBe(1);
    expect(events(warn)).toContainEqual({
      event: "rakuten_tx_skipped",
      monthsProvided: 1,
      monthsSkipped: 1,
      rowsSkipped: 0,
      reasons: { invalid_payload: 1 },
    });
    warn.mockRestore();
    log.mockRestore();
  }, 20_000);

  it("logs a count-only event when the bank says the list is truncated and keeps the returned rows", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { result } = await syncWith({
      tapDepositCurrent: depositTxnRsData(monthRows("2026/09", 58_888, 9), {
        dataEnd: false,
        dataLimit: true,
      }),
      tapDepositMonths: {},
    });
    expect(result.bankTransactions).toHaveLength(2);
    expect(events(log)).toContainEqual({
      event: "rakuten_tx_truncated",
      monthsTruncated: 1,
    });
    warn.mockRestore();
    log.mockRestore();
  }, 20_000);

  it("skips the transaction step without failing when the 臺幣存款 link cannot be clicked", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { result } = await syncWith({
      onDepositOpened: () => {
        throw new Error("boom");
      },
    });
    expect(result.bankTransactions).toEqual([]);
    expect(result.bankAccounts?.length).toBe(1);
    expect(events(warn)).toContainEqual({
      event: "rakuten_tx_fetch_skipped",
      reason: "nav_missing",
    });
    warn.mockRestore();
    log.mockRestore();
  }, 20_000);
});
