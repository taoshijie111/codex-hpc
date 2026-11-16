import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ConfigStore } from "../dist/config.js";
import { HpcRuntime } from "../dist/runtime.js";
import { createMcpServer } from "../dist/mcp.js";
import { fakePool, response } from "./fixtures.mjs";

test("real stdio initialization, tools/list, validation, structured errors and clean EOF", async () => {
  const root = mkdtempSync(join(tmpdir(), "hpc-stdio-")),
    config = join(root, "config.json");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/cli.js"), "serve", "--config", config],
    env: { ...process.env, CODEX_HPC_HOME: root },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr.on("data", (chunk) => (stderr += chunk));
  const client = new Client({ name: "test", version: "1" });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().name, "codex-hpc");
    assert.match(client.getInstructions(), /job_wait/);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 21);
    assert.equal(
      tools.find((x) => x.name === "shell_run").annotations.readOnlyHint,
      false,
    );
    assert.equal(
      tools.find((x) => x.name === "transfer_queue").inputSchema.properties
        .items.type,
      "array",
    );
    assert.deepEqual(
      (await client.callTool({ name: "server_list", arguments: {} }))
        .structuredContent.servers,
      [],
    );
    const added = await client.callTool({
      name: "server_add",
      arguments: {
        id: "test",
        host: "127.0.0.1",
        username: "u",
        auth: "password",
        passwordEnv: "HPC_TEST_MISSING_SECRET",
      },
    });
    assert.equal(added.structuredContent.server.id, "test");
    const missing = await client.callTool({
      name: "server_connect",
      arguments: { server: "test" },
    });
    assert.equal(missing.isError, true);
    assert.equal(missing.structuredContent.error.code, "CREDENTIAL_MISSING");
    const invalid = await client.callTool({
      name: "job_wait",
      arguments: { jobId: "x", timeoutMs: 30001 },
    });
    assert.equal(invalid.isError, true);
    const secret = await client.callTool({
      name: "server_add",
      arguments: {
        id: "bad",
        host: "h",
        username: "u",
        auth: "password",
        password: "dont-log-me",
      },
    });
    assert.equal(secret.isError, true);
    assert.equal(JSON.stringify(secret).includes("dont-log-me"), false);
    const unknown = await client.callTool({
      name: "job_logs",
      arguments: { jobId: "missing" },
    });
    assert.equal(unknown.structuredContent.error.code, "JOB_NOT_FOUND");
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(stderr.includes("dont-log-me"), false);
});
test("bounded job_wait returns before a slow refresh, and runtime redaction handles quoted secrets", async () => {
  const root = mkdtempSync(join(tmpdir(), "hpc-wait-")),
    config = new ConfigStore(join(root, "config.json"));
  let runtime, client, mcp;
  try {
    await config.update((c) => ({
      ...c,
      servers: [
        { id: "s", host: "h", username: "u", auth: "password", kind: "bare" },
      ],
    }));
    const pool = fakePool({
      exec: (_cmd, cb) => setTimeout(() => response(cb, "ALIVE:100\n"), 100),
      end: () => {},
    });
    runtime = new HpcRuntime(config, { pool, resume: false });
    runtime.store.saveJob({
      id: "j",
      server: "s",
      backend: "bare",
      state: "running",
      submission: "submitted",
      pid: 3,
      pidStart: "100",
      createdAt: "2026",
      exitPath: "/x.exit",
    });
    runtime.rememberSecret('"\\42');
    assert.deepEqual(runtime.clean({ x: 'prefix "\\42 suffix', n: 42 }), {
      x: "prefix [REDACTED] suffix",
      n: 42,
    });
    mcp = createMcpServer(runtime);
    client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await mcp.connect(b);
    await client.connect(a);
    const start = Date.now();
    const result = await client.callTool({
      name: "job_wait",
      arguments: { jobId: "j", timeoutMs: 15 },
    });
    assert.equal(result.structuredContent.timedOut, true);
    assert.ok(Date.now() - start < 90);
  } finally {
    await client?.close();
    await mcp?.close();
    await runtime?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
