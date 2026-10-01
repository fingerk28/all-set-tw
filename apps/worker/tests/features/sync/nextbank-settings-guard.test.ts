import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  compareAndSetConnectorSecret,
  connectorSettingsGuardStatement,
} from "../../../src/features/sync/repository";

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    "CREATE TABLE connector_settings(connector_id TEXT PRIMARY KEY, encrypted_config TEXT, updated_at TEXT); CREATE TABLE promoted(value TEXT);",
  );
  sqlite
    .prepare("INSERT INTO connector_settings VALUES(?, ?, ?)")
    .run("nextbank", "old-ciphertext", "version-1");
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: Array<string | number | null>) {
          return {
            async run() {
              return {
                meta: {
                  changes: Number(sqlite.prepare(sql).run(...values).changes),
                },
              };
            },
            async all() {
              return { results: sqlite.prepare(sql).all(...values) };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { sqlite, db };
}

describe("Nextbank configuration concurrency", () => {
  it("consumes a challenge once and refuses to overwrite newer credentials", async () => {
    const { sqlite, db } = fixture();
    try {
      const previous = {
        encrypted_config: "old-ciphertext",
        updated_at: "version-1",
      };
      await compareAndSetConnectorSecret(
        db,
        "nextbank",
        previous,
        "cleared-ciphertext",
        "version-2",
      );
      await expect(
        compareAndSetConnectorSecret(
          db,
          "nextbank",
          previous,
          "stale-ciphertext",
          "version-3",
        ),
      ).rejects.toThrow("設定已變更");
      expect(
        sqlite.prepare("SELECT encrypted_config FROM connector_settings").get()
          ?.encrypted_config,
      ).toBe("cleared-ciphertext");
    } finally {
      sqlite.close();
    }
  });

  it("aborts an atomic promotion transaction when settings changed", async () => {
    const { sqlite, db } = fixture();
    try {
      await connectorSettingsGuardStatement(
        db,
        "nextbank",
        "old-ciphertext",
        "version-1",
      ).all();
      sqlite
        .prepare("UPDATE connector_settings SET encrypted_config = ?")
        .run("new-credentials");
      sqlite.exec("BEGIN");
      try {
        sqlite.exec("INSERT INTO promoted VALUES('must-roll-back')");
        await connectorSettingsGuardStatement(
          db,
          "nextbank",
          "old-ciphertext",
          "version-1",
        ).all();
        throw new Error("guard failed to reject stale settings");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        expect(String(error)).toContain("malformed JSON");
      }
      expect(
        sqlite.prepare("SELECT COUNT(*) AS count FROM promoted").get()?.count,
      ).toBe(0);
    } finally {
      sqlite.close();
    }
  });
});
