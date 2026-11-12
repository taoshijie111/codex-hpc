import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { StateStore } from "../dist/state.js";
import {
  submitJob,
  refreshJob,
  cancelJob,
  readJobLogs,
} from "../dist/core/jobs.js";
import { response, commandBody, fakePool } from "./fixtures.mjs";

function scheduler(t, { uncertain = false, bare = false } = {}) {
  const store = new StateStore(":memory:", "jobs");
  t.after(() => store.close());
  let submissions = 0;
  const scripts = [],
    commands = [];
  const client = new EventEmitter();
  const spec = {
    id: "s",
    host: "fake",
    username: "u",
    auth: "password",
    kind: bare ? "bare" : "slurm",
  };
  client.exec = (wrapped, cb) => {
    const body = commandBody(wrapped);
    commands.push(body);
    if (body === 'printf %s "$HOME"') return response(cb, "/home/u");
    if (body.startsWith("mkdir")) return response(cb, "");
    if (body.startsWith("umask")) {
      scripts.push(
        Buffer.from(/printf %s '([^']+)'/.exec(body)[1], "base64").toString(),
      );
      return response(cb, "");
    }
    if (body.startsWith("sbatch")) {
      submissions++;
      return response(cb, uncertain ? "" : "42\n", uncertain ? null : 0);
    }
    if (body.startsWith("setsid")) {
      submissions++;
      return response(cb, "");
    }
    if (body.startsWith("cat ") && body.includes(".pid"))
      return response(cb, "1234:50000\n");
    if (body.startsWith("squeue -h --name")) return response(cb, "42\n42\n");
    if (body.startsWith("squeue -h -j")) return response(cb, "RUNNING\n");
    if (body.includes('echo "EXIT:')) return response(cb, "ALIVE:99999\n");
    if (body.startsWith("tail -n")) return response(cb, "process exited");
    if (body.includes("echo MATCH")) return response(cb, "", 1);
    return response(cb, "", 0);
  };
  const ctx = { store, secret: () => undefined, pinHost: async () => {} },
    pool = fakePool(client);
  return {
    ctx,
    pool,
    spec,
    scripts,
    commands,
    get submissions() {
      return submissions;
    },
  };
}
test("uncertain Slurm submission is durable and recovered by name without relaunch", async (t) => {
  const f = scheduler(t, { uncertain: true });
  await assert.rejects(
    submitJob(f.ctx, f.pool, f.spec, {
      command: "python train.py",
      workdir: "/home/u/project",
      requestId: "stable",
    }),
    (e) => e.code === "SUBMISSION_UNCERTAIN",
  );
  const [pending] = f.ctx.store.listJobs();
  assert.equal(pending.submission, "uncertain");
  assert.equal(pending.state, "unknown");
  const recovered = await refreshJob(f.ctx, f.pool, f.spec, pending);
  assert.equal(recovered.schedulerJobId, "42");
  assert.equal(recovered.state, "running");
  await submitJob(f.ctx, f.pool, f.spec, {
    command: "python train.py",
    workdir: "/home/u/project",
    requestId: "stable",
  });
  assert.equal(f.submissions, 1);
  await assert.rejects(
    submitJob(f.ctx, f.pool, f.spec, {
      command: "different",
      workdir: "/home/u/project",
      requestId: "stable",
    }),
    (e) => e.code === "REQUEST_ID_CONFLICT",
  );
});
test("bare job wraps exit/set-e and cancellation never signals a reused PID", async (t) => {
  const f = scheduler(t, { bare: true }),
    job = await submitJob(f.ctx, f.pool, f.spec, {
      script: "set -e\nexit 7",
      workdir: "/home/u",
    });
  assert.equal(job.pid, 1234);
  assert.equal(job.pidStart, "50000");
  assert.match(f.scripts[0], /bash --noprofile --norc -c/);
  assert.ok(
    f.scripts[0].indexOf("echo $__mss_rc") > f.scripts[0].indexOf("exit 7"),
  );
  const result = await cancelJob(f.ctx, f.pool, f.spec, job);
  assert.equal(result.state, "lost");
  assert.equal(
    f.commands.some((c) => /kill -TERM|kill -KILL/.test(c)),
    false,
  );
});
test("explicit unsupported schedulers cannot fall back to bare-metal submission", async (t) => {
  const f = scheduler(t);
  for (const kind of ["pbs", "lsf"])
    await assert.rejects(
      submitJob(
        f.ctx,
        f.pool,
        { ...f.spec, kind },
        { command: "echo x", workdir: "/home/u" },
      ),
      (e) => e.code === "UNSUPPORTED_SCHEDULER",
    );
  assert.equal(f.submissions, 0);
});
test("incremental logs preserve split UTF-8 characters and raw byte offsets", async (t) => {
  const f = scheduler(t),
    bytes = Buffer.from("中文hello");
  const client = {
    exec: (wrapped, cb) => {
      const body = commandBody(wrapped);
      if (body.includes("tail -c")) {
        const offset = Number(/tail -c \+(\d+)/.exec(body)[1]) - 1,
          max = Number(/head -c (\d+)/.exec(body)[1]);
        return response(
          cb,
          bytes.subarray(offset, offset + max).toString("base64"),
        );
      }
      return response(cb, String(bytes.length));
    },
  };
  const pool = fakePool(client),
    record = { outPath: "/x", errPath: "/e" };
  const first = await readJobLogs(f.ctx, pool, f.spec, record, { maxBytes: 4 });
  assert.equal(first.text, "中");
  assert.equal(first.nextOffset, 3);
  assert.equal(first.truncated, true);
  const second = await readJobLogs(f.ctx, pool, f.spec, record, {
    offset: first.nextOffset,
    maxBytes: 4,
  });
  assert.equal(second.text, "文h");
  assert.equal(second.nextOffset, 7);
});
