import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
import { ShellSession } from "../dist/core/session.js";

const bash =
  process.platform === "win32"
    ? "C:/Program Files/Git/bin/bash.exe"
    : "/bin/bash";
test(
  "real Bash preserves cwd/environment and resets only its shell after timeout",
  { skip: !existsSync(bash), timeout: 10000 },
  async () => {
    const children = new Set();
    const client = {
      exec: (_command, callback) => {
        const child = spawn(bash, ["-l"], { stdio: "pipe" });
        children.add(child);
        const channel = Duplex.from({
          readable: child.stdout,
          writable: child.stdin,
        });
        channel.stderr = child.stderr;
        channel.close = () => {
          child.stdin.end();
          child.kill();
          child.stdout.destroy();
          child.stderr.destroy();
        };
        child.on("error", () => channel.destroy());
        child.on("exit", () => {
          children.delete(child);
          channel.emit("close");
        });
        queueMicrotask(() => callback(null, channel));
      },
    };
    const session = new ShellSession(client, "test", "main", 3000);
    try {
      await session.start();
      const a = await session.run("cd /tmp; export HPC_STATE=retained", 1000);
      assert.equal(a.code, 0);
      const b = await session.run('printf "%s:%s" "$PWD" "$HPC_STATE"', 1000);
      assert.equal(b.stdout, "/tmp:retained");
      const timeout = await session.run("sleep 0.3", 30);
      assert.equal(timeout.timedOut, true);
      assert.equal(timeout.stateReset, true);
      const fresh = await session.run('printf "%s" "${HPC_STATE-unset}"', 1000);
      assert.equal(fresh.stdout, "unset");
    } finally {
      await session.close();
      for (const child of children) child.kill();
    }
  },
);
