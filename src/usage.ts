import type { Client } from "ssh2";
import { execRemote } from "./core/ssh.js";
import { HpcError } from "./core/types.js";
export function buildScript(): string {
  return [
    "if command -v scontrol >/dev/null 2>&1; then",
    "  echo __MODE__slurm",
    "  echo __SINFO__; sinfo -h -N -o '%P|%t|%m' 2>/dev/null | head -400",
    "  echo __NODES__; scontrol show node -o 2>/dev/null | head -400",
    "  echo __QUEUE__; squeue -h -o '%T' 2>/dev/null | sort | uniq -c",
    "elif command -v qsub >/dev/null 2>&1 || command -v qstat >/dev/null 2>&1; then",
    "  echo __MODE__queue",
    "  echo __QUEUESYS__pbs",
    "elif command -v bsub >/dev/null 2>&1 || command -v bjobs >/dev/null 2>&1; then",
    "  echo __MODE__queue",
    "  echo __QUEUESYS__lsf",
    "else",
    "  echo __MODE__bare",
    "  echo __LOAD__; uptime",
    "  echo __CPU__; top -bn1 2>/dev/null | grep -m1 'Cpu(s)' || echo unknown",
    "  echo __MEM__; free -m 2>/dev/null | grep -m1 'Mem:' || echo unknown",
    "  echo __MEMINFO__; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo 2>/dev/null || true",
    "  echo __GPU__; nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null || echo none",
    "  echo __DISK__; df -P -h -x tmpfs -x devtmpfs 2>/dev/null | tail -n +2 | head -10",
    "fi",
    "echo __LOGINLOAD__; uptime",
    "echo __LOGINCPU__; top -bn1 2>/dev/null | grep -m1 'Cpu(s)' || echo unknown",
    "echo __LOGINMEM__; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo 2>/dev/null || true",
    "echo __NPROC__; nproc 2>/dev/null || echo 1",
  ].join("\n");
}

function section(raw: string, name: string): string {
  const start = raw.indexOf(`__${name}__`);
  if (start < 0) return "";
  const rest = raw.slice(start + name.length + 4);
  const end = rest.search(/\n__[A-Z]+__/);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

type CpuStats = { usagePercent: number | null; cores: number; load: number[] };
type MemStats = {
  totalMb: number;
  usedMb: number;
  availableMb: number;
  percent: number;
};

export function parseCpu(raw: string, nproc: number): CpuStats {
  const loadMatch = /load average:\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(
    raw,
  );
  const load = loadMatch
    ? [Number(loadMatch[1]), Number(loadMatch[2]), Number(loadMatch[3])]
    : [];
  const idleMatch = /([\d.]+)\s*id/.exec(raw);
  const usagePercent = idleMatch
    ? Math.max(
        0,
        Math.min(100, Math.round((100 - Number(idleMatch[1])) * 10) / 10),
      )
    : null;
  return { usagePercent, cores: nproc, load };
}

export function parseMemory(raw: string): MemStats | null {
  const totalKb = Number(/MemTotal:\s*(\d+)/.exec(raw)?.[1]);
  const availableKb = Number(/MemAvailable:\s*(\d+)/.exec(raw)?.[1]);
  if (Number.isFinite(totalKb) && totalKb > 0 && Number.isFinite(availableKb)) {
    const totalMb = Math.round(totalKb / 1024);
    const availableMb = Math.round(availableKb / 1024);
    const usedMb = Math.max(0, totalMb - availableMb);
    return {
      totalMb,
      usedMb,
      availableMb,
      percent: Math.round((usedMb / totalMb) * 1000) / 10,
    };
  }
  const parts = raw.split(/\s+/);
  if (parts.length >= 7) {
    const totalMb = Number(parts[1]);
    const usedMb = Number(parts[2]);
    const availableMb = Number(parts[6] ?? parts[3]);
    if (Number.isFinite(totalMb) && totalMb > 0) {
      return {
        totalMb,
        usedMb,
        availableMb,
        percent: Math.round((usedMb / totalMb) * 1000) / 10,
      };
    }
  }
  return null;
}

export function parseGpus(raw: string): Array<{
  index: number;
  name: string;
  utilPercent: number;
  memUsedMb: number;
  memTotalMb: number;
}> {
  if (!raw || raw === "none") return [];
  const gpus = [];
  for (const rawLine of raw.split("\n")) {
    const cells = rawLine.split(",").map((cell) => cell.trim());
    if (cells.length < 5) continue;
    const utilPercent = Number(cells[2]);
    const memUsedMb = Number(cells[3]);
    const memTotalMb = Number(cells[4]);
    if (
      !Number.isFinite(utilPercent) ||
      !Number.isFinite(memTotalMb) ||
      memTotalMb <= 0
    )
      continue;
    gpus.push({
      index: Number(cells[0]) || gpus.length,
      name: cells[1] ?? "GPU",
      utilPercent,
      memUsedMb,
      memTotalMb,
    });
  }
  return gpus;
}

export function parseDisks(raw: string): Array<{
  filesystem: string;
  size: string;
  used: string;
  avail: string;
  percent: number;
  mount: string;
}> {
  return raw
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 6)
    .filter(
      (parts) =>
        !/^\/boot/.test(parts[5]!) &&
        !/^\/(sys|proc|run)/.test(parts[5]!) &&
        parts[0] !== "efivarfs",
    )
    .map((parts) => ({
      filesystem: parts[0]!,
      size: parts[1]!,
      used: parts[2]!,
      avail: parts[3]!,
      percent: Number(String(parts[4]).replace("%", "")) || 0,
      mount: parts[5]!,
    }))
    .filter(
      (disk, index, all) =>
        all.findIndex((entry) => entry.mount === disk.mount) === index,
    )
    .slice(0, 4);
}

export function parsePartitions(raw: string) {
  const partitions = new Map<
    string,
    {
      name: string;
      idle: number;
      mixed: number;
      allocated: number;
      down: number;
      other: number;
      memoryMb: number;
    }
  >();
  for (const rawLine of raw.split("\n")) {
    const [partitionRaw, stateRaw, memoryRaw] = rawLine.trim().split("|");
    if (!partitionRaw) continue;
    const name = partitionRaw.replace(/\*$/, "") || "default";
    const entry = partitions.get(name) ?? {
      name,
      idle: 0,
      mixed: 0,
      allocated: 0,
      down: 0,
      other: 0,
      memoryMb: 0,
    };
    entry.memoryMb += Number(memoryRaw) || 0;
    const state = (stateRaw ?? "").trim().toLowerCase();
    if (state.startsWith("idle")) entry.idle += 1;
    else if (state.startsWith("mix")) entry.mixed += 1;
    else if (state.startsWith("alloc")) entry.allocated += 1;
    else if (/down|drain|fail|maint|unknown/.test(state)) entry.down += 1;
    else entry.other += 1;
    partitions.set(name, entry);
  }
  return [...partitions.values()].sort(
    (a, b) => b.idle + b.mixed + b.allocated - (a.idle + a.mixed + a.allocated),
  );
}

export function parseNodes(raw: string) {
  const nodes = {
    total: 0,
    idle: 0,
    mixed: 0,
    allocated: 0,
    down: 0,
    other: 0,
    cpus: { total: 0, allocated: 0 },
    memoryMb: { total: 0, allocated: 0, freeMb: 0 },
    gpus: { total: 0, used: 0 },
  };
  for (const rawLine of raw.split("\n")) {
    const text = rawLine.trim();
    if (!text.startsWith("NodeName=")) continue;
    const field = (key: string) =>
      new RegExp(`${key}=(\\S+)`).exec(text)?.[1] ?? "";
    nodes.total += 1;
    const state = field("State").toLowerCase();
    if (state.startsWith("idle")) nodes.idle += 1;
    else if (state.startsWith("mix")) nodes.mixed += 1;
    else if (state.startsWith("alloc")) nodes.allocated += 1;
    else if (/down|drain|fail|maint|unknown/.test(state)) nodes.down += 1;
    else nodes.other += 1;
    nodes.cpus.total += Number(field("CPUTot")) || 0;
    nodes.cpus.allocated += Number(field("CPUAlloc")) || 0;
    const realMemory = Number(field("RealMemory")) || 0;
    // Clusters often misreport RealMemory as 1; only trust plausible values.
    if (realMemory > 512) nodes.memoryMb.total += realMemory;
    nodes.memoryMb.allocated += Number(field("AllocMem")) || 0;
    nodes.memoryMb.freeMb += Number(field("FreeMem")) || 0;
    const gres = /Gres=([^\s]+)/.exec(text)?.[1] ?? "";
    const countGpu = (value: string) =>
      [...value.matchAll(/(?:^|,)gpu:(?:[^,:()]+:)?(\d+)/g)].reduce(
        (n, m) => n + Number(m[1]),
        0,
      );
    nodes.gpus.total += countGpu(gres);
    const gresUsed = /GresUsed=([^\s]+)/.exec(text)?.[1] ?? "";
    nodes.gpus.used += countGpu(gresUsed);
  }
  return nodes;
}

export function parseQueue(raw: string): {
  running: number;
  pending: number;
  other: number;
} {
  const result = { running: 0, pending: 0, other: 0 };
  for (const rawLine of raw.split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)/.exec(rawLine);
    if (!match) continue;
    const count = Number(match[1]);
    const state = match[2]!.toUpperCase();
    if (
      state === "RUNNING" ||
      state === "COMPLETING" ||
      state === "CONFIGURING"
    )
      result.running += count;
    else if (state === "PENDING") result.pending += count;
    else result.other += count;
  }
  return result;
}

export async function sampleUsage(
  client: Client,
  server: string,
  signal?: AbortSignal,
) {
  const started = Date.now();
  const result = await execRemote(client, buildScript(), {
    timeoutMs: 30000,
    signal,
    maxBytes: 1024 * 1024,
  });
  if (result.timedOut || result.code !== 0)
    throw new HpcError(
      "Resource sampling did not complete; retry server_usage",
      "USAGE_UNAVAILABLE",
    );
  const raw = result.stdout,
    nproc = Number(section(raw, "NPROC")) || 1,
    mode = section(raw, "MODE");
  const login = {
    cpu: parseCpu(
      `${section(raw, "LOGINLOAD")}\n${section(raw, "LOGINCPU")}`,
      nproc,
    ),
    memory: parseMemory(section(raw, "LOGINMEM")),
  };
  const base = {
    server,
    sampledAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    login,
    truncated: result.truncated,
  };
  if (mode === "slurm")
    return {
      ...base,
      kind: "slurm",
      cluster: {
        nodes: parseNodes(section(raw, "NODES")),
        partitions: parsePartitions(section(raw, "SINFO")),
        jobs: parseQueue(section(raw, "QUEUE")),
      },
    };
  if (mode === "queue")
    return {
      ...base,
      kind: section(raw, "QUEUESYS"),
      note: "PBS/LSF: login node metrics only; submission unsupported",
    };
  return {
    ...base,
    kind: "bare",
    cpu: parseCpu(`${section(raw, "LOAD")}\n${section(raw, "CPU")}`, nproc),
    memory:
      parseMemory(section(raw, "MEMINFO")) ?? parseMemory(section(raw, "MEM")),
    gpus: parseGpus(section(raw, "GPU")),
    disks: parseDisks(section(raw, "DISK")),
  };
}
