import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../dist/config.js";
import { StateStore } from "../dist/state.js";
import { ConnectionPool } from "../dist/core/pool.js";
import { EventEmitter } from "node:events";

function temporary(t) {
  const path = mkdtempSync(join(tmpdir(), "hpc-config-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
test("locked config updates preserve concurrent writes; raw secrets and invalid resources are rejected", async (t) => {
  const root = temporary(t),
    a = new ConfigStore(join(root, "config.json")),
    b = new ConfigStore(a.path);
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      (i % 2 ? a : b).update((c) => ({
        ...c,
        servers: [
          ...c.servers,
          { id: "s" + i, host: "h", username: "u", auth: "password" },
        ],
      })),
    ),
  );
  assert.equal(a.read().servers.length, 8);
  assert.equal(JSON.parse(readFileSync(a.path)).servers.length, 8);
  await assert.rejects(
    a.update((c) => ({
      ...c,
      servers: [
        {
          id: "s",
          host: "h",
          username: "u",
          auth: "password",
          password: "secret",
        },
      ],
    })),
  );
  await assert.rejects(
    a.update((c) => ({
      ...c,
      servers: [
        {
          id: "s",
          host: "h",
          username: "u",
          auth: "password",
          schedulerDefaults: { partition: "gpu\n#SBATCH --x" },
        },
      ],
    })),
  );
});
test("SQLite persists history, rejects stale writes and arbitrates process leases", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hpc-config-")),
    path = join(root, "state.db"),
    a = new StateStore(path, "scope"),
    b = new StateStore(path, "scope");
  t.after(() => {
    a.close();
    b.close();
    rmSync(root, { recursive: true, force: true });
  });
  a.saveJob({
    id: "job",
    server: "s",
    createdAt: "2026-01-01",
    state: "running",
  });
  const stale = a.getJob("job"),
    fresh = b.getJob("job");
  fresh.state = "completed";
  b.saveJob(fresh);
  stale.state = "running";
  assert.throws(
    () => a.saveJob(stale),
    (e) => e.code === "STATE_CONFLICT",
  );
  assert.equal(a.getJob("job").state, "completed");
  assert.equal(a.lease("job", "owner-a"), true);
  assert.equal(b.lease("job", "owner-b"), false);
  a.release("job", "owner-a");
  assert.equal(b.lease("job", "owner-b"), true);
  const third = new StateStore(path, "scope");
  assert.equal(third.getJob("job").state, "completed");
  third.close();
});
test("concurrent SSH connection requests coalesce and changed endpoints invalidate a connection", async () => {
  let count = 0,
    ended = 0;
  const pool = new ConnectionPool({
    connectTimeoutMs: () => 100,
    idleTimeoutMs: () => 0,
    keepaliveIntervalMs: () => 0,
    connect: async () => {
      count++;
      await new Promise((r) => setTimeout(r, 10));
      const client = new EventEmitter();
      client.end = () => {
        ended++;
        client.emit("close");
      };
      return { client, fingerprint: "SHA256:test", close: () => client.end() };
    },
  });
  try {
    const spec = { id: "s", host: "a", username: "u", auth: "password" };
    await Promise.all(Array.from({ length: 10 }, () => pool.ensure({}, spec)));
    assert.equal(count, 1);
    await pool.ensure({}, spec);
    assert.equal(count, 1);
    await pool.ensure({}, { ...spec, host: "b" });
    assert.equal(count, 2);
    assert.equal(ended, 1);
  } finally {
    await pool.closeAll();
  }
});
