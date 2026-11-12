#!/usr/bin/env node
import { existsSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigStore } from "./config.js";
import { HpcRuntime } from "./runtime.js";
import { createMcpServer } from "./mcp.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const index = args.indexOf("--config");
  let path: string | undefined;
  if (index >= 0) {
    path = args[index + 1];
    if (!path || path.startsWith("--"))
      throw new Error("--config needs a path");
    args.splice(index, 2);
  }
  if (args.includes("--help") || args.length === 0) {
    console.log(
      "codex-hpc serve | init | config validate | doctor [--config PATH]\nRequires Node.js 24. Use serve as the MCP launch command.",
    );
    return;
  }
  const config = new ConfigStore(path);
  const command = args.join(" ");
  if (command === "init") {
    const existed = existsSync(config.path);
    await config.update((c) => c);
    console.log(JSON.stringify({ configPath: config.path, created: !existed }));
    return;
  }
  if (command === "config validate") {
    const c = config.read();
    if (!existsSync(config.path))
      throw new Error(`Config does not exist: ${config.path}; run init first`);
    console.log(
      JSON.stringify({
        valid: true,
        configPath: config.path,
        servers: c.servers.length,
      }),
    );
    return;
  }
  if (command === "doctor") {
    const info = config.doctor(),
      nodeOk = Number(process.versions.node.split(".")[0]) === 24;
    const result = {
      ...info,
      ok: info.ok && nodeOk,
      node: process.versions.node,
      nodeOk,
      configExists: existsSync(config.path),
    };
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command !== "serve") throw new Error("Unknown command; use --help");
  if (Number(process.versions.node.split(".")[0]) !== 24)
    throw new Error("codex-hpc requires Node.js 24");
  const runtime = new HpcRuntime(config),
    mcp = createMcpServer(runtime);
  const log = (error: unknown) =>
    console.error(runtime.redact((error as Error).message));
  mcp.server.onclose = () => {
    void runtime.close().catch(log);
  };
  const stop = async () => {
    await mcp.close();
    await runtime.close();
  };
  process.once("SIGINT", () => {
    void stop().catch(log);
  });
  process.once("SIGTERM", () => {
    void stop().catch(log);
  });
  try {
    await mcp.connect(new StdioServerTransport());
  } catch (error) {
    await runtime.close();
    throw error;
  }
}
void main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
