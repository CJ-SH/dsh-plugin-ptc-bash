# dsh-plugin-ptc-bash

[English](README.md) | 中文

`ptc-bash` 在 dsh 的 Windows 会话里提供以 **Git Bash 为首选**的 `bash` 工具，并把 AGENTS.md 指令链带进系统提示词。

## 功能

- **首个回合即为 PTC**：以官方 PTC preset 为底座，工具面只有 `run_code` 与 subagent 工具。
- Windows 上首选 **Git Bash**：新增 `dsh-bash-win` 行，参数集对齐官方 `bash`（`description` / `timeoutMs` / `run_in_background`）。
- 保留官方 `pwsh` 行作备用 shell；其余行与官方 `ptc` 逐行一致。
- 新增 `workspace-instructions` 行：AGENTS.md / CLAUDE.md 指令链随系统提示词注入。
- 预设以**声明**方式注册到宿主，无需手工复制任何文件即可被新会话选用。

## 安装

### 从 GitHub 安装（推荐）

```bash
dsh plugin --profile web add github:CJ-SH/dsh-plugin-ptc-bash
```
### 从本地目录安装

```bash
dsh plugin --profile web add ./dsh-plugin-ptc-bash
```
重启 dsh web 后，新建会话的预设选择器里即可看到「PTC + Bash 模式」。

## 使用

- 入口：新建会话时在预设选择器里选「PTC + Bash 模式」（预设 id `ptc-bash`），选中后即可开新会话。
- 会话里的普通命令走 `bash`（Git Bash）；需要 PowerShell 时仍可用 `pwsh` 工具。
- 预设加载行默认不带配置、全部走默认值；要调整时给 `presets/ptc-bash/agent.cordis.yml` 里对应行加 `config`（可用键见 [docs/design-notes.md](docs/design-notes.md)）。

## 卸载

```bash
dsh plugin --profile web remove dsh-plugin-ptc-bash
```

## 技术说明

- 需要 `@deepseek-ai/dsh` `^0.2.0-rc.1`；不兼容的升级会在启动时拒绝本行并在 stderr 给出原因。
- 预设 id 不得与其他已声明预设重名，重名时本包只 warn、不注册。
- 改 `presets/ptc-bash/**` 不触发热重挂载：都要重启 `dsh web`，且只对**新开的会话**生效。
- `bash` 工具默认超时 `120000`ms、单次上限 `600000`ms、每路输出上限 `64000` 字节（截断时给出 spill 文件路径）。
- 后台任务用 `job_output` / `job_list` / `job_kill` 收集（需 `dsh-jobs` 与 `dsh-tool-jobs` 已装载）。

## 深入阅读

契约、排障与内部结构见 [docs/design-notes.md](docs/design-notes.md)。

## License

MIT © 2026 HenTaiCJN
