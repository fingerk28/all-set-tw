import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestD1 } from "../../../../../packages/db/testing/d1";
import {
  findMappingTransaction,
  listInvoiceTransactionPreferences,
} from "../../../src/features/activity/repository";

describe("activity repository on D1", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  beforeAll(async () => {
    harness = await createTestD1();
    const db = harness.binding;
    await db
      .prepare(
        "INSERT INTO bank_accounts (id, connector_id, source_id, account_type, created_at, updated_at) VALUES ('card', 'test', 'card', 'credit', 't', 't')",
      )
      .run();
    for (const [id, status, matched] of [
      ["posted", "posted", null],
      ["pending", "pending", null],
      ["matched-pending", "pending", "posted"],
      ["matched-posted", "posted", "matched-posted"],
    ] as const) {
      await db
        .prepare(
          "INSERT INTO bank_transactions (id, connector_id, source_id, account_id, posted_date, amount, currency, status, matched_transaction_id, created_at, updated_at) VALUES (?, 'test', ?, 'card', '2026-07-13', -35, 'TWD', ?, ?, 't', 't')",
        )
        .bind(id, id, status, matched)
        .run();
    }
    for (const id of [
      "posted",
      "pending",
      "matched-pending",
      "matched-posted",
      "separate",
    ]) {
      await db.batch([
        db
          .prepare(
            "INSERT INTO invoices (id, connector_id, source_id, invoice_date, amount, created_at, updated_at) VALUES (?, 'einvoice', ?, '2026-07-13', 35, 'created', 'updated')",
          )
          .bind(id, id),
        db
          .prepare(
            "INSERT INTO invoice_transaction_preferences VALUES (?, ?, ?, 'created', 'updated')",
          )
          .bind(
            id,
            id === "separate" ? null : id,
            id === "separate" ? "separate" : "linked",
          ),
      ]);
    }
  }, 60_000);
  afterAll(async () => {
    await harness?.mf.dispose();
  });

  it("loads mapping aliases and excludes only matched pending transactions", async () => {
    for (const id of ["posted", "pending", "matched-posted"]) {
      expect(await findMappingTransaction(harness.binding, id)).toEqual({
        id,
        postedDate: "2026-07-13",
        authorizedAt: null,
        amount: -35,
        currency: "TWD",
        accountType: "credit",
      });
    }
    expect(
      await findMappingTransaction(harness.binding, "matched-pending"),
    ).toBeNull();
    expect(await findMappingTransaction(harness.binding, "missing")).toBeNull();
  });

  it("keeps separate NULL preferences and filters only the correlated matched pending row", async () => {
    expect(await listInvoiceTransactionPreferences(harness.binding)).toEqual(
      ["matched-posted", "pending", "posted", "separate"].map((id) => ({
        invoiceId: id,
        transactionId: id === "separate" ? null : id,
        decision: id === "separate" ? "separate" : "linked",
        createdAt: "created",
        updatedAt: "updated",
      })),
    );
  });
});
