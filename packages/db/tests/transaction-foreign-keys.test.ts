import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { unstable_splitSqlQuery } from "wrangler";
import { createTestD1, readMigrations } from "../testing/d1";
const migration = readFileSync(
  new URL(
    "../migrations/0046_transaction_self_foreign_keys.sql",
    import.meta.url,
  ),
  "utf8",
);
const all = readMigrations();
const previous = all.slice(0, all.indexOf(migration));
async function snapshot(db: D1Database) {
  return Promise.all(
    [
      "bank_transactions",
      "bank_transaction_preferences",
      "invoice_transaction_preferences",
    ].map(
      async (t) =>
        (await db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()).results,
    ),
  );
}
it.each(["valid", "transfer_peer_id", "matched_transaction_id"])(
  "upgrades transaction references atomically: %s",
  async (mode) => {
    const h = await createTestD1(undefined, previous);
    try {
      const db = h.binding;
      await db.batch(
        [
          "INSERT INTO bank_accounts (id,connector_id,source_id,created_at,updated_at) VALUES ('a','test','a','t','t')",
          "INSERT INTO bank_transactions (id,connector_id,account_id,source_id,amount,status,transfer_peer_id,matched_transaction_id,created_at,updated_at) VALUES ('parent','test','a','parent',1,'posted',NULL,NULL,'t','t'),('pending','test','a','pending',1,'pending',NULL,'parent','t','t'),('deposit','test','a','deposit',-1,'posted','parent',NULL,'t','t'),('self','test','a','self',1,'posted',NULL,'self','t','t')",
          "INSERT INTO invoices (id,connector_id,source_id,invoice_date,amount,created_at,updated_at) VALUES ('linked','test','linked','2026-09-13',1,'t','t'),('separate','test','separate','2026-09-13',1,'t','t')",
          "INSERT INTO bank_transaction_preferences VALUES ('parent',1,'created','updated')",
          "INSERT INTO invoice_transaction_preferences VALUES ('linked','parent','linked','created','updated'),('separate',NULL,'separate','created','updated')",
        ].map((s) => db.prepare(s)),
      );
      if (mode !== "valid")
        await db
          .prepare(
            `UPDATE bank_transactions SET ${mode}='missing' WHERE id='deposit'`,
          )
          .run();
      const before = await snapshot(db);
      const apply = () =>
        db.batch(unstable_splitSqlQuery(migration).map((s) => db.prepare(s)));
      if (mode !== "valid") {
        await expect(apply()).rejects.toThrow(/FOREIGN KEY/);
        expect(await snapshot(db)).toEqual(before);
        expect(
          (
            await db
              .prepare(
                "SELECT name FROM sqlite_schema WHERE name LIKE '_0046_%' OR name='bank_transactions_new'",
              )
              .all()
          ).results,
        ).toEqual([]);
        return;
      }
      await apply();
      expect(await snapshot(db)).toEqual(before);
      for (const column of ["transfer_peer_id", "matched_transaction_id"]) {
        await expect(
          db
            .prepare(
              `UPDATE bank_transactions SET ${column}='missing' WHERE id='deposit'`,
            )
            .run(),
        ).rejects.toThrow(/FOREIGN KEY/);
      }
      // Remove preference references to prove the self-FKs themselves block deletion.
      await db.batch([
        db.prepare("DELETE FROM bank_transaction_preferences"),
        db.prepare(
          "DELETE FROM invoice_transaction_preferences WHERE invoice_id='linked'",
        ),
      ]);
      await expect(
        db.prepare("DELETE FROM bank_transactions WHERE id='parent'").run(),
      ).rejects.toThrow(/FOREIGN KEY/);
      expect(
        (await db.prepare("PRAGMA foreign_key_check").all()).results,
      ).toEqual([]);
      expect(
        (await db.prepare("PRAGMA foreign_key_list(bank_transactions)").all())
          .results,
      ).toHaveLength(3);
    } finally {
      await h.mf.dispose();
    }
  },
  60000,
);
