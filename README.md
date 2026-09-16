# dsh-plugin-ptc-bash

一个 dsh agent preset 包：以**官方 PTC preset** 为底座，去掉梁神模式的「特殊第一轮」，
在 Windows 上提供以 **Git Bash 为首选**的 `bash` 工具，并把 AGENTS.md 指令链放进系统提示词。

- 预设 id：`ptc-bash`（显示名「PTC + Bash 模式」）
- 宿主半边：启动时把 `presets/ptc-bash/**` 幂等同步到 `$DSH_HOME/.agent-presets/ptc-bash/`
  （harness-home 用户根，agent-presets roster 本来就在扫描），因此预设无需手工复制即可被新会话选用。
- 零运行时依赖：只用 node 内置模块，不依赖任何 `@deepseek-ai/*` 包（预设行引用的是官方插件，
  与插件包自身的依赖无关）。

## 预设里有什么

| 行 | 说明 |
|---|---|
| `tool-bash` | 官方行：非 win32 用沙箱 bash 执行器 |
| `tool-pwsh` | 官方行：win32 的 pwsh，**保留为备用 shell** |
| `dsh-bash-win`（新增） | win32 的 Git Bash `bash` 工具（首选 shell）；参数集对齐官方（`description`/`timeoutMs`/`run_in_background`），后台任务用 `job_output`/`job_kill` 收集 |
| `workspace-instructions`（新增） | AGENTS.md/CLAUDE.md 指令链进系统提示词；官方 `agent-instructions` 的重复注入被替换为标记消息 |
| 其余行 | 与官方 `ptc` 逐字一致（含 `tool-presentation` `mode: ptc` → 首回合即 PTC、`/goal`、`web_fetch`、subagent 模型选择等） |

## 安装

```sh
dsh plugin --profile web add <本包目录或 git URL>
# 重启 dsh web 后，新建会话的预设选择器里即可看到「PTC + Bash 模式」
```

## 验证

```sh
npm test                       # 同步幂等 / 组合结构 / 插件行为
node --check lib/index.js
node --check presets/ptc-bash/dsh-bash-win.mjs
node --check presets/ptc-bash/workspace-instructions.mjs
```

新会话里的手工验收：`bash` 能跑 `uname -s` / `git --version` / `pwd`；非零退出带输出回报；
普通命令走 `bash` 而非 `pwsh`；首个回合即为 PTC（工具面只有 `run_code` + SDK）。

## 迭代注意

- **改 `.mjs` 不触发预设重挂**：挂载代际只以 `presets/ptc-bash/agent.cordis.yml` 的 mtime+size 为键。
  改完插件文件后把插件重新挂载：重启 `dsh web`，或 `touch presets/ptc-bash/agent.cordis.yml` 后重启
  （同步只在新宿主启动时运行）。
- 预设 id 不得与内置/随包预设重名（内置根优先，重名会被静默忽略）。
- 预设目录必须是真实目录：符号链接目录会被 roster 跳过。

## 回滚

```sh
dsh plugin --profile web remove dsh-plugin-ptc-bash   # 解除装载
rm -rf "$DSH_HOME/.agent-presets/ptc-bash"            # 清理同步产物
```


## bash 工具（dsh-bash-win）

预设里的加载行默认不带配置，全部走默认值；需要调整时给该行加 `config`：

| 键 | 默认 | 含义 |
|---|---|---|
| `bashPath` | 自动推断 | 显式指定 Git Bash 可执行文件；推断顺序：git 安装根 → ProgramFiles / ProgramFiles(x86) / LOCALAPPDATA / scoop 推导根 → PATH（兜底可能是 WSL shim） |
| `timeoutMs` | `120000` | 每次调用的默认超时 |
| `maxTimeoutMs` | `600000` | 单次 `timeoutMs` 参数的上限 |
| `maxOutputBytes` | `64000` | 每路输出在内存中的上限；被截断时结果里会给出 spill 文件路径 |
| `enableRunInBackground` | `true` | 设为 `false` 时 `run_in_background` 直接报错 |

模型侧参数：`command`（必填）、`description`（必填，UI 显示用）、`timeoutMs`、`workdir`（相对路径按会话工作目录解析）、
`run_in_background`。

结果文本：stdout → `[stderr]` 段 → `[output truncated; full output: <path>]` / `[timed out after Nms]` / `[killed by signal: S]` /
`[exit code: N]` 标记。非零退出是「报告」而不是错误结果；只有参数非法、spawn 失败、工具调用被中止才是 isError。
后台任务注册到宿主 `ctx.jobs` 注册表，用 `job_output` / `job_list` / `job_kill` 驱动（需要 `dsh-jobs` 与 `dsh-tool-jobs` 已装载，预设里本来就带 `tool-jobs`）。

## 派生脚本（不是黑箱）

agent.cordis.yml 与 workspace-instructions.mjs 由上游产物派生（dsh-bash-win.mjs 早期同样是派生件，
现已在本仓库自行维护，派生脚本不覆盖它）；tools/derive-preset.mjs 把派生过程写成可重跑、带断言的脚本：

```sh
npm run derive-preset
# 可选：DSH_PLUGIN_HOME / LIANGSHEN_PRESET_DIR / PTC_BASH_PRESET_DIR 覆盖三个路径
```

它对 agent.cordis.yml 施加三处锚定修改，对两个 .mjs 施加锚定替换与删除，任何锚点缺失或不唯一
时直接失败且不写入。改动点与断言在 NOTICE 与脚本头部都有记录；重跑后产物若与仓库里的不同，
git diff 就能看出是上游漂移还是本地手改。

## 出处与许可

见 [NOTICE](./NOTICE) 与 [LICENSES/](./LICENSES)：

- `agent.cordis.yml` 改编自官方 `ptc` preset（MIT，DeepSeek）；
- `dsh-bash-win.mjs`（原 `custom-bash.mjs`，后改名并增强）原始实现来自 xiaobright/dsh-anchored-standard（MIT），直接来源是
  `@linxin666/dsh-liangshen`（Apache-2.0）；
- `workspace-instructions.mjs` 来自 `@linxin666/dsh-liangshen` 的 `minimal-prompt.mjs`（Apache-2.0）。

本包自有代码（`lib/`、`test/`、`tools/`、`cordis.patch.yml`）以 MIT 分发；随包分发的派生文件按其上游
许可（Apache-2.0 / MIT）使用，改动声明见 NOTICE。
