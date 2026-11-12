import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import type { CoreContext } from "./context.js";
import { answerPrompts } from "./auth.js";
import {
  HpcError,
  shellQuote,
  type ExecResult,
  type ServerSpec,
} from "./types.js";
import { passwordEnvFor } from "../config.js";

export { isVerificationPrompt } from "./auth.js";
export function fingerprintOf(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}
export type Connection = { client: Client; fingerprint: string; close(): void };
export type ConnectOptions = {
  connectTimeoutMs: number;
  keepaliveIntervalMs?: number;
  expectedFingerprint?: string | null;
  verificationCode?: string;
};

export async function connect(
  ctx: CoreContext,
  server: ServerSpec,
  options: ConnectOptions,
): Promise<Connection> {
  const envName = server.passwordEnv ?? passwordEnvFor(server.id);
  const password = server.auth === "password" ? ctx.secret(envName) : undefined;
  if (server.auth === "password" && !password)
    throw new HpcError(
      `Credential ${envName} is missing. Set it in the MCP process environment (Codex env_vars); on Windows, a saved user environment variable is also supported. Run codex-hpc doctor to check availability without displaying its value.`,
      "CREDENTIAL_MISSING",
    );
  const privateKey =
    server.auth === "key" ? await readFile(server.keyPath!) : undefined;
  const passphrase = server.keyPassphraseEnv
    ? ctx.secret(server.keyPassphraseEnv)
    : undefined;
  if (server.keyPassphraseEnv && !passphrase)
    throw new HpcError(
      `Credential ${server.keyPassphraseEnv} is missing. Set it in the MCP process environment (Codex env_vars) or Windows user environment, then run codex-hpc doctor.`,
      "CREDENTIAL_MISSING",
    );
  const code = options.verificationCode?.trim();
  let sawPrompt = false;
  const attempt = (effectivePassword: string | undefined) =>
    new Promise<Connection>((resolve, reject) => {
      const client = new Client();
      let fingerprint = "",
        specificError: HpcError | undefined,
        finished = false,
        needsCode = false;
      const fail = (error: Error) => {
        if (finished) return;
        finished = true;
        client.end();
        reject(
          specificError ??
            new HpcError(
              `Connection to ${server.id} failed: ${error.message}`,
              (error as Error & { level?: string }).level ===
                "client-authentication"
                ? "AUTH_FAILED"
                : "SSH_CONNECT_FAILED",
            ),
        );
      };
      const config: ConnectConfig = {
        host: server.host,
        port: server.port ?? 22,
        username: server.username,
        readyTimeout: options.connectTimeoutMs,
        keepaliveInterval: options.keepaliveIntervalMs ?? 30000,
        tryKeyboard: true,
        ...(effectivePassword ? { password: effectivePassword } : {}),
        ...(privateKey ? { privateKey } : {}),
        ...(passphrase ? { passphrase } : {}),
        hostVerifier: (rawKey: Buffer, verify: (ok: boolean) => void) => {
          fingerprint = fingerprintOf(rawKey);
          if (
            options.expectedFingerprint &&
            options.expectedFingerprint !== fingerprint
          ) {
            specificError = new HpcError(
              `Host key for ${server.id} changed. Observed ${fingerprint}; verify before editing hostKey.`,
              "HOST_KEY_CHANGED",
            );
            verify(false);
            return;
          }
          if (options.expectedFingerprint) {
            verify(true);
            return;
          }
          void ctx.pinHost(server, fingerprint).then(
            () => {
              if (!finished) verify(true);
            },
            (error) => {
              specificError =
                error instanceof HpcError
                  ? error
                  : new HpcError(
                      "Could not persist host fingerprint",
                      "HOST_KEY_STORE_FAILED",
                    );
              if (!finished) verify(false);
            },
          );
        },
      };
      client.on("error", fail);
      client.once("close", () =>
        fail(new Error("SSH connection closed before authentication")),
      );
      client.on(
        "keyboard-interactive",
        (_name, _instructions, _language, prompts, finish) => {
          sawPrompt ||= prompts.length > 0;
          const result = answerPrompts(prompts, {
            secret: password ?? passphrase,
            code,
          });
          needsCode ||= result.sawCodePrompt;
          if (result.sawCodePrompt && !code)
            specificError = new HpcError(
              `Server ${server.id} needs a current one-time code. Call server_connect with otp.`,
              "MFA_REQUIRED",
            );
          finish(result.answers);
        },
      );
      client.once("ready", () => {
        if (finished) return;
        if (needsCode && !code) {
          fail(specificError!);
          return;
        }
        finished = true;
        resolve({ client, fingerprint, close: () => client.end() });
      });
      client.connect(config);
    });
  try {
    return await attempt(password);
  } catch (error) {
    // Preserve gateways that accept password+OTP without an interactive prompt.
    // Only one extra attempt, only after a definite authentication rejection.
    if (
      code &&
      password &&
      !sawPrompt &&
      (error as HpcError).code === "AUTH_FAILED"
    )
      return attempt(password + code);
    throw error;
  }
}

/** One-off command, bounded in time and memory. Never used to own a compute job. */
export function execRemote(
  client: Client,
  command: string,
  options: {
    timeoutMs: number;
    cwd?: string;
    signal?: AbortSignal;
    maxBytes?: number;
  },
): Promise<ExecResult> {
  const started = Date.now();
  if (options.signal?.aborted)
    return Promise.reject(new HpcError("Command cancelled", "CANCELLED"));
  const wrapped = options.cwd
    ? `cd ${shellQuote(options.cwd)} && bash -lc ${shellQuote(command)}`
    : `bash -lc ${shellQuote(command)}`;
  return new Promise((resolve, reject) => {
    let settled = false,
      stdout = "",
      stderr = "",
      stdoutBytes = 0,
      stderrBytes = 0;
    let channel: ClientChannel | undefined;
    const cap = options.maxBytes ?? 256 * 1024;
    const outDecoder = new StringDecoder("utf8"),
      errDecoder = new StringDecoder("utf8");
    const finish = (code: number | null, timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      stdout += outDecoder.end();
      stderr += errDecoder.end();
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
        stdoutBytes,
        stderrBytes,
        truncated: stdoutBytes > cap || stderrBytes > cap,
      });
    };
    const stop = () => {
      finish(null, true);
      channel?.destroy();
    };
    const abort = () => stop();
    const timer = setTimeout(stop, options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    client.exec(wrapped, (error, stream) => {
      if (settled) {
        stream?.close();
        return;
      }
      if (error) {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        settled = true;
        reject(new HpcError(error.message, "SSH_EXEC_FAILED"));
        return;
      }
      channel = stream;
      stream.on("data", (chunk: Buffer) => {
        const take = Math.max(0, cap - stdoutBytes);
        stdoutBytes += chunk.length;
        if (take) stdout += outDecoder.write(chunk.subarray(0, take));
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        const take = Math.max(0, cap - stderrBytes);
        stderrBytes += chunk.length;
        if (take) stderr += errDecoder.write(chunk.subarray(0, take));
      });
      stream.on("close", (code: number | null) => finish(code));
      stream.on("error", () => finish(null));
    });
  });
}
