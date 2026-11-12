import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../dist/config.js";
import { HpcRuntime } from "../dist/runtime.js";
import { execRemote } from "../dist/core/ssh.js";
import { submitJob } from "../dist/core/jobs.js";
import { uploadWithResume, downloadWithResume } from "../dist/core/transfer.js";
import { shellQuote } from "../dist/core/types.js";
import { isTerminal } from "../dist/core/watch.js";

const enabled = Boolean(
  process.env.HPC_TEST_HOST &&
  process.env.HPC_TEST_USER &&
  (process.env.HPC_TEST_PASSWORD || process.env.HPC_TEST_KEY_PATH),
);
test(
  "opt-in live SSH, persistent shell, transfer and scheduler/bare job",
  { skip: !enabled, timeout: 180000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "hpc-live-")),
      config = new ConfigStore(join(root, "config.json"));
    let runtime, remote, job;
    try {
      await config.update((c) => ({
        ...c,
        servers: [
          {
            id: "live",
            host: process.env.HPC_TEST_HOST,
            port: Number(process.env.HPC_TEST_PORT ?? 22),
            username: process.env.HPC_TEST_USER,
            auth: process.env.HPC_TEST_KEY_PATH ? "key" : "password",
            keyPath: process.env.HPC_TEST_KEY_PATH,
            passwordEnv: "HPC_TEST_PASSWORD",
            kind: process.env.HPC_TEST_KIND ?? "auto",
          },
        ],
      }));
      runtime = new HpcRuntime(config, { resume: false });
      const spec = runtime.server("live"),
        { client } = await runtime.pool.ensure(runtime.ctx, spec);
      const home = (
        await execRemote(client, 'printf %s "$HOME"', { timeoutMs: 15000 })
      ).stdout.trim();
      assert.ok(home.startsWith("/"));
      remote = home + "/.codex-hpc-test-" + randomUUID();
      await execRemote(client, `mkdir -p ${shellQuote(remote)}`, {
        timeoutMs: 15000,
      });
      await runtime.sessions.run(
        runtime.ctx,
        config.read(),
        "live",
        `cd ${shellQuote(remote)}; export HPC_LIVE_STATE=retained`,
        { timeoutMs: 10000 },
      );
      const state = await runtime.sessions.run(
        runtime.ctx,
        config.read(),
        "live",
        'printf "%s:%s" "$PWD" "$HPC_LIVE_STATE"',
        { timeoutMs: 10000 },
      );
      assert.equal(state.stdout, remote + ":retained");
      const file = join(root, "binary.bin"),
        bytes = Buffer.alloc(4099, 123);
      writeFileSync(file, bytes);
      await uploadWithResume(client, file, remote + "/binary.bin", {
        overwrite: false,
      });
      await downloadWithResume(
        client,
        remote + "/binary.bin",
        join(root, "download.bin"),
        { overwrite: false },
      );
      assert.deepEqual(readFileSync(join(root, "download.bin")), bytes);
      job = await submitJob(
        runtime.ctx,
        runtime.pool,
        { ...runtime.server("live"), jobRoot: remote + "/jobs" },
        {
          command: "sleep 1; echo HPC_OK",
          workdir: remote,
          requestId: randomUUID(),
        },
      );
      const until = Date.now() + 120000;
      while (!isTerminal(job.state) && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 1000));
        job = await runtime.refresh(job.id);
      }
      assert.equal(job.state, "completed");
      assert.equal(job.exitCode, 0);
    } finally {
      if (runtime && remote) {
        if (job && !isTerminal(job.state))
          await runtime.cancel(job.id).catch(() => {});
        const state = await runtime.pool
          .ensure(runtime.ctx, runtime.server("live"))
          .catch(() => null);
        if (state) {
          const paths = [
            remote + "/binary.bin",
            ...(job
              ? [
                  job.scriptPath,
                  job.outPath,
                  job.errPath,
                  job.exitPath,
                  `${job.jobRoot}/${job.id}.pid`,
                ].filter(Boolean)
              : []),
          ];
          await execRemote(
            state.client,
            `rm -f -- ${paths.map(shellQuote).join(" ")}; rmdir -- ${shellQuote(remote + "/jobs")} ${shellQuote(remote)} 2>/dev/null || true`,
            { timeoutMs: 15000 },
          ).catch(() => {});
        }
      }
      await runtime?.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
