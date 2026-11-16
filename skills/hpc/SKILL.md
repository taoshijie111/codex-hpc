---
name: hpc
description: Manage configured SSH servers, submit and inspect Slurm or bare-metal compute jobs, transfer files with resume, and open local tunnels through the Codex HPC MCP tools. Use for remote server and HPC work, not unrelated local commands.
---

Start with `server_list` to resolve a server ID. Configure inventory with
`server_add`; pass environment variable names and absolute local key paths.
Passwords and key passphrases are referenced by environment variable names, never tool arguments.
The MCP process environment takes precedence. On Windows, missing process values fall
back to the current user's saved environment, queried by the configured name only.
If credentials are missing, use `codex-hpc doctor` to check availability/source without
printing values. A terminal's environment is not proof that the MCP has the value.
Do not work around credential failures by extracting passwords or bypassing the plugin.
After changing plugin code, reload its MCP process before retrying connections.
For a known six-digit MFA server, register `requiresOtp: true` before connecting.
If the user requests key login, call `server_setup_key` without an OTP first to
prepare the dedicated local key before asking for a newly refreshed code. Then
immediately call `server_setup_key(server, otp)` once with the fresh code. It
authenticates, appends the public key on the same connection, verifies key-only
login once, and changes config only if that verification succeeds. Do not promise
OTP-free access until `keyOnlyVerified` is true; server policy may still require MFA.
Otherwise use `server_connect(server, otp)` once. Password and OTP can be two prompts
within keyboard-interactive; the tool selects this before SSH password authentication.
OTP arguments may appear in the host transcript. Never store codes or TOTP seeds.
After an authentication/connection failure STOP. Do not call shell_run, server_test,
or another tool to force a reconnect. Do not reuse a failed code, append it to a
password, change authentication methods, or launch a manual SSH retry. Ask the user
before any further attempt; `retryAuth: true` explicitly overrides the process's
retry guard and must only be used with that authorization. A fresh user-provided
OTP permits one new attempt. Prepare all local work before requesting a short-lived
code. If a code was never submitted, explain that rather than blaming its expiry.
Reuse the pooled connection after successful login.

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
