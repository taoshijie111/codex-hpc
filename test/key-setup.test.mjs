import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ssh2 from "ssh2";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ConfigStore } from "../dist/config.js";
import { HpcRuntime } from "../dist/runtime.js";
import { createMcpServer } from "../dist/mcp.js";

for (const mode of [
  "success",
  "key-still-needs-otp",
  "rejected-otp",
  "rejected-password",
  "repeated-password",
  "repeated-prompt",
  "unsupported-prompt",
  "separate-methods",
]) {
  test(`MCP interactive key setup: ${mode}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "hpc-key-"));
    const authorizedKeys = join(root, "remote", ".ssh", "authorized_keys");
    mkdirSync(join(root, "remote", ".ssh"), { recursive: true });
    writeFileSync(authorizedKeys, "preserve-existing-key-without-newline");
    const config = new ConfigStore(join(root, "config.json")),
      keyPath = join(root, "专用 key");
    const host = ssh2.utils.generateKeyPairSync("ed25519");
    const sockets = new Set();
    let connections = 0,
      passwords = 0,
      codes = 0,
      installs = 0,
      keyChecks = 0;
    const server = new ssh2.Server(
      { hostKeys: [host.private] },
      (connection) => {
        connections++;
        sockets.add(connection);
        connection.on("error", () => {});
        connection.on("close", () => sockets.delete(connection));
        connection.on("authentication", (ctx) => {
          if (ctx.method === "none") {
            ctx.reject(
              mode === "separate-methods" && installs === 0
                ? ["password"]
                : ["publickey", "password", "keyboard-interactive"],
            );
            return;
          }
          if (ctx.method === "publickey") {
            keyChecks++;
            assert.equal(installs, 1);
            if (mode === "key-still-needs-otp") {
              ctx.reject(["keyboard-interactive"], true);
              return;
            }
            const key = ssh2.utils.parseKey(readFileSync(keyPath));
            assert.ok(
              readFileSync(authorizedKeys, "utf8")
                .split("\n")
                .some((line) =>
                  line.startsWith(
                    key.type + " " + key.getPublicSSH().toString("base64"),
                  ),
                ),
            );
            if (!ctx.key.data.equals(key.getPublicSSH())) {
              ctx.reject();
              return;
            }
            if (
              ctx.signature &&
              key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true
            ) {
              ctx.reject();
              return;
            }
            ctx.accept();
            return;
          }
          if (ctx.method === "password") {
            passwords++;
            assert.equal(
              mode,
              "separate-methods",
              "Must prefer interactive when both methods are offered",
            );
            assert.equal(ctx.password, "fixture-secret");
            ctx.reject(["keyboard-interactive"], true);
            return;
          }
          if (ctx.method === "keyboard-interactive") {
            const askCode = () =>
              ctx.prompt(
                [{ prompt: "Verification code:", echo: false }],
                (a) => {
                  codes++;
                  assert.equal(a[0], "123456");
                  if (mode === "rejected-otp") {
                    ctx.reject(["keyboard-interactive"]);
                    return;
                  }
                  if (mode === "repeated-prompt") {
                    ctx.prompt(
                      [{ prompt: "Verification code:", echo: false }],
                      () => {
                        codes++;
                        ctx.reject();
                      },
                    );
                    return;
                  }
                  ctx.accept();
                },
              );
            if (mode === "separate-methods") {
              askCode();
              return;
            }
            if (mode === "unsupported-prompt") {
              ctx.prompt(
                [{ prompt: "What is your pet name?", echo: false }],
                () => {
                  passwords++;
                  ctx.reject();
                },
              );
              return;
            }
            ctx.prompt([{ prompt: "Password:", echo: false }], (a) => {
              passwords++;
              assert.equal(a[0], "fixture-secret");
              if (mode === "rejected-password") {
                ctx.reject(["password", "keyboard-interactive"]);
                return;
              }
              if (mode === "repeated-password") {
                ctx.prompt([{ prompt: "Password:", echo: false }], () => {
                  passwords++;
                  ctx.reject();
                });
                return;
              }
              askCode();
            });
          }
        });
        connection.on("ready", () =>
          connection.on("session", (accept) => {
            const session = accept();
            session.on("exec", (acceptExec, _reject, info) => {
              assert.match(info.command, /authorized_keys/);
              assert.ok(!info.command.startsWith("bash -lc"));
              installs++;
              const bash =
                process.platform === "win32"
                  ? "C:/Program Files/Git/bin/bash.exe"
                  : "/bin/bash";
              const ran = spawnSync(
                bash,
                ["-c", 'export HOME="$PWD/remote"; ' + info.command],
                { cwd: root, encoding: "utf8" },
              );
              assert.equal(ran.status, 0, ran.stderr);
              assert.ok(
                readFileSync(authorizedKeys, "utf8").startsWith(
                  "preserve-existing-key-without-newline\nssh-",
                ),
              );
              const stream = acceptExec();
              stream.exit(0);
              stream.end();
            });
          }),
        );
      },
    );
    let runtime, mcp, client;
    const old = process.env.HPC_KEY_FIXTURE_PASSWORD;
    process.env.HPC_KEY_FIXTURE_PASSWORD = "fixture-secret";
    try {
      await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
      await config.update((c) => ({
        ...c,
        servers: [
          {
            id: "fixture",
            host: "127.0.0.1",
            port: server.address().port,
            username: "fixture",
            auth: "password",
            passwordEnv: "HPC_KEY_FIXTURE_PASSWORD",
            requiresOtp: true,
          },
        ],
      }));
      runtime = new HpcRuntime(config, { resume: false });
      mcp = createMcpServer(runtime);
      client = new Client({ name: "setup-test", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await mcp.connect(b);
      await client.connect(a);
      const noCode = await client.callTool({
        name: "server_setup_key",
        arguments: { server: "fixture", keyPath },
      });
      assert.equal(noCode.structuredContent.error.code, "MFA_REQUIRED");
      assert.equal(connections, 0);
      const result = await client.callTool({
        name: "server_setup_key",
        arguments: { server: "fixture", otp: "123456", keyPath },
      });
      const output = JSON.stringify(result);
      assert.ok(
        !output.includes("fixture-secret") &&
          !output.includes("123456") &&
          !output.includes("PRIVATE KEY"),
      );
      if (
        [
          "rejected-otp",
          "repeated-prompt",
          "unsupported-prompt",
          "rejected-password",
          "repeated-password",
        ].includes(mode)
      ) {
        assert.equal(result.isError, true);
        assert.equal(connections, 1);
        assert.equal(installs, 0);
        const again = await client.callTool({
          name: "shell_run",
          arguments: { server: "fixture", command: "true" },
        });
        assert.equal(again.structuredContent.error.code, "AUTH_RETRY_BLOCKED");
        assert.equal(connections, 1);
        assert.equal(passwords, mode === "unsupported-prompt" ? 0 : 1);
        assert.equal(
          codes,
          [
            "unsupported-prompt",
            "rejected-password",
            "repeated-password",
          ].includes(mode)
            ? 0
            : 1,
        );
      } else {
        assert.equal(result.isError, undefined);
        assert.equal(connections, 2);
        assert.equal(installs, 1);
        assert.equal(passwords, 1);
        assert.equal(codes, 1);
        assert.ok(keyChecks > 0);
        const verified = mode !== "key-still-needs-otp";
        assert.equal(result.structuredContent.keyOnlyVerified, verified);
        assert.equal(
          config.read().servers[0].auth,
          verified ? "key" : "password",
        );
        if (verified) {
          const original = readFileSync(keyPath);
          assert.ok(original.length > 50);
          // Config changes after first TOFU/setup must not lose history or secrets.
          assert.equal(config.read().servers[0].requiresOtp, false);
        }
      }
    } finally {
      await client?.close();
      await mcp?.close();
      await runtime?.close();
      for (const s of sockets) s.end();
      await new Promise((ok) => server.close(ok));
      if (old === undefined) delete process.env.HPC_KEY_FIXTURE_PASSWORD;
      else process.env.HPC_KEY_FIXTURE_PASSWORD = old;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
