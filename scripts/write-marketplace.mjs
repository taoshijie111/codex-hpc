import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = {
  name: "codex-hpc-local",
  interface: { displayName: "Codex HPC" },
  plugins: [
    {
      name: "codex-hpc",
      source: { source: "local", path: "./release/codex-hpc" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    },
  ],
};
mkdirSync(resolve(root, ".agents/plugins"), { recursive: true });
writeFileSync(
  resolve(root, ".agents/plugins/marketplace.json"),
  JSON.stringify(catalog, null, 2) + "\n",
);
