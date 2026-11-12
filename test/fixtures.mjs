import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";

export function unquote(text) {
  return text.startsWith("'")
    ? text.slice(1, -1).replaceAll("'\\''", "'")
    : text;
}
export function commandBody(text) {
  return text.startsWith("bash -lc ") ? unquote(text.slice(9)) : text;
}
export function response(callback, text, code = 0, stderr = "") {
  const stream = new PassThrough();
  stream.stderr = new PassThrough();
  stream.close = () => stream.destroy();
  callback(null, stream);
  queueMicrotask(() => {
    stream.emit("data", Buffer.from(text));
    if (stderr) stream.stderr.emit("data", Buffer.from(stderr));
    stream.emit("close", code);
  });
  return stream;
}
export function fileClient(root, { corrupt = false } = {}) {
  const remote = (p) => join(root, p.replace(/^\//, ""));
  const sftp = new EventEmitter();
  let closed = 0;
  sftp.end = () => closed++;
  sftp.lstat = (p, cb) =>
    fs.lstat(remote(p), (e, s) =>
      cb(
        e
          ? Object.assign(new Error(e.message), {
              code: e.code === "ENOENT" ? 2 : 4,
            })
          : null,
        s,
      ),
    );
  sftp.mkdir = (p, cb) => fs.mkdir(remote(p), cb);
  sftp.readdir = (p, cb) =>
    fs.readdir(remote(p), { withFileTypes: true }, (e, list) =>
      cb(
        e,
        list?.map((x) => ({ filename: x.name })),
      ),
    );
  sftp.rename = (a, b, cb) => fs.rename(remote(a), remote(b), cb);
  sftp.ext_openssh_rename = sftp.rename;
  sftp.unlink = (p, cb) => fs.unlink(remote(p), cb);
  sftp.createReadStream = (p, o) => fs.createReadStream(remote(p), o);
  sftp.createWriteStream = (p, o) => fs.createWriteStream(remote(p), o);
  const client = new EventEmitter();
  client.end = () => client.emit("close");
  client.sftp = (cb) => queueMicrotask(() => cb(null, sftp));
  client.exec = (wrapped, cb) => {
    const body = commandBody(wrapped),
      match = /sha256sum -- (.*?); else/.exec(body);
    if (!match) {
      response(cb, "", 1, "unsupported fake command");
      return;
    }
    const path = unquote(match[1]);
    try {
      const hash = createHash("sha256")
        .update(fs.readFileSync(remote(path)))
        .digest("hex");
      response(
        cb,
        `${corrupt && path.endsWith(".part") ? "0".repeat(64) : hash}  ${path}\n`,
      );
    } catch {
      response(cb, "", 1, "missing");
    }
  };
  return { client, sftp, remote, getClosed: () => closed };
}
export function fakePool(client) {
  let holds = 0;
  return {
    ensure: async () => ({ client, alive: true, fingerprint: "SHA256:fake" }),
    hold: () => holds++,
    release: () => holds--,
    closeAll: async () => {},
    close: async () => {},
    list: () => [],
    get: () => undefined,
    attachSession: () => {},
    detachSession: () => {},
    get holds() {
      return holds;
    },
  };
}
