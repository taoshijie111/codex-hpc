import { createServer as createNetServer, type Socket } from "node:net";
import { isAbsolute, posix } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resourceSchema, serverSchema } from "./config.js";
import { HpcRuntime } from "./runtime.js";
import { HpcError } from "./core/types.js";
import { execRemote } from "./core/ssh.js";
import { resolveBackend, readJobLogs, submitJob } from "./core/jobs.js";
import { isTerminal } from "./core/watch.js";
import { sampleUsage } from "./usage.js";

const serverId = { server: z.string().min(1) };
const localPath = z
  .string()
  .min(1)
  .refine(
    (v) => isAbsolute(v) && !v.includes("\0"),
    "Use an absolute local path",
  );
const remotePath = z
  .string()
  .min(1)
  .refine(
    (v) => posix.isAbsolute(v) && !/[\r\n\0]/.test(v),
    "Use an absolute remote path",
  );
const transferOptions = {
  background: z.boolean().default(true),
  overwrite: z.boolean().default(false),
  chunkSize: z
    .number()
    .int()
    .min(4096)
    .max(8 * 1024 * 1024)
    .optional(),
};
const limit = z
  .number()
  .int()
  .min(1)
  .max(1024 * 1024);
const port = z.number().int().min(1).max(65535);

export function createMcpServer(runtime: HpcRuntime): McpServer {
  const mcp = new McpServer(
    { name: "codex-hpc", version: "0.1.1" },
    {
      instructions:
        "Use server_list first. Run short commands in shell_run; submit compute work with job_submit. Jobs survive disconnect; shells, tunnels and local transfers belong to this MCP process. Use job_status or job_wait (at most 30 seconds); completion does not automatically wake Codex. Transfers are background by default; inspect transfer_status. Credentials are environment references. Never retry an uncertain submission with a new requestId.",
    },
  );
  function tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    readOnly: boolean,
    run: (
      args: z.output<z.ZodObject<S>>,
      signal: AbortSignal,
    ) => Promise<unknown>,
  ) {
    const schema = z.object(shape).strict();
    mcp.registerTool<z.ZodRawShape, typeof schema>(
      name,
      {
        description,
        inputSchema: schema,
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: !readOnly,
          openWorldHint: true,
        },
      },
      async (args, extra) => {
        try {
          await runtime.sync();
          if (extra.signal.aborted)
            throw new HpcError("Request cancelled", "CANCELLED");
          const result = runtime.clean(
            await run(args as z.output<z.ZodObject<S>>, extra.signal),
          );
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: result as Record<string, unknown>,
          };
        } catch (error) {
          const e = error as Error;
          const result = runtime.clean({
            error: {
              code: e instanceof HpcError ? e.code : "OPERATION_FAILED",
              message: e instanceof z.ZodError ? z.prettifyError(e) : e.message,
            },
          });
          return {
            isError: true,
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: result,
          };
        }
      },
    );
  }
  tool(
    "server_list",
    "List configured servers and this MCP process's connections, sessions and forwards. Start here.",
    {},
    true,
    async () => ({
      servers: runtime.config.read().servers.map((s) => ({
        ...s,
        ...runtime.pool.list().find((c) => c.serverId === s.id),
        hostKeyPinned: Boolean(s.hostKey),
      })),
    }),
  );
  tool(
    "server_add",
    "Register or update a server. Pass environment variable names, never password values. New servers need host, username and auth; existing IDs can be patched.",
    {
      ...z.object(serverSchema.shape).partial().shape,
      id: serverSchema.shape.id,
    },
    false,
    async (args) => {
      const config = await runtime.config.update((c) => {
        const previous = c.servers.find((s) => s.id === args.id);
        const merged = serverSchema.parse({ ...previous, ...args });
        if (
          previous &&
          (previous.host !== merged.host ||
            previous.port !== merged.port ||
            previous.username !== merged.username)
        ) {
          if (args.hostKey === undefined) delete merged.hostKey;
          delete merged.resolvedKind;
        }
        if (previous && args.kind !== undefined && previous.kind !== args.kind)
          delete merged.resolvedKind;
        c.servers = [...c.servers.filter((s) => s.id !== args.id), merged];
        return c;
      });
      return { server: config.servers.find((s) => s.id === args.id) };
    },
  );
  tool(
    "server_remove",
    "Remove a server from local inventory and close this process's sessions, forwards and transfers. Remote jobs continue; environment variables are not changed.",
    serverId,
    false,
    async ({ server }) => {
      runtime.server(server);
      await runtime.transfers.abortServer(server);
      await runtime.sessions.closeForServer(server);
      await runtime.pool.close(server);
      runtime.suspendServer(server);
      await runtime.config.update((c) => ({
        ...c,
        servers: c.servers.filter((s) => s.id !== server),
      }));
      return { removed: server };
    },
  );
  const connectShape = {
    ...serverId,
    otp: z.string().min(1).max(128).optional(),
  };
  tool(
    "server_connect",
    "Open/reuse SSH. otp is a current MFA code; it is not persisted by this server (tool arguments can appear in the client transcript). First contact pins the host fingerprint.",
    connectShape,
    false,
    async ({ server, otp }) => {
      runtime.rememberSecret(otp);
      const state = await runtime.pool.ensure(
        runtime.ctx,
        runtime.server(server),
        { verificationCode: otp },
      );
      runtime.resumeServer(server);
      return {
        server,
        connected: state.alive,
        hostKeyFingerprint: state.fingerprint,
      };
    },
  );
  tool(
    "server_disconnect",
    "Close this process's SSH connection, shells, local transfers and tunnels. Detached remote jobs continue.",
    serverId,
    false,
    async ({ server }) => {
      runtime.suspendServer(server);
      await runtime.transfers.abortServer(server);
      await runtime.sessions.closeForServer(server);
      await runtime.pool.close(server);
      return { server, connected: false };
    },
  );
  tool(
    "server_test",
    "Test connectivity and fingerprint. profile=true detects scheduler and basic platform capabilities; PBS/LSF submission remains unsupported.",
    { ...connectShape, profile: z.boolean().default(false) },
    false,
    async ({ server, otp, profile }, signal) => {
      runtime.rememberSecret(otp);
      const spec = runtime.server(server),
        start = Date.now();
      const state = await runtime.pool.ensure(runtime.ctx, spec, {
        verificationCode: otp,
      });
      let capabilities: unknown;
      if (profile) {
        let kind: string;
        try {
          kind = await resolveBackend(
            runtime.ctx,
            runtime.pool,
            spec,
            async (resolvedKind) => {
              await runtime.config.update((c) => ({
                ...c,
                servers: c.servers.map((s) =>
                  s.id === server ? { ...s, resolvedKind } : s,
                ),
              }));
            },
          );
        } catch (e) {
          if (!/supports Slurm|not supported/.test((e as Error).message))
            throw e;
          kind =
            runtime.server(server).resolvedKind ?? spec.kind ?? "unsupported";
        }
        const result = await execRemote(
          state.client,
          'uname -srm; hostname; printf \'home=%s\\n\' "$HOME"; for c in sbatch squeue sacct qsub bsub conda python3 module sha256sum; do command -v "$c" || true; done',
          { timeoutMs: 15000, signal },
        );
        capabilities = { kind, text: result.stdout };
      }
      runtime.resumeServer(server);
      return {
        server,
        reachable: state.alive,
        latencyMs: Date.now() - start,
        hostKeyFingerprint: state.fingerprint,
        ...(profile ? { profile: capabilities } : {}),
      };
    },
  );
  tool(
    "server_usage",
    "Sample CPU, memory, GPU and disk usage; Slurm reports compute-node capacity separately from login-node metrics.",
    serverId,
    true,
    async ({ server }, signal) => {
      runtime.pool.hold(server);
      try {
        const state = await runtime.pool.ensure(
          runtime.ctx,
          runtime.server(server),
        );
        return await sampleUsage(state.client, server, signal);
      } finally {
        runtime.pool.release(server);
      }
    },
  );
  tool(
    "shell_run",
    "Run a short command in a named persistent login shell. cd/export/module state persists within this MCP process. Compute or long work belongs in job_submit. Timeout resets the affected shell.",
    {
      ...serverId,
      command: z.string().min(1),
      session: z.string().min(1).max(128).default("main"),
      timeoutMs: z.number().int().min(1).max(300000).optional(),
      maxBytes: limit.default(256 * 1024),
    },
    false,
    async (args, signal) => {
      const config = runtime.config.read();
      const result = await runtime.sessions.run(
        runtime.ctx,
        config,
        args.server,
        args.command,
        {
          session: args.session,
          timeoutMs: args.timeoutMs ?? config.commandTimeoutMs ?? 120000,
          signal,
        },
      );
      const crop = (s: string) =>
        Buffer.from(s).subarray(0, args.maxBytes).toString("utf8");
      return {
        ...result,
        stdout: crop(result.stdout),
        stderr: crop(result.stderr),
        truncated:
          result.truncated ||
          Buffer.byteLength(result.stdout) > args.maxBytes ||
          Buffer.byteLength(result.stderr) > args.maxBytes,
      };
    },
  );
  tool(
    "shell_close",
    "Close one named shell; keep the pooled connection for other uses.",
    { ...serverId, session: z.string().default("main") },
    false,
    async ({ server, session }) => ({
      closed: await runtime.sessions.close(server, session),
    }),
  );

  tool(
    "job_submit",
    "Submit Slurm or detached bare-metal compute work and return immediately by default. Use a stable requestId for retries; uncertain submissions are recovered, never relaunched. Put a pipeline in one script. Use job_status/job_wait; completion does not automatically wake Codex.",
    {
      ...serverId,
      command: z.string().min(1).optional(),
      script: z.string().min(1).optional(),
      workdir: remotePath,
      name: z.string().max(100).optional(),
      requestId: z.string().min(1).max(128).optional(),
      ...resourceSchema.shape,
      watch: z.boolean().default(true),
      waitMs: z.number().int().min(0).max(30000).default(0),
    },
    false,
    async (args, signal) => {
      const {
        server,
        command,
        script,
        workdir,
        name,
        requestId,
        watch,
        waitMs,
        ...resources
      } = args;
      if (!command && !script)
        throw new HpcError("Provide command or script", "INVALID_ARGUMENT");
      const record = await runtime.serial(
        `submit:${server}:${requestId ?? randomRequest()}`,
        () =>
          submitJob(
            runtime.ctx,
            runtime.pool,
            runtime.server(server),
            { command, script, workdir, name, requestId, resources },
            async (resolvedKind) => {
              await runtime.config.update((c) => ({
                ...c,
                servers: c.servers.map((s) =>
                  s.id === server ? { ...s, resolvedKind } : s,
                ),
              }));
            },
          ),
      );
      if (watch) runtime.watch(record.id);
      const result = waitMs
        ? await waitJob(runtime, record.id, waitMs, signal)
        : { job: record, timedOut: false };
      return {
        ...result,
        jobId: record.id,
        watching: runtime.store.isLeased(`monitor:${record.id}`),
        notificationsSupported: false,
      };
    },
  );
  tool(
    "job_status",
    "Read tracked job snapshots and reconcile with remote state. Filter by jobId or server. Unknown means unresolved, not necessarily finished.",
    { jobId: z.string().optional(), server: z.string().optional() },
    true,
    async ({ jobId, server }) => {
      const records = jobId
        ? [runtime.job(jobId)]
        : runtime.store.listJobs(server);
      const jobs = [];
      for (const record of records) {
        if (server && record.server !== server) continue;
        try {
          jobs.push(await runtime.refresh(record.id));
        } catch (error) {
          jobs.push({
            ...record,
            queryError: runtime.redact((error as Error).message),
          });
        }
      }
      return { jobs };
    },
  );
  tool(
    "job_wait",
    "Wait at most 30 seconds for one job; timeout returns a snapshot and does not cancel it.",
    {
      jobId: z.string(),
      timeoutMs: z.number().int().min(0).max(30000).default(30000),
    },
    true,
    async ({ jobId, timeoutMs }, signal) =>
      waitJob(runtime, jobId, timeoutMs, signal),
  );
  tool(
    "job_logs",
    "Read bounded job output from a byte offset. Use nextOffset to continue; stdout and stderr have independent offsets.",
    {
      jobId: z.string(),
      offset: z.number().int().nonnegative().default(0),
      maxBytes: z
        .number()
        .int()
        .min(4)
        .max(1024 * 1024)
        .default(65536),
      stream: z.enum(["stdout", "stderr"]).default("stdout"),
    },
    true,
    async (args) => {
      const record = runtime.job(args.jobId);
      return {
        jobId: record.id,
        ...(await readJobLogs(
          runtime.ctx,
          runtime.pool,
          runtime.server(record.server),
          record,
          args,
        )),
      };
    },
  );
  tool(
    "job_cancel",
    "Cancel a tracked remote job. Bare-metal cancellation checks PID start identity before signalling its process group.",
    { jobId: z.string() },
    false,
    async ({ jobId }) => ({ job: await runtime.cancel(jobId) }),
  );

  const startTransfer = async (
    server: string,
    spec: Parameters<HpcRuntime["transfers"]["start"]>[1],
    background: boolean,
    signal: AbortSignal,
  ) => {
    const record = runtime.transfers.start(runtime.server(server), spec);
    if (background)
      return { transferId: record.id, state: record.state, background: true };
    const timeout = AbortSignal.timeout(30000);
    const bounded = AbortSignal.any([signal, timeout]);
    return {
      transferId: record.id,
      background: false,
      transfer: await runtime.transfers.wait(record.id, bounded),
    };
  };
  tool(
    "upload",
    "Upload a file/directory to remoteDir/basename(localPath). Background by default; transfer_status shows progress. Identical content is skipped; differing targets need overwrite=true.",
    { ...serverId, localPath, remoteDir: remotePath, ...transferOptions },
    false,
    async (a, signal) =>
      startTransfer(
        a.server,
        {
          direction: "upload",
          items: [{ source: a.localPath, targetDir: a.remoteDir }],
          overwrite: a.overwrite,
          chunkSize: a.chunkSize,
        },
        a.background,
        signal,
      ),
  );
  tool(
    "download",
    "Download to localDir/basename(remotePath). Background by default. Re-submit the same paths to resume retained .part data.",
    { ...serverId, remotePath, localDir: localPath, ...transferOptions },
    false,
    async (a, signal) =>
      startTransfer(
        a.server,
        {
          direction: "download",
          items: [{ source: a.remotePath, targetDir: a.localDir }],
          overwrite: a.overwrite,
          chunkSize: a.chunkSize,
        },
        a.background,
        signal,
      ),
  );
  tool(
    "transfer_queue",
    "Transfer files/directories sequentially. items is a structured array of {source,targetDir}. Stops on request or continues past failures when continueOnError=true.",
    {
      ...serverId,
      direction: z.enum(["upload", "download"]),
      items: z
        .array(z.object({ source: z.string(), targetDir: z.string() }).strict())
        .min(1)
        .max(1000),
      continueOnError: z.boolean().default(true),
      ...transferOptions,
    },
    false,
    async (a, signal) => {
      for (const item of a.items) {
        (a.direction === "upload" ? localPath : remotePath).parse(item.source);
        (a.direction === "upload" ? remotePath : localPath).parse(
          item.targetDir,
        );
      }
      return startTransfer(
        a.server,
        {
          direction: a.direction,
          items: a.items,
          overwrite: a.overwrite,
          chunkSize: a.chunkSize,
          continueOnError: a.continueOnError,
        },
        a.background,
        signal,
      );
    },
  );
  tool(
    "transfer_status",
    "Read one or all durable transfer records. Interrupted transfers resume by re-submitting their paths.",
    { transferId: z.string().optional() },
    true,
    async ({ transferId }) => ({
      transfers: runtime.transfers.status(transferId),
    }),
  );
  tool(
    "transfer_cancel",
    "Request cancellation of a transfer, including one owned by another live MCP process. Partial files are retained.",
    { transferId: z.string() },
    false,
    async ({ transferId }) => ({
      transfer: runtime.transfers.cancel(transferId),
    }),
  );
  tool(
    "forward",
    "Open a local loopback TCP tunnel to a host reachable from the SSH server, or close one using localPort. Tunnels end with this MCP process.",
    {
      ...serverId,
      remoteHost: z.string().min(1).default("127.0.0.1"),
      remotePort: port.optional(),
      localPort: z.number().int().min(0).max(65535).default(0),
      close: z.boolean().default(false),
    },
    false,
    async (a) => {
      const state = await runtime.pool.ensure(
        runtime.ctx,
        runtime.server(a.server),
      );
      if (a.close)
        return { closed: runtime.pool.closeForward(state, a.localPort) };
      if (!a.remotePort)
        throw new HpcError(
          "remotePort is required when opening a forward",
          "INVALID_ARGUMENT",
        );
      const sockets = new Set<Socket>();
      const listener = createNetServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => undefined);
        socket.once("close", () => sockets.delete(socket));
        state.client.forwardOut(
          "127.0.0.1",
          socket.remotePort ?? 0,
          a.remoteHost,
          a.remotePort!,
          (error, channel) => {
            if (error) {
              socket.destroy();
              return;
            }
            if (socket.destroyed) {
              channel.destroy();
              return;
            }
            socket.on("error", () => channel.destroy());
            channel.on("error", () => socket.destroy());
            socket.pipe(channel).pipe(socket);
          },
        );
      });
      await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(a.localPort, "127.0.0.1", () => {
          listener.removeListener("error", reject);
          resolve();
        });
      });
      listener.on("error", () => undefined);
      const localPort = (listener.address() as { port: number }).port;
      runtime.pool.addForward(state, {
        server: listener,
        sockets,
        localPort,
        remoteHost: a.remoteHost,
        remotePort: a.remotePort,
      });
      return {
        server: a.server,
        localPort,
        remoteHost: a.remoteHost,
        remotePort: a.remotePort,
      };
    },
  );
  return mcp;
}
function randomRequest(): string {
  return Math.random().toString(36);
}
async function waitJob(
  runtime: HpcRuntime,
  id: string,
  ms: number,
  signal: AbortSignal,
) {
  const until = Date.now() + ms;
  let job = runtime.job(id);
  while (!signal.aborted && !isTerminal(job.state) && Date.now() < until) {
    // Race the refresh against the deadline; it may finish safely in the background.
    let timer: NodeJS.Timeout | undefined;
    const pending = runtime.refresh(id);
    const result = await Promise.race([
      pending,
      new Promise<null>((resolve) => {
        timer = setTimeout(
          () => resolve(null),
          Math.max(0, until - Date.now()),
        );
      }),
    ]).finally(() => clearTimeout(timer));
    if (!result) break;
    job = result;
    if (isTerminal(job.state)) break;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(t);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const t = setTimeout(
        finish,
        Math.min(1000, Math.max(0, until - Date.now())),
      );
      signal.addEventListener("abort", finish, { once: true });
    });
  }
  return { job, timedOut: !isTerminal(job.state), cancelled: signal.aborted };
}
