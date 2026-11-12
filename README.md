# Codex HPC

面向 **Codex 桌面版和 CLI** 的本地插件：管理 SSH 服务器、运行持久 Shell、提交 Slurm／普通 Linux 服务器作业、上传下载文件并断点续传。

由 [dsh-hpc](https://github.com/taoshijie111/dsh-hpc) 迁移而来，保留核心能力，运行时不依赖 DeepSeek Harness 或 Cordis。需要 **Node.js 24**；本机支持 Windows、macOS、Linux，远程服务器需要 Bash，普通服务器作业还需要 Linux `/proc`、`setsid` 和 `nohup`。

## 安装：选择一种方式

### A. 安装插件包

从 [GitHub Releases](https://github.com/taoshijie111/codex-hpc/releases/latest) 下载并解压 `codex-hpc-0.1.0-plugin.zip`，其中的 `codex-hpc` 文件夹已含编译产物、生产依赖和 marketplace。无需运行 npm install 或构建。

```powershell
# 替换为解压后的绝对路径
codex plugin marketplace add "E:/tools/codex-hpc"
codex plugin add codex-hpc@codex-hpc-local
```

重开 Codex 会话。桌面版可在插件目录选择 **Codex HPC** 本地来源进行安装；CLI 可用 `/plugins` 检查。需要先将 Node.js 24 加入桌面应用可见的 PATH。

从源码生成同一发布包（Git 仓库不包含编译产物和依赖，请构建后再注册 marketplace）：

```powershell
git clone https://github.com/taoshijie111/codex-hpc.git
cd codex-hpc
npm ci --ignore-scripts
npm run typecheck
npm test
npm run package:plugin
codex plugin marketplace add "E:/tools/codex-hpc/release/codex-hpc"
codex plugin add codex-hpc@codex-hpc-local
```

`release/codex-hpc` 是可直接注册的独立目录。发布 ZIP 包包含此目录。打包仅使用 npm 缓存中的依赖，不运行生命周期安装脚本；可选原生 SSH 加速模块缺失时使用 JavaScript 实现。

### B. 直接注册 MCP 服务

已有源码和依赖时执行 `npm run build`，然后：

```powershell
codex mcp add hpc -- node "E:/tools/codex-hpc/dist/cli.js" serve
```

也可从解压后的包中直接注册 `dist/cli.js`。插件方式与直接 MCP 注册**二选一**。直接 MCP 方式不自动安装操作技能，可参考本仓库 `skills/hpc/SKILL.md`。

需要指定配置或转发凭据环境变量时，在 Codex 的 MCP 设置中配置；以下为 `config.toml` 示例，桌面版和 CLI 共用该设置：

```toml
[mcp_servers.hpc]
command = "node"
args = ["E:/tools/codex-hpc/dist/cli.js", "serve", "--config", "E:/private/hpc/config.json"]
env_vars = ["HPC_CLUSTER_PASSWORD", "HPC_KEY_PASSPHRASE"]
tool_timeout_sec = 180
```

插件方式默认读取下述用户级配置。如使用自定义配置根目录，将 `CODEX_HPC_HOME` 设置到启动 Codex 的环境中。长命令的 MCP 超时可用用户级 `[plugins."codex-hpc@codex-hpc-local".mcp_servers.hpc]` 设置 `tool_timeout_sec = 180`。

规范参考：[官方插件打包](https://developers.openai.com/plugins/build/plugins)、[官方 MCP 配置](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

## 配置服务器与认证

```powershell
node dist/cli.js init
node dist/cli.js config validate
node dist/cli.js doctor
# 任意命令均支持 --config PATH
```

默认目录 `~/.codex-hpc`；设置 `CODEX_HPC_HOME` 可以改变它。`--config` 优先选择配置文件，SQLite 账本与所选文件放在同一目录，并按配置文件路径隔离历史。配置不存在时 MCP 可空配置启动，随后用 `server_add` 添加服务器。

发布包的 `examples/config.json` 默认使用空的 `servers` 列表，不附带服务器或凭据。下面仅为虚构的配置示例，密码模式只保存环境变量名：

```json
{
  "version": 1,
  "servers": [
    {
      "id": "cluster",
      "host": "login.example.org",
      "username": "alice",
      "auth": "password",
      "passwordEnv": "HPC_CLUSTER_PASSWORD",
      "kind": "slurm",
      "schedulerDefaults": {
        "partition": "gpu",
        "cpusPerTask": 8,
        "memory": "32G",
        "gpus": 1
      }
    }
  ]
}
```

省略 `passwordEnv` 时，`cluster-a` 默认读取 `CODEX_HPC_CLUSTER_A_PASSWORD`。密钥模式设置 `auth: "key"` 和绝对路径 `keyPath`；加密私钥另配 `keyPassphraseEnv`。不支持在配置中写入密码或私钥内容。

环境变量必须对 **MCP 子进程** 可见：在启动 Codex 的终端设置后启动，或配置 Codex 的 `env_vars`。已经运行的桌面应用不会自动获得其他终端中新设置的变量，应完全退出后重开。`doctor` 仅报告变量名是否缺失、密钥可读性及指纹配置状态，不输出秘密值；它不连接服务器。

键盘交互 MFA 使用 `server_connect(server, otp)`。密码不会替代缺失的验证码。如果已提供 OTP、服务器没有发出交互提示且明确拒绝认证，最多额外尝试一次“密码＋验证码”，兼容原插件支持的网关。插件不持久化 OTP，**宿主仍可能记录工具参数或对话中的验证码**。

首次 SSH 握手采用 TOFU：在发送认证材料前把观察到的 `SHA256:…` 指纹写入配置。也可提前提供 `hostKey`。指纹变化时拒绝连接；核实远程服务器后手工更新配置，或通过 `server_add` 更新指纹。

其他服务器字段保留：`port`、`label`、`kind`、`resolvedKind`、`jobRoot`、`schedulerDefaults`。`kind` 为 `auto | bare | slurm | pbs | lsf`。只有 Slurm 和 bare 支持提交；PBS／LSF 仅识别。

全局默认值：连接超时 15 秒，Shell 命令超时 120 秒，保活间隔 30 秒，连接空闲回收 10 分钟，每服务器 4 个命名 Shell，Shell 空闲回收 30 分钟，Shell 启动超时 30 秒。对应字段见初始化生成的配置；空闲和保活间隔设为 0 可关闭。

## 使用示例

在 Codex 中直接描述工作即可，例如：

> 查看 cluster 的 GPU 和队列资源，把本地项目上传到 /home/alice/work，然后申请一张 GPU 运行 train.py。

工具调用示例：

```text
server_list()
server_test(server="cluster", profile=true)
server_usage(server="cluster")
shell_run(server="cluster", command="cd ~/work && module load cuda")
shell_run(server="cluster", command="pwd")
job_submit(server="cluster", command="python train.py", workdir="/home/alice/work",
           requestId="experiment-001", partition="gpu", gpus=1)
job_status(jobId="hpc-...")
job_wait(jobId="hpc-...", timeoutMs=30000)
job_logs(jobId="hpc-...", offset=0)
download(server="cluster", remotePath="/home/alice/work/results", localDir="E:/results")
transfer_status(transferId="transfer-...")
```

上传目标为 `remoteDir/basename(localPath)`；下载目标为 `localDir/basename(remotePath)`。路径均需绝对路径。队列的 `items` 是数组，例如 `[{"source":"E:/data/a.bin","targetDir":"/home/alice/data"}]`。

| 类别   | 工具                                                                                                                             |
| ------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 服务器 | `server_list`、`server_add`（新增／更新）、`server_remove`、`server_test`、`server_connect`、`server_disconnect`、`server_usage` |
| Shell  | `shell_run`、`shell_close`                                                                                                       |
| 作业   | `job_submit`、`job_status`、`job_wait`、`job_logs`、`job_cancel`                                                                 |
| 传输   | `upload`、`download`、`transfer_queue`、`transfer_status`、`transfer_cancel`                                                     |
| 隧道   | `forward`（打开／关闭）                                                                                                          |

## 状态与故障恢复

- **持久 Shell**：工作目录和环境在同一 MCP 进程内保持，命令串行执行。超时或取消报告 `stateReset`，只重置受影响的 Shell。Shell 状态不会传给 `job_submit`，作业脚本需自行设置环境。
- **作业**：提交意图先写入 SQLite，随后交给 Slurm 或 `setsid/nohup`。稳定的 `requestId` 防止同一请求重试时重复启动；请求结果不明会报告作业 ID，先查询该 ID。`unknown` 不是失败或完成。控制端无法识别的不确定启动不会自动重试。
- **监控**：MCP 存活时自适应查询，状态持久化。关闭后计算继续，重开后重新核对；需要 MFA 或凭据时先重新连接。完成事件不会自动唤醒 Codex，可主动查询或使用每次最多 30 秒的 `job_wait`。
- **传输**：默认后台执行，`background:false` 最多等待 30 秒，超过后取消并保留临时数据。每文件 `.part` 暂存、SHA256 校验后才替换目标。同内容跳过，不同内容须显式 `overwrite:true`；本地原子重命名，远程覆盖需要 OpenSSH 原子重命名扩展，不支持时保留原文件与 `.part` 并报错。
- **续传和取消**：用相同路径重新提交传输。`transfer_cancel` 可向另一个 MCP 进程的传输发出取消请求，状态随后变成 `cancelled`。关闭 MCP 的活动传输标记 `interrupted`；崩溃后最多约 15 秒租约到期后识别为中断。符号链接和特殊文件不传输。
- **多会话**：每个 MCP 进程有独立连接池、Shell 和隧道；配置、任务历史与租约共享。配置文件应放在本机磁盘，SQLite WAL 不适用于网络共享文件系统。更新连接配置会使相关旧连接和 Shell 失效。
- **隧道**：仅绑定本地 `127.0.0.1`。远程目标是从登录服务器可达的主机。没有 SSH 跳板链。

任意远程 Shell／作业命令均可能修改远程系统，工具已标记为可能写入，审批仍由 Codex 的工具策略控制。SSH 私钥、环境变量及用户账户权限决定可访问范围。服务的标准输出只承载 MCP 协议，诊断使用标准错误。

## 开发与验证

```powershell
npm ci --ignore-scripts
npm run typecheck
npm test
npm run package:plugin
node --test test/package-smoke.mjs
```

测试包含真实 stdio 客户端、本机真实 SSH 握手／MFA、注入的 SFTP 文件系统、Shell 故障恢复、作业状态机、提交结果丢失恢复、并发配置和 SQLite 事务。文件测试包含二进制、目录、空目录、中文及空格路径、覆盖与校验保护、双向续传和取消。

GitHub Actions 在 Windows／macOS／Linux 的 Node.js 24 上构建、测试和打包。本机验证不等于远程生产 Slurm 验证。真实服务器测试默认跳过；配置 `HPC_TEST_HOST`、`HPC_TEST_USER` 和 `HPC_TEST_PASSWORD`（或 `HPC_TEST_KEY_PATH`），可选 `HPC_TEST_PORT`、`HPC_TEST_KIND=bare|slurm` 后执行 `node --test test/live.test.mjs`。测试会创建专用临时远程工作目录并提交一个短作业，适合专门的测试账户。

发布范围是本地使用：不提供网页管理、常驻后台服务、公网 MCP、跳板链、PBS／LSF 提交或 DSH 双宿主适配。

发布新版本时，将 `package.json`、插件清单和 MCP 服务版本同步更新，并推送匹配的 `vX.Y.Z` 标签。Release 工作流会先构建和测试，再发布包含依赖的 ZIP；已发布版本不会被覆盖。

## 许可证

MIT。原始代码版本和迁移来源见 [NOTICE.md](NOTICE.md)。
