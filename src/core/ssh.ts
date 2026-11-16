import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import type { CoreContext } from "./context.js";
import { isVerificationPrompt, promptText } from "./auth.js";
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
  /** For key provisioning verification: never answer password/OTP prompts. */
  keyOnly?: boolean;
};

export async function connect(
  ctx: CoreContext,
  server: ServerSpec,
  options: ConnectOptions,
): Promise<Connection> {
  if (server.requiresOtp && !options.verificationCode && !options.keyOnly)
    throw new HpcError(
      `Server ${server.id} requires a fresh OTP; obtain it before connecting. No connection was opened.`,
      "MFA_REQUIRED",
    );
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
  return new Promise<Connection>((resolve, reject) => {
    const client = new Client();
    let fingerprint = "",
      specificError: HpcError | undefined,
      finished = false,
      passwordSent = false,
      codeSent = false,
      selected = false,
      interactive = false;
    let phase = "handshake";
    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      client.end();
      reject(
        specificError ??
          new HpcError(
            `Connection to ${server.id} failed during ${phase}: ${error.message}. No retry was made. Stop and check the authentication flow before requesting a fresh code.`,
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
      authHandler: (methods, partial, next) => {
        if (methods === null) {
          next({ type: "none", username: server.username });
          return;
        }
        if (!selected) {
          selected = true;
          if (privateKey && methods.includes("publickey")) {
            phase = "publickey";
            next({
              type: "publickey",
              username: server.username,
              key: privateKey,
              passphrase,
            });
            return;
          }
          // Both password and OTP prompts may belong to keyboard-interactive.
          if (!privateKey && methods.includes("keyboard-interactive")) {
            interactive = true;
            phase = "interactive";
            next({
              type: "keyboard-interactive",
              username: server.username,
              prompt: answer,
            });
            return;
          }
          if (!privateKey && methods.includes("password")) {
            passwordSent = true;
            phase = "password";
            next({
              type: "password",
              username: server.username,
              password: password!,
            });
            return;
          }
        } else if (
          partial &&
          !interactive &&
          !options.keyOnly &&
          methods.includes("keyboard-interactive")
        ) {
          interactive = true;
          phase = "interactive";
          next({
            type: "keyboard-interactive",
            username: server.username,
            prompt: answer,
          });
          return;
        }
        // A rejection is terminal. Never try another credential or append OTP.
        next(false as never);
      },
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
    function answer(
      _name: string,
      _instructions: string,
      _language: string,
      prompts: { prompt: string; echo: boolean }[],
      finish: (answers: string[]) => void,
    ) {
      if (finished) return;
      const answers: string[] = [];
      for (const raw of prompts) {
        const text = promptText(raw);
        if (isVerificationPrompt(text)) {
          phase = "otp";
          if (!code || options.keyOnly) {
            specificError = new HpcError(
              `Server ${server.id} needs a fresh OTP. Call server_connect with otp; no empty code was submitted.`,
              "MFA_REQUIRED",
            );
            fail(specificError);
            return;
          }
          if (codeSent) {
            specificError = new HpcError(
              "Repeated OTP prompt; stopped without resubmitting the code",
              "AUTH_FAILED",
            );
            fail(specificError);
            return;
          }
          codeSent = true;
          answers.push(code);
        } else if (/password|passphrase|密码/i.test(text)) {
          phase = "password";
          if (passwordSent || !password || options.keyOnly) {
            specificError = new HpcError(
              "Repeated or unexpected password prompt; stopped without retry",
              "AUTH_FAILED",
            );
            fail(specificError);
            return;
          }
          passwordSent = true;
          answers.push(password);
        } else {
          specificError = new HpcError(
            "Unrecognized authentication prompt; no secret was submitted. Check the SSH client's prompt sequence.",
            "AUTH_PROMPT_UNSUPPORTED",
          );
          fail(specificError);
          return;
        }
      }
      finish(answers);
    }
    client.once("ready", () => {
      if (finished) return;
      finished = true;
      resolve({ client, fingerprint, close: () => client.end() });
    });
    client.connect(config);
  });
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
    login?: boolean;
  },
): Promise<ExecResult> {
  const started = Date.now();
  if (options.signal?.aborted)
    return Promise.reject(new HpcError("Command cancelled", "CANCELLED"));
  const wrapped =
    options.login === false
      ? command
      : options.cwd
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
