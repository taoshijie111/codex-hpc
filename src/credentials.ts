import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { HpcError } from "./core/types.js";

export type Credential = {
  value?: string;
  source: "process" | "windows-user" | "missing";
};

// A GUI host can have a stale environment, and MCP hosts may filter variables.
// Query only the configured name, never enumerate the user's environment. The
// value travels over a private pipe, never command arguments or a temporary file.
export function readWindowsUserEnv(name: string): string | undefined {
  const result = spawnSync(
    join(
      process.env.SystemRoot || "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    ),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference = 'Stop'; " +
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); " +
        "$name = [Console]::In.ReadToEnd(); " +
        "[Console]::Write([Environment]::GetEnvironmentVariable($name, 'User'))",
    ],
    {
      input: name,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 64 * 1024,
    },
  );
  if (result.error || result.status !== 0)
    throw new HpcError(
      `Cannot read Windows user environment variable ${name}. Check PowerShell access or forward the variable with Codex env_vars, then restart the MCP service.`,
      "CREDENTIAL_LOOKUP_FAILED",
    );
  return result.stdout || undefined;
}

export function resolveCredential(
  name: string,
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    readUserEnv?: (name: string) => string | undefined;
  } = {},
): Credential {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new HpcError(
      "Invalid credential environment variable name",
      "CONFIG_INVALID",
    );
  const value = (options.env ?? process.env)[name];
  if (value) return { value, source: "process" };
  if ((options.platform ?? process.platform) === "win32") {
    // Do not cache: a running MCP process must observe newly saved user values.
    const saved = (options.readUserEnv ?? readWindowsUserEnv)(name);
    if (saved) return { value: saved, source: "windows-user" };
  }
  return { source: "missing" };
}
