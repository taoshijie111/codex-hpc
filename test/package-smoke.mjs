import test from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { unzipSync } from "fflate";

test("packaged plugin runs outside the source tree with only packaged production dependencies", async () => {
  const source = resolve("release/codex-hpc");
  assert.ok(existsSync(source), "Run npm run package:plugin first");
  const root = mkdtempSync(join(tmpdir(), "hpc-package-")),
    plugin = join(root, "codex-hpc");
  cpSync(source, plugin, { recursive: true });
  let client;
  try {
    assert.deepEqual(
      JSON.parse(readFileSync(join(plugin, "examples/config.json"), "utf8"))
        .servers,
      [],
    );
    const manifest = JSON.parse(
      readFileSync(join(plugin, ".codex-plugin/plugin.json"), "utf8"),
    );
    assert.equal(manifest.mcpServers, "./.mcp.json");
    assert.ok(existsSync(join(plugin, "skills/hpc/SKILL.md")));
    const require = createRequire(join(plugin, "package.json"));
    for (const dependency of [
      "ssh2",
      "@modelcontextprotocol/sdk/server/mcp.js",
      "zod",
      "proper-lockfile",
    ])
      assert.ok(require.resolve(dependency).startsWith(realpathSync(plugin)));
    const entry = JSON.parse(readFileSync(join(plugin, ".mcp.json"), "utf8"))
      .mcpServers.hpc;
    const args = [...entry.args];
    args.push("--config", join(root, "config.json"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args,
      cwd: resolve(plugin, entry.cwd ?? "."),
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr.on("data", (c) => (stderr += c));
    client = new Client({ name: "package-test", version: "1" });
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 20);
    assert.equal(
      (await client.callTool({ name: "server_list", arguments: {} })).isError,
      undefined,
    );
    const archive = unzipSync(
      readFileSync(resolve("release/codex-hpc-0.1.0-plugin.zip")),
    );
    assert.ok(archive["codex-hpc/.codex-plugin/plugin.json"]);
    assert.ok(archive["codex-hpc/node_modules/ssh2/package.json"]);
    assert.equal(
      readFileSync(join(plugin, "package.json"), "utf8").includes(
        "@deepseek-ai",
      ),
      false,
    );
  } finally {
    await client?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
