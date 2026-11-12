import type { CoreContext } from "./context.js";
import type { Client } from "ssh2";
import { connect } from "./ssh.js";
import type { ServerSpec } from "./types.js";

export type ForwardInfo = {
  localPort: number;
  remoteHost: string;
  remotePort: number;
};

type Forward = ForwardInfo & {
  server: import("node:net").Server;
  sockets?: Set<import("node:net").Socket>;
};

/**
 * One authenticated SSH connection per server, kept alive across tool calls.
 * A connection carries multiple shell sessions, SFTP channels and forwarded
 * ports; idle reaping never closes a connection that still has live sessions.
 */
export type ConnectionState = {
  serverId: string;
  client: Client;
  fingerprint: string;
  connectedAt: number;
  lastUsedAt: number;
  alive: boolean;
  idleTimer: NodeJS.Timeout | null;
  sessions: Set<string>;
  signature: string;
  forwards: Map<number, Forward>;
};

export type PoolOptions = {
  connectTimeoutMs: () => number;
  keepaliveIntervalMs: () => number;
  /** 0 disables idle reaping. */
  idleTimeoutMs: () => number;
  /** Connection factory; injected by tests, defaults to the real SSH connect. */
  connect?: typeof connect;
};

export class ConnectionPool {
  private readonly entries = new Map<string, ConnectionState>();
  /** Servers that must not be idle-reaped (a watcher is following a job on them). */
  private readonly holds = new Map<string, number>();
  private closed = false;
  private readonly pending = new Map<
    string,
    { signature: string; promise: Promise<ConnectionState> }
  >();
  private readonly generations = new Map<string, number>();

  constructor(private readonly options: PoolOptions) {}

  async ensure(
    ctx: CoreContext,
    server: ServerSpec,
    options: { verificationCode?: string } = {},
  ): Promise<ConnectionState> {
    if (this.closed) throw new Error("Connection pool is closed");
    const signature = this.signature({
      ...server,
      hostKey: server.hostKey ?? this.entries.get(server.id)?.fingerprint,
    });
    const pending = this.pending.get(server.id);
    if (pending) {
      if (pending.signature === signature) return pending.promise;
      await pending.promise.catch(() => undefined);
      return this.ensure(ctx, server, options);
    }
    const existing = this.entries.get(server.id);
    if (existing && existing.alive && existing.signature === signature) {
      this.touch(existing);
      return existing;
    }
    if (existing) this.forget(server.id);
    const promise = this.open(ctx, server, options);
    this.pending.set(server.id, { signature, promise });
    try {
      return await promise;
    } finally {
      if (this.pending.get(server.id)?.promise === promise)
        this.pending.delete(server.id);
    }
  }

  private signature(server: ServerSpec): string {
    return JSON.stringify([
      server.host,
      server.port ?? 22,
      server.username,
      server.auth,
      server.passwordEnv,
      server.keyPath,
      server.keyPassphraseEnv,
      server.hostKey ?? null,
    ]);
  }

  private async open(
    ctx: CoreContext,
    server: ServerSpec,
    options: { verificationCode?: string },
  ): Promise<ConnectionState> {
    const generation = this.generations.get(server.id) ?? 0;
    const connection = await (this.options.connect ?? connect)(ctx, server, {
      connectTimeoutMs: this.options.connectTimeoutMs(),
      keepaliveIntervalMs: this.options.keepaliveIntervalMs(),
      expectedFingerprint: server.hostKey ?? null,
      ...(options.verificationCode
        ? { verificationCode: options.verificationCode }
        : {}),
    });
    if (this.closed || generation !== (this.generations.get(server.id) ?? 0)) {
      connection.close();
      throw new Error("Connection was closed while opening");
    }
    const state: ConnectionState = {
      serverId: server.id,
      client: connection.client,
      fingerprint: connection.fingerprint,
      connectedAt: Date.now(),
      lastUsedAt: Date.now(),
      alive: true,
      idleTimer: null,
      sessions: new Set(),
      signature: this.signature({
        ...server,
        hostKey: connection.fingerprint || server.hostKey,
      }),
      forwards: new Map(),
    };
    connection.client.once("close", () => {
      state.alive = false;
      state.sessions.clear();
      this.closeForwards(state);
      if (this.entries.get(server.id) === state) this.entries.delete(server.id);
    });
    connection.client.on("error", () => {
      state.alive = false;
    });
    this.entries.set(server.id, state);
    this.touch(state);
    return state;
  }

  get(serverId: string): ConnectionState | undefined {
    const state = this.entries.get(serverId);
    return state && state.alive ? state : undefined;
  }

  list(): Array<{
    serverId: string;
    fingerprint: string;
    connectedAt: string;
    idleSinceMs: number;
    sessions: string[];
    forwards: ForwardInfo[];
  }> {
    return [...this.entries.values()]
      .filter((state) => state.alive)
      .map((state) => ({
        serverId: state.serverId,
        fingerprint: state.fingerprint,
        connectedAt: new Date(state.connectedAt).toISOString(),
        idleSinceMs: Math.max(0, Date.now() - state.lastUsedAt),
        sessions: [...state.sessions],
        forwards: [...state.forwards.values()].map(
          ({ localPort, remoteHost, remotePort }) => ({
            localPort,
            remoteHost,
            remotePort,
          }),
        ),
      }));
  }

  /** Register a listening local forward that uses this connection's channel. */
  addForward(state: ConnectionState, forward: Forward): void {
    state.forwards.set(forward.localPort, forward);
    this.touch(state);
  }

  closeForward(state: ConnectionState, localPort: number): boolean {
    const forward = state.forwards.get(localPort);
    if (!forward) return false;
    state.forwards.delete(localPort);
    for (const socket of forward.sockets ?? []) socket.destroy();
    try {
      forward.server.close();
    } catch {
      /* already closed */
    }
    return true;
  }

  drop(serverId: string): void {
    this.forget(serverId);
  }

  /**
   * Keep this server's connection out of idle reaping. The job watcher holds a
   * server while it follows a job: reconnecting is cheap on password-only
   * hosts, but a 2FA host would lose the connection for good without a fresh
   * code, leaving the job unwatched forever.
   */
  hold(serverId: string): void {
    this.holds.set(serverId, (this.holds.get(serverId) ?? 0) + 1);
    const state = this.entries.get(serverId);
    if (state) this.clearIdle(state);
  }

  release(serverId: string): void {
    const count = this.holds.get(serverId) ?? 0;
    if (count <= 1) this.holds.delete(serverId);
    else this.holds.set(serverId, count - 1);
    const state = this.entries.get(serverId);
    if (state) this.scheduleIdle(state);
  }

  private isHeld(serverId: string): boolean {
    return (this.holds.get(serverId) ?? 0) > 0;
  }

  attachSession(serverId: string, session: string): void {
    const state = this.entries.get(serverId);
    if (!state) return;
    state.sessions.add(session);
    state.lastUsedAt = Date.now();
    this.clearIdle(state);
  }

  detachSession(serverId: string, session: string): void {
    const state = this.entries.get(serverId);
    if (!state) return;
    state.sessions.delete(session);
    state.lastUsedAt = Date.now();
    this.scheduleIdle(state);
  }

  async close(serverId: string): Promise<void> {
    this.generations.set(serverId, (this.generations.get(serverId) ?? 0) + 1);
    this.forget(serverId);
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    this.holds.clear();
    for (const serverId of [...this.entries.keys()]) this.forget(serverId);
  }

  private touch(state: ConnectionState): void {
    state.lastUsedAt = Date.now();
    this.scheduleIdle(state);
  }

  private clearIdle(state: ConnectionState): void {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
  }

  private scheduleIdle(state: ConnectionState): void {
    const timeout = this.options.idleTimeoutMs();
    if (
      timeout <= 0 ||
      state.sessions.size > 0 ||
      state.forwards.size > 0 ||
      this.isHeld(state.serverId)
    )
      return;
    this.clearIdle(state);
    state.idleTimer = setTimeout(() => {
      const current = this.entries.get(state.serverId);
      if (current !== state) return;
      if (state.sessions.size > 0) return;
      this.forget(state.serverId);
    }, timeout);
    state.idleTimer.unref?.();
  }

  private closeForwards(state: ConnectionState): void {
    for (const forward of state.forwards.values()) {
      for (const socket of forward.sockets ?? []) socket.destroy();
      try {
        forward.server.close();
      } catch {
        /* ignore */
      }
    }
    state.forwards.clear();
  }

  private forget(serverId: string): void {
    const state = this.entries.get(serverId);
    if (!state) return;
    this.entries.delete(serverId);
    this.clearIdle(state);
    this.closeForwards(state);
    state.alive = false;
    try {
      state.client.end();
    } catch {
      /* already gone */
    }
  }
}
