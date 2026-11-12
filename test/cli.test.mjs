import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("CLI initializes, validates and diagnoses config without disclosing secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "hpc-cli-")),
    path = join(root, "config.json");
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), ...args, "--config", path],
      {
        encoding: "utf8",
        env: { ...process.env, HPC_CLI_TEST_SECRET: 'test-"secret\\value' },
      },
    );
  try {
    assert.equal(run("init").status, 0);
    assert.equal(run("config", "validate").status, 0);
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.servers = [
      {
        id: "test",
        host: "h",
        username: "u",
        auth: "password",
        passwordEnv: "HPC_CLI_TEST_SECRET",
      },
    ];
    writeFileSync(path, JSON.stringify(config));
    const healthy = run("doctor");
    assert.equal(healthy.status, 0);
    assert.equal(JSON.parse(healthy.stdout).servers[0].ok, true);
    assert.equal(healthy.stdout.includes("secret"), false);
    config.servers[0].passwordEnv = "HPC_CLI_TEST_MISSING";
    writeFileSync(path, JSON.stringify(config));
    const missing = run("doctor");
    assert.equal(missing.status, 1);
    assert.deepEqual(JSON.parse(missing.stdout).servers[0].missingEnv, [
      "HPC_CLI_TEST_MISSING",
    ]);
    assert.equal(run("init").status, 0);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).servers[0].host, "h");
    config.servers[0].password = "raw-secret-never-print";
    writeFileSync(path, JSON.stringify(config));
    const invalid = run("config", "validate");
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stderr.includes("raw-secret-never-print"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
