import { fireEvent, render, waitFor, within } from "@testing-library/svelte";
import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
import { describe, expect, it, vi } from "vitest";
import { connectorFields } from "@/data/connectors/definitions";
import type { ConnectorField, SyncJobRow } from "@/data/connectors/types";
import { ApiRequestError, type ApiClient } from "@/shared/api/client";
import ConnectorPanel from "./ConnectorPanel.svelte";

function syncJob(overrides: Partial<SyncJobRow> = {}): SyncJobRow {
  return {
    id: "einvoice:all",
    connectorId: "einvoice",
    configured: true,
    scope: "all",
    enabled: true,
    intervalMinutes: 1440,
    nextRunAt: "2026-08-13T00:00:00.000Z",
    scheduleMode: "inherit",
    preferredTime: "08:00",
    preferredWeekday: 1,
    lockedUntil: null,
    lockedBy: null,
    lockTrigger: null,
    lockScope: null,
    lastRunAt: null,
    lastSuccessAt: null,
    lastStatus: null,
    lastError: null,
    updatedAt: "2026-08-12T00:00:00.000Z",
    running: false,
    ...overrides,
  };
}

function renderEinvoicePanel(syncJobs: SyncJobRow[][]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  let syncJobRequest = 0;
  const api = {
    get: vi.fn((path: string) => {
      if (path === "/api/sync-jobs")
        return Promise.resolve(
          syncJobs[Math.min(syncJobRequest++, syncJobs.length - 1)] ?? [],
        );
      return Promise.resolve({});
    }),
    post: vi.fn().mockResolvedValue({
      success: true,
      connectorId: "einvoice",
      scope: "all",
      status: "queued",
      runId: "run-1",
    }),
  } as unknown as ApiClient;
  const result = render(
    ConnectorPanel,
    {
      props: {
        api,
        connectorId: "einvoice",
        demoMode: false,
        title: "電子發票",
        fields: connectorFields.einvoice as ConnectorField[],
      },
    },
    {
      wrapper: QueryClientProvider,
      wrapperProps: { client: queryClient },
    },
  );
  return { ...result, api, queryClient };
}

function renderCathayPanel(
  post: ReturnType<typeof vi.fn>,
  connectorSettings: Record<string, unknown> = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  const api = {
    get: vi.fn((path: string) => {
      if (path === "/api/sync-jobs")
        return Promise.resolve([
          syncJob({
            id: "cathaybk:all",
            connectorId: "cathaybk",
          }),
        ]);
      if (path === "/api/connectors/cathaybk/settings")
        return Promise.resolve(connectorSettings);
      return Promise.resolve({});
    }),
    post,
  } as unknown as ApiClient;
  const result = render(
    ConnectorPanel,
    {
      props: {
        api,
        connectorId: "cathaybk",
        demoMode: false,
        title: "國泰世華銀行",
        fields: connectorFields.cathaybk as ConnectorField[],
      },
    },
    {
      wrapper: QueryClientProvider,
      wrapperProps: { client: queryClient },
    },
  );
  return { ...result, api, queryClient };
}

function renderFirstbankPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  const api = {
    get: vi.fn((path: string) => {
      if (path === "/api/sync-jobs") {
        return Promise.resolve([
          syncJob({
            id: "firstbank:all",
            connectorId: "firstbank",
            enabled: true,
            lastStatus: "failed",
            lastError:
              "第一銀行登入資料驗證失敗，請確認設定後重試。請重新取得驗證碼。",
          }),
        ]);
      }
      if (path === "/api/connectors/firstbank/settings") {
        return Promise.resolve({
          connectorId: "firstbank",
          configured: true,
          credentialsComplete: true,
          sessionAvailable: false,
          updatedAt: "2026-08-26T00:00:00.000Z",
        });
      }
      return Promise.resolve({});
    }),
    post: vi.fn(),
    patch: vi.fn(),
  } as unknown as ApiClient;
  const result = render(
    ConnectorPanel,
    {
      props: {
        api,
        connectorId: "firstbank",
        demoMode: false,
        title: "第一銀行",
        fields: connectorFields.firstbank as ConnectorField[],
      },
    },
    {
      wrapper: QueryClientProvider,
      wrapperProps: { client: queryClient },
    },
  );
  return { ...result, api };
}

function renderMegabankPanel(post: ReturnType<typeof vi.fn>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  const api = {
    get: vi.fn((path: string) => {
      if (path === "/api/sync-jobs") {
        return Promise.resolve([
          syncJob({ id: "megabank:all", connectorId: "megabank" }),
        ]);
      }
      if (path === "/api/connectors/megabank/settings") {
        return Promise.resolve({
          connectorId: "megabank",
          configured: true,
          credentialsComplete: true,
          sessionAvailable: false,
          updatedAt: "2026-09-27T00:00:00.000Z",
        });
      }
      return Promise.resolve({});
    }),
    post,
    patch: vi.fn(),
  } as unknown as ApiClient;
  const result = render(
    ConnectorPanel,
    {
      props: {
        api,
        connectorId: "megabank",
        demoMode: false,
        title: "兆豐銀行",
        fields: connectorFields.megabank as ConnectorField[],
      },
    },
    {
      wrapper: QueryClientProvider,
      wrapperProps: { client: queryClient },
    },
  );
  return { ...result, api };
}

function renderRakutenPanel(post: ReturnType<typeof vi.fn>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  const api = {
    get: vi.fn((path: string) => {
      if (path === "/api/sync-jobs") {
        return Promise.resolve([
          syncJob({ id: "rakuten:all", connectorId: "rakuten" }),
        ]);
      }
      if (path === "/api/connectors/rakuten/settings") {
        return Promise.resolve({
          connectorId: "rakuten",
          configured: true,
          credentialsComplete: true,
          sessionAvailable: false,
          updatedAt: "2026-09-27T00:00:00.000Z",
        });
      }
      return Promise.resolve({});
    }),
    post,
    patch: vi.fn(),
  } as unknown as ApiClient;
  const result = render(
    ConnectorPanel,
    {
      props: {
        api,
        connectorId: "rakuten",
        demoMode: false,
        title: "樂天國際銀行",
        fields: connectorFields.rakuten as ConnectorField[],
      },
    },
    {
      wrapper: QueryClientProvider,
      wrapperProps: { client: queryClient },
    },
  );
  return { ...result, api };
}

function renderNextbankPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  const api = {
    get: vi.fn((path: string) => {
      if (path === "/api/sync-jobs") {
        return Promise.resolve([
          syncJob({
            id: "nextbank:all",
            connectorId: "nextbank",
            enabled: true,
            lastStatus: "failed",
            lastError:
              "將來銀行登入資料驗證失敗，請確認設定後重試。請重新取得驗證碼。",
          }),
        ]);
      }
      if (path === "/api/connectors/nextbank/settings") {
        return Promise.resolve({
          connectorId: "nextbank",
          configured: true,
          credentialsComplete: true,
          sessionAvailable: false,
          updatedAt: "2026-08-26T00:00:00.000Z",
        });
      }
      return Promise.resolve({});
    }),
    post: vi.fn(),
    patch: vi.fn(),
  } as unknown as ApiClient;
  const result = render(
    ConnectorPanel,
    {
      props: {
        api,
        connectorId: "nextbank",
        demoMode: false,
        title: "將來銀行",
        fields: connectorFields.nextbank as ConnectorField[],
      },
    },
    {
      wrapper: QueryClientProvider,
      wrapperProps: { client: queryClient },
    },
  );
  return { ...result, api };
}

describe("ConnectorPanel", () => {
  it("enables First Bank web sync and keeps both verification paths available", async () => {
    const { api, findByText, getByRole } = renderFirstbankPanel();

    expect(await findByText("自動同步：開")).toBeInTheDocument();
    expect(await findByText("狀態：失敗")).toBeInTheDocument();
    expect(
      await findByText(/上次同步：第一銀行登入資料驗證失敗/),
    ).toBeInTheDocument();
    expect(getByRole("button", { name: "自動驗證並同步" })).toBeEnabled();
    expect(getByRole("button", { name: "人工輸入驗證碼" })).toBeEnabled();
    expect(api.post).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("switches Rakuten to a manual CAPTCHA when automatic recognition fails", async () => {
    const post = vi.fn((path: string) => {
      if (path === "/api/connectors/rakuten/sync") {
        return Promise.reject(
          new ApiRequestError(
            "MANUAL_CAPTCHA_REQUIRED",
            "樂天驗證碼自動辨識連續失敗 3 次，請改用人工驗證。",
            400,
          ),
        );
      }
      if (path === "/api/connectors/rakuten/captcha") {
        return Promise.resolve({
          captchaImage: "data:image/png;base64,AQID",
          expiresAt: "2026-09-27T00:02:00.000Z",
          captchaLength: 4,
          captchaKind: "alphanumeric",
        });
      }
      return Promise.resolve({});
    });
    const { findByAltText, findByRole } = renderRakutenPanel(post);

    await fireEvent.click(
      await findByRole("button", { name: "自動驗證並同步" }),
    );

    expect(await findByAltText("樂天圖形驗證碼")).toBeInTheDocument();
    expect(post.mock.calls.map(([path]) => path)).toEqual([
      "/api/connectors/rakuten/sync",
      "/api/connectors/rakuten/captcha",
    ]);
  });

  it("does not open a manual CAPTCHA for other Rakuten user-action errors", async () => {
    const post = vi.fn((path: string) =>
      path === "/api/connectors/rakuten/sync"
        ? Promise.reject(
            new ApiRequestError(
              "USER_ACTION_REQUIRED",
              "樂天銀行身分證字號、使用者代號或密碼錯誤。",
              400,
            ),
          )
        : Promise.resolve({}),
    );
    const { findByRole, findByText } = renderRakutenPanel(post);

    await fireEvent.click(
      await findByRole("button", { name: "自動驗證並同步" }),
    );

    expect(
      await findByText(/樂天銀行身分證字號、使用者代號或密碼錯誤。/),
    ).toBeInTheDocument();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("keeps connector credential fields from inviting browser autofill", async () => {
    const { getByLabelText } = renderFirstbankPanel();
    const userId = getByLabelText("身分證字號／統編");
    const account = getByLabelText("登入代號");
    const password = getByLabelText("網路銀行密碼");

    expect(userId).toHaveAttribute("autocomplete", "off");
    expect(userId).toHaveAttribute("name", "tfh-firstbank-userId");
    expect(userId).toHaveAttribute("readonly");
    expect(account).toHaveAttribute("autocomplete", "off");
    expect(account).toHaveAttribute("readonly");
    expect(password).toHaveAttribute("autocomplete", "new-password");
    expect(password).toHaveAttribute("readonly");

    await fireEvent.focus(account);
    expect(account).not.toHaveAttribute("readonly");
    expect(password).toHaveAttribute("readonly");
  });

  it("shows a fallback when a failed sync has an empty stored error", async () => {
    const { findByText } = renderEinvoicePanel([
      [syncJob({ lastStatus: "failed", lastError: "" })],
    ]);

    expect(
      await findByText("上次同步失敗，但未取得錯誤原因。"),
    ).toBeInTheDocument();
  });

  it("polls an e-invoice run and refreshes financial data only after success", async () => {
    vi.useFakeTimers();
    const running = syncJob({ running: true });
    const completed = syncJob({
      lastRunAt: "2026-08-12T00:01:00.000Z",
      lastSuccessAt: "2026-08-12T00:01:00.000Z",
      lastStatus: "success",
    });
    const { api, getByRole, queryByText, queryClient } = renderEinvoicePanel([
      [],
      [running],
      [completed],
    ]);
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    expect(queryByText("同步品項明細")).not.toBeInTheDocument();
    await fireEvent.click(getByRole("button", { name: "同步" }));
    await vi.advanceTimersByTimeAsync(0);

    expect(api.post).toHaveBeenCalledWith("/api/connectors/einvoice/sync", {});
    expect(getByRole("button", { name: "已排入同步" })).toBeDisabled();
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ["summary"],
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ["invoices"],
    });

    await vi.advanceTimersByTimeAsync(2_000);

    expect(
      (api.get as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([path]) => path === "/api/sync-jobs",
      ),
    ).toHaveLength(4);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["summary"],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["sync-reports", "latest"],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["invoices"],
    });
    expect(getByRole("button", { name: "已排入同步" })).toBeEnabled();
    vi.useRealTimers();
  });

  it("stops polling without refreshing data when an e-invoice run fails", async () => {
    vi.useFakeTimers();
    const { api, getByRole, queryClient } = renderEinvoicePanel([
      [],
      [syncJob({ running: true })],
      [
        syncJob({
          lastRunAt: "2026-08-12T00:01:00.000Z",
          lastStatus: "failed",
          lastError: "連線失敗",
        }),
      ],
    ]);
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    await fireEvent.click(getByRole("button", { name: "同步" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.post).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(getByRole("button", { name: "已排入同步" })).toBeEnabled();
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ["summary"],
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ["invoices"],
    });
    vi.useRealTimers();
  });

  it("cancels e-invoice polling when the panel is destroyed", async () => {
    vi.useFakeTimers();
    const { api, getByRole, unmount } = renderEinvoicePanel([
      [],
      [syncJob({ running: true })],
    ]);

    await fireEvent.click(getByRole("button", { name: "同步" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.post).toHaveBeenCalledOnce();
    const syncJobRequestsBeforeUnmount = (
      api.get as ReturnType<typeof vi.fn>
    ).mock.calls.filter(([path]) => path === "/api/sync-jobs").length;

    unmount();
    await vi.advanceTimersByTimeAsync(4_000);

    expect(
      (api.get as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([path]) => path === "/api/sync-jobs",
      ),
    ).toHaveLength(syncJobRequestsBeforeUnmount);
    vi.useRealTimers();
  });

  it("guides Cathay through channel selection and OTP verification", async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiRequestError(
          "CATHAY_OTP_CHANNEL_REQUIRED",
          "需要選擇驗證方式。",
          400,
        ),
      )
      .mockRejectedValueOnce(
        new ApiRequestError(
          "CATHAY_EMAIL_OTP_REQUIRED",
          "Email 驗證碼已寄出。",
          400,
        ),
      )
      .mockResolvedValueOnce({ success: true });
    const { getByLabelText, getByRole, findByText, getByPlaceholderText } =
      renderCathayPanel(post);
    const progress = getByLabelText("國泰世華連線進度");

    expect(
      within(progress).getByText("確認網銀帳密").parentElement,
    ).toHaveClass("bg-steel/[0.07]");

    await fireEvent.click(getByRole("button", { name: "同步" }));
    expect(await findByText("需要額外驗證")).toBeInTheDocument();
    expect(
      within(progress).getByText("驗證這台裝置").parentElement,
    ).toHaveClass("bg-steel/[0.07]");
    expect(getByRole("button", { name: "使用 Email" })).toBeInTheDocument();
    expect(getByRole("button", { name: "使用簡訊" })).toBeInTheDocument();

    await fireEvent.click(getByRole("button", { name: "使用 Email" }));
    expect(await findByText("Email 驗證碼已寄出")).toBeInTheDocument();
    expect(post).toHaveBeenNthCalledWith(2, "/api/connectors/cathaybk/sync", {
      otpChannel: "email",
    });

    await fireEvent.input(getByPlaceholderText("例如 310307（不含英文前綴）"), {
      target: { value: "123456" },
    });
    await fireEvent.click(getByRole("button", { name: "驗證並完成首次同步" }));
    expect(post).toHaveBeenNthCalledWith(3, "/api/connectors/cathaybk/sync", {
      otp: "123456",
      otpChannel: "email",
    });
    await waitFor(() =>
      expect(
        within(progress).getByText("完成首次同步").parentElement,
      ).toHaveClass("bg-moss/[0.07]"),
    );
  });

  it("restores a pending Cathay Email verification after remount", async () => {
    const { findByText, getByPlaceholderText } = renderCathayPanel(vi.fn(), {
      connectorId: "cathaybk",
      configured: true,
      credentialsComplete: true,
      sessionAvailable: false,
      verificationPending: true,
      verificationChannel: "email",
      verificationExpiresAt: "2099-08-22T08:08:00.000Z",
    });

    expect(await findByText("Email 驗證碼已寄出")).toBeInTheDocument();
    expect(
      getByPlaceholderText("例如 310307（不含英文前綴）"),
    ).toBeInTheDocument();
  });

  it("keeps the Cathay Email step open after an incorrect OTP", async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiRequestError(
          "CATHAY_OTP_INVALID",
          "國泰世華驗證碼錯誤或已逾時，請重新輸入或取得驗證碼。",
          400,
        ),
      );
    const {
      findByPlaceholderText,
      findByText,
      getByPlaceholderText,
      getByRole,
    } = renderCathayPanel(post, {
      connectorId: "cathaybk",
      configured: true,
      credentialsComplete: true,
      sessionAvailable: false,
      verificationPending: true,
      verificationChannel: "email",
      verificationExpiresAt: "2099-08-22T08:08:00.000Z",
    });

    const input = await findByPlaceholderText("例如 310307（不含英文前綴）");
    await fireEvent.input(input, { target: { value: "123456" } });
    await fireEvent.click(getByRole("button", { name: "驗證並完成首次同步" }));

    expect(
      await findByText("國泰世華驗證碼錯誤或已逾時，請重新輸入或取得驗證碼。"),
    ).toBeInTheDocument();
    expect(
      getByPlaceholderText("例如 310307（不含英文前綴）"),
    ).toBeInTheDocument();
    expect(getByRole("button", { name: "重新寄送 Email" })).toBeInTheDocument();
  });

  it("closes an expired Cathay verification flow and restarts it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T08:00:00.000Z"));
    const post = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiRequestError(
          "CATHAY_OTP_SESSION_EXPIRED",
          "驗證工作階段已逾時，請重新同步。",
          400,
        ),
      )
      .mockRejectedValueOnce(
        new ApiRequestError(
          "CATHAY_OTP_CHANNEL_REQUIRED",
          "需要選擇驗證方式。",
          400,
        ),
      );

    try {
      const { getByRole, getByText } = renderCathayPanel(post, {
        connectorId: "cathaybk",
        configured: true,
        credentialsComplete: true,
        sessionAvailable: false,
        verificationPending: true,
        verificationChannel: "email",
        verificationExpiresAt: "2026-08-22T08:02:00.000Z",
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(getByText("請於 2:00 內完成驗證")).toBeInTheDocument();

      await vi.advanceTimersByTimeAsync(120_000);
      expect(getByText("驗證工作階段已逾時")).toBeInTheDocument();

      await fireEvent.click(getByRole("button", { name: "重新開始驗證" }));
      await vi.advanceTimersByTimeAsync(0);

      expect(post).toHaveBeenCalledTimes(2);
      expect(getByText("需要額外驗證")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("bank verification feedback", () => {
  it("shows pending and transport failure immediately when requesting an image", async () => {
    const view = renderNextbankPanel();
    let rejectRequest!: (reason: Error) => void;
    vi.mocked(view.api.post).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectRequest = reject;
        }),
    );
    await fireEvent.click(
      await view.findByRole("button", { name: "改用手動驗證" }),
    );
    expect(await view.findByText("正在取得驗證碼圖片…")).toBeInTheDocument();
    expect(view.getByRole("button", { name: "同步帳戶" })).toBeDisabled();
    rejectRequest(new Error("將來銀行 API：transport"));
    expect(await view.findByRole("alert")).toHaveTextContent("無法取得驗證碼");
    expect(view.getByRole("alert")).toHaveTextContent(
      "手動驗證無法解決連線問題",
    );
    expect(view.api.post).toHaveBeenCalledTimes(1);
  });
  it("shows the returned image and requires input before verification", async () => {
    const view = renderNextbankPanel();
    vi.mocked(view.api.post).mockResolvedValue({
      captchaImage: "data:image/png;base64,AQID",
      expiresAt: new Date(Date.now() + 120000).toISOString(),
      captchaLength: 5,
      captchaKind: "alphanumeric",
    });
    await fireEvent.click(
      await view.findByRole("button", { name: "改用手動驗證" }),
    );
    expect(
      await view.findByRole("img", { name: "將來圖形驗證碼" }),
    ).toBeInTheDocument();
    expect(view.getByRole("button", { name: "驗證並同步" })).toBeDisabled();
    await fireEvent.input(view.getByPlaceholderText("5 位英數字驗證碼"), {
      target: { value: "AB123" },
    });
    expect(view.getByRole("button", { name: "驗證並同步" })).toBeEnabled();
    expect(view.api.post).toHaveBeenCalledTimes(1);
  });
});

describe("Nextbank CAPTCHA recovery", () => {
  const rejected = () =>
    new ApiRequestError("NEXTBANK_CAPTCHA_REQUIRED", "請重新取得圖片。", 400);
  const image = () => ({
    captchaImage: "data:image/png;base64,AQID",
    expiresAt: new Date(Date.now() + 120000).toISOString(),
    captchaLength: 5,
    captchaKind: "alphanumeric",
  });
  it("gets one new image without retrying login, including a rejected manual answer", async () => {
    const v = renderNextbankPanel();
    const post = vi.mocked(v.api.post);
    post
      .mockRejectedValueOnce(rejected())
      .mockResolvedValueOnce(image())
      .mockRejectedValueOnce(rejected())
      .mockResolvedValueOnce(image());
    await fireEvent.click(await v.findByRole("button", { name: "同步帳戶" }));
    expect(await v.findByRole("img", { name: "將來圖形驗證碼" })).toBeVisible();
    expect(post.mock.calls.map((c) => c[0])).toEqual([
      "/api/connectors/nextbank/sync",
      "/api/connectors/nextbank/captcha",
    ]);
    await fireEvent.input(v.getByPlaceholderText("5 位英數字驗證碼"), {
      target: { value: "AB123" },
    });
    await fireEvent.click(v.getByRole("button", { name: "驗證並同步" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(4));
    expect(await v.findByRole("img", { name: "將來圖形驗證碼" })).toBeVisible();
    expect(v.getByPlaceholderText("5 位英數字驗證碼")).toHaveValue("");
    expect(post.mock.calls.map((c) => c[0])).toEqual([
      "/api/connectors/nextbank/sync",
      "/api/connectors/nextbank/captcha",
      "/api/connectors/nextbank/sync",
      "/api/connectors/nextbank/captcha",
    ]);
  });
  it("stops if the new image cannot be acquired and offers retry", async () => {
    const v = renderNextbankPanel();
    vi.mocked(v.api.post)
      .mockRejectedValueOnce(rejected())
      .mockRejectedValueOnce(new Error("圖片暫時無法取得"));
    await fireEvent.click(await v.findByRole("button", { name: "同步帳戶" }));
    expect(await v.findByRole("alert")).toHaveTextContent("無法取得驗證碼");
    expect(v.getByRole("button", { name: "重新取得驗證碼" })).toBeEnabled();
    expect(v.api.post).toHaveBeenCalledTimes(2);
  });
  it.each(["credentials", "transport", "session_conflict"])(
    "does not fetch CAPTCHA for %s",
    async (kind) => {
      const v = renderNextbankPanel();
      vi.mocked(v.api.post).mockRejectedValue(
        new ApiRequestError(
          "USER_ACTION_REQUIRED",
          "將來銀行需要重新驗證：" + kind + "。",
          400,
        ),
      );
      await fireEvent.click(await v.findByRole("button", { name: "同步帳戶" }));
      await v.findByRole("alert");
      expect(v.api.post).toHaveBeenCalledTimes(1);
    },
  );
});

describe("Megabank SMS OTP", () => {
  const otpRequiredError = () =>
    new ApiRequestError(
      "MEGABANK_SMS_OTP_REQUIRED",
      "兆豐銀行已寄出簡訊驗證碼（簡訊檢核碼 1234），請於三分鐘內輸入。",
      400,
    );

  it("enters the SMS OTP step when the bank requires it after login", async () => {
    const post = vi.fn((path: string) =>
      path === "/api/connectors/megabank/sync"
        ? Promise.reject(otpRequiredError())
        : Promise.resolve({}),
    );
    const { findByRole, findByText, findByPlaceholderText } =
      renderMegabankPanel(post);

    await fireEvent.click(
      await findByRole("button", { name: "自動驗證並同步" }),
    );

    expect(
      await findByText(
        "兆豐銀行已寄出簡訊驗證碼（簡訊檢核碼 1234），請於三分鐘內輸入。",
      ),
    ).toBeInTheDocument();
    expect(await findByPlaceholderText("4-8 位數字驗證碼")).toBeInTheDocument();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("completes sync and clears the OTP step on success", async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(otpRequiredError())
      .mockResolvedValueOnce({ success: true });
    const { findByRole, findByPlaceholderText, queryByPlaceholderText } =
      renderMegabankPanel(post);

    await fireEvent.click(
      await findByRole("button", { name: "自動驗證並同步" }),
    );
    const input = await findByPlaceholderText("4-8 位數字驗證碼");
    await fireEvent.input(input, { target: { value: "123456" } });
    await fireEvent.click(await findByRole("button", { name: "驗證並同步" }));

    await waitFor(() =>
      expect(
        queryByPlaceholderText("4-8 位數字驗證碼"),
      ).not.toBeInTheDocument(),
    );
    expect(post).toHaveBeenNthCalledWith(2, "/api/connectors/megabank/sync", {
      otp: "123456",
    });
  });

  it("keeps the OTP step and clears the input when the SMS code is wrong", async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(otpRequiredError())
      .mockRejectedValueOnce(
        new ApiRequestError(
          "MEGABANK_OTP_INVALID",
          "兆豐銀行簡訊驗證碼不正確，請重新輸入。",
          400,
        ),
      );
    const { findByRole, findByPlaceholderText, findByText } =
      renderMegabankPanel(post);

    await fireEvent.click(
      await findByRole("button", { name: "自動驗證並同步" }),
    );
    const input = await findByPlaceholderText("4-8 位數字驗證碼");
    await fireEvent.input(input, { target: { value: "000000" } });
    await fireEvent.click(await findByRole("button", { name: "驗證並同步" }));

    expect(
      await findByText(/兆豐銀行簡訊驗證碼不正確，請重新輸入。/),
    ).toBeInTheDocument();
    expect(await findByPlaceholderText("4-8 位數字驗證碼")).toHaveValue("");
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("exits the OTP step and resets to the initial state on any other error", async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(otpRequiredError())
      .mockRejectedValueOnce(
        new ApiRequestError(
          "USER_ACTION_REQUIRED",
          "兆豐銀行簡訊驗證已逾時，請重新取得圖形驗證碼。",
          400,
        ),
      );
    const {
      findByRole,
      findByPlaceholderText,
      findByText,
      queryByPlaceholderText,
    } = renderMegabankPanel(post);

    await fireEvent.click(
      await findByRole("button", { name: "自動驗證並同步" }),
    );
    const input = await findByPlaceholderText("4-8 位數字驗證碼");
    await fireEvent.input(input, { target: { value: "123456" } });
    await fireEvent.click(await findByRole("button", { name: "驗證並同步" }));

    expect(
      await findByText(/兆豐銀行簡訊驗證已逾時，請重新取得圖形驗證碼。/),
    ).toBeInTheDocument();
    expect(queryByPlaceholderText("4-8 位數字驗證碼")).not.toBeInTheDocument();
    expect(
      await findByRole("button", { name: "自動驗證並同步" }),
    ).toBeEnabled();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("enters the SMS OTP step from a manual CAPTCHA submission too", async () => {
    const post = vi.fn((path: string) => {
      if (path === "/api/connectors/megabank/captcha") {
        return Promise.resolve({
          captchaImage: "data:image/png;base64,AQID",
          expiresAt: new Date(Date.now() + 120000).toISOString(),
          captchaLength: 5,
          captchaKind: "numeric",
        });
      }
      if (path === "/api/connectors/megabank/sync") {
        return Promise.reject(otpRequiredError());
      }
      return Promise.resolve({});
    });
    const { findByRole, findByPlaceholderText } = renderMegabankPanel(post);

    await fireEvent.click(
      await findByRole("button", { name: "人工輸入驗證碼" }),
    );
    await fireEvent.input(await findByPlaceholderText("5 位數字驗證碼"), {
      target: { value: "12345" },
    });
    await fireEvent.click(await findByRole("button", { name: "驗證並同步" }));

    expect(await findByPlaceholderText("4-8 位數字驗證碼")).toBeInTheDocument();
    expect(post.mock.calls.map((c) => c[0])).toEqual([
      "/api/connectors/megabank/captcha",
      "/api/connectors/megabank/sync",
    ]);
  });
});
