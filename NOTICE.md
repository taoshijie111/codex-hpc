# Source and attribution

Codex HPC is derived from [taoshijie111/dsh-hpc](https://github.com/taoshijie111/dsh-hpc),
revision `70e99b5484c827c9a04eeccf2d5b5b8130e71a92` (MIT).
The original MIT license is preserved in LICENSE.

The SSH connection pool, persistent shell framing, scheduler/bare-metal job engine,
job state classification, resource parsers and original regression scenarios were
adapted from that project. MCP integration, environment credentials, locked JSON
configuration, SQLite persistence, transfer streaming, CLI and plugin packaging
are maintained here independently. No DeepSeek Harness or Cordis package is
required at runtime.

Runtime dependency licenses are included with the packaged dependencies:
`@modelcontextprotocol/sdk`, `ssh2`, `proper-lockfile`, `zod` and their dependencies.
