import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const launch = vi.hoisted(() => vi.fn());
vi.mock("@cloudflare/puppeteer", () => ({ default: { launch } }));
import {
  BrowserRunCapacityError,
  classifyBrowserRunCapacityError,
  launchBrowserWithRetry,
} from "../../src/connectors/browser";
import { createCathaybkConnector } from "../../src/connectors/cathaybk";
import { createEsunConnector } from "../../src/connectors/esun";

type Binding = Parameters<typeof launchBrowserWithRetry>[0];
const acquisitionUrl = "https://fake.host/v1/devtools/browser?keep_alive=60000";

describe("browser acquisition retry", () => {
  beforeEach(() => {
    launch.mockReset();
    launch.mockImplementation((binding: Binding) =>
      binding.fetch(acquisitionUrl, { method: "POST" }),
    );
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns success immediately and preserves launch options", async () => {
    const response = new Response("session");
    const fetch = vi.fn().mockResolvedValue(response);
    const options = { keep_alive: 60000 };
    await expect(launchBrowserWithRetry({ fetch }, options)).resolves.toBe(
      response,
    );
    expect(launch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ fetch: expect.any(Function) }),
      options,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries by status regardless of response text and preserves the request", async () => {
    const failed = new Response("服務暫時不可用", { status: 503 });
    const response = new Response("session");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(response);
    launch.mockImplementation((binding: Binding) =>
      binding.fetch(
        new Request(acquisitionUrl, {
          method: "POST",
          headers: { "X-Test": "preserved" },
          body: "payload",
        }),
      ),
    );
    const result = launchBrowserWithRetry({ fetch });
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(failed.bodyUsed).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(response);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [request] of fetch.mock.calls) {
      expect(request.url).toBe(acquisitionUrl);
      expect(request.method).toBe("POST");
      expect(request.headers.get("X-Test")).toBe("preserved");
      expect(await request.text()).toBe("payload");
    }
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("stops after three attempts and leaves the final response readable", async () => {
    const final = new Response("last failure", { status: 503 });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("first", { status: 503 }))
      .mockResolvedValueOnce(new Response("second", { status: 503 }))
      .mockResolvedValueOnce(final);
    const result = launchBrowserWithRetry({ fetch });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(final);
    expect(await final.text()).toBe("last failure");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([401, 429, 500])(
    "passes through status %s without retry",
    async (status) => {
      const response = new Response("error", { status });
      const fetch = vi.fn().mockResolvedValue(response);
      await expect(launchBrowserWithRetry({ fetch })).resolves.toBe(response);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(response.bodyUsed).toBe(false);
    },
  );

  it.each([
    ["GET", acquisitionUrl],
    ["GET", "https://fake.host/v1/devtools/browser/session-id"],
    ["POST", "https://fake.host/v1/devtools/browser/session-id"],
  ])("does not retry other requests: %s %s", async (method, url) => {
    const response = new Response("unavailable", { status: 503 });
    const fetch = vi.fn().mockResolvedValue(response);
    const init = { method };
    launch.mockImplementation((binding: Binding) => binding.fetch(url, init));
    await expect(launchBrowserWithRetry({ fetch })).resolves.toBe(response);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(url, init);
    expect(response.bodyUsed).toBe(false);
  });

  it("does not retry network exceptions with an unknown acquisition outcome", async () => {
    const error = new Error("connection lost");
    const fetch = vi.fn().mockRejectedValue(error);
    await expect(launchBrowserWithRetry({ fetch })).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(1);
  });
});

describe("Browser Run capacity errors", () => {
  beforeEach(() => launch.mockReset());

  it.each([
    ["2026-09-27T23:59:59.500Z", 1],
    ["2026-09-28T00:00:00.000Z", 86_400],
  ])("reports the next Taiwan 08:00 reset from %s", (time, seconds) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(time));
    try {
      expect(
        classifyBrowserRunCapacityError(
          new Error(
            "Unable to create new browser: code: 429: message: Browser time limit exceeded for today",
          ),
        ),
      ).toMatchObject({
        kind: "daily_quota",
        retryAfterSeconds: seconds,
        message: expect.stringContaining("每日台灣時間早上 8 點重置"),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    "Unable to create new browser: code: 429: message: Rate limit exceeded",
    "Rate limit exceeded",
    "Too many requests",
    "Browser capacity exceeded",
  ])("classifies a short Browser Run limit: %s", (message) => {
    expect(classifyBrowserRunCapacityError(new Error(message))).toMatchObject({
      kind: "rate_limit",
      retryAfterSeconds: 20,
    });
  });

  it.each([
    new Error(
      "Unable to create new browser: code: 503: message: capacity unavailable",
    ),
    new Error("E.SUN API responded with HTTP 429"),
    new Error("Navigation timeout"),
  ])("leaves unrelated errors alone: %s", (error) => {
    expect(classifyBrowserRunCapacityError(error)).toBeUndefined();
  });

  it("converts launch limits and preserves unrelated launch failures", async () => {
    launch.mockRejectedValueOnce(
      new Error("Unable to create new browser: code: 429"),
    );
    await expect(launchBrowserWithRetry({} as Fetcher)).rejects.toBeInstanceOf(
      BrowserRunCapacityError,
    );

    const unrelated = new Error("socket hang up");
    launch.mockRejectedValueOnce(unrelated);
    await expect(launchBrowserWithRetry({} as Fetcher)).rejects.toBe(unrelated);
  });

  it.each([
    ["esun", createEsunConnector],
    ["cathaybk", createCathaybkConnector],
  ])("propagates %s launch limits", async (_id, createConnector) => {
    launch.mockRejectedValueOnce(
      new Error("Unable to create new browser: code: 429"),
    );
    await expect(
      createConnector({} as Fetcher).sync({
        userId: "A123456789",
        account: "test-user",
        password: "test-password",
      }),
    ).rejects.toBeInstanceOf(BrowserRunCapacityError);
  });
});
