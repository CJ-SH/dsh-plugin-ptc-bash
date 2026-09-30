# dsh-plugin-ptc-bash 技术笔记

[README](../README.zh.md) 面向安装与使用者；本文面向改这个包的人，承载被挤出 README 的契约、
操作、排障与内部结构。事实点（命令、路径、状态码、席位 id、限制、许可与出处）按原样保留，
只删掉「当初怎么一步步做出来」的过程化叙述。

## 契约

### 预设声明

- 预设 id：`ptc-bash`（显示名「PTC + Bash 模式」）。
- 宿主半边在激活时读本包自带的 `presets/ptc-bash/{preset.yml,agent.cordis.yml}`，调
  `ctx.agentPresets.register({ id, name, description, order, plugins })` 把预设**声明**给宿主注册表。
  0.2.0 起预设只以声明方式存在——不再有任何 roster 扫描 `$DSH_HOME/.agent-presets`——因此预设无需手工复制
  即可被新会话选用。
- 注册表按**声明方 loader 的基准**挂载，`./` 会被解析到 profile 而不是本包，因此相对行
  （`./dsh-bash-win.mjs`、`./workspace-instructions.mjs`）发成 **file URL**。
- 零运行时依赖：宿主半边只用 node 内置模块、**不 import 任何 `@deepseek-ai/*` 包**（组合文件由包内自带的
  小读取器解析，测试用装机自带的 `js-yaml` + `entryListSchema` 逐行比对它）。它只通过
  `inject: ['agentPresets']` 使用注册表服务：缺该服务的 profile 里本行**不激活**而不是报错。
- `peerDependencies` 声明 `@deepseek-ai/dsh: ^0.2.0-rc.1`：0.2.0 的兼容门禁只校验
  `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peer，**不声明就静默放行**；声明后不兼容的升级会在启动时
  拒绝本行并在 stderr 给出原因。
- 预设 id 不得与已声明的预设重名：注册表会抛 `Duplicate agent preset: ptc-bash`，本包**只 warn 不注册**
  （`apply` 不抛错；不再有 0.1.x 那种「内置根优先、重名静默忽略」）。
- 预设文件必须随包存在：相对行发成 file URL 后指向本包 `presets/ptc-bash/` 下的真实文件，文件缺失时该行
  在挂载时报错（`composition-health` 的逐行查找会先拦下）。
- 宿主半边读不懂的组合构造会**直接抛错**（带行号），`apply` 只 warn 一次、不注册预设——宁可没有预设，
  也不要一个悄悄少了几行的预设。

### 预设行表

| 行 | 说明 |
|---|---|
| `tool-bash` | 官方行：非 win32 用沙箱 bash 执行器 |
| `tool-pwsh` | 官方行：win32 的 pwsh，**保留为备用 shell** |
| `dsh-bash-win`（新增） | win32 的 Git Bash `bash` 工具（首选 shell）；参数集对齐官方（`description`/`timeoutMs`/`run_in_background`），后台任务用 `job_output`/`job_kill` 收集 |
| `workspace-instructions`（新增） | AGENTS.md/CLAUDE.md 指令链进系统提示词；官方 `agent-instructions` 的重复注入被替换为标记消息 |
| `workflow-ptc` / `tool-workflow` / `tool-ralph` | 官方行：编排引擎与它的两个消费方（`workflow` 扇出脚本、`ralph` 全新 agent 迭代）。官方在 `ptc` 里默认**三行全禁用**——PTC 模式的编排面只有 `run_code` + subagent 工具——本预设跟随上游，不额外保留 ralph |
| `tool-plugin-manager` | 官方行：模型侧 `plugin_manager`（可改 profile 插件与组合包，官方默认 `disabled`），本预设跟随上游 |
| 其余行 | 与官方 `ptc` 逐行一致（含 `tool-presentation` `mode: ptc` → 首回合即 PTC、`/goal`、`web_fetch`、subagent 模型选择等） |

### bash 工具（dsh-bash-win）配置与结果契约

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

### 会话身份（DSH_*）

工具声明 `inject: ['subprocess', 'tools', 'systemPrompt', 'shellEnv']`，并在每次调用时把
**本次执行**的 dsh shell 环境事实（`ctx.shellEnv.collect(exec)`：`DSH_SESSION_ID` / `DSH_SHELL` / `DSH_HOME`
+ 贡献者变量）作为 spawn spec 的显式 `env` 传给 Git Bash。

为什么必须这么做：`@deepseek-ai/dsh-subprocess` 会**主动剥掉 ambient 环境里所有 `DSH_*`**（Windows 名字大小写不敏感，
避免「当前 DSH_* 事实」被隐式继承），spawn spec 的 `env` 是唯一受支持的注入通道；官方 `dsh-tool-bash` / `dsh-tool-pwsh`
用的正是同一条路径。

影响：任何在**本 bash 工具**里跑的子进程都能拿到当前 dsh 会话 id。对 Trellis 工作区而言，这意味着
`python ./.trellis/scripts/task.py create|start` 不再进入降级模式，会正常写
`.trellis/.runtime/sessions/dsh_session-<id>.json` 会话指针（dsh 的 `statusline` 之类消费者依赖它）。
注册表缺失 / 抛错 / 返回空时归一为「不注入」，shell 照常工作（`test/plugins.test.mjs` 覆盖这三种降级）。

注意生效时机：预设模块在**会话挂载时**加载，因此改动只对改动后**新开的会话**生效；老会话沿用旧模块。

## 操作与排障

### 卸载与回滚

```sh
dsh plugin --profile web remove dsh-plugin-ptc-bash   # 解除装载；预设声明随行卸载一起撤销
rm -rf "$DSH_HOME/.agent-presets/ptc-bash"            # 只在清理 0.1.x 的同步产物时需要；0.2.0 不读该目录
```

### 迭代注意

- **升级 dsh 后先重派生，再跑测试**：`npm run derive-preset` 按装机的
  `@deepseek-ai/dsh-web-app/presets/ptc.patch.yml`（`insert[0].config.plugins`）重写组合，
  把上游改名与默认值一起带过来，随后 `npm test`。上游把某个包改名/删掉导致的行失效，由
  `test/composition-health.test.mjs` 在测试阶段拦下，而不是等到会话挂载失败。
- **改 `presets/ptc-bash/**` 不触发热重挂**：注册发生在**插件行激活**时（宿主启动），预设行由 loader
  在注册时 import，ESM 模块缓存会复用已加载的模块。改完 `.mjs` 或改完 `agent.cordis.yml` 都要重启
  `dsh web` 才会生效（本包不依赖 HMR，热重载未在 0.2.0 上实测）。

## 内部结构

- **宿主半边**在 `lib/`：只用 node 内置模块与注册表服务，不含任何 `@deepseek-ai/*` 依赖。
- **组合读取**：`presets/ptc-bash/agent.cordis.yml` 由包内自带的读取器解析，测试用装机自带的
  `js-yaml` + `entryListSchema` 逐行比对，确认声明与磁盘一致。
- **派生脚本（不是黑箱）**：`agent.cordis.yml` 与 `workspace-instructions.mjs` 由上游产物派生
  （`dsh-bash-win.mjs` 早期同样是派生件，现已在本仓库自行维护，派生脚本不覆盖它）；
  `tools/derive-preset.mjs` 把派生过程写成可重跑、带断言的脚本：

  ```sh
  npm run derive-preset
  # 可选：DSH_INSTALL_ROOT（dsh 包根）/ DSH_PLUGIN_HOME（装机的 @deepseek-ai 目录）/
  #       LIANGSHEN_PRESET_DIR / PTC_BASH_PRESET_DIR 覆盖四个路径
  ```

  它从装机 `@deepseek-ai/dsh-web-app/presets/ptc.patch.yml` 的 `insert[0].config.plugins`
  读上游 `ptc` 行表（0.2.0 不再以 preset 目录分发该预设，0.1.x 的 `@deepseek-ai/dsh-agent-presets` 已不存在），
  对 agent.cordis.yml 施加两处锚定修改（shell 行、workspace-instructions 行），对 workspace-instructions.mjs
  施加锚定替换与删除。任何锚点缺失或不唯一时**不写入并以非零状态退出**；两处写盘都先写临时文件再 `rename`
  （原子替换），不会留下半成品文件。装机路径不写死 node 版本或用户名：`DSH_INSTALL_ROOT` /
  `DSH_PLUGIN_HOME` 优先，否则顺着 `$DSH_HOME/profiles` 的 junction 找到装机。

  **注意**：上游那份 patch 是宿主自己 dump 出来的，**不带注释**，所以重派生会把 agent.cordis.yml 里的
  说明性注释换成纯行表（行内容与当前仓库逐行相同，已核对）。要改注释就先
  `PTC_BASH_PRESET_DIR=<临时目录> npm run derive-preset` 看 diff 再覆盖。

## 开发与验证

### 命令

```sh
npm test                       # 组合读取与结构 / 插件行为 / 清单契约 / 组合健康（装机 harness 判定）
node --check lib/index.js
node --check presets/ptc-bash/dsh-bash-win.mjs
node --check presets/ptc-bash/workspace-instructions.mjs
```

### 组合健康判定（不自己实现）

`test/composition-health.test.mjs` 不自己实现判定：它先定位装机 harness
（`$DSH_HOME/profiles/**/node_modules/@deepseek-ai/dsh`，或 `DSH_INSTALL_ROOT` / `DSH_PLUGIN_HOME` 指定），
再用装机自带的五件东西判：

1. 注册表的 `entryListProblem`——行形状（离线、只验形状）；
2. 声明插件 `@deepseek-ai/dsh-agent-preset` 的 `Config` schema——本包实际提交的那份声明本身；
3. **逐行的包查找**——把每个启用或不启用行的 `name` 按装机的解析路径真的找一遍。
   `entryListProblem` 只验形状，改名/删包它看不出来（0.1.5→0.1.6 的 `dsh-workflow-worker-thread` 改名正是如此，
   而且它就在一行 `disabled: true` 上，所以查找**不跳过 disabled 行**）；
4. `@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility`——启动期兼容门禁本身，用本包的
   `peerDependencies` 跑一次（离线、无副作用），不必等下一次重启才知道本行会不会被拒；
5. 与装机随包 `ptc` 预设的逐行 diff——装机 0.2.0 以 `@deepseek-ai/dsh-web-app/presets/ptc.patch.yml`
   的 `insert[0].config.plugins` 分发该预设。

**装机在、但缺注册表/声明插件时这些用例失败而不是 skip**：2026-09 的静默失效正是这种形态——旧定位器
找不到已删除的 `@deepseek-ai/dsh-agent-presets`，四条权威用例全 skip，skip 文案还把原因写成「没有装机
harness」。只有整机都没有 dsh 时才会 skip，且文案会写明这一点。离线那一半（组合读取、结构契约、清单契约）
永远运行，不依赖装机。

### 手工验收（需新会话）

新会话里的手工验收：`bash` 能跑 `uname -s` / `git --version` / `pwd`；非零退出带输出回报；
普通命令走 `bash` 而非 `pwsh`；首个回合即为 PTC（工具面只有 `run_code` + SDK）。

预设可见性（0.2.0 起唯一无法离线替代的验收）：新会话预设选择器里出现 `ptc-bash`，选中后能新建会话。

会话身份（`DSH_*`）验收，同样要在**新会话**里经 `bash` 工具执行：

```sh
env | grep '^DSH_'        # 期望：DSH_HOME / DSH_SESSION_ID=session-<本会话> / DSH_SHELL=1
```

## 出处与许可

见 [NOTICE](./NOTICE) 与 [LICENSES/](./LICENSES)：

- `agent.cordis.yml` 改编自官方 `ptc` preset（MIT，DeepSeek）。0.2.0 起该预设由
  `@deepseek-ai/dsh-web-app` 的 `presets/ptc.patch.yml`（`insert[0].config.plugins`）随包分发，
  0.1.x 的 `@deepseek-ai/dsh-agent-presets` 包已不存在；许可全文见
  `LICENSES/deepseek-dsh-agent-presets-MIT.txt`（文件名保留，内容即该 preset 的 MIT 文本）；
- `dsh-bash-win.mjs`（原 `custom-bash.mjs`，后改名并增强）原始实现来自 xiaobright/dsh-anchored-standard（MIT），直接来源是
  `@linxin666/dsh-liangshen`（Apache-2.0）；
- `workspace-instructions.mjs` 来自 `@linxin666/dsh-liangshen` 的 `minimal-prompt.mjs`（Apache-2.0）。

本包自有代码（`lib/`、`test/`、`tools/`、`cordis.patch.yml`）以 MIT 分发；随包分发的派生文件按其上游
许可（Apache-2.0 / MIT）使用，改动声明见 NOTICE。派生链与逐项改动见 NOTICE。
