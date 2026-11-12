import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HpcRuntime } from "../dist/runtime.js";
import { ConfigStore } from "../dist/config.js";
import { fileClient, fakePool } from "./fixtures.mjs";
import { parseNodes } from "../dist/usage.js";

test("shutdown persists interrupted transfers; another runtime reads history", async () => {
  const root = mkdtempSync(join(tmpdir(), "hpc-stop-"));
  let a, b;
  try {
    mkdirSync(join(root, "remote"));
    const files = fileClient(join(root, "remote"));
    writeFileSync(files.remote("/a"), Buffer.alloc(1024 * 1024));
    const config = new ConfigStore(join(root, "config.json"));
    await config.update((c) => ({
      ...c,
      servers: [{ id: "s", host: "fake", username: "u", auth: "password" }],
    }));
    a = new HpcRuntime(config, { pool: fakePool(files.client), resume: false });
    const task = a.transfers.start(a.server("s"), {
      direction: "download",
      items: [{ source: "/a", targetDir: root }],
    });
    await a.close();
    a = undefined;
    b = new HpcRuntime(config, { pool: fakePool(files.client), resume: false });
    assert.equal(b.transfers.status(task.id)[0].state, "interrupted");
  } finally {
    await a?.close();
    await b?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("same-destination transfers exclude each other even within one MCP process", async () => {
  const root = mkdtempSync(join(tmpdir(), "hpc-lock-"));
  let runtime;
  try {
    mkdirSync(join(root, "remote"));
    const files = fileClient(join(root, "remote"));
    writeFileSync(files.remote("/a"), Buffer.alloc(2 * 1024 * 1024));
    const config = new ConfigStore(join(root, "config.json"));
    await config.update((c) => ({
      ...c,
      servers: [{ id: "s", host: "fake", username: "u", auth: "password" }],
    }));
    runtime = new HpcRuntime(config, {
      pool: fakePool(files.client),
      resume: false,
    });
    const spec = {
        direction: "download",
        items: [{ source: "/a", targetDir: root }],
      },
      a = runtime.transfers.start(runtime.server("s"), spec),
      b = runtime.transfers.start(runtime.server("s"), spec);
    const results = await Promise.all([
      runtime.transfers.wait(a.id),
      runtime.transfers.wait(b.id),
    ]);
    assert.deepEqual(results.map((x) => x.state).sort(), [
      "completed",
      "failed",
    ]);
    assert.match(
      results.find((x) => x.state === "failed").error,
      /owns this destination/,
    );
  } finally {
    await runtime?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("Slurm resource parser includes typed GPU resources", () => {
  const nodes = parseNodes(
    "NodeName=gpu01 State=MIXED CPUTot=32 CPUAlloc=8 RealMemory=131072 AllocMem=1024 FreeMem=100000 Gres=gpu:a100:4(S:0-1),gpu:h100:2(S:2) GresUsed=gpu:a100:2(IDX:0-1)",
  );
  assert.deepEqual(nodes.gpus, { total: 6, used: 2 });
  assert.equal(nodes.cpus.total, 32);
});
