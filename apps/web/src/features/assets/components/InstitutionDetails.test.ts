import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import InstitutionDetails from "./InstitutionDetails.svelte";
import { calculateAssetSummary } from "../model/summary";

describe("credit card balance availability", () => {
  it.each([null, undefined, 0, -1200, 137])(
    "distinguishes missing balances from a confirmed balance of %s",
    (balance) => {
      const summary = calculateAssetSummary({
        bank: {
          accounts: [
            {
              id: "yen",
              sourceId: "yen",
              connectorId: "sinopac",
              accountType: "credit",
              currency: "JPY",
              balance,
            },
          ],
          transactions: [],
        },
        investments: [],
        manualAssets: [],
        rates: [{ currency: "JPY", rateTwd: 0.2, updatedAt: "2026-09-13" }],
      });
      expect(summary.hasUnknownCardBalance).toBe(balance == null);
      expect(summary.institutionGroups[0].hasUnknownCardBalance).toBe(
        balance == null,
      );
      render(InstitutionDetails, {
        group: summary.institutionGroups[0],
        bills: [],
      });
      if (balance == null) {
        expect(screen.getByText("金額尚未取得")).toBeInTheDocument();
        expect(screen.getByText("資料不完整")).toBeInTheDocument();
        expect(screen.queryByText("JP¥0")).not.toBeInTheDocument();
      } else {
        expect(screen.queryByText("金額尚未取得")).not.toBeInTheDocument();
        expect(screen.queryByText("資料不完整")).not.toBeInTheDocument();
        expect(
          screen.getByText(
            balance === 0 ? "JP¥0" : balance > 0 ? "JP¥137" : "−JP¥1,200",
          ),
        ).toBeInTheDocument();
        if (balance > 0) {
          expect(screen.getByText("信用卡溢繳餘額")).toBeInTheDocument();
          expect(screen.getByText("溢繳餘額，無需繳款")).toBeInTheDocument();
        }
      }
    },
  );

  it("shows the latest bill deadline and each Mega Bank bill's payment status", () => {
    const summary = calculateAssetSummary({
      bank: {
        accounts: [
          {
            id: "card",
            sourceId: "megabank:credit:TWD",
            connectorId: "megabank",
            accountType: "credit",
            currency: "TWD",
            balance: 0,
            accountName: "兆豐信用卡（TWD）",
            paymentDueDate: "2026-11-07",
          },
        ],
        transactions: [],
      },
      investments: [],
      manualAssets: [],
    });
    render(InstitutionDetails, {
      group: summary.institutionGroups[0],
      bills: [
        {
          id: "sep",
          connectorId: "megabank",
          accountId: "card",
          sourceId: "sep",
          billingPeriod: "2026-09",
          statementAmount: 111,
          isPaid: 1,
          paymentDueDate: "2026-10-07",
          currency: "TWD",
        },
        {
          id: "aug",
          connectorId: "megabank",
          accountId: "card",
          sourceId: "aug",
          billingPeriod: "2026-08",
          statementAmount: 111,
          isPaid: 0,
          paymentDueDate: "2026-09-06",
          currency: "TWD",
        },
        {
          id: "jul",
          connectorId: "megabank",
          accountId: "card",
          sourceId: "jul",
          billingPeriod: "2026-07",
          statementAmount: 0,
          isPaid: 1,
          paymentDueDate: "2026-08-06",
          currency: "TWD",
        },
      ],
    });
    expect(
      screen.getByText(/最近帳單已繳 · 期限 2026\/10\/7/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/最近帳單已繳 · 期限 2026\/11\/7/),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/2026-09.*已繳/)).toBeInTheDocument();
    expect(screen.getByText(/2026-08.*待繳/)).toBeInTheDocument();
    expect(screen.getByText(/2026-07.*無需繳款/)).toBeInTheDocument();
    expect(screen.queryByText("繳款期限尚未提供")).not.toBeInTheDocument();
  });

  it("does not pair a paid bill with the card's different due date", () => {
    const summary = calculateAssetSummary({
      bank: {
        accounts: [
          {
            id: "card",
            sourceId: "megabank:credit:TWD",
            connectorId: "megabank",
            accountType: "credit",
            currency: "TWD",
            balance: 0,
            paymentDueDate: "2026-11-07",
          },
        ],
        transactions: [],
      },
      investments: [],
      manualAssets: [],
    });
    render(InstitutionDetails, {
      group: summary.institutionGroups[0],
      bills: [
        {
          id: "sep",
          connectorId: "megabank",
          accountId: "card",
          sourceId: "sep",
          billingPeriod: "2026-09",
          statementAmount: 111,
          isPaid: 1,
          currency: "TWD",
        },
      ],
    });
    expect(screen.getByText("最近帳單已繳")).toBeInTheDocument();
    expect(screen.queryByText(/最近帳單已繳 · 期限/)).not.toBeInTheDocument();
  });
});
