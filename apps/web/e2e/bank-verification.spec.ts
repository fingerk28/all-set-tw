import { expect, test } from "@playwright/test";
for (const width of [1440, 390])
  test(`bank verification feedback at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const job = {
      id: "nextbank:all",
      connectorId: "nextbank",
      scope: "all",
      configured: true,
      enabled: false,
      running: false,
      scheduleMode: "custom",
      intervalMinutes: 10080,
      preferredTime: "06:00",
      preferredWeekday: 1,
      preferredWeekdays: [1, 3, 5],
      lastStatus: "failed",
      lastError: "將來銀行 API：transport",
      lastRunAt: "2026-09-28T01:05:00Z",
      lastSuccessAt: "2026-09-27T01:05:00Z",
    };
    let captchaCalls = 0;
    let recover = false;
    let syncCalls = 0;
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith("/api/")) return route.continue();
      if (path === "/api/connectors/nextbank/sync") {
        syncCalls++;
        return route.fulfill({
          status: 400,
          json: {
            error: {
              code: "NEXTBANK_CAPTCHA_REQUIRED",
              message: "請重新取得圖片。",
            },
          },
        });
      }
      if (path === "/api/connectors/nextbank/captcha") {
        captchaCalls++;
        if (recover)
          return route.fulfill({
            json: {
              captchaImage:
                "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=",
              expiresAt: new Date(Date.now() + 120000).toISOString(),
              captchaLength: 5,
              captchaKind: "alphanumeric",
            },
          });
        return route.fulfill({
          status: 502,
          json: {
            error: {
              code: "TEST_TRANSPORT",
              message: "將來銀行 API：transport",
            },
          },
        });
      }
      const data =
        path === "/api/runtime"
          ? { demoMode: false }
          : path === "/api/bank"
            ? { accounts: [], transactions: [] }
            : path === "/api/sync-jobs"
              ? [job]
              : path.endsWith("/settings")
                ? {
                    configured: true,
                    credentialsComplete: true,
                    sessionAvailable: false,
                  }
                : path === "/api/sync-schedule"
                  ? {
                      intervalMinutes: 10080,
                      preferredTime: "06:00",
                      preferredWeekday: 1,
                      preferredWeekdays: [1, 3, 5],
                    }
                  : path === "/api/notifications/config"
                    ? { enabled: false }
                    : [];
      await route.fulfill({ json: data });
    });
    await page.goto("/#/data-sources");
    if (width >= 768)
      await page
        .getByRole("button", { name: "管理將來銀行", exact: true })
        .click();
    else
      await page
        .locator("div.rounded-xl")
        .filter({
          has: page.getByRole("heading", { name: "將來銀行", exact: true }),
        })
        .getByRole("button", { name: "管理設定" })
        .click();
    const progress = page.getByRole("region", { name: "同步進度" });
    await expect(progress).toContainText("最近同步結果：失敗");
    await expect(progress).toContainText("最近成功更新：");
    await page
      .getByRole("button", { name: "改用手動驗證", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText("無法取得驗證碼");
    await expect(page.getByRole("alert")).toContainText(
      "手動驗證無法解決連線問題",
    );
    expect(captchaCalls).toBe(1);
    recover = true;
    await page.getByRole("button", { name: "同步帳戶", exact: true }).click();
    await expect(
      page.getByRole("img", { name: "將來圖形驗證碼" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "驗證並同步", exact: true }),
    ).toBeDisabled();
    expect(syncCalls).toBe(1);
    expect(captchaCalls).toBe(2);
    const imageY = (await page
      .getByRole("img", { name: "將來圖形驗證碼" })
      .boundingBox())!.y;
    const helpY = (await page
      .locator("summary:visible")
      .filter({ hasText: "使用說明" })
      .boundingBox())!.y;
    expect(imageY).toBeLessThan(helpY);
    await progress.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath("bank-verification.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
