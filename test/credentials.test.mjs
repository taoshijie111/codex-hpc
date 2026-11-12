import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ssh2 from "ssh2";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveCredential } from "../dist/credentials.js";
import { ConfigStore } from "../dist/config.js";
import { HpcRuntime } from "../dist/runtime.js";

test("credential precedence, platform boundary and uncached user values", () => {
  let saved = "first",
    calls = 0;
  const options = {
    env: {},
    platform: "win32",
    readUserEnv: () => {
      calls++;
      return saved;
    },
  };
  assert.deepEqual(
    resolveCredential("HPC_SECRET", {
      ...options,
      env: { HPC_SECRET: "explicit" },
    }),
    { value: "explicit", source: "process" },
  );
  assert.equal(calls, 0);
  assert.deepEqual(resolveCredential("HPC_SECRET", options), {
    value: "first",
    source: "windows-user",
  });
  saved = "second";
  assert.equal(resolveCredential("HPC_SECRET", options).value, "second");
  saved = undefined;
  assert.deepEqual(resolveCredential("HPC_SECRET", options), {
    source: "missing",
  });
  const before = calls;
  for (const platform of ["linux", "darwin"])
    assert.deepEqual(
      resolveCredential("HPC_SECRET", { ...options, platform }),
      { source: "missing" },
    );
  assert.throws(
    () => resolveCredential("BAD;name", options),
    (e) => e.code === "CONFIG_INVALID",
  );
  assert.equal(calls, before);
});

test(
  "Windows stdio MCP reads late-saved user credentials without forwarding or leaking them",
  {
    skip: process.platform !== "win32",
    timeout: 60000,
  },
  async () => {
    const name = `CODEX_HPC_TEST_${randomUUID().replaceAll("-", "")}`;
    const root = mkdtempSync(join(tmpdir(), "hpc-user-env-"));
    const config = new ConfigStore(join(root, "config.json"));
    const powershell = join(
      process.env.SystemRoot || "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    );
    // A disposable test-only name; no broadcasts or changes to existing credentials.
    const save = (value) => {
      const result = spawnSync(
        powershell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); " +
            "$p=[Console]::In.ReadToEnd() | ConvertFrom-Json; " +
            "$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); " +
            "try { if ($null -eq $p.value) { $k.DeleteValue($p.name,$false) } else { $k.SetValue($p.name,$p.value,[Microsoft.Win32.RegistryValueKind]::String) } } finally { $k.Dispose() }",
        ],
        {
          input: JSON.stringify({ name, value }),
          encoding: "utf8",
          windowsHide: true,
          timeout: 10000,
        },
      );
      assert.equal(result.status, 0, "Test user environment fixture failed");
    };
    let expected = '密码 空格"\\$value\n尾部 ';
    const clients = new Set();
    const server = new ssh2.Server(
      {
        hostKeys: [
          generateKeyPairSync("rsa", {
            modulusLength: 2048,
            privateKeyEncoding: { type: "pkcs1", format: "pem" },
            publicKeyEncoding: { type: "pkcs1", format: "pem" },
          }).privateKey,
        ],
      },
      (connection) => {
        clients.add(connection);
        connection.on("error", () => {});
        connection.on("close", () => clients.delete(connection));
        connection.on("authentication", (auth) => {
          if (auth.method === "password" && auth.password === expected)
            auth.accept();
          else auth.reject(["password"]);
        });
      },
    );
    let client,
      stderr = "";
    try {
      await new Promise((ok, no) => {
        server.once("error", no);
        server.listen(0, "127.0.0.1", ok);
      });
      await config.update((c) => ({
        ...c,
        servers: [
          {
            id: "test",
            host: "127.0.0.1",
            port: server.address().port,
            username: "test",
            auth: "password",
            passwordEnv: name,
          },
        ],
      }));
      const env = { ...process.env };
      delete env[name];
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [resolve("dist/cli.js"), "serve", "--config", config.path],
        env,
        stderr: "pipe",
      });
      transport.stderr.on("data", (c) => (stderr += c));
      client = new Client({ name: "user-env-test", version: "1" });
      await client.connect(transport);
      const call = (tool) =>
        client.callTool({ name: tool, arguments: { server: "test" } });
      assert.equal(
        (await call("server_connect")).structuredContent.error.code,
        "CREDENTIAL_MISSING",
      );
      // Save after MCP initialization: its inherited environment cannot contain it.
      save(expected);
      assert.equal(
        resolveCredential(name).value,
        expected,
        "Preserve Unicode, quotes, whitespace and newlines",
      );
      const report = config.doctor();
      assert.equal(report.ok, true);
      assert.deepEqual(report.servers[0].credentials, [
        { name, available: true, source: "windows-user" },
      ]);
      const runtime = new HpcRuntime(config, { resume: false });
      try {
        assert.equal(runtime.ctx.secret(name), expected);
        assert.equal(runtime.clean({ output: expected }).output, "[REDACTED]");
      } finally {
        await runtime.close();
      }
      const first = await call("server_connect");
      assert.equal(first.isError, undefined);
      assert.ok(config.read().servers[0].hostKey);
      await call("server_disconnect");
      expected = "rotated-" + randomUUID();
      save(expected);
      const second = await call("server_connect");
      assert.equal(
        second.isError,
        undefined,
        "An existing MCP observes user credential rotation on reconnect",
      );
      assert.equal(
        JSON.stringify([first, second, report]).includes(expected),
        false,
      );
      assert.equal(stderr.includes(expected), false);
    } finally {
      await client?.close();
      for (const connection of clients) connection.end();
      await new Promise((ok) => server.close(ok));
      try {
        save(null);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
);
