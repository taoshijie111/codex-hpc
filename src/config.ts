import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { HpcError, type Config, type ServerSpec } from "./core/types.js";
import { resolveCredential } from "./credentials.js";

const line = z
  .string()
  .min(1)
  .refine((v) => !/[\r\n\0]/.test(v), "Must be a single line without NUL");
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
export const resourceSchema = z
  .object({
    partition: line.optional(),
    account: line.optional(),
    qos: line.optional(),
    time: line.optional(),
    cpusPerTask: z.number().int().positive().optional(),
    memory: line.optional(),
    gpus: z.number().int().nonnegative().optional(),
  })
  .strict();
export const serverSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    label: line.optional(),
    host: line,
    port: z.number().int().min(1).max(65535).optional(),
    username: line,
    auth: z.enum(["password", "key"]),
    passwordEnv: envName.optional(),
    keyPath: line.optional(),
    keyPassphraseEnv: envName.optional(),
    hostKey: z
      .string()
      .regex(/^SHA256:[A-Za-z0-9+/]{43}$/)
      .optional(),
    kind: z.enum(["auto", "bare", "slurm", "pbs", "lsf"]).optional(),
    resolvedKind: z.enum(["bare", "slurm", "pbs", "lsf"]).optional(),
    schedulerDefaults: resourceSchema.optional(),
    jobRoot: line
      .refine(
        (v) => v.startsWith("/") || v.startsWith("~/"),
        "Use an absolute remote path or ~/",
      )
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.auth === "key" && (!v.keyPath || !isAbsolute(v.keyPath)))
      ctx.addIssue({
        code: "custom",
        path: ["keyPath"],
        message: "Key authentication needs an absolute local keyPath",
      });
  });
const timeout = z.number().int().min(1).max(3_600_000);
export const configSchema = z
  .object({
    version: z.literal(1).default(1),
    servers: z.array(serverSchema).default([]),
    connectTimeoutMs: timeout.default(15000),
    commandTimeoutMs: timeout.default(120000),
    keepaliveIntervalMs: timeout.or(z.literal(0)).default(30000),
    idleTimeoutMs: timeout.or(z.literal(0)).default(600000),
    maxSessionsPerServer: z.number().int().min(1).max(64).default(4),
    sessionIdleTimeoutMs: timeout.or(z.literal(0)).default(1800000),
    sessionReadyTimeoutMs: timeout.default(30000),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.servers.map((s) => s.id)).size !== v.servers.length)
      ctx.addIssue({
        code: "custom",
        path: ["servers"],
        message: "Server IDs must be unique",
      });
  });

export function hpcHome(): string {
  return resolve(process.env.CODEX_HPC_HOME || join(homedir(), ".codex-hpc"));
}
export function passwordEnvFor(id: string): string {
  return `CODEX_HPC_${id.toUpperCase().replaceAll("-", "_")}_PASSWORD`;
}

export class ConfigStore {
  readonly path: string;
  constructor(path = join(hpcHome(), "config.json")) {
    this.path = resolve(path);
  }
  read(): Config {
    try {
      return configSchema.parse(
        existsSync(this.path)
          ? JSON.parse(readFileSync(this.path, "utf8"))
          : {},
      );
    } catch (e) {
      throw new HpcError(
        `Invalid config ${this.path}: ${e instanceof z.ZodError ? z.prettifyError(e) : "Cannot read valid JSON"}`,
        "CONFIG_INVALID",
      );
    }
  }
  async update(edit: (config: Config) => Config): Promise<Config> {
    mkdirSync(dirname(this.path), { recursive: true });
    const release = await lockfile.lock(this.path, {
      realpath: false,
      retries: { retries: 20, minTimeout: 25, maxTimeout: 200 },
      stale: 10000,
    });
    let temporary = "";
    try {
      const value = configSchema.parse(edit(this.read()));
      temporary = `${this.path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, this.path);
      return value;
    } finally {
      if (temporary && existsSync(temporary)) unlinkSync(temporary);
      await release();
    }
  }
  async pin(server: ServerSpec, fingerprint: string): Promise<void> {
    await this.update((config) => {
      const current = config.servers.find((s) => s.id === server.id);
      if (
        !current ||
        current.host !== server.host ||
        current.port !== server.port ||
        current.username !== server.username
      )
        throw new HpcError(
          "Server changed during connection; retry",
          "CONFIG_CHANGED",
        );
      if (current.hostKey && current.hostKey !== fingerprint)
        throw new HpcError(
          "Host key changed; verify it before updating hostKey",
          "HOST_KEY_CHANGED",
        );
      current.hostKey = fingerprint;
      return config;
    });
  }
  doctor(): { ok: boolean; configPath: string; servers: unknown[] } {
    const config = this.read();
    const servers = config.servers.map((s) => {
      const envs = [
        s.auth === "password"
          ? (s.passwordEnv ?? passwordEnvFor(s.id))
          : s.keyPassphraseEnv,
      ].filter((x): x is string => Boolean(x));
      const credentials = envs.map((name) => {
        try {
          const { value, source } = resolveCredential(name);
          return { name, available: Boolean(value), source };
        } catch {
          return {
            name,
            available: false,
            source: "unavailable" as const,
            error: "CREDENTIAL_LOOKUP_FAILED",
          };
        }
      });
      const missingEnv = credentials
        .filter((c) => !c.available)
        .map((c) => c.name);
      let keyReadable = true;
      if (s.auth === "key") {
        try {
          accessSync(s.keyPath!, constants.R_OK);
        } catch {
          keyReadable = false;
        }
      }
      return {
        id: s.id,
        ok: missingEnv.length === 0 && keyReadable,
        missingEnv,
        credentials,
        keyReadable,
        hostKeyPinned: Boolean(s.hostKey),
      };
    });
    return { ok: servers.every((s) => s.ok), configPath: this.path, servers };
  }
}
