import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadWithResume, downloadWithResume } from "../dist/core/transfer.js";
import { fileClient, fakePool } from "./fixtures.mjs";
import { HpcRuntime } from "../dist/runtime.js";
import { ConfigStore } from "../dist/config.js";

function setup(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "hpc-xfer-")),
    dispose = [];
  t.after(async () => {
    for (const close of dispose) await close();
    rmSync(root, { recursive: true, force: true });
  });
  const local = join(root, "本地 文件"),
    remoteRoot = join(root, "remote");
  mkdirSync(local);
  mkdirSync(remoteRoot);
  return { root, local, dispose, ...fileClient(remoteRoot, options) };
}
test("binary and directory transfers preserve contents and empty directories, both ways", async (t) => {
  const f = setup(t),
    source = join(f.local, "目录");
  mkdirSync(join(source, "空目录"), { recursive: true });
  const bytes = Buffer.from(Array.from({ length: 4097 }, (_, i) => i % 256));
  writeFileSync(join(source, "数据.bin"), bytes);
  const up = await uploadWithResume(f.client, source, "/输入 目录", {
    overwrite: false,
  });
  assert.equal(up.verified, true);
  assert.equal(up.files, 1);
  assert.ok(existsSync(f.remote("/输入 目录/空目录")));
  const destination = join(f.local, "download");
  await downloadWithResume(f.client, "/输入 目录", destination, {
    overwrite: false,
  });
  assert.deepEqual(readFileSync(join(destination, "数据.bin")), bytes);
  assert.ok(existsSync(join(destination, "空目录")));
  assert.equal(
    (
      await uploadWithResume(f.client, source, "/输入 目录", {
        overwrite: false,
      })
    ).skipped,
    true,
  );
  assert.equal(f.getClosed(), 3);
});
test("different sizes cannot bypass overwrite; successful overwrite is staged", async (t) => {
  const f = setup(t),
    local = join(f.local, "a");
  writeFileSync(local, "long source");
  writeFileSync(f.remote("/a"), "old");
  await assert.rejects(
    uploadWithResume(f.client, local, "/a", { overwrite: false }),
    (e) => e.code === "TARGET_EXISTS",
  );
  assert.equal(readFileSync(f.remote("/a"), "utf8"), "old");
  await uploadWithResume(f.client, local, "/a", { overwrite: true });
  assert.equal(readFileSync(f.remote("/a"), "utf8"), "long source");
  writeFileSync(local, "x");
  await assert.rejects(
    downloadWithResume(f.client, "/a", local, { overwrite: false }),
    (e) => e.code === "TARGET_EXISTS",
  );
  assert.equal(readFileSync(local, "utf8"), "x");
  await downloadWithResume(f.client, "/a", local, { overwrite: true });
  assert.equal(readFileSync(local, "utf8"), "long source");
});
test("SHA mismatch and unavailable atomic replacement preserve existing target", async (t) => {
  const f = setup(t, { corrupt: true }),
    local = join(f.local, "a");
  writeFileSync(local, "new");
  writeFileSync(f.remote("/a"), "original");
  await assert.rejects(
    uploadWithResume(f.client, local, "/a", { overwrite: true }),
    (e) => e.code === "CHECKSUM_MISMATCH",
  );
  assert.equal(readFileSync(f.remote("/a"), "utf8"), "original");
  const good = fileClient(join(f.root, "remote"));
  good.sftp.ext_openssh_rename = (_a, _b, cb) => cb(new Error("unsupported"));
  await assert.rejects(
    uploadWithResume(good.client, local, "/a", { overwrite: true }),
    (e) => e.code === "ATOMIC_RENAME_UNAVAILABLE",
  );
  assert.equal(readFileSync(f.remote("/a"), "utf8"), "original");
  assert.ok(existsSync(f.remote("/a.part")));
});
test("resume works in both directions including already complete staging files", async (t) => {
  const f = setup(t),
    local = join(f.local, "a"),
    bytes = Buffer.alloc(700000, 7);
  writeFileSync(local, bytes);
  writeFileSync(f.remote("/a.part"), bytes.subarray(0, 12345));
  const up = await uploadWithResume(f.client, local, "/a", {
    overwrite: false,
  });
  assert.equal(up.resumed, true);
  assert.equal(up.bytes, bytes.length - 12345);
  const out = join(f.local, "b");
  writeFileSync(out + ".part", bytes.subarray(0, 32123));
  const down = await downloadWithResume(f.client, "/a", out, {
    overwrite: false,
  });
  assert.equal(down.resumed, true);
  assert.deepEqual(readFileSync(out), bytes);
  writeFileSync(f.remote("/c.part"), bytes);
  const complete = await uploadWithResume(f.client, local, "/c", {
    overwrite: false,
  });
  assert.equal(complete.bytes, 0);
  assert.deepEqual(readFileSync(f.remote("/c")), bytes);
});
test("active download cancellation closes streams and retains resumable staging", async (t) => {
  const f = setup(t),
    bytes = Buffer.alloc(4 * 1024 * 1024, 9);
  writeFileSync(f.remote("/a"), bytes);
  const out = join(f.local, "a"),
    controller = new AbortController();
  await assert.rejects(
    downloadWithResume(f.client, "/a", out, {
      overwrite: false,
      chunkSize: 65536,
      signal: controller.signal,
      onProgress: (b) => {
        if (b > 512 * 1024) controller.abort();
      },
    }),
  );
  assert.equal(existsSync(out), false);
  assert.ok(statSync(out + ".part").size < bytes.length);
  await downloadWithResume(f.client, "/a", out, { overwrite: false });
  assert.deepEqual(readFileSync(out), bytes);
});
test("background download uses correct paths; queue failure and durable status", async (t) => {
  const f = setup(t),
    config = new ConfigStore(join(f.root, "config.json"));
  await config.update((c) => ({
    ...c,
    servers: [{ id: "srv", host: "fake", username: "u", auth: "password" }],
  }));
  writeFileSync(f.remote("/a"), "downloaded");
  const pool = fakePool(f.client),
    runtime = new HpcRuntime(config, { pool, resume: false });
  f.dispose.push(() => runtime.close());
  const started = runtime.transfers.start(runtime.server("srv"), {
    direction: "download",
    items: [{ source: "/a", targetDir: f.local }],
  });
  const finished = await runtime.transfers.wait(started.id);
  assert.equal(finished.state, "completed");
  assert.equal(readFileSync(join(f.local, "a"), "utf8"), "downloaded");
  assert.equal(pool.holds, 0);
  const q = runtime.transfers.start(runtime.server("srv"), {
    direction: "download",
    items: [
      { source: "/missing", targetDir: f.local },
      { source: "/a", targetDir: f.local },
    ],
    continueOnError: true,
  });
  const result = await runtime.transfers.wait(q.id);
  assert.equal(result.state, "failed");
  assert.deepEqual(
    result.result.items.map((x) => x.ok),
    [false, true],
  );
});
