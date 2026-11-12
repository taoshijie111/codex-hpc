import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { ConfigStore } from "./config.js";
import { StateStore } from "./state.js";
import { ConnectionPool } from "./core/pool.js";
import { SessionRegistry } from "./core/session.js";
import type { CoreContext } from "./core/context.js";
import {
  HpcError,
  findServer,
  type Config,
  type ServerSpec,
} from "./core/types.js";
import { cancelJob, refreshJob, type JobRecord } from "./core/jobs.js";
import { isTerminal, sleep, type CancelState } from "./core/watch.js";
import { TransferManager } from "./transfers.js";

export class HpcRuntime {
  readonly owner = randomUUID();
  readonly store: StateStore;
  readonly pool: ConnectionPool;
  readonly sessions: SessionRegistry;
  readonly ctx: CoreContext;
  readonly transfers: TransferManager;
  private readonly secrets = new Set<string>();
  private readonly watchers = new Map<
    string,
    { state: CancelState; done: Promise<void> }
  >();
  private readonly operations = new Map<string, Promise<unknown>>();
  private signatures = new Map<string, string>();
  private closing = false;
  private readonly blockedWatchServers = new Set<string>();
  private readonly heartbeat: NodeJS.Timeout;
  constructor(
    readonly config: ConfigStore,
    options: {
      statePath?: string;
      pool?: ConnectionPool;
      resume?: boolean;
    } = {},
  ) {
    config.read();
    this.store = new StateStore(
      options.statePath ?? join(dirname(config.path), "state.db"),
      config.path,
    );
    this.ctx = {
      store: this.store,
      secret: (name) => {
        const value = process.env[name];
        if (value) this.secrets.add(value);
        return value;
      },
      pinHost: async (server, key) => {
        await config.pin(server, key);
        this.signatures.set(
          server.id,
          this.signature({ ...server, hostKey: key }),
        );
      },
    };
    const live = () => config.read();
    this.pool =
      options.pool ??
      new ConnectionPool({
        connectTimeoutMs: () => live().connectTimeoutMs ?? 15000,
        keepaliveIntervalMs: () => live().keepaliveIntervalMs ?? 30000,
        idleTimeoutMs: () => live().idleTimeoutMs ?? 600000,
      });
    this.sessions = new SessionRegistry(this.pool, {
      maxPerServer: () => live().maxSessionsPerServer ?? 4,
      idleTimeoutMs: () => live().sessionIdleTimeoutMs ?? 1800000,
      readyTimeoutMs: () => live().sessionReadyTimeoutMs ?? 30000,
    });
    this.transfers = new TransferManager(
      this.ctx,
      this.pool,
      this.owner,
      (text) => this.redact(text),
    );
    this.signatures = new Map(
      live().servers.map((s) => [s.id, this.signature(s)]),
    );
    this.heartbeat = setInterval(() => {
      if (this.closing) return;
      try {
        for (const id of this.watchers.keys())
          this.store.lease(`monitor:${id}`, this.owner);
        for (const record of this.store.listJobs())
          if (!isTerminal(record.state)) this.watch(record.id);
      } catch {
        /* A transient busy database is retried on the next heartbeat. */
      }
    }, 10000);
    this.heartbeat.unref();
    if (options.resume !== false)
      for (const record of this.store.listJobs())
        if (!isTerminal(record.state)) this.watch(record.id);
  }
  private signature(server: ServerSpec): string {
    const {
      host,
      port,
      username,
      auth,
      passwordEnv,
      keyPath,
      keyPassphraseEnv,
      hostKey,
    } = server;
    return JSON.stringify({
      host,
      port,
      username,
      auth,
      passwordEnv,
      keyPath,
      keyPassphraseEnv,
      hostKey,
    });
  }
  rememberSecret(secret?: string): void {
    if (secret) this.secrets.add(secret);
  }
  redact(text: string): string {
    for (const value of [...this.secrets].sort((a, b) => b.length - a.length))
      text = text.replaceAll(value, "[REDACTED]");
    return text;
  }
  clean<T>(value: T): T {
    return JSON.parse(
      JSON.stringify(value, (_k, v) =>
        typeof v === "string"
          ? this.redact(v)
          : typeof v === "bigint"
            ? String(v)
            : v,
      ),
    ) as T;
  }
  async sync(): Promise<Config> {
    const config = this.config.read();
    for (const [id, signature] of this.signatures) {
      const next = config.servers.find((s) => s.id === id);
      if (!next || this.signature(next) !== signature) {
        await this.transfers.abortServer(id);
        await this.sessions.closeForServer(id);
        await this.pool.close(id);
        this.blockedWatchServers.delete(id);
      }
    }
    this.signatures = new Map(
      config.servers.map((s) => [s.id, this.signature(s)]),
    );
    return config;
  }
  server(id: string): ServerSpec {
    return findServer(this.config.read(), id);
  }
  job(id: string): JobRecord {
    const record = this.store.getJob(id);
    if (!record) throw new HpcError(`Unknown job ${id}`, "JOB_NOT_FOUND");
    return record;
  }
  async serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const before = this.operations.get(key) ?? Promise.resolve();
    const task = before.catch(() => undefined).then(run);
    this.operations.set(key, task);
    try {
      return await task;
    } finally {
      if (this.operations.get(key) === task) this.operations.delete(key);
    }
  }
  async refresh(id: string): Promise<JobRecord> {
    return this.serial(`job:${id}`, async () => {
      const record = this.job(id);
      if (isTerminal(record.state)) return record;
      const server = this.config
        .read()
        .servers.find((s) => s.id === record.server);
      if (!server)
        return {
          ...record,
          note: "Server is no longer configured; historical record retained",
        };
      if (!this.store.lease(`job:${id}`, this.owner)) return record;
      this.pool.hold(server.id);
      try {
        return await refreshJob(this.ctx, this.pool, server, record);
      } finally {
        this.pool.release(server.id);
        this.store.release(`job:${id}`, this.owner);
      }
    });
  }
  async cancel(id: string): Promise<JobRecord> {
    return this.serial(`job:${id}`, async () => {
      if (!this.store.lease(`job:${id}`, this.owner))
        throw new HpcError(
          "Job is being reconciled; retry cancellation shortly",
          "JOB_BUSY",
        );
      try {
        const record = this.job(id);
        const result = await cancelJob(
          this.ctx,
          this.pool,
          this.server(record.server),
          record,
        );
        this.stopWatch(id);
        return result;
      } finally {
        this.store.release(`job:${id}`, this.owner);
      }
    });
  }
  watch(id: string): void {
    const record = this.job(id);
    if (
      this.closing ||
      this.watchers.has(id) ||
      isTerminal(record.state) ||
      this.blockedWatchServers.has(record.server)
    )
      return;
    if (!this.store.lease(`monitor:${id}`, this.owner)) return;
    const state: CancelState = { cancelled: false, wake: null };
    this.pool.hold(record.server);
    const done = Promise.resolve()
      .then(async () => {
        let delay = 15000;
        while (!state.cancelled && !this.closing) {
          try {
            const record = await this.refresh(id);
            if (
              isTerminal(record.state) ||
              !this.config.read().servers.some((s) => s.id === record.server)
            )
              return;
          } catch (error) {
            if (
              [
                "MFA_REQUIRED",
                "CREDENTIAL_MISSING",
                "HOST_KEY_CHANGED",
                "AUTH_FAILED",
              ].includes((error as HpcError).code)
            ) {
              this.blockedWatchServers.add(record.server);
              return;
            }
          }
          await sleep(delay, state);
          delay = Math.min(900000, Math.round(delay * 1.7));
        }
      })
      .finally(() => {
        this.pool.release(record.server);
        this.store.release(`monitor:${id}`, this.owner);
        this.watchers.delete(id);
      });
    this.watchers.set(id, { state, done });
    void done.catch(() => undefined);
  }
  resumeServer(id: string): void {
    this.blockedWatchServers.delete(id);
    for (const record of this.store.listJobs(id))
      if (!isTerminal(record.state)) this.watch(record.id);
  }
  suspendServer(id: string): void {
    this.blockedWatchServers.add(id);
    for (const record of this.store.listJobs(id)) this.stopWatch(record.id);
  }
  stopWatch(id: string): void {
    const watch = this.watchers.get(id);
    if (watch) {
      watch.state.cancelled = true;
      watch.state.wake?.();
    }
  }
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.heartbeat);
    for (const id of this.watchers.keys()) this.stopWatch(id);
    const transfers = this.transfers.close();
    await this.sessions.closeAll();
    await this.pool.closeAll();
    await transfers;
    await Promise.allSettled([...this.watchers.values()].map((w) => w.done));
    await Promise.allSettled([...this.operations.values()]);
    this.store.close();
    this.secrets.clear();
  }
}
