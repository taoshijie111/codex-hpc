import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as connectNet } from "node:net";
import { once } from "node:events";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../dist/mcp.js";
import ssh2 from "ssh2";
const { Server } = ssh2;
import { ConfigStore } from "../dist/config.js";
import { HpcRuntime } from "../dist/runtime.js";
import { execRemote } from "../dist/core/ssh.js";

const hostKey = () =>
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  }).privateKey;
async function fixture({ mfa = false, append = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hpc-ssh-")),
    config = new ConfigStore(join(root, "config.json")),
    clients = new Set(),
    answers = [];
  let pinnedBeforeAuth = false;
  const server = new Server({ hostKeys: [hostKey()] }, (client) => {
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    client.on("authentication", (ctx) => {
      if (ctx.method === "none") {
        ctx.reject(["password", "keyboard-interactive"]);
        return;
      }
      pinnedBeforeAuth = Boolean(config.read().servers[0].hostKey);
      if (
        !mfa &&
        ctx.method === "password" &&
        ctx.password === (append ? "test-password123456" : "test-password")
      ) {
        ctx.accept();
        return;
      }
      if (mfa && ctx.method === "keyboard-interactive") {
        ctx.prompt([{ prompt: "Verification code:", echo: false }], (value) => {
          answers.push(...value);
          value[0] === "123456" ? ctx.accept() : ctx.reject();
        });
        return;
      }
      ctx.reject(append ? ["password"] : ["keyboard-interactive"]);
    });
    client.on("ready", () =>
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          stream.write(
            info.command.includes("big-output") ? "x".repeat(4096) : "hello\n",
          );
          stream.exit(0);
          stream.end();
        });
      }),
    );
    client.on("tcpip", (accept) => {
      const stream = accept();
      stream.on("error", () => {});
      stream.pipe(stream);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  await config.update((c) => ({
    ...c,
    servers: [
      {
        id: "test",
        host: "127.0.0.1",
        port: server.address().port,
        username: "u",
        auth: "password",
        passwordEnv: "CODEX_HPC_SSH_FIXTURE_PASSWORD",
      },
    ],
  }));
  const old = process.env.CODEX_HPC_SSH_FIXTURE_PASSWORD;
  process.env.CODEX_HPC_SSH_FIXTURE_PASSWORD = "test-password";
  const runtime = new HpcRuntime(config, { resume: false });
  return {
    runtime,
    config,
    answers,
    get pinnedBeforeAuth() {
      return pinnedBeforeAuth;
    },
    async close() {
      await runtime.close();
      for (const client of clients) client.end();
      await new Promise((resolve) => server.close(resolve));
      if (old === undefined) delete process.env.CODEX_HPC_SSH_FIXTURE_PASSWORD;
      else process.env.CODEX_HPC_SSH_FIXTURE_PASSWORD = old;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test("actual SSH handshake pins before password auth, pools connections, bounds output and rejects host drift", async () => {
  const f = await fixture();
  try {
    const state = await f.runtime.pool.ensure(
      f.runtime.ctx,
      f.runtime.server("test"),
    );
    assert.equal(f.pinnedBeforeAuth, true);
    assert.equal(f.config.read().servers[0].hostKey, state.fingerprint);
    assert.equal(
      (await execRemote(state.client, "echo hello", { timeoutMs: 1000 }))
        .stdout,
      "hello\n",
    );
    const capped = await execRemote(state.client, "big-output", {
      timeoutMs: 1000,
      maxBytes: 64,
    });
    assert.equal(capped.stdout.length, 64);
    assert.equal(capped.truncated, true);
    await f.runtime.pool.close("test");
    await f.config.update((c) => ({
      ...c,
      servers: c.servers.map((s) => ({
        ...s,
        hostKey: "SHA256:" + "A".repeat(43),
      })),
    }));
    await assert.rejects(
      f.runtime.pool.ensure(f.runtime.ctx, f.runtime.server("test")),
      (e) => e.code === "HOST_KEY_CHANGED",
    );
  } finally {
    await f.close();
  }
});
test("actual keyboard-interactive MFA never substitutes password for missing OTP", async () => {
  const f = await fixture({ mfa: true });
  try {
    await assert.rejects(
      f.runtime.pool.ensure(f.runtime.ctx, f.runtime.server("test")),
      (e) => e.code === "MFA_REQUIRED",
    );
    assert.ok(f.answers.length);
    assert.equal(f.answers.includes("test-password"), false);
    const connected = await f.runtime.pool.ensure(
      f.runtime.ctx,
      f.runtime.server("test"),
      { verificationCode: "123456" },
    );
    assert.equal(connected.alive, true);
    assert.equal(f.answers.at(-1), "123456");
  } finally {
    await f.close();
  }
});
test("password+OTP gateway gets a single fallback attempt without interactive prompts", async () => {
  const f = await fixture({ append: true });
  try {
    const state = await f.runtime.pool.ensure(
      f.runtime.ctx,
      f.runtime.server("test"),
      { verificationCode: "123456" },
    );
    assert.equal(state.alive, true);
  } finally {
    await f.close();
  }
});
test(
  "forwarding binds loopback and explicit close destroys active connections",
  { timeout: 10000 },
  async () => {
    const f = await fixture(),
      server = createMcpServer(f.runtime),
      client = new McpClient({ name: "tunnel-test", version: "1" });
    let socket;
    try {
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(b);
      await client.connect(a);
      const opened = await client.callTool({
        name: "forward",
        arguments: { server: "test", remotePort: 8000 },
      });
      assert.equal(opened.isError, undefined);
      const port = opened.structuredContent.localPort;
      socket = connectNet(port, "127.0.0.1");
      socket.on("error", () => {});
      await once(socket, "connect");
      const reply = once(socket, "data");
      socket.write("ping");
      assert.equal((await reply)[0].toString(), "ping");
      const closed = once(socket, "close");
      const result = await client.callTool({
        name: "forward",
        arguments: { server: "test", localPort: port, close: true },
      });
      assert.equal(result.structuredContent.closed, true);
      await closed;
    } finally {
      socket?.destroy();
      await client.close();
      await server.close();
      await f.close();
    }
  },
);
