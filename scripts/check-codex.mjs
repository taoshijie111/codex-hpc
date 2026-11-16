import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

// Query Codex's own plugin loader, without a model turn or real HPC configuration.
const executable =
  process.env.CODEX_CLI_PATH ||
  (process.platform === "win32" ? "codex.exe" : "codex");
const temporary = mkdtempSync(join(tmpdir(), "codex-hpc-host-"));
const child = spawn(executable, ["app-server", "--stdio"], {
  env: { ...process.env, CODEX_HPC_HOME: temporary },
  stdio: "pipe",
  windowsHide: true,
});
let sequence = 0;
const pending = new Map();
const rejectPending = (error) => {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  pending.clear();
};
child.on("error", () =>
  rejectPending(
    new Error(
      "Cannot start Codex CLI. Set CODEX_CLI_PATH to the desktop app's current codex executable.",
    ),
  ),
);
child.on("exit", () =>
  rejectPending(new Error("Codex host exited before the diagnostic completed")),
);
child.stderr.on("data", () => {});
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const waiter = pending.get(message.id);
  if (waiter) {
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    message.error
      ? waiter.reject(new Error(JSON.stringify(message.error)))
      : waiter.resolve(message.result);
  } else if (message.id !== undefined && message.method)
    child.stdin.write(
      JSON.stringify({
        id: message.id,
        error: { code: -32601, message: "Unsupported diagnostic request" },
      }) + "\n",
    );
});
function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, 45000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
try {
  await call("initialize", {
    clientInfo: {
      name: "codex-hpc-diagnostics",
      title: "Codex HPC diagnostics",
      version: "0.1.0",
    },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  const status = await call("mcpServerStatus/list", {
    serverName: "hpc",
    detail: "full",
  });
  const servers = (status.data ?? []).map((server) => ({
    name: server.name,
    pluginId: server.pluginId,
    toolCount: Object.keys(server.tools ?? {}).length,
    error: server.toolsError ?? null,
  }));
  const ok = servers.some(
    (s) => s.name === "hpc" && s.toolCount === 21 && !s.error,
  );
  console.log(JSON.stringify({ ok, servers }));
  if (!ok) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  lines.close();
  const closed = new Promise((resolve) => {
    if (child.exitCode !== null || child.pid === undefined) resolve();
    else child.once("close", resolve);
  });
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 2000);
  await closed;
  clearTimeout(timer);
  if (!resolve(temporary).startsWith(resolve(tmpdir()) + sep))
    throw new Error("Unexpected diagnostic temporary path");
  rmSync(temporary, { recursive: true, force: true });
}
