import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { JobRecord } from "./core/jobs.js";
import { HpcError } from "./core/types.js";

export type TransferRecord = {
  id: string;
  server: string;
  direction: "upload" | "download";
  items: { source: string; targetDir: string }[];
  state: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  owner: string;
  bytes: number;
  totalBytes: number;
  itemIndex: number;
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  error?: string;
  cancelRequested?: boolean;
};
export class StateStore {
  private readonly db: DatabaseSync;
  constructor(
    path: string,
    private readonly scope: string,
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
    );
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS records(scope TEXT,kind TEXT,id TEXT,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(scope,kind,id));
      CREATE TABLE IF NOT EXISTS leases(scope TEXT,key TEXT,owner TEXT,until_ms INTEGER,PRIMARY KEY(scope,key));
      PRAGMA user_version=1;`);
  }
  private read<T>(kind: string, id: string): T | undefined {
    const row = this.db
      .prepare(
        "SELECT data,version FROM records WHERE scope=? AND kind=? AND id=?",
      )
      .get(this.scope, kind, id);
    return row
      ? { ...JSON.parse(String(row.data)), revision: Number(row.version) }
      : undefined;
  }
  private list<T>(kind: string): T[] {
    return this.db
      .prepare(
        "SELECT data,version FROM records WHERE scope=? AND kind=? ORDER BY id",
      )
      .all(this.scope, kind)
      .map((row) => ({
        ...JSON.parse(String(row.data)),
        revision: Number(row.version),
      }));
  }
  private put(
    kind: string,
    id: string,
    value: object,
    revision?: number,
  ): number {
    if (revision === undefined) {
      this.db
        .prepare("INSERT INTO records(scope,kind,id,data) VALUES(?,?,?,?)")
        .run(this.scope, kind, id, JSON.stringify(value));
      return 1;
    }
    const r = this.db
      .prepare(
        "UPDATE records SET data=?,version=version+1 WHERE scope=? AND kind=? AND id=? AND version=?",
      )
      .run(JSON.stringify(value), this.scope, kind, id, revision);
    if (!r.changes)
      throw new HpcError(
        "State changed concurrently; read its latest status and retry",
        "STATE_CONFLICT",
      );
    return revision + 1;
  }
  getJob(id: string): JobRecord | undefined {
    return this.read("job", id);
  }
  listJobs(server?: string): JobRecord[] {
    return this.list<JobRecord>("job")
      .filter((r) => !server || r.server === server)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  saveJob(record: JobRecord): void {
    record.revision = this.put("job", record.id, record, record.revision);
  }
  getTransfer(id: string): TransferRecord | undefined {
    return this.read("transfer", id);
  }
  listTransfers(): TransferRecord[] {
    return this.list("transfer");
  }
  saveTransfer(record: TransferRecord): void {
    const revision = (record as TransferRecord & { revision?: number })
      .revision;
    Object.assign(record, {
      revision: this.put("transfer", record.id, record, revision),
    });
  }
  updateTransfer(
    id: string,
    edit: (r: TransferRecord) => void,
  ): TransferRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = this.getTransfer(id);
      if (!r)
        throw new HpcError(`Unknown transfer ${id}`, "TRANSFER_NOT_FOUND");
      edit(r);
      this.saveTransfer(r);
      this.db.exec("COMMIT");
      return r;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  isLeased(key: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM leases WHERE scope=? AND key=? AND until_ms>?")
        .get(this.scope, key, Date.now()),
    );
  }
  lease(key: string, owner: string, ttl = 120000): boolean {
    return Boolean(
      this.db
        .prepare(
          `INSERT INTO leases VALUES(?,?,?,?) ON CONFLICT(scope,key) DO UPDATE SET owner=excluded.owner,until_ms=excluded.until_ms
      WHERE leases.owner=excluded.owner OR leases.until_ms<?`,
        )
        .run(this.scope, key, owner, Date.now() + ttl, Date.now()).changes,
    );
  }
  leaseAlive(key: string, owner: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM leases WHERE scope=? AND key=? AND owner=? AND until_ms>?",
        )
        .get(this.scope, key, owner, Date.now()),
    );
  }
  release(key: string, owner: string): void {
    this.db
      .prepare("DELETE FROM leases WHERE scope=? AND key=? AND owner=?")
      .run(this.scope, key, owner);
  }
  close(): void {
    this.db.close();
  }
}
