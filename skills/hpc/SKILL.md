---
name: hpc
description: Manage configured SSH servers, submit and inspect Slurm or bare-metal compute jobs, transfer files with resume, and open local tunnels through the Codex HPC MCP tools. Use for remote server and HPC work, not unrelated local commands.
---

Start with `server_list` to resolve a server ID. Configure inventory with
`server_add`; pass environment variable names and absolute local key paths.
Passwords and key passphrases belong in the MCP process environment, not tool arguments.
If connection reports MFA_REQUIRED, obtain a current code and use `server_connect(otp)`;
OTP arguments may appear in the host transcript. Reuse the pooled connection afterwards.

Use `shell_run` for short login-node work. Its named session preserves cwd,
exports and module loads only while this MCP process lives. Timeout resets that
shell; inspect `stateReset` before relying on prior environment setup.

Submit compute or long-running work with `job_submit`, with an absolute remote
workdir and an explicit command or script. Combine related pipeline steps into one
job. Include a stable `requestId` when a retry could otherwise duplicate work.
An uncertain submission must be checked with `job_status` using the reported ID;
retrying with a new requestId can start duplicate remote work. Slurm and Linux
bare-metal submission are supported; PBS/LSF are detection-only.

Submission returns without waiting for completion. Check `job_status`, or use
`job_wait` (up to 30 seconds) when asked to wait. Remote completion does not
automatically wake Codex. If asked to follow a run to completion, continue using
bounded waits and report meaningful changes. Read `job_logs` incrementally using
its byte `nextOffset`; stdout/stderr offsets are separate. Use `job_cancel` to stop work.

Uploads/downloads use explicit parent directories and append the source basename.
Transfers run in the background by default: inspect `transfer_status` and use
`transfer_cancel` to stop one. Re-submit the same paths to resume `.part` data.
Different target content requires explicit overwrite intent; identical content is skipped.
`transfer_queue.items` is an array of `{source,targetDir}`, not a JSON string.

Remote compute survives disconnect. Shells, local transfers, resource monitoring
and forwards end when this MCP process exits. Reopening reconciles recorded remote
jobs; it does not restore shell state or automatically restart local transfers.
Use `server_usage` for resources and `forward` for loopback-only local tunnels.
