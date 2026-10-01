import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`overview sync details expand lazily without overflow at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    let requests = 0;
    let activitiesPath = "";
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith("/api/")) return route.continue();
      let json: unknown = [];
      if (path === "/api/runtime") json = { demoMode: true };
      else if (path === "/api/bank") json = { accounts: [], transactions: [] };
      else if (path === "/api/notifications/config") json = { enabled: false };
      else if (path === "/api/sync-reports/latest")
        json = {
          id: "default:report",
          startedAt: "2026-09-15T06:00:00Z",
          completedAt: "2026-09-15T06:05:00Z",
          status: "success",
          recoveredAt: null,
          sources: [
            {
              connectorId: "sinopac",
              status: "success",
              completedAt: "2026-09-15T06:05:00Z",
              recoveredAt: null,
              newRecords: {
                bankTransactions: 1,
                invoices: 0,
                investmentTransactions: 0,
              },
            },
          ],
          sourceSummary: {
            total: 1,
            success: 1,
            failed: 0,
            needsUserAction: 0,
          },
          newRecords: {
            bankTransactions: 1,
            invoices: 0,
            investmentTransactions: 0,
          },
          financialChange: null,
          financialChangeUnavailableReason: "baseline",
          missingCurrencies: [],
        };
      else if (path.endsWith("/activities")) {
        activitiesPath = path;
        requests++;
        json = {
          sources: {
            sinopac: {
              availability: "available",
              items: [
                {
                  id: "card:t1",
                  date: "2026-09-01",
                  title: "全聯福利中心台中北屯店",
                  subtitle: "永豐銀行 · DAWAY 末四碼 1234",
                  amount: -358,
                  currency: "TWD",
                  status: "pending",
                  syncedAt: "2026-09-15T06:05:00Z",
                  changes: ["added"],
                },
                {
                  id: "card:t2",
                  date: "2026-08-29",
                  title: "台灣高鐵",
                  subtitle: "永豐銀行 · DAWAY 末四碼 1234",
                  amount: -700,
                  currency: "TWD",
                  status: "posted",
                  syncedAt: "2026-09-15T06:05:00Z",
                  changes: ["posted", "invoice_linked"],
                },
              ],
            },
          },
        };
      }
      await route.fulfill({ json });
    });
    await page.goto("/#/overview");
    await expect(
      page.getByText("最近一次排程同步", { exact: true }),
    ).toBeVisible();
    expect(requests).toBe(0);
    await page.getByText("查看各資料來源", { exact: true }).click();
    await expect(page.getByText("全聯福利中心台中北屯店")).toBeVisible();
    await expect(page.getByText("補上發票", { exact: true })).toBeVisible();
    expect(requests).toBe(1);
    expect(activitiesPath).toBe(
      "/api/sync-reports/default%3Areport/activities",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await page
      .getByText("最近一次排程同步", { exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `/tmp/sync-details-${width}.png`,
      fullPage: true,
    });
    await page.getByText("收合各資料來源", { exact: true }).click();
    await expect(page.getByText("全聯福利中心台中北屯店")).not.toBeVisible();
  });
}
