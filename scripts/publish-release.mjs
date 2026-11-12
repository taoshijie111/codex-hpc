import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const tag = process.env.GITHUB_REF_NAME,
  repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
if (!token || !repository)
  throw new Error("GH_TOKEN and GITHUB_REPOSITORY are required");
if (tag !== `v${pkg.version}`)
  throw new Error("Tag must match the package version");
const path = resolve("release", `codex-hpc-${pkg.version}-plugin.zip`),
  bytes = readFileSync(path);
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "codex-hpc-release",
};
async function api(route, method = "GET", body) {
  const response = await fetch(
    `https://api.github.com/repos/${repository}${route}`,
    {
      method,
      headers: { ...headers, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    },
  );
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok && response.status !== 404)
    throw new Error(`GitHub API ${response.status}: ${data?.message}`);
  return { status: response.status, data };
}
let { status, data: release } = await api(
  `/releases/tags/${encodeURIComponent(tag)}`,
);
if (status === 200 && !release.draft)
  throw new Error(
    "A published release already exists; publish a new version instead of replacing it",
  );
if (status === 404)
  ({ data: release } = await api("/releases", "POST", {
    tag_name: tag,
    name: `Codex HPC ${tag}`,
    draft: true,
    generate_release_notes: true,
    body: "Local Codex HPC plugin. The ZIP includes compiled code and production dependencies, with an empty server configuration. Requires Node.js 24. See README for installation.",
  }));
const name = `codex-hpc-${pkg.version}-plugin.zip`;
for (const asset of release.assets ?? [])
  if (asset.name === name) await api(`/releases/assets/${asset.id}`, "DELETE");
const upload = new URL(release.upload_url.split("{")[0]);
if (upload.origin !== "https://uploads.github.com")
  throw new Error("Unexpected release upload origin");
upload.searchParams.set("name", name);
const response = await fetch(upload, {
  method: "POST",
  headers: { ...headers, "Content-Type": "application/zip" },
  body: bytes,
  signal: AbortSignal.timeout(120000),
});
if (!response.ok) throw new Error(`Release upload failed (${response.status})`);
await api(`/releases/${release.id}`, "PATCH", { draft: false });
console.log(`Published https://github.com/${repository}/releases/tag/${tag}`);
