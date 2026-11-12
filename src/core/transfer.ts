import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Client, SFTPWrapper, Stats } from "ssh2";
import { execRemote } from "./ssh.js";
import { HpcError, shellQuote } from "./types.js";

export type TransferResult = {
  path: string;
  files: number;
  bytes: number;
  resumed: boolean;
  skipped: boolean;
  sha256: string | null;
  verified: boolean;
};
export type TransferOptions = {
  overwrite: boolean;
  signal?: AbortSignal;
  chunkSize?: number;
  onProgress?: (transferred: number, total: number) => void;
};
function check(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new HpcError(
      "Transfer cancelled; partial data retained",
      "CANCELLED",
    );
}
async function digest(path: string, signal?: AbortSignal): Promise<string> {
  check(signal);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal }))
    hash.update(chunk);
  return hash.digest("hex");
}
async function remoteDigest(
  client: Client,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  check(signal);
  const result = await execRemote(
    client,
    `if command -v sha256sum >/dev/null 2>&1; then sha256sum -- ${shellQuote(path)}; else shasum -a 256 -- ${shellQuote(path)}; fi`,
    { timeoutMs: 120000, signal },
  );
  const hash = /^([a-f0-9]{64})\s/.exec(result.stdout)?.[1];
  if (result.code !== 0 || !hash)
    throw new HpcError(
      "Remote SHA256 unavailable; install sha256sum or shasum. Target was not replaced.",
      "CHECKSUM_UNAVAILABLE",
    );
  return hash;
}
function stat(sftp: SFTPWrapper, path: string): Promise<Stats | null> {
  return new Promise((resolve, reject) =>
    sftp.lstat(path, (error, stats) => {
      if (error) {
        if ((error as { code?: number }).code === 2) resolve(null);
        else reject(error);
      } else resolve(stats);
    }),
  );
}
async function mkdir(sftp: SFTPWrapper, path: string): Promise<void> {
  let current = path.startsWith("/") ? "" : ".";
  for (const part of path.split("/").filter(Boolean)) {
    current += `/${part}`;
    const at = current;
    await new Promise<void>((resolve, reject) =>
      sftp.mkdir(at, (error) => {
        if (!error) resolve();
        else
          void stat(sftp, at).then(
            (s) => (s?.isDirectory() ? resolve() : reject(error)),
            reject,
          );
      }),
    );
  }
}
async function withSftp<T>(
  client: Client,
  signal: AbortSignal | undefined,
  run: (sftp: SFTPWrapper) => Promise<T>,
): Promise<T> {
  check(signal);
  const sftp = await new Promise<SFTPWrapper>((resolve, reject) =>
    client.sftp((e, s) => (e ? reject(e) : resolve(s))),
  );
  sftp.on("error", () => undefined);
  try {
    return await run(sftp);
  } finally {
    sftp.end();
  }
}
function sizeOfPart(size: number | undefined, total: number): number {
  return size !== undefined && size <= total ? size : 0;
}
function chunkSize(total: number, options: TransferOptions): number {
  return (
    options.chunkSize ??
    (total > 256 * 1024 * 1024
      ? 8 * 1024 * 1024
      : total > 32 * 1024 * 1024
        ? 4 * 1024 * 1024
        : 256 * 1024)
  );
}
function rejectLink(stats: { isSymbolicLink(): boolean }, path: string): void {
  if (stats.isSymbolicLink())
    throw new HpcError(
      `Symbolic links are not transferred: ${path}`,
      "SYMLINK_UNSUPPORTED",
    );
}
function safeName(name: string): void {
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name))
    throw new HpcError("Unsafe directory entry", "INVALID_PATH");
}

async function uploadFile(
  client: Client,
  sftp: SFTPWrapper,
  local: string,
  remote: string,
  options: TransferOptions,
): Promise<TransferResult> {
  const source = lstatSync(local);
  rejectLink(source, local);
  const total = source.size,
    hash = await digest(local, options.signal);
  const target = await stat(sftp, remote);
  if (target) {
    rejectLink(target, remote);
    if (!target.isFile())
      throw new HpcError(
        `Target is not a regular file: ${remote}`,
        "INVALID_PATH",
      );
    if (
      target.size === total &&
      (await remoteDigest(client, remote, options.signal)) === hash
    )
      return {
        path: remote,
        files: 1,
        bytes: 0,
        resumed: false,
        skipped: true,
        sha256: hash,
        verified: true,
      };
    if (!options.overwrite)
      throw new HpcError(
        `Target differs: ${remote}; use overwrite=true to replace`,
        "TARGET_EXISTS",
      );
  }
  const part = remote + ".part",
    partStats = await stat(sftp, part);
  if (partStats) {
    rejectLink(partStats, part);
    if (!partStats.isFile())
      throw new HpcError("Staging path is not a file", "INVALID_PATH");
  }
  const offset = sizeOfPart(partStats?.size, total);
  await mkdir(sftp, posix.dirname(remote));
  check(options.signal);
  options.onProgress?.(offset, total);
  if (offset < total || !partStats) {
    const input = createReadStream(local, {
      start: offset,
      highWaterMark: chunkSize(total, options),
    });
    const output = sftp.createWriteStream(part, {
      flags: offset > 0 ? "r+" : "w",
      start: offset,
      mode: 0o600,
      highWaterMark: chunkSize(total, options),
    });
    let bytes = offset;
    input.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      options.onProgress?.(bytes, total);
    });
    await pipeline(input, output, { signal: options.signal });
  }
  check(options.signal);
  if ((await remoteDigest(client, part, options.signal)) !== hash) {
    await new Promise<void>((resolve) => sftp.unlink(part, () => resolve()));
    throw new HpcError(
      "Upload checksum mismatch; target preserved. Retry from the source.",
      "CHECKSUM_MISMATCH",
    );
  }
  // Check again before committing; never remove the old target as a fallback.
  if (!options.overwrite && !target && (await stat(sftp, remote)))
    throw new HpcError("Target appeared during transfer", "TARGET_EXISTS");
  await new Promise<void>((resolve, reject) => {
    if (!target) {
      sftp.rename(part, remote, (e) => (e ? reject(e) : resolve()));
      return;
    }
    sftp.ext_openssh_rename(part, remote, (e) =>
      e
        ? reject(
            new HpcError(
              "Server cannot atomically replace this target; original and .part retained",
              "ATOMIC_RENAME_UNAVAILABLE",
            ),
          )
        : resolve(),
    );
  });
  return {
    path: remote,
    files: 1,
    bytes: total - offset,
    resumed: offset > 0,
    skipped: false,
    sha256: hash,
    verified: true,
  };
}

async function downloadFile(
  client: Client,
  sftp: SFTPWrapper,
  remote: string,
  local: string,
  options: TransferOptions,
): Promise<TransferResult> {
  const source = await stat(sftp, remote);
  if (!source?.isFile())
    throw new HpcError(
      `Remote file missing or unsupported: ${remote}`,
      "INVALID_PATH",
    );
  rejectLink(source, remote);
  const total = source.size,
    hash = await remoteDigest(client, remote, options.signal);
  if (existsSync(local)) {
    const target = lstatSync(local);
    rejectLink(target, local);
    if (!target.isFile())
      throw new HpcError("Local target is not a regular file", "INVALID_PATH");
    if (target.size === total && (await digest(local, options.signal)) === hash)
      return {
        path: local,
        files: 1,
        bytes: 0,
        resumed: false,
        skipped: true,
        sha256: hash,
        verified: true,
      };
    if (!options.overwrite)
      throw new HpcError(
        `Target differs: ${local}; use overwrite=true to replace`,
        "TARGET_EXISTS",
      );
  }
  const targetExisted = existsSync(local),
    part = local + ".part";
  if (existsSync(part)) {
    const info = lstatSync(part);
    rejectLink(info, part);
    if (!info.isFile())
      throw new HpcError("Staging path is not a file", "INVALID_PATH");
  }
  const partSize = existsSync(part) ? statSync(part).size : undefined;
  const offset = sizeOfPart(partSize, total);
  mkdirSync(dirname(local), { recursive: true });
  check(options.signal);
  options.onProgress?.(offset, total);
  if (offset < total || partSize === undefined) {
    const input = sftp.createReadStream(remote, {
      start: offset,
      highWaterMark: chunkSize(total, options),
    });
    const output = createWriteStream(part, {
      flags: offset > 0 ? "r+" : "w",
      start: offset,
      mode: 0o600,
    });
    let bytes = offset;
    input.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      options.onProgress?.(bytes, total);
    });
    await pipeline(input, output, { signal: options.signal });
  }
  check(options.signal);
  if ((await digest(part, options.signal)) !== hash) {
    unlinkSync(part);
    throw new HpcError(
      "Download checksum mismatch; target preserved",
      "CHECKSUM_MISMATCH",
    );
  }
  if (!options.overwrite && !targetExisted && existsSync(local))
    throw new HpcError("Target appeared during transfer", "TARGET_EXISTS");
  renameSync(part, local);
  return {
    path: local,
    files: 1,
    bytes: total - offset,
    resumed: offset > 0,
    skipped: false,
    sha256: hash,
    verified: true,
  };
}

function aggregate(path: string, parts: TransferResult[]): TransferResult {
  return {
    path,
    files: parts.reduce((n, p) => n + p.files, 0),
    bytes: parts.reduce((n, p) => n + p.bytes, 0),
    resumed: parts.some((p) => p.resumed),
    skipped: parts.length > 0 && parts.every((p) => p.skipped),
    sha256: parts.length === 1 ? parts[0]!.sha256 : null,
    verified: parts.every((p) => p.verified),
  };
}
export async function uploadWithResume(
  client: Client,
  local: string,
  remote: string,
  options: TransferOptions,
): Promise<TransferResult> {
  return withSftp(client, options.signal, async (sftp) => {
    const parts: TransferResult[] = [];
    const walk = async (l: string, r: string): Promise<void> => {
      check(options.signal);
      const info = lstatSync(l);
      rejectLink(info, l);
      if (info.isDirectory()) {
        await mkdir(sftp, r);
        for (const e of readdirSync(l)) {
          safeName(e);
          await walk(join(l, e), posix.join(r, e));
        }
      } else if (info.isFile())
        parts.push(await uploadFile(client, sftp, l, r, options));
      else throw new HpcError("Unsupported source type", "INVALID_PATH");
    };
    await walk(local, remote);
    return aggregate(remote, parts);
  });
}
export async function downloadWithResume(
  client: Client,
  remote: string,
  local: string,
  options: TransferOptions,
): Promise<TransferResult> {
  return withSftp(client, options.signal, async (sftp) => {
    const parts: TransferResult[] = [];
    const walk = async (r: string, l: string): Promise<void> => {
      check(options.signal);
      const info = await stat(sftp, r);
      if (!info)
        throw new HpcError(`Missing remote source: ${r}`, "INVALID_PATH");
      rejectLink(info, r);
      if (info.isDirectory()) {
        if (existsSync(l)) {
          const target = lstatSync(l);
          rejectLink(target, l);
          if (!target.isDirectory())
            throw new HpcError("Target must be a directory", "INVALID_PATH");
        }
        mkdirSync(l, { recursive: true });
        const entries = await new Promise<{ filename: string }[]>(
          (resolve, reject) =>
            sftp.readdir(r, (e, list) => (e ? reject(e) : resolve(list))),
        );
        for (const e of entries) {
          if (e.filename === "." || e.filename === "..") continue;
          safeName(e.filename);
          await walk(posix.join(r, e.filename), join(l, e.filename));
        }
      } else parts.push(await downloadFile(client, sftp, r, l, options));
    };
    await walk(remote, local);
    return aggregate(local, parts);
  });
}
