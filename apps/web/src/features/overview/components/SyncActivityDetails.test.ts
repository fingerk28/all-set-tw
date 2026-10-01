import { fireEvent, render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import { moneyState } from "@/shared/state/money-visibility.svelte";
import SyncActivityDetails from "./SyncActivityDetails.svelte";

const item = {
  id: "t1",
  title: "全聯福利中心",
  subtitle: "永豐銀行",
  date: "2026-09-01",
  syncedAt: "2026-09-15T06:00:00Z",
  amount: -358,
  currency: "TWD",
  status: "pending",
  changes: ["added"] as Array<"added">,
};

describe("本次同步明細", () => {
  it("載入失敗可重試，舊報告不顯示成零變動", async () => {
    const onRetry = vi.fn();
    const ui = render(SyncActivityDetails, {
      props: { failed: true, onRetry },
    });
    await ui.findByText("無法載入同步明細。");
    await fireEvent.click(ui.getByRole("button", { name: "重試" }));
    expect(onRetry).toHaveBeenCalledOnce();
    ui.unmount();
    const legacy = render(SyncActivityDetails, {
      props: {
        page: { availability: "legacy", items: [] },
        onRetry,
      },
    });
    await legacy.findByText("此報告僅提供筆數，沒有保存活動明細。");
    expect(
      legacy.queryByText("本次沒有新增活動、入帳或補上發票。"),
    ).not.toBeInTheDocument();
  });
  it("隱藏金額涵蓋新增的明細", async () => {
    moneyState.hidden = true;
    try {
      const ui = render(SyncActivityDetails, {
        props: {
          page: {
            availability: "available",
            items: [item],
          },
          onRetry: vi.fn(),
        },
      });
      await ui.findByText("••••••");
      expect(ui.queryByText(/358/)).not.toBeInTheDocument();
    } finally {
      moneyState.hidden = false;
    }
  });

  it("只顯示日期與來源名稱，狀態標籤維持內容高度", async () => {
    const ui = render(SyncActivityDetails, {
      props: {
        page: {
          availability: "available",
          items: [
            {
              ...item,
              subtitle: "中國信託商業銀行 · LINE Pay信用卡 · FE79512955",
              changes: ["posted"],
            },
          ],
        },
        onRetry: vi.fn(),
      },
    });

    expect(
      await ui.findByText("2026/9/1 · 中國信託商業銀行", { exact: true }),
    ).toBeInTheDocument();
    expect(ui.queryByText(/LINE Pay信用卡|FE79512955/)).not.toBeInTheDocument();
    expect(ui.queryByText(/依本次同步變動列出/)).not.toBeInTheDocument();
    expect(ui.getByText("已入帳").parentElement).toHaveClass("items-start");
  });
});
