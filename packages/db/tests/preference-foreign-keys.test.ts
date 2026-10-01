import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_splitSqlQuery } from "wrangler";
import { createTestD1, readMigrations } from "../testing/d1";

const migration = readFileSync(
  new URL("../migrations/0045_preference_foreign_keys.sql", import.meta.url),
  "utf8",
);
const migrations = readMigrations();
const previous = migrations.slice(0, migrations.indexOf(migration));
const account =
  "INSERT INTO bank_accounts (id, connector_id, source_id, created_at, updated_at) VALUES ('account', 'test', 'account', 'created', 'updated')";
const transaction = (id: string) =>
  `INSERT INTO bank_transactions (id, connector_id, account_id, source_id, amount, created_at, updated_at) VALUES ('${id}', 'test', 'account', '${id}', 100, 'created', 'updated')`;
const invoice = (id: string) =>
  `INSERT INTO invoices (id, connector_id, source_id, invoice_date, amount, created_at, updated_at) VALUES ('${id}', 'test', '${id}', '2026-09-13', 100, 'created', 'updated')`;
const bankPreference =
  "INSERT INTO bank_transaction_preferences VALUES ('transaction', 1, 'created', 'updated')";
const linked =
  "INSERT INTO invoice_transaction_preferences VALUES ('linked', 'transaction', 'linked', 'created', 'updated')";
const separate =
  "INSERT INTO invoice_transaction_preferences VALUES ('separate', NULL, 'separate', 'created', 'updated')";
function apply(db: D1Database) {
  return db.batch(
    unstable_splitSqlQuery(migration).map((sql) => db.prepare(sql)),
  );
}
async function preferences(db: D1Database) {
  return Promise.all([
    db
      .prepare(
        "SELECT * FROM bank_transaction_preferences ORDER BY transaction_id",
      )
      .all(),
    db
      .prepare(
        "SELECT * FROM invoice_transaction_preferences ORDER BY invoice_id",
      )
      .all(),
  ]).then((results) => results.map((result) => result.results));
}

describe("preference foreign keys on D1", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  beforeAll(async () => {
    harness = await createTestD1(undefined, previous);
  }, 60_000);
  afterAll(async () => {
    await harness?.mf.dispose();
  });

  it("upgrades populated tables, protects decisions, and allows explicit reassignment", async () => {
    const db = harness.binding;
    await db.batch(
      [
        account,
        transaction("transaction"),
        invoice("linked"),
        invoice("separate"),
        bankPreference,
        linked,
        separate,
      ].map((sql) => db.prepare(sql)),
    );
    const before = await preferences(db);
    await apply(db);
    expect(await preferences(db)).toEqual(before);
    for (const sql of [
      "INSERT INTO bank_transaction_preferences VALUES ('missing', 0, 't', 't')",
      "INSERT INTO invoice_transaction_preferences VALUES ('missing', NULL, 'separate', 't', 't')",
      "UPDATE invoice_transaction_preferences SET transaction_id = 'missing' WHERE invoice_id = 'linked'",
      "DELETE FROM bank_transactions WHERE id = 'transaction'",
      "DELETE FROM invoices WHERE id = 'linked'",
      "DELETE FROM invoices WHERE id = 'separate'",
      "UPDATE invoice_transaction_preferences SET transaction_id = NULL WHERE invoice_id = 'linked'",
    ])
      await expect(db.prepare(sql).run()).rejects.toThrow(/constraint/i);
    expect(await preferences(db)).toEqual(before);
    await db.prepare(invoice("second")).run();
    await expect(
      db
        .prepare(
          "INSERT INTO invoice_transaction_preferences VALUES ('second', 'transaction', 'linked', 't', 't')",
        )
        .run(),
    ).rejects.toThrow(/UNIQUE/i);
    // The old transaction can only be removed after both references move.
    await db.batch(
      [
        transaction("replacement"),
        "UPDATE bank_transaction_preferences SET transaction_id = 'replacement' WHERE transaction_id = 'transaction'",
        "UPDATE invoice_transaction_preferences SET transaction_id = 'replacement' WHERE transaction_id = 'transaction'",
        "DELETE FROM bank_transactions WHERE id = 'transaction'",
      ].map((sql) => db.prepare(sql)),
    );
    expect((await preferences(db))[1]).toEqual([
      {
        invoice_id: "linked",
        transaction_id: "replacement",
        decision: "linked",
        created_at: "created",
        updated_at: "updated",
      },
      {
        invoice_id: "separate",
        transaction_id: null,
        decision: "separate",
        created_at: "created",
        updated_at: "updated",
      },
    ]);
    expect(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
  });
});

it.each(["bank", "invoice", "transaction"])(
  "rolls back the entire migration for an orphan %s reference without losing preferences",
  async (orphan) => {
    const harness = await createTestD1(undefined, previous);
    try {
      const db = harness.binding;
      await db.batch(
        [
          account,
          transaction("transaction"),
          invoice("linked"),
          bankPreference,
          linked,
        ].map((sql) => db.prepare(sql)),
      );
      await db
        .prepare(
          orphan === "bank"
            ? "UPDATE bank_transaction_preferences SET transaction_id = 'missing'"
            : orphan === "invoice"
              ? "UPDATE invoice_transaction_preferences SET invoice_id = 'missing'"
              : "UPDATE invoice_transaction_preferences SET transaction_id = 'missing'",
        )
        .run();
      const before = await preferences(db);
      await expect(apply(db)).rejects.toThrow(/FOREIGN KEY/i);
      expect(await preferences(db)).toEqual(before);
      expect(
        (
          await db
            .prepare(
              "SELECT name FROM sqlite_schema WHERE name IN ('bank_transaction_preferences_new', 'invoice_transaction_preferences_new')",
            )
            .all()
        ).results,
      ).toEqual([]);
      expect(
        (
          await db
            .prepare("PRAGMA foreign_key_list(bank_transaction_preferences)")
            .all()
        ).results,
      ).toEqual([]);
    } finally {
      await harness.mf.dispose();
    }
  },
  60_000,
);
