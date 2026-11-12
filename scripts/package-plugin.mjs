import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { zipSync } from "fflate";

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  release = join(root, "release"),
  stage = join(release, "codex-hpc");
const example = JSON.parse(
  readFileSync(join(root, "examples/config.json"), "utf8"),
);
if (!Array.isArray(example.servers) || example.servers.length !== 0)
  throw new Error(
    "Published config must contain an empty servers array; remove personal server entries before packaging.",
  );
if (!stage.startsWith(release + sep) || stage === release)
  throw new Error("Invalid staging target");
mkdirSync(release, { recursive: true });
if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
mkdirSync(stage);
for (const name of [
  "dist",
  "skills",
  ".codex-plugin",
  ".mcp.json",
  "examples",
  "README.md",
  "NOTICE.md",
  "LICENSE",
  "package.json",
  "package-lock.json",
])
  cpSync(join(root, name), join(stage, name), { recursive: true });
const npmCli =
  process.env.npm_execpath ||
  join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
const installed = spawnSync(
  process.execPath,
  [
    npmCli,
    "ci",
    "--omit=dev",
    "--ignore-scripts",
    "--offline",
    "--no-audit",
    "--no-fund",
  ],
  { cwd: stage, stdio: "inherit" },
);
if (installed.status !== 0)
  throw new Error(
    "Production dependency installation failed. Run npm ci in the project to populate the cache.",
  );
const catalog = {
  name: "codex-hpc-local",
  interface: { displayName: "Codex HPC" },
  plugins: [
    {
      name: "codex-hpc",
      source: { source: "local", path: "./" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    },
  ],
};
mkdirSync(join(stage, ".agents/plugins"), { recursive: true });
writeFileSync(
  join(stage, ".agents/plugins/marketplace.json"),
  JSON.stringify(catalog, null, 2) + "\n",
);
const entries = {};
function collect(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (entry.isFile())
      entries["codex-hpc/" + relative(stage, path).split(sep).join("/")] =
        new Uint8Array(readFileSync(path));
  }
}
collect(stage);
const version = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
).version;
const artifact = join(release, `codex-hpc-${version}-plugin.zip`);
writeFileSync(artifact, zipSync(entries, { level: 6 }));
console.log(
  JSON.stringify({
    pluginRoot: stage,
    zip: artifact,
    files: Object.keys(entries).length,
  }),
);
