import { randomBytes, createHash, randomUUID } from "node:crypto";
import type { CoreContext } from "./context.js";
import {
  applySlurmEscalation,
  classifyBare,
  classifySlurmScontrol,
  mapSlurmState,
  planSlurmPoll,
  type Verdict,
} from "./jobstate.js";
import type { ConnectionPool } from "./pool.js";
import { execRemote } from "./ssh.js";
import { HpcError, shellQuote, type Config, type ServerSpec } from "./types.js";

export type JobBackend = "bare" | "slurm";
export type ResolvedBackend = "bare" | "slurm" | "pbs" | "lsf";
export type JobState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "lost"
  | "unknown";

export type JobResources = {
  partition?: string;
  account?: string;
  qos?: string;
  time?: string;
  cpusPerTask?: number;
  memory?: string;
  gpus?: number;
};

export type JobSpec = {
  command?: string;
  script?: string;
  workdir: string;
  name?: string;
  resources?: JobResources;
  requestId?: string;
};

export type JobRecord = {
  id: string;
  server: string;
  backend: JobBackend;
  schedulerJobId?: string;
  name: string;
  command: string;
  workdir: string;
  resources: Required<Pick<JobResources, never>> & JobResources;
  jobRoot: string;
  scriptPath: string;
  outPath: string;
  errPath: string;
  exitPath?: string;
  pid?: number;
  pidStart?: string;
  state: JobState;
  exitCode?: number | null;
  /** Consecutive polls that could not resolve a state (drives the escalation). */
  unknownPolls?: number;
  /** Explanation stored when a job ends ambiguously (surfaced in the job output). */
  note?: string;
  /** Optimistic SQLite revision and durable submission phase. */
  revision?: number;
  submission?: "prepared" | "uncertain" | "submitted";
  requestId?: string;
  createdAt: string;
  lastCheckedAt: string;
};

function jobId(): string {
  return `hpc-${randomBytes(6).toString("hex")}`;
}

function jobName(serverId: string, requested?: string): string {
  const base = (requested ?? serverId)
    .replace(/[^A-Za-z0-9_.-]/g, "-")
    .slice(0, 40);
  return `hpc-${base}-${randomBytes(3).toString("hex")}`;
}

/** Resolve the backend for a server: explicit kind, cached detection, or a fresh probe. */
export async function resolveBackend(
  ctx: CoreContext,
  pool: ConnectionPool,
  server: ServerSpec,
  persist?: (backend: ResolvedBackend) => Promise<void>,
): Promise<JobBackend> {
  if (server.kind === "bare" || server.kind === "slurm") return server.kind;
  if (server.kind === "pbs" || server.kind === "lsf")
    throw new HpcError(
      `Job submission for ${server.kind} is not supported`,
      "UNSUPPORTED_SCHEDULER",
    );
  if (server.resolvedKind === "pbs" || server.resolvedKind === "lsf")
    throw new HpcError(
      `Job submission for ${server.resolvedKind} is not supported`,
      "UNSUPPORTED_SCHEDULER",
    );
  if (server.resolvedKind === "bare" || server.resolvedKind === "slurm")
    return server.resolvedKind;
  const state = await pool.ensure(ctx, server);
  const result = await execRemote(
    state.client,
    [
      "if command -v scontrol >/dev/null 2>&1 || (command -v sbatch >/dev/null 2>&1 && command -v squeue >/dev/null 2>&1); then echo slurm",
      "elif command -v qsub >/dev/null 2>&1 || command -v qstat >/dev/null 2>&1; then echo pbs",
      "elif command -v bsub >/dev/null 2>&1 || command -v bjobs >/dev/null 2>&1; then echo lsf",
      "else echo bare; fi",
    ].join(String.fromCharCode(10)),
    { timeoutMs: 15_000 },
  );
  const detected = result.stdout.trim();
  if (detected === "pbs" || detected === "lsf") {
    await persist?.(detected);
    throw new HpcError(
      `Server "${server.id}" runs ${detected.toUpperCase()}; job submission currently supports Slurm and bare metal only.`,
    );
  }
  const backend: JobBackend = detected === "slurm" ? "slurm" : "bare";
  await persist?.(backend);
  return backend;
}

async function remoteHome(
  ctx: CoreContext,
  pool: ConnectionPool,
  server: ServerSpec,
): Promise<string> {
  const state = await pool.ensure(ctx, server);
  const result = await execRemote(state.client, 'printf %s "$HOME"', {
    timeoutMs: 15_000,
  });
  const home = result.stdout.trim();
  if (!home.startsWith("/"))
    throw new HpcError(`Could not resolve HOME on ${server.id}`);
  return home;
}

function expandPath(path: string, home: string): string {
  return path.startsWith("~/") ? `${home}/${path.slice(2)}` : path;
}

function jobRootFor(server: ServerSpec, home: string): string {
  return expandPath(server.jobRoot ?? "~/.hpc/jobs", home);
}

function mergedResources(
  server: ServerSpec,
  overrides?: JobResources,
): JobResources {
  return { ...(server.schedulerDefaults ?? {}), ...(overrides ?? {}) };
}

function scriptForBare(record: JobRecord): string {
  return [
    "#!/bin/bash",
    `cd ${shellQuote(record.workdir)} || exit 127`,
    `bash --noprofile --norc -c ${shellQuote(record.command)}`,
    "__mss_rc=$?",
    `echo $__mss_rc > ${shellQuote(record.exitPath!)}`,
    "exit $__mss_rc",
    "",
  ].join("\n");
}

function sbatchLines(record: JobRecord): string {
  const lines = [
    "#!/bin/bash",
    `#SBATCH --job-name=${record.name}`,
    `#SBATCH --chdir=${shellQuote(record.workdir)}`,
    `#SBATCH --output=${shellQuote(record.outPath)}`,
    `#SBATCH --error=${shellQuote(record.errPath)}`,
  ];
  const r = record.resources;
  if (r.partition) lines.push(`#SBATCH --partition=${shellQuote(r.partition)}`);
  if (r.account) lines.push(`#SBATCH --account=${shellQuote(r.account)}`);
  if (r.qos) lines.push(`#SBATCH --qos=${shellQuote(r.qos)}`);
  if (r.time) lines.push(`#SBATCH --time=${shellQuote(r.time)}`);
  if (r.cpusPerTask) lines.push(`#SBATCH --cpus-per-task=${r.cpusPerTask}`);
  if (r.memory) lines.push(`#SBATCH --mem=${shellQuote(r.memory)}`);
  if (r.gpus) lines.push(`#SBATCH --gres=gpu:${r.gpus}`);
  lines.push("", record.command, "");
  return lines.join("\n");
}

async function writeRemoteFile(
  ctx: CoreContext,
  pool: ConnectionPool,
  server: ServerSpec,
  path: string,
  content: string,
): Promise<void> {
  const state = await pool.ensure(ctx, server);
  const encoded = Buffer.from(content, "utf8").toString("base64");
  const result = await execRemote(
    state.client,
    `umask 077; printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(path)} && chmod 700 ${shellQuote(path)}`,
    { timeoutMs: 30_000 },
  );
  if (result.code !== 0)
    throw new HpcError(
      `Could not write remote script: ${result.stderr.trim()}`,
    );
}

export async function submitJob(
  ctx: CoreContext,
  pool: ConnectionPool,
  server: ServerSpec,
  spec: JobSpec,
  persistBackend?: (backend: ResolvedBackend) => Promise<void>,
): Promise<JobRecord> {
  const command =
    (spec.script ? `bash ${shellQuote("<script>")}` : spec.command) ?? "";
  if (!spec.script && !spec.command)
    throw new HpcError("job_submit needs command or script");
  if (!spec.workdir.startsWith("/"))
    throw new HpcError("workdir must be absolute");

  const backend = await resolveBackend(ctx, pool, server, persistBackend);
  const home = await remoteHome(ctx, pool, server);
  const root = jobRootFor(server, home);
  const id = spec.requestId
    ? `hpc-${createHash("sha256")
        .update(server.id + ":" + spec.requestId)
        .digest("hex")
        .slice(0, 24)}`
    : jobId();
  const existing = ctx.store.getJob(id);
  if (existing) {
    if (
      existing.command !== (spec.script ?? spec.command ?? "") ||
      existing.workdir !== spec.workdir
    )
      throw new HpcError(
        "requestId already belongs to a different command or workdir",
        "REQUEST_ID_CONFLICT",
      );
    return ctx.store.isLeased(`submission:${id}`)
      ? existing
      : refreshJob(ctx, pool, server, existing);
  }
  const name = jobName(server.id, spec.name);
  const record: JobRecord = {
    id,
    server: server.id,
    backend,
    name,
    command: spec.script ?? spec.command ?? "",
    workdir: spec.workdir,
    resources: mergedResources(server, spec.resources),
    jobRoot: root,
    scriptPath: `${root}/${id}.sh`,
    outPath: `${root}/${id}.out`,
    errPath: `${root}/${id}.err`,
    ...(backend === "bare" ? { exitPath: `${root}/${id}.exit` } : {}),
    state: "unknown",
    submission: "prepared",
    ...(spec.requestId ? { requestId: spec.requestId } : {}),
    createdAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
  };
  const attemptOwner = randomUUID();
  if (!ctx.store.lease(`submission:${id}`, attemptOwner))
    throw new HpcError(
      `Submission ${id} is already in progress; query job_status`,
      "SUBMISSION_BUSY",
    );
  try {
    ctx.store.saveJob(record);
    const state = await pool.ensure(ctx, server);
    const mkdir = await execRemote(
      state.client,
      `mkdir -p ${shellQuote(root)}`,
      { timeoutMs: 15_000 },
    );
    if (mkdir.code !== 0)
      throw new HpcError(
        `Cannot create job directory ${root}: ${mkdir.stderr.trim()}`,
      );

    if (backend === "bare") {
      await writeRemoteFile(
        ctx,
        pool,
        server,
        record.scriptPath,
        scriptForBare(record),
      );
      const pidPath = `${root}/${id}.pid`;
      // The channel may stay open as long as the detached child holds inherited fds,
      // so cap the wait and read the pid from its file instead of the channel tail.
      record.submission = "uncertain";
      ctx.store.saveJob(record);
      const launch = await execRemote(
        state.client,
        `setsid nohup bash ${shellQuote(record.scriptPath)} > ${shellQuote(record.outPath)} 2> ${shellQuote(record.errPath)} < /dev/null & p=$!; t=$(awk '{print $22}' /proc/$p/stat 2>/dev/null); printf '%s:%s\\n' "$p" "$t" > ${shellQuote(pidPath)}`,
        { timeoutMs: 6_000 },
      );
      const pidRead = await execRemote(
        state.client,
        `cat ${shellQuote(pidPath)} 2>/dev/null || true`,
        { timeoutMs: 10_000 },
      );
      const [pidText, startedText] = pidRead.stdout.trim().split(":");
      const pid = Number(pidText);
      if (!Number.isInteger(pid) || pid <= 0)
        throw new HpcError(
          `Could not start background job: ${launch.stderr.trim()}`,
        );
      record.pid = pid;
      record.pidStart = startedText || undefined;
      record.state = "running";
    } else {
      record.command = spec.script ?? spec.command ?? "";
      await writeRemoteFile(
        ctx,
        pool,
        server,
        record.scriptPath,
        sbatchLines(record),
      );
      record.submission = "uncertain";
      ctx.store.saveJob(record);
      const submit = await execRemote(
        state.client,
        `sbatch --parsable ${shellQuote(record.scriptPath)}`,
        {
          timeoutMs: 30_000,
        },
      );
      if (submit.code !== 0) {
        if (!submit.timedOut && submit.code !== null) {
          record.state = "failed";
          record.note = "sbatch rejected submission";
          ctx.store.saveJob(record);
        }
        throw new HpcError(
          `sbatch failed: ${(submit.stderr || submit.stdout).trim()}`,
        );
      }
      const schedulerJobId = submit.stdout.trim().split(";")[0] ?? "";
      if (!/^\d+$/.test(schedulerJobId))
        throw new HpcError(`Unexpected sbatch output: ${submit.stdout.trim()}`);
      record.schedulerJobId = schedulerJobId;
      record.state = "queued";
    }

    record.submission = "submitted";
    ctx.store.saveJob(record);
    return record;
  } catch (error) {
    if (record.state !== "failed") {
      record.state = record.submission === "prepared" ? "failed" : "unknown";
      record.note =
        "Submission did not return a definite result; query this job before retrying";
      ctx.store.saveJob(record);
    }
    throw new HpcError(
      `Job ${record.id}: ${(error as Error).message}. Query job_status before resubmitting.`,
      "SUBMISSION_UNCERTAIN",
    );
  } finally {
    ctx.store.release(`submission:${id}`, attemptOwner);
  }
}

async function refreshBare(
  ctx: CoreContext,
  pool: ConnectionPool,
  server: ServerSpec,
  record: JobRecord,
): Promise<JobRecord> {
  const state = await pool.ensure(ctx, server);
  const probe = await execRemote(
    state.client,
    [
      `if [ -f ${shellQuote(record.exitPath!)} ]; then echo "EXIT:$(cat ${shellQuote(record.exitPath!)})";`,
      `elif kill -0 ${record.pid ?? 0} 2>/dev/null; then echo ALIVE:$(awk '{print $22}' /proc/${record.pid ?? 0}/stat 2>/dev/null);`,
      "else echo GONE; fi",
    ].join(String.fromCharCode(10)),
    { timeoutMs: 15_000 },
  );
  const line = probe.stdout.trim();
  record.lastCheckedAt = new Date().toISOString();
  const verdict = classifyBare(
    record,
    probe.code === 0 && !probe.timedOut ? line : "",
  );
  applyVerdict(record, verdict);
  if (verdict.state === "lost") {
    // A lost process leaves no exit code; the last lines of output are the only
    // clue left, so attach them instead of returning a bare "lost".
    const tail = await outputTail(ctx, pool, server, record);
    if (tail)
      record.note = `${verdict.note ?? "作业已丢失"}\n输出末尾:\n${tail}`;
  }
  ctx.store.saveJob(record);
  return record;
}

async function refreshSlurm(
  ctx: CoreContext,
  pool: ConnectionPool,
  server: ServerSpec,
  record: JobRecord,
): Promise<JobRecord> {
  const state = await pool.ensure(ctx, server);
  const id = record.schedulerJobId ?? "";
  const queue = await execRemote(
    state.client,
    `squeue -h -j ${id} -o %T 2>/dev/null || true`,
    { timeoutMs: 20_000 },
  );
  record.lastCheckedAt = new Date().toISOString();
  const queued = mapSlurmState(queue.stdout);
  if (queued) {
    // While the job is still in the queue nothing else needs to be asked.
    record.unknownPolls = 0;
    applyVerdict(record, queued);
    ctx.store.saveJob(record);
    return record;
  }
  const accounting = await execRemote(
    state.client,
    `sacct -j ${id} -n -P --format=State,ExitCode,Elapsed 2>/dev/null | head -1 || true`,
    { timeoutMs: 20_000 },
  );
  const plan = planSlurmPoll({
    unknownPolls: record.unknownPolls ?? 0,
    queue: queue.stdout,
    accounting: accounting.stdout,
  });
  record.unknownPolls = plan.unknownPolls;
  let verdict = plan.verdict;
  if (!verdict && plan.escalate) {
    // Accounting is off or lagging. Ask the controller directly, then fall back
    // to the output files instead of spinning until the 15-minute poll cap.
    const scontrol = await execRemote(
      state.client,
      `scontrol show job ${id} -o 2>&1 || true`,
      {
        timeoutMs: 20_000,
      },
    );
    const silent = classifySlurmScontrol(scontrol.stdout)
      ? undefined
      : await outputSilenceMs(ctx, pool, server, record);
    verdict = applySlurmEscalation({
      scontrol: scontrol.stdout,
      outputSilentMs: silent,
    });
    if (verdict.state !== "unknown") record.unknownPolls = 0;
  }
  applyVerdict(record, verdict ?? { state: "unknown" });
  ctx.store.saveJob(record);
  return record;
}

function applyVerdict(record: JobRecord, verdict: Verdict): void {
  record.state = verdict.state;
  if (verdict.exitCode !== undefined) record.exitCode = verdict.exitCode;
  if (verdict.note !== undefined) record.note = verdict.note;
}

/** Age of the newest write to the job's out/err files, or undefined when neither exists. */
async function outputSilenceMs(
  ctx: CoreContext,
  pool: ConnectionPool,
  server: ServerSpec,
  record: JobRecord,
): Promise<number | undefined> {
  const state = await pool.ensure(ctx, server);
  const result = await execRemote(
    state.client,
    `for f in ${shellQuote(record.outPath)} ${shellQuote(record.errPath)}; do [ -f "$f" ] && stat -c %Y "$f" 2>/dev/null; [ -f "$f" ] && stat -f %m "$f" 2>/dev/null; done; true`,
    { timeoutMs: 15_000 },
  );
  const stamps = result.stdout
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (stamps.length === 0) return undefined;
  return Math.max(0, Date.now() - Math.max(...stamps) * 1000);
}

/** Last lines of a job's stdout, used to explain a lost bare-metal process. */
async function outputTail(
  ctx: CoreContext,
  pool: ConnectionPool,
  server: ServerSpec,
  record: JobRecord,
  lines = 20,
): Promise<string> {
  const state = await pool.ensure(ctx, server);
  const result = await execRemote(
    state.client,
    `tail -n ${lines} ${shellQuote(record.outPath)} 2>/dev/null || true`,
    { timeoutMs: 15_000 },
  );
  const text = result.stdout.trim();
  return text.length > 4000 ? `...${text.slice(-4000)}` : text;
}

/** Reconcile one ledger record with the scheduler or process. */
export async function refreshJob(
  ctx: CoreContext,
  pool: ConnectionPool,
  server: ServerSpec,
  record: JobRecord,
): Promise<JobRecord> {
  if (["completed", "failed", "cancelled", "lost"].includes(record.state))
    return record;
  if (ctx.store.isLeased(`submission:${record.id}`)) return record;
  if (record.submission !== "submitted") {
    const recovered = await recoverSubmission(ctx, pool, server, record);
    if (!recovered) return record;
  }
  return record.backend === "slurm"
    ? refreshSlurm(ctx, pool, server, record)
    : refreshBare(ctx, pool, server, record);
}

/** Recover a launch whose response was lost. Never launches another process. */
async function recoverSubmission(
  ctx: CoreContext,
  pool: ConnectionPool,
  server: ServerSpec,
  record: JobRecord,
): Promise<boolean> {
  if (record.submission === "prepared") {
    record.state = "failed";
    record.note =
      "Submission was interrupted before launch; no launch will be retried automatically";
    ctx.store.saveJob(record);
    return false;
  }
  const { client } = await pool.ensure(ctx, server);
  if (record.backend === "bare") {
    const result = await execRemote(
      client,
      `cat ${shellQuote(`${record.jobRoot}/${record.id}.pid`)} 2>/dev/null || true`,
      { timeoutMs: 10000 },
    );
    const [pid, start] = result.stdout.trim().split(":");
    if (!/^\d+$/.test(pid ?? "") || Number(pid) <= 0) return false;
    record.pid = Number(pid);
    record.pidStart = start || undefined;
  } else {
    const result = await execRemote(
      client,
      `squeue -h --name ${shellQuote(record.name)} -o %A 2>/dev/null; sacct -n -X --name ${shellQuote(record.name)} --format=JobIDRaw 2>/dev/null`,
      { timeoutMs: 20000 },
    );
    const ids = [
      ...new Set(
        result.stdout
          .trim()
          .split(/\s+/)
          .filter((v) => /^\d+$/.test(v)),
      ),
    ];
    if (ids.length !== 1) return false;
    record.schedulerJobId = ids[0];
  }
  record.submission = "submitted";
  record.note = "Recovered remote submission";
  ctx.store.saveJob(record);
  return true;
}

export async function queryJobs(
  ctx: CoreContext,
  pool: ConnectionPool,
  servers: ServerSpec[],
  options: { serverId?: string; jobId?: string },
): Promise<JobRecord[]> {
  const records = options.jobId
    ? ([ctx.store.getJob(options.jobId)].filter(Boolean) as JobRecord[])
    : ctx.store.listJobs(options.serverId);
  const results: JobRecord[] = [];
  for (const record of records) {
    if (options.serverId && record.server !== options.serverId) continue;
    const server = servers.find((entry) => entry.id === record.server);
    if (!server) {
      record.state = "lost";
      results.push(record);
      continue;
    }
    if (["completed", "failed", "cancelled", "lost"].includes(record.state)) {
      results.push(record);
      continue;
    }
    results.push(await refreshJob(ctx, pool, server, record));
  }
  return results;
}

export async function readJobLogs(
  ctx: CoreContext,
  pool: ConnectionPool,
  server: ServerSpec,
  record: JobRecord,
  options: { offset?: number; maxBytes?: number; stream?: "stdout" | "stderr" },
): Promise<{ text: string; nextOffset: number; truncated: boolean }> {
  const path = options.stream === "stderr" ? record.errPath : record.outPath;
  const offset = Math.max(0, options.offset ?? 0);
  const maxBytes = Math.max(4, options.maxBytes ?? 64 * 1024);
  const state = await pool.ensure(ctx, server);
  const result = await execRemote(
    state.client,
    `if [ -f ${shellQuote(path)} ]; then tail -c +${offset + 1} ${shellQuote(path)} | head -c ${maxBytes} | base64; fi`,
    { timeoutMs: 30_000, maxBytes: Math.ceil(maxBytes * 1.5) + 128 },
  );
  if (result.code !== 0 || result.timedOut)
    throw new HpcError("Could not read job logs", "LOG_READ_FAILED");
  const buffer = Buffer.from(result.stdout.replace(/\s/g, ""), "base64");
  // Leave an incomplete trailing UTF-8 character for the next byte-offset read.
  let end = buffer.length,
    start = end - 1;
  while (start >= 0 && (buffer[start]! & 0xc0) === 0x80) start--;
  if (start >= 0) {
    const lead = buffer[start]!,
      width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc2 ? 2 : 1;
    if (end - start < width) end = start;
  }
  const text = buffer.subarray(0, end).toString("utf8");
  const nextOffset = offset + end;
  const sizeCheck = await execRemote(
    state.client,
    `if [ -f ${shellQuote(path)} ]; then wc -c < ${shellQuote(path)}; else echo 0; fi`,
    { timeoutMs: 15_000 },
  );
  const total = Number(sizeCheck.stdout.trim()) || 0;
  return { text, nextOffset, truncated: total > nextOffset };
}

export async function cancelJob(
  ctx: CoreContext,
  pool: ConnectionPool,
  server: ServerSpec,
  record: JobRecord,
): Promise<JobRecord> {
  if (ctx.store.isLeased(`submission:${record.id}`))
    throw new HpcError(
      "Submission is still in progress; query its status before cancelling",
      "JOB_BUSY",
    );
  if (["completed", "failed", "cancelled", "lost"].includes(record.state))
    return record;
  if (
    record.submission !== "submitted" &&
    !(await recoverSubmission(ctx, pool, server, record))
  )
    throw new HpcError(
      "Cannot identify remote job yet; query job_status before cancelling",
      "JOB_UNRESOLVED",
    );
  const state = await pool.ensure(ctx, server);
  if (record.backend === "slurm" && record.schedulerJobId) {
    const result = await execRemote(
      state.client,
      `scancel ${record.schedulerJobId}`,
      { timeoutMs: 20_000 },
    );
    if (result.code !== 0)
      throw new HpcError(
        "scancel failed; query job_status for current state",
        "CANCEL_FAILED",
      );
  } else if (record.pid) {
    if (!record.pidStart)
      throw new HpcError(
        "No process start identity recorded; refusing to signal an unidentified PID",
        "PID_UNVERIFIED",
      );
    const guard = `[ "$(awk '{print $22}' /proc/${record.pid}/stat 2>/dev/null)" = ${shellQuote(record.pidStart)} ]`;
    const identity = await execRemote(state.client, `${guard} && echo MATCH`, {
      timeoutMs: 10000,
    });
    if (identity.stdout.trim() !== "MATCH")
      return refreshBare(ctx, pool, server, record);
    await execRemote(
      state.client,
      `${guard} && (kill -TERM -- -${record.pid} 2>/dev/null || kill -TERM ${record.pid} 2>/dev/null)`,
      {
        timeoutMs: 15_000,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await execRemote(
      state.client,
      `${guard} && (kill -KILL -- -${record.pid} 2>/dev/null || kill -KILL ${record.pid} 2>/dev/null) || true`,
      { timeoutMs: 15_000 },
    );
  }
  record.state = "cancelled";
  record.lastCheckedAt = new Date().toISOString();
  ctx.store.saveJob(record);
  return record;
}

/** Detect and describe the scheduler for server_test(profile). */
export async function describeScheduler(
  ctx: CoreContext,
  pool: ConnectionPool,
  server: ServerSpec,
): Promise<{ backend: JobBackend; detected: boolean }> {
  const backend = await resolveBackend(ctx, pool, server);
  return { backend, detected: !server.kind || server.kind === "auto" };
}

export type { Config };
