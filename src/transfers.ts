import { randomUUID } from "node:crypto";
import { basename, join, posix } from "node:path";
import type { CoreContext } from "./core/context.js";
import type { ConnectionPool } from "./core/pool.js";
import type { ServerSpec } from "./core/types.js";
import { HpcError } from "./core/types.js";
import {
  uploadWithResume,
  downloadWithResume,
  type TransferResult,
} from "./core/transfer.js";
import type { StateStore, TransferRecord } from "./state.js";

export type TransferItem = { source: string; targetDir: string };
export type TransferSpec = {
  direction: "upload" | "download";
  items: TransferItem[];
  overwrite?: boolean;
  chunkSize?: number;
  continueOnError?: boolean;
};
export function transferPaths(
  direction: "upload" | "download",
  item: TransferItem,
): { localPath: string; remotePath: string } {
  return direction === "upload"
    ? {
        localPath: item.source,
        remotePath: posix.join(
          item.targetDir,
          posix.basename(item.source.replaceAll("\\", "/")),
        ),
      }
    : {
        remotePath: item.source,
        localPath: join(item.targetDir, posix.basename(item.source)),
      };
}
export class TransferManager {
  private readonly active = new Map<
    string,
    { controller: AbortController; done: Promise<void>; server: string }
  >();
  constructor(
    private readonly ctx: CoreContext,
    private readonly pool: ConnectionPool,
    readonly owner: string,
    private readonly redact: (text: string) => string = (x) => x,
  ) {}
  private get store(): StateStore {
    return this.ctx.store;
  }
  start(server: ServerSpec, spec: TransferSpec): TransferRecord {
    const stamp = new Date().toISOString();
    const record: TransferRecord = {
      id: `transfer-${randomUUID()}`,
      server: server.id,
      direction: spec.direction,
      items: spec.items,
      state: "running",
      owner: this.owner,
      bytes: 0,
      totalBytes: 0,
      itemIndex: 0,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.store.lease(`transfer:${record.id}`, this.owner, 15000);
    this.store.saveTransfer(record);
    const controller = new AbortController();
    const done = Promise.resolve().then(() =>
      this.run(server, spec, record.id, controller),
    );
    this.active.set(record.id, { controller, done, server: server.id });
    void done
      .finally(() => this.active.delete(record.id))
      .catch(() => undefined);
    return record;
  }
  private async run(
    server: ServerSpec,
    spec: TransferSpec,
    id: string,
    controller: AbortController,
  ): Promise<void> {
    const locks: string[] = [],
      results: {
        source: string;
        ok: boolean;
        result?: TransferResult;
        error?: string;
      }[] = [];
    let interrupted = false;
    const heartbeat = setInterval(() => {
      try {
        this.store.lease(`transfer:${id}`, this.owner, 15000);
        for (const key of locks)
          if (!this.store.lease(key, id)) controller.abort();
        if (this.store.getTransfer(id)?.cancelRequested) controller.abort();
      } catch {
        controller.abort();
      }
    }, 500);
    heartbeat.unref();
    this.pool.hold(server.id);
    try {
      const { client } = await this.pool.ensure(this.ctx, server);
      let completedBytes = 0;
      for (let index = 0; index < spec.items.length; index++) {
        if (controller.signal.aborted) break;
        const item = spec.items[index]!,
          paths = transferPaths(spec.direction, item);
        const key = `destination:${spec.direction}:${spec.direction === "upload" ? server.id + ":" + paths.remotePath : paths.localPath}`;
        if (!this.store.lease(key, id))
          throw new HpcError(
            "Another transfer owns this destination",
            "TRANSFER_BUSY",
          );
        locks.push(key);
        try {
          const options = {
            overwrite: spec.overwrite ?? false,
            signal: controller.signal,
            chunkSize: spec.chunkSize,
            onProgress: (bytes: number, total: number) => {
              this.store.updateTransfer(id, (r) => {
                r.itemIndex = index;
                r.bytes = completedBytes + bytes;
                r.totalBytes = completedBytes + total;
                r.updatedAt = new Date().toISOString();
                if (r.cancelRequested) controller.abort();
              });
            },
          };
          const result =
            spec.direction === "upload"
              ? await uploadWithResume(
                  client,
                  paths.localPath,
                  paths.remotePath,
                  options,
                )
              : await downloadWithResume(
                  client,
                  paths.remotePath,
                  paths.localPath,
                  options,
                );
          completedBytes += result.bytes;
          results.push({ source: item.source, ok: true, result });
        } catch (error) {
          results.push({
            source: item.source,
            ok: false,
            error: this.redact((error as Error).message),
          });
          if (controller.signal.aborted || spec.continueOnError === false)
            break;
        } finally {
          this.store.release(key, id);
          locks.splice(locks.indexOf(key), 1);
        }
      }
      this.store.updateTransfer(id, (r) => {
        interrupted = this.stopping;
        r.state = controller.signal.aborted
          ? interrupted
            ? "interrupted"
            : "cancelled"
          : results.some((x) => !x.ok)
            ? "failed"
            : "completed";
        r.result = {
          items: results,
          files: results.reduce((n, x) => n + (x.result?.files ?? 0), 0),
          bytes: completedBytes,
        };
        r.bytes = completedBytes;
        r.updatedAt = new Date().toISOString();
      });
    } catch (error) {
      this.store.updateTransfer(id, (r) => {
        r.state = controller.signal.aborted
          ? this.stopping
            ? "interrupted"
            : "cancelled"
          : "failed";
        r.error = this.redact((error as Error).message);
        r.updatedAt = new Date().toISOString();
      });
    } finally {
      clearInterval(heartbeat);
      this.store.release(`transfer:${id}`, this.owner);
      for (const k of locks) this.store.release(k, id);
      this.pool.release(server.id);
    }
  }
  status(id?: string): TransferRecord[] {
    const records = id
      ? [this.store.getTransfer(id)].filter((r): r is TransferRecord =>
          Boolean(r),
        )
      : this.store.listTransfers();
    if (id && !records.length)
      throw new HpcError(`Unknown transfer ${id}`, "TRANSFER_NOT_FOUND");
    return records.map((record) => {
      if (
        record.state === "running" &&
        !this.store.leaseAlive(`transfer:${record.id}`, record.owner)
      )
        return this.store.updateTransfer(record.id, (r) => {
          if (
            r.state === "running" &&
            !this.store.leaseAlive(`transfer:${r.id}`, r.owner)
          ) {
            r.state = "interrupted";
            r.error =
              "Owning MCP process stopped; submit the same paths to resume";
          }
        });
      return record;
    });
  }
  cancel(id: string): TransferRecord {
    this.status(id);
    const record = this.store.updateTransfer(id, (r) => {
      if (r.state === "running") r.cancelRequested = true;
    });
    this.active.get(id)?.controller.abort();
    return record;
  }
  async wait(id: string, signal?: AbortSignal): Promise<TransferRecord> {
    const active = this.active.get(id);
    const abort = () => this.cancel(id);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      await active?.done;
      return this.status(id)[0]!;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  async abortServer(server: string): Promise<void> {
    const tasks = [...this.active.values()].filter((t) => t.server === server);
    for (const t of tasks) t.controller.abort();
    await Promise.allSettled(tasks.map((t) => t.done));
  }
  private stopping = false;
  async close(): Promise<void> {
    this.stopping = true;
    for (const t of this.active.values()) t.controller.abort();
    await Promise.allSettled([...this.active.values()].map((t) => t.done));
  }
}
