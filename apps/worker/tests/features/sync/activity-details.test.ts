import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createTestD1 } from "../../../../../packages/db/testing/d1";
import {
  beginActivityRun,
  getReportActivityDetails,
  saveActivityDetails,
} from "../../../src/features/sync/activity-detail-repository";
import { materializeActivityReport } from "../../../src/features/sync/activity-detail-service";
import {
  persistStagedSyncWrite,
  type SyncWriteRecord,
} from "../../../src/features/sync/persistence";
import {
  recordDefaultScheduleBatchResult,
  finalizeOpenDefaultScheduleBatch,
} from "../../../src/features/sync/notification-batch-repository";
import { recoverLatestScheduledSyncSource } from "../../../src/features/sync/report-repository";
import { syncScheduleRoutes } from "../../../src/features/sync/schedule-route";

const now = "2026-09-15T06:00:00.000Z";
const counts = { invoices: 0, bankTransactions: 0, investmentTransactions: 0 };
function transaction(id: string, status = "pending"): SyncWriteRecord {
  return {
    entityType: "bank_transaction",
    recordKey: id,
    payload: {
      id,
      connector_id: "sinopac",
      account_id: "card",
      source_id: id,
      authorized_at: "2026-09-01",
      posted_date: "2026-09-03",
      amount: -358,
      currency: "TWD",
      description: "全聯福利中心",
      counterparty: "全聯福利中心",
      status,
      raw_payload: "{}",
      created_at: now,
      updated_at: now,
    },
  };
}
function invoice(id: string): SyncWriteRecord {
  return {
    entityType: "invoice",
    recordKey: id,
    payload: {
      id,
      connector_id: "einvoice",
      source_id: id,
      invoice_number: "AA12345678",
      invoice_date: "2026-09-01",
      seller_name: "全聯",
      amount: 358,
      raw_payload: "{}",
      created_at: now,
      updated_at: now,
    },
  };
}

async function sourceDetails(
  target: D1Database,
  batchId: string,
  connectorId: "sinopac" | "einvoice",
) {
  return (await getReportActivityDetails(target, batchId))?.[connectorId];
}

describe("同步活動明細：隔離 D1", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  let db: D1Database;
  beforeAll(async () => {
    harness = await createTestD1();
    db = harness.binding as unknown as D1Database;
  }, 60000);
  afterAll(async () => {
    await harness?.mf.dispose();
  });
  beforeEach(async () => {
    await db.batch([
      ...[
        "scheduled_sync_batches",
        "invoice_transaction_preferences",
        "invoices",
        "bank_transactions",
        "bank_accounts",
      ].map((t) => db.prepare(`DELETE FROM ${t}`)),
      db.prepare(`UPDATE sync_jobs SET locked_by = NULL`),
      db
        .prepare(
          `INSERT INTO bank_accounts (id, connector_id, source_id, account_type, institution_name, account_name, created_at, updated_at) VALUES ('card', 'sinopac', 'card', 'credit', '永豐銀行', 'DAWAY', ?, ?)`,
        )
        .bind(now, now),
    ]);
    await batch("batch");
  });
  async function batch(id: string) {
    await db.batch([
      db
        .prepare(
          `INSERT INTO scheduled_sync_batches (id, created_at, completed_at, notification_claimed_at) VALUES (?, ?, ?, ?)`,
        )
        .bind(id, now, now, now),
      ...["sinopac", "einvoice"].map((connector) =>
        db
          .prepare(
            `INSERT INTO scheduled_sync_batch_results (batch_id, job_id, connector_id) VALUES (?, ?, ?)`,
          )
          .bind(id, `${connector}:all`, connector),
      ),
    ]);
  }
  async function start(id: string, connector = "sinopac", batchId = "batch") {
    await beginActivityRun(db, id, batchId, connector);
    await db
      .prepare(
        `UPDATE sync_jobs SET locked_by = ? WHERE connector_id = ? AND scope = 'all'`,
      )
      .bind(id, connector)
      .run();
  }
  async function finish(
    id: string,
    connector: "sinopac" | "einvoice" = "sinopac",
    batchId = "batch",
  ) {
    await recordDefaultScheduleBatchResult(db, {
      batchId,
      jobId: `${connector}:all`,
      notification: { connectorId: connector, status: "success" },
      newRecords: counts,
      runId: id,
    });
  }
  it("補抓舊消費並凍結報告；相同資料重抓不會標成新活動", async () => {
    await start("run1");
    const newRecords = await persistStagedSyncWrite(db, {
      records: [transaction("t1")],
    });
    expect(newRecords.bankTransactions).toBe(1);
    await finish("run1");
    await materializeActivityReport(db, "batch");
    const first = await sourceDetails(db, "batch", "sinopac");
    expect(first?.items).toHaveLength(1);
    expect(first?.items[0]).toMatchObject({
      date: "2026-09-01",
      title: "全聯福利中心",
      amount: -358,
      changes: ["added"],
    });
    await batch("batch2");
    await start("run2", "sinopac", "batch2");
    expect(
      (await persistStagedSyncWrite(db, { records: [transaction("t1")] }))
        .bankTransactions,
    ).toBe(0);
    await finish("run2", "sinopac", "batch2");
    await materializeActivityReport(db, "batch2");
    expect((await sourceDetails(db, "batch2", "sinopac"))?.items).toEqual([]);
    await db
      .prepare(
        `UPDATE bank_transactions SET description = '後來的新名稱', amount = -999`,
      )
      .run();
    expect(await sourceDetails(db, "batch", "sinopac")).toEqual(first);
  });
  it("不同 ID 入帳與同 ID 入帳都只呈現入帳變動", async () => {
    await persistStagedSyncWrite(db, {
      records: [transaction("pending"), transaction("same")],
    });
    await start("run");
    await persistStagedSyncWrite(db, {
      records: [transaction("posted", "posted"), transaction("same", "posted")],
      afterPromoteStatements: [
        db.prepare(
          `UPDATE bank_transactions SET matched_transaction_id = 'posted' WHERE id = 'pending'`,
        ),
      ],
    });
    await finish("run");
    await materializeActivityReport(db, "batch");
    const page = await sourceDetails(db, "batch", "sinopac");
    expect(page?.items).toHaveLength(2);
    expect(page?.items.map((i) => i.changes)).toEqual([["posted"], ["posted"]]);
  });
  it("同批新增交易與發票合併；後續新增發票標示補上發票", async () => {
    await start("bank");
    await persistStagedSyncWrite(db, { records: [transaction("t1")] });
    await finish("bank");
    await start("invoice", "einvoice");
    await persistStagedSyncWrite(db, { records: [invoice("i1")] });
    await finish("invoice", "einvoice");
    await materializeActivityReport(db, "batch");
    const bank = await sourceDetails(db, "batch", "sinopac");
    const invoices = await sourceDetails(db, "batch", "einvoice");
    expect(bank?.items).toHaveLength(1);
    expect(bank?.items[0].invoiceId).toBe("i1");
    expect(invoices?.items).toHaveLength(1);
    expect(invoices?.items[0].id).toBe(bank?.items[0].id);
    expect(invoices?.items[0].changes).toEqual(["added", "invoice_linked"]);
    await batch("batch2");
    await db.prepare(`DELETE FROM invoices`).run();
    await start("invoice2", "einvoice", "batch2");
    await persistStagedSyncWrite(db, { records: [invoice("i2")] });
    await finish("invoice2", "einvoice", "batch2");
    await materializeActivityReport(db, "batch2");
    expect(
      (await sourceDetails(db, "batch2", "einvoice"))?.items[0].changes,
    ).toEqual(["invoice_linked"]);
  });
  it("promotion 失敗時資料與明細一起回滾，重試不重複", async () => {
    await start("run");
    await expect(
      persistStagedSyncWrite(db, {
        records: [transaction("t1")],
        finalizeStatements: [
          db.prepare(`INSERT INTO bank_transactions (id) VALUES ('invalid')`),
        ],
      }),
    ).rejects.toThrow();
    expect(
      (
        await db
          .prepare(`SELECT COUNT(*) AS n FROM sync_activity_changes`)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    await persistStagedSyncWrite(db, { records: [transaction("t1")] });
    await persistStagedSyncWrite(db, { records: [transaction("t1")] });
    await finish("run");
    await materializeActivityReport(db, "batch");
    await materializeActivityReport(db, "batch");
    expect((await sourceDetails(db, "batch", "sinopac"))?.items).toHaveLength(
      1,
    );
  });
  it("手動補救只發佈指定失敗報告的執行，重複補救不累加", async () => {
    await db
      .prepare(
        `UPDATE scheduled_sync_batch_results SET status = 'failed', completed_at = ? WHERE batch_id = 'batch' AND connector_id = 'sinopac'`,
      )
      .bind(now)
      .run();
    await start("recovery");
    await persistStagedSyncWrite(db, { records: [transaction("t1")] });
    expect((await sourceDetails(db, "batch", "sinopac"))?.items).toEqual([]);
    const input = {
      connectorId: "sinopac" as const,
      batchId: "batch",
      runId: "recovery",
      newRecords: { ...counts, bankTransactions: 1 },
    };
    expect(await recoverLatestScheduledSyncSource(db, input)).toBe(true);
    expect(await recoverLatestScheduledSyncSource(db, input)).toBe(false);
    expect((await sourceDetails(db, "batch", "sinopac"))?.items).toHaveLength(
      1,
    );
  });
  it("補救 CAS 落敗時，即使完成時間相同也不發布該 run", async () => {
    await db
      .prepare(
        `UPDATE scheduled_sync_batch_results SET status = 'failed', completed_at = ? WHERE batch_id = 'batch' AND connector_id = 'sinopac'`,
      )
      .bind(now)
      .run();
    await start("loser");
    const originalBatch = db.batch.bind(db);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-16T06:00:00.000Z"));
    const racingDb = {
      prepare: db.prepare.bind(db),
      batch: async (statements: D1PreparedStatement[]) => {
        // Another recovery wins after selection, in the same millisecond.
        await db
          .prepare(
            `UPDATE scheduled_sync_batch_results SET status = 'success', recovered_at = ? WHERE batch_id = 'batch' AND connector_id = 'sinopac'`,
          )
          .bind(new Date().toISOString())
          .run();
        return originalBatch(statements);
      },
    } as D1Database;
    try {
      expect(
        await recoverLatestScheduledSyncSource(racingDb, {
          connectorId: "sinopac",
          batchId: "batch",
          runId: "loser",
          newRecords: counts,
        }),
      ).toBe(false);
      expect(
        await db
          .prepare(
            "SELECT published FROM sync_activity_runs WHERE id = 'loser'",
          )
          .first(),
      ).toEqual({ published: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
  it("較晚完成的投影不得改動已凍結的明細", async () => {
    await start("run");
    await persistStagedSyncWrite(db, { records: [transaction("t1")] });
    await finish("run");
    await materializeActivityReport(db, "batch");
    const before = await sourceDetails(db, "batch", "sinopac");
    await saveActivityDetails(db, "run", [
      { ...before!.items[0]!, title: "不同投影" },
      { ...before!.items[0]!, id: "bank:extra" },
    ]);
    expect(await sourceDetails(db, "batch", "sinopac")).toEqual(before);
  });
  it("一次回傳報告全部來源明細，舊報告不推算，API 驗證參數", async () => {
    expect((await sourceDetails(db, "batch", "sinopac"))?.availability).toBe(
      "legacy",
    );
    expect(await getReportActivityDetails(db, "missing")).toBeNull();
    await start("run");
    await persistStagedSyncWrite(db, {
      records: Array.from({ length: 35 }, (_, i) => transaction(`t${i}`)),
    });
    await finish("run");
    await materializeActivityReport(db, "batch");
    const page = await sourceDetails(db, "batch", "sinopac");
    expect(page?.items).toHaveLength(35);
    expect(new Set(page!.items.map((item) => item.id)).size).toBe(35);
    const report = await syncScheduleRoutes.request(
      "/sync-reports/batch/activities",
      {},
      { DB: db },
    );
    expect(report.status).toBe(200);
    expect(
      ((await report.json()) as { sources: { sinopac: { items: unknown[] } } })
        .sources.sinopac.items,
    ).toHaveLength(35);
    const missing = await syncScheduleRoutes.request(
      "/sync-reports/missing/activities",
      {},
      { DB: db },
    );
    expect(missing.status).toBe(404);
  });
  it("整理失敗不顯示部分明細，下一次 scheduler 可重試", async () => {
    await start("retry");
    await persistStagedSyncWrite(db, { records: [transaction("t1")] });
    await finish("retry");
    await db
      .prepare(
        "CREATE TRIGGER reject_projection BEFORE INSERT ON sync_activity_details BEGIN SELECT RAISE(ABORT, 'projection failure'); END",
      )
      .run();
    try {
      await expect(materializeActivityReport(db, "batch")).rejects.toThrow();
    } finally {
      await db.prepare("DROP TRIGGER reject_projection").run();
    }
    expect((await sourceDetails(db, "batch", "sinopac"))?.availability).toBe(
      "pending",
    );
    await finalizeOpenDefaultScheduleBatch(db);
    expect((await sourceDetails(db, "batch", "sinopac"))?.items).toHaveLength(
      1,
    );
  });
  it("來源完成時間固定版本，不混入後來的補救執行", async () => {
    await start("original");
    await persistStagedSyncWrite(db, { records: [transaction("t1")] });
    await finish("original");
    await materializeActivityReport(db, "batch");
    const before = await sourceDetails(db, "batch", "sinopac");
    await beginActivityRun(db, "later", "batch", "sinopac");
    await db
      .prepare(
        "UPDATE sync_activity_runs SET created_at = '2099-01-01T00:00:00.000Z', published = 1 WHERE id = 'later'",
      )
      .run();
    expect(await sourceDetails(db, "batch", "sinopac")).toEqual(before);
  });
});
