import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import ssh2 from "ssh2";
const { utils } = ssh2;
import { connect, execRemote } from "./core/ssh.js";
import { HpcError, shellQuote } from "./core/types.js";
import type { HpcRuntime } from "./runtime.js";

export async function setupKey(
  runtime: HpcRuntime,
  id: string,
  otp?: string,
  keyPath?: string,
) {
  return runtime.serial(`key-setup:${id}`, async () => {
    const spec = runtime.server(id);
    const path = keyPath ?? join(homedir(), ".ssh", `codex_hpc_${id}_ed25519`);
    // Prepare before authenticating, so a short-lived OTP is used immediately.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!existsSync(path)) {
      if (existsSync(path + ".pub"))
        throw new HpcError(
          "Public key exists without private key; choose another keyPath",
          "KEY_CONFLICT",
        );
      const keys = utils.generateKeyPairSync("ed25519", {
        comment: `codex-hpc-${id}`,
      });
      writeFileSync(path, keys.private, { flag: "wx", mode: 0o600 });
      if (process.platform === "win32") {
        const system = join(
          process.env.SystemRoot || "C:\\Windows",
          "System32",
        );
        try {
          const owner = execFileSync(join(system, "whoami.exe"), [], {
            encoding: "utf8",
            windowsHide: true,
            timeout: 5000,
          }).trim();
          execFileSync(
            join(system, "icacls.exe"),
            [path, "/inheritance:r", "/grant:r", `${owner}:(F)`],
            { stdio: "pipe", windowsHide: true, timeout: 5000 },
          );
        } catch {
          unlinkSync(path);
          throw new HpcError(
            "Could not restrict the new private key's Windows permissions; no server connection opened",
            "KEY_PERMISSIONS_FAILED",
          );
        }
      }
      writeFileSync(path + ".pub", keys.public + "\n", {
        flag: "wx",
        mode: 0o644,
      });
    }
    const parsed = utils.parseKey(readFileSync(path));
    if (parsed instanceof Error)
      throw new HpcError(
        "Cannot parse private key; use a dedicated unencrypted keyPath",
        "KEY_INVALID",
      );
    const publicKey = `${parsed.type} ${parsed.getPublicSSH().toString("base64")} codex-hpc-${id}`;
    runtime.pool.hold(id);
    try {
      const state = await runtime.pool.ensure(runtime.ctx, spec, {
        verificationCode: otp,
      });
      const result = await execRemote(
        state.client,
        `set -eu; umask 077; mkdir -p "$HOME/.ssh"; test ! -L "$HOME/.ssh/authorized_keys"; touch "$HOME/.ssh/authorized_keys"; chmod 700 "$HOME/.ssh"; chmod 600 "$HOME/.ssh/authorized_keys"; grep -qxF -- ${shellQuote(publicKey)} "$HOME/.ssh/authorized_keys" || { echo; echo ${shellQuote(publicKey)}; } >> "$HOME/.ssh/authorized_keys"`,
        { timeoutMs: 20000, login: false },
      );
      if (result.code !== 0 || result.timedOut)
        throw new HpcError(
          "Public key installation did not complete; configuration unchanged. Do not retry blindly.",
          "KEY_INSTALL_FAILED",
        );
      let verified;
      try {
        // Exactly one deliberate verification, no password or OTP fallback.
        verified = await connect(
          runtime.ctx,
          {
            ...spec,
            auth: "key",
            keyPath: path,
            keyPassphraseEnv: undefined,
            requiresOtp: false,
          },
          {
            connectTimeoutMs: 15000,
            expectedFingerprint: state.fingerprint,
            keyOnly: true,
          },
        );
      } catch (error) {
        return {
          server: id,
          publicKeyInstalled: true,
          keyOnlyVerified: false,
          configurationChanged: false,
          keyPath: path,
          message: `Key-only verification failed; the server may require MFA. Stop without retry. ${(error as Error).message}`,
        };
      }
      verified.close();
      await runtime.config.update((c) => {
        const current = c.servers.find((s) => s.id === id);
        if (
          !current ||
          current.host !== spec.host ||
          current.port !== spec.port ||
          current.username !== spec.username ||
          current.auth !== spec.auth ||
          current.hostKey !== state.fingerprint
        )
          throw new HpcError(
            "Server configuration changed during key setup; not switching authentication",
            "CONFIG_CHANGED",
          );
        current.auth = "key";
        current.keyPath = path;
        current.requiresOtp = false;
        delete current.keyPassphraseEnv;
        return c;
      });
      return {
        server: id,
        publicKeyInstalled: true,
        keyOnlyVerified: true,
        configurationChanged: true,
        keyPath: path,
      };
    } finally {
      runtime.pool.release(id);
    }
  });
}
