import { describe, expect, it } from "vitest";
import { shouldEnableScheduleAfterFirstSync } from "./schedule-after-sync";

describe("schedule after manual sync", () => {
  it("enables supported banks after their first successful sync", () => {
    for (const connectorId of [
      "sinopac",
      "taishin",
      "obank",
      "megabank",
    ] as const) {
      expect(
        shouldEnableScheduleAfterFirstSync(connectorId, {
          enabled: false,
          lastSuccessAt: null,
        }),
      ).toBe(true);
    }
  });

  it("preserves an explicit disable after a previous successful sync", () => {
    for (const connectorId of [
      "sinopac",
      "taishin",
      "obank",
      "megabank",
    ] as const) {
      expect(
        shouldEnableScheduleAfterFirstSync(connectorId, {
          enabled: false,
          lastSuccessAt: "2026-09-27T10:00:00.000Z",
        }),
      ).toBe(false);
    }
    expect(
      shouldEnableScheduleAfterFirstSync("megabank", {
        enabled: true,
        lastSuccessAt: null,
      }),
    ).toBe(false);
  });
});
