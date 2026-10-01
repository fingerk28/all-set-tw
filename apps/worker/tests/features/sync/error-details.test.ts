import { describe, expect, it } from "vitest";
import { BrowserRunCapacityError } from "../../../src/connectors/browser";
import {
  CathayOtpChannelRequiredError,
  CathayOtpInvalidError,
  CathayOtpRequiredError,
  CathayOtpSessionExpiredError,
} from "../../../src/connectors/cathaybk";
import {
  RakutenAutoCaptchaFailedError,
  RakutenConnectionError,
} from "../../../src/connectors/rakuten";
import {
  isUserActionError,
  ManualCaptchaRequiredError,
  safeErrorLogDetails,
  safeErrorMessage,
} from "../../../src/features/sync/service";

describe("sync error details", () => {
  it("keeps Browser Run capacity failures as failed syncs", () => {
    expect(
      isUserActionError(new BrowserRunCapacityError("daily_quota", 60)),
    ).toBe(false);
  });

  it("classifies Cathay OTP states as user actions", () => {
    expect(
      isUserActionError(
        new CathayOtpChannelRequiredError(
          "choose channel",
          "pending-session",
          "2026-08-22T12:00:00.000Z",
        ),
      ),
    ).toBe(true);
    expect(isUserActionError(new CathayOtpRequiredError("sent", "email"))).toBe(
      true,
    );
    expect(isUserActionError(new CathayOtpSessionExpiredError())).toBe(true);
    expect(isUserActionError(new CathayOtpInvalidError())).toBe(true);
  });

  it("pauses scheduling after Rakuten OCR fails by classifying it as a user action", () => {
    // needs_user_action 的 job 不會再被排程挑選（見 schedule-state.test.ts），
    // 直到使用者以人工驗證碼同步成功；一次排程最多只送出 3 次驗證碼。
    for (const reason of [
      "exhausted",
      "recognizer_unavailable",
      "out_of_time",
    ] as const) {
      expect(
        isUserActionError(
          new RakutenAutoCaptchaFailedError(reason, "請改用人工驗證"),
        ),
      ).toBe(true);
    }
    expect(
      isUserActionError(new ManualCaptchaRequiredError("請改用人工驗證")),
    ).toBe(true);
    expect(
      isUserActionError(new RakutenConnectionError("登入結果無法辨識")),
    ).toBe(false);
  });

  it("uses a non-empty fallback when Error.message is blank", () => {
    expect(safeErrorMessage(new Error("  \n  "))).toBe(
      "同步失敗，但未取得錯誤原因。",
    );
    expect(safeErrorMessage(undefined)).toBe("同步失敗，但未取得錯誤原因。");
  });

  it("normalizes and bounds the persisted message", () => {
    expect(safeErrorMessage(new Error("連線   暫時\n失敗"))).toBe(
      "連線 暫時 失敗",
    );
    expect(safeErrorMessage(new Error("失".repeat(301)))).toHaveLength(300);
  });

  it("redacts identifiers and secrets from the persisted message", () => {
    const message = safeErrorMessage(
      new Error(
        "登入失敗 A123456789 帳號 0012345678901 手機 0912345678 password=hunter2 token abcdefghijklmnopqrstuvwxyz https://bank.example/login?id=A123456789",
      ),
    );

    expect(message).toBe(
      "登入失敗 [redacted] 帳號 [redacted] 手機 [redacted] password=[redacted] token [redacted] [URL]",
    );
  });

  it("keeps short numbers such as amounts and dates readable", () => {
    expect(safeErrorMessage(new Error("金額 1,234,567 日期 20260923"))).toBe(
      "金額 1,234,567 日期 20260923",
    );
  });

  it("redacts sensitive values from structured log diagnostics", () => {
    const error = new Error("request failed");
    error.stack =
      "Error: password=must-not-appear\n    at https://bank.example/path token=abcdefghijklmnopqrstuvwxyz password=hunter2";
    const cause = new Error(
      "authorization=Bearer_abcdefghijklmnopqrstuvwx cookie=session-value",
    );
    cause.stack =
      "Error: cookie=must-not-appear\n    at https://bank.example/cause secret=short-value";
    error.cause = cause;

    const details = safeErrorLogDetails(error);

    expect(details).toMatchObject({
      errorName: "Error",
      stack: expect.stringContaining("[URL]"),
      causeName: "Error",
      causeStack: expect.stringContaining("secret=[redacted]"),
    });
    expect(JSON.stringify(details)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(JSON.stringify(details)).not.toContain("hunter2");
    expect(JSON.stringify(details)).not.toContain("session-value");
    expect(JSON.stringify(details)).not.toContain("must-not-appear");
    expect(JSON.stringify(details)).not.toContain("short-value");
  });

  it("includes a bounded stage identifier when an error exposes one", () => {
    const error = Object.assign(new Error("failed"), {
      stage: "fetch_realtime",
    });

    expect(safeErrorLogDetails(error)).toMatchObject({
      errorName: "Error",
      stage: "fetch_realtime",
    });
  });
});
