# codex-delegation-guard

[English](README.md) | [简体中文](README.zh-CN.md)

让 Claude Code 真正把大型编码任务交给 Codex：为官方 [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) 配套的、基于 hook 的分工守卫。

[![MIT 许可证](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-green.svg)](package.json)
[![测试](https://github.com/publicmain/codex-delegation-guard/actions/workflows/test.yml/badge.svg)](https://github.com/publicmain/codex-delegation-guard/actions/workflows/test.yml)

## 要解决的问题

在 `CLAUDE.md` 中写“把大型编码任务交给 Codex”，仍然只是一条指令。
长会话中模型可能偏离约定，上下文压缩也可能丢掉这条规则。
现有的委派命令、模式和技能，仍依赖模型记得使用它们。
本插件增加提醒和写入时的检查，让 Claude 在直接进行较大代码修改前重新考虑分工。

## 它做什么

- **先分工。** 在会话启动、恢复和上下文压缩后注入判断标准；对符合条件的编码提示，最多每三个真实用户提示提醒一次。

  ```text
  Split: Codex does X (brief + tests), I do Y.
  ```

- **写入时检查。** 对 Git 工作树中、扩展名符合配置的代码文件，检查 `Write`、`Edit`、`MultiEdit` 和 `NotebookEdit`。默认单次最多 60 行、本轮累计最多 150 行；超过任一上限会拦截。

  ```text
  单次 60 行：放行   单次 61 行：重新考虑分工
  本轮 150 行：放行  本轮 151 行：重新考虑分工
  ```

- **按标准决定。** 携带任务说明委派，或记录一行理由，再在 soft 模式下重试完全相同的修改。`stats` 会显示理由和观测到的委派率。

  ```bash
  node "<absolute-plugin-path>/scripts/guard.mjs" justify --session-id <session-id> --reason "上下文转移成本较高"
  # 然后在同一轮重试完全相同的修改。
  node "<absolute-plugin-path>/scripts/guard.mjs" stats
  ```

下面是新一轮中提出 61 行修改时，守卫实际输出的默认拦截消息。
保留英文原文；只有插件路径和会话 ID 使用占位符：

```text
Delegation guard: 61 lines in this call; 61 lines this turn (limits 60/call, 150/turn).
1. Codex: a self-contained brief of about one page, without conversation history.
2. Codex: an objective acceptance check (tests, a probe, or a data comparison).
3. Codex: big or slow enough that brief + verification cost less, or it runs while the lead does something else.
4. Claude: costly context; judgement/trade-offs/user decision; a small edit; or verification costing about as much as doing it.
Choose (a) delegate: /codex:rescue --background or codex:codex-rescue, with a brief and a waiter.
Or (b) do it directly: first record a one-line reason:
node "<absolute-plugin-path>/scripts/guard.mjs" justify --session-id <session-id> --reason "<why this stays with Claude>"
Then retry the identical change in this turn.
```

## 分工判断标准

以下是[分工技能](skills/delegation-guard/SKILL.md)中同一组标准的中文翻译；英文版 README 保留技能中的原文。

只有同时满足以下所有条件，才适合交给 Codex：

1. 能写成约一页的自包含任务说明，无需依赖对话历史。
2. 有客观的验收方法，例如测试、探针或数据对比。
3. 工作足够大或足够慢，使编写说明加验证的成本低于自己完成，或能在主负责人做其他工作时并行进行。

满足以下任一条件，就留给 Claude：

- 依赖转移成本较高的上下文；
- 需要判断、权衡或用户决定；
- 只是小修改；
- 验证成本与完成工作本身的成本相近。

Claude 始终负责：拆分工作、编写任务说明、通过真实路径验证、整合和提交。

提交仍须得到用户授权。行数上限只是提醒重新判断，并不自动决定工作该由谁完成。

## 安装

前提：**Claude Code**、**Node.js >= 18**、`PATH` 中可用的 **Git**，以及已配置可用的官方 Codex 插件。
本插件没有 npm 依赖，无需执行 `npm install`。

先在 Claude Code 中安装并设置官方插件：

```text
/plugin marketplace add openai/codex-plugin-cc
/plugin install codex@openai-codex
/codex:setup
```

再安装本守卫：

```text
/plugin marketplace add publicmain/codex-delegation-guard
/plugin install codex-delegation-guard@codex-delegation-guard
```

等价的终端安装命令：

```sh
claude plugin marketplace add openai/codex-plugin-cc
claude plugin install codex@openai-codex
claude plugin marketplace add publicmain/codex-delegation-guard
claude plugin install codex-delegation-guard@codex-delegation-guard
```

如果从终端安装官方插件，仍需进入 Claude Code 运行 `/codex:setup`。
新 hook 会在新会话中加载，也可运行 `/reload-plugins`。
更新本插件市场：

```text
/plugin marketplace update codex-delegation-guard
```

版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 命令

| Claude Code 中的命令 | 作用 |
| --- | --- |
| `/codex-delegation-guard:pause` | 暂停当前会话的守卫，后续用户提示也保持暂停。 |
| `/codex-delegation-guard:resume` | 清除会话暂停和本轮暂停，保留行数计数。 |
| `/codex-delegation-guard:status` | 显示模式、上限、暂停状态、计数、理由和观测到的委派。 |
| `/codex-delegation-guard:stats` | 显示最近七天各项目的总量、比率、规模中位数，以及最近十次覆盖放行的路径和理由。 |

`justify` 是 CLI 操作，不是斜杠命令。复制拦截消息中打印的命令：

```sh
node "<absolute-plugin-path>/scripts/guard.mjs" justify --session-id <session-id> --reason "为什么由 Claude 直接完成"
```

使用 hook 的真实会话 ID。理由会去除首尾空白、合并为一行，并限制为最多 200 个字符。
新的真实用户提示会清除理由；后台通知不会。
相同修改必须在同一轮中先被拒绝过，才可重试放行；不同修改仍会先被拒绝。

`stats` 统计的是观测到的派发尝试，不代表 Codex 已完成任务。
委派率为 `delegations / (delegations + overrides + allowedLarge)`；`allowedLarge` 统计暂停或 off 模式下放行的超限修改提案。
缺少比率或规模证据时返回 `null`。允许通过的提案行数，也不证明工具最终完成了写入。

## 配置

配置按以下顺序合并：

1. 内置默认值。
2. 用户配置：`~/.claude/delegation-guard.json`。
3. 仓库配置：`<git-root>/.claude/delegation-guard.json`。

仓库中的同名键覆盖用户配置。数组会替换整个默认列表。
无效值回退到该键的内置默认值；未知键会被忽略。

| 配置键 | 默认值 | 含义 |
| --- | --- | --- |
| `mode` | `"soft"` | 首次超限拦截；记录理由后，相同修改可重试放行。`"strict"` 持续拦截；`"off"` 放行，但仍计数并记录符合条件的修改。 |
| `perCallLines` | `60` | 正整数；单次行数超过它时拦截。 |
| `perTurnLines` | `150` | 正整数；本轮已放行行数加当前提案超过它时拦截。 |
| `codeExtensions` | 见下方完整列表 | 纳入检查的代码扩展名，不区分大小写。 |
| `excludeGlobs` | 见下方完整列表 | 即使扩展名符合条件也排除的路径；支持 `**`、`*`、`?` 和目录模式。 |
| `pausePhrases` | `["这次你自己写", "你自己写", "自己改", "write it yourself", "no codex"]` | 在真实用户提示中匹配子串，不区分大小写；只暂停本轮。 |
| `planReminder` | `"auto"` | `"auto"` 识别编码提示；`"always"` 跳过该识别；`"off"` 关闭提示提醒。频率限制和暂停状态仍生效。 |
| `requireReason` | `true` | soft 模式下重试相同修改前必须记录理由；`false` 恢复 v0.1 无需理由的重试流程。 |
| `reminderRequiresGit` | `true` | 提示提醒要求当前目录位于 Git 工作树中，包括 `"always"` 模式；`false` 允许在仓库外提醒。 |
| `nonUserPromptMarkers` | 见下方完整列表 | 去除开头空白后，按大小写精确匹配前缀；匹配的通知保留当前轮次且不提醒。`[]` 关闭过滤。 |

完整默认列表：

```json
{
  "codeExtensions": [
    ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".py", ".pyw",
    ".rb", ".php", ".java", ".kt", ".kts", ".go", ".rs", ".c", ".h", ".cc", ".cpp",
    ".cxx", ".hpp", ".cs", ".fs", ".fsx", ".vb", ".swift", ".m", ".mm", ".scala",
    ".sc", ".sh", ".bash", ".zsh", ".ps1", ".psm1", ".psd1", ".bat", ".cmd", ".sql",
    ".html", ".htm", ".css", ".scss", ".sass", ".less", ".vue", ".svelte", ".astro",
    ".ex", ".exs", ".erl", ".hrl", ".clj", ".cljs", ".cljc", ".dart", ".r", ".jl",
    ".lua", ".pl", ".pm", ".groovy", ".gradle", ".tf", ".tfvars", ".sol", ".proto",
    ".graphql", ".gql", ".ipynb", ".razor", ".cshtml"
  ],
  "excludeGlobs": [
    "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
    "bun.lockb", "go.sum", "Cargo.lock", "Gemfile.lock", "Pipfile.lock",
    "*.min.*", "dist/", "build/", "node_modules/", "vendor/", ".git/",
    "generated/", "__generated__/", ".generated/", ".next/", ".nuxt/", "coverage/",
    "*.md", "*.txt", "*.json", "*.yaml", "*.yml", "*.toml", "*.lock", "*.csv", "*.svg"
  ],
  "nonUserPromptMarkers": [
    "<task-notification", "<system-reminder", "[SYSTEM NOTIFICATION",
    "<cross-session-message", "<side-sessions-event", "<ci-monitor-event"
  ]
}
```

一个小配置示例：

```json
{
  "mode": "soft",
  "perCallLines": 80,
  "perTurnLines": 200,
  "reminderRequiresGit": false
}
```

这些提醒配置不会关闭 SessionStart 注入的策略。
无论 `reminderRequiresGit` 如何设置，写入守卫始终只检查 Git 工作树内的文件。

## 工作原理

| Hook 事件 | 匹配器 | 作用 |
| --- | --- | --- |
| `SessionStart` | `startup\|resume\|compact` | 注入标准和先分工策略，不重置本轮状态。 |
| `UserPromptSubmit` | 所有提示 | 忽略配置的通知前缀；否则重置本轮、处理暂停短语，并按条件提醒。 |
| `PreToolUse` | `Write\|Edit\|MultiEdit\|NotebookEdit` | 确定目标所属的 Git 工作树，过滤文件，计算行数并决定放行或拦截。 |
| `PreToolUse` | `Bash\|Agent\|Task` | 观测可识别的 Codex 派发尝试，计数并重置本轮行数。 |

观测规则识别 Bash 中的 `codex exec`、带 `task` 的 `codex-companion.mjs`，以及 Agent/Task 的 `subagent_type: "codex:codex-rescue"`。
守卫本身不启动工作进程。Claude 通过官方插件派发，并验证结果。

`Write` 新文件按全部行数计；已有文件通过有规模上限的差异计算，统计变化片段。
`Edit` 按替换文本行数计，至少一行；`MultiEdit` 求和；`NotebookEdit` 按 `new_source` 行数计。

Hook 采用 **fail-open（故障时放行）**：输入格式错误或内部错误会静默以退出码 0 结束。
主动拦截则以退出码 2 结束。
状态保存在 `<os-temp>/codex-delegation-guard/`；可用 `CODEX_DELEGATION_GUARD_STATE_DIR` 覆盖。
日志 `~/.claude/delegation-guard/log.jsonl` 保存元数据和覆盖放行理由，绝不保存文件内容。
元数据包括时间、会话 ID、项目文件夹名、相对路径、工具名、计数和决定。
日志超过 5 MiB 后轮转；轮转时移除超过七天的归档。
理由中不要填写敏感信息；委派说明中也不要放入个人或学生数据。

## 局限

- 通过 Bash 或外部程序写入的代码，不受写入守卫检查。
- soft 模式会按设计放行已记录理由的相同重试。它是分工检查点，不是安全边界。
- 编码提示识别较简单：匹配中英文动作词和代码相关名词，可能漏提醒或误提醒。
- CI 已配置 Windows、macOS、Linux 与 Node 18、20、22 的矩阵；需在 GitHub 实际运行后才能确认结果。
- 已在 Windows 上的 Claude Code 中实际运行过；CI 会在 Windows、macOS 和 Linux（Node 18、20、22）上跑钩子测试。

## 常见问题

**它会把我的代码发送到其他地方吗？**

不会。本插件不发起网络请求，只决定是否放行写入、注入提醒，并在本地记录元数据和理由。
Claude 选择派发时，委派由官方 Codex 插件完成；代码传输和权限由该插件负责。

**能只关闭一轮吗？**

在提示中加入 `write it yourself`、`no codex`、`这次你自己写`、`你自己写` 或 `自己改`。
暂停持续到下一个真实用户提示。若要暂停整个会话，使用 `/codex-delegation-guard:pause`。

**严格模式呢？**

在任一配置文件中设置 `"mode": "strict"`。
即使运行 `justify`，超限提案也仍被拦截；用户授权直接修改时，可通过暂停放行。

## 参与贡献

欢迎提交 [Issue](https://github.com/publicmain/codex-delegation-guard/issues) 和 [Pull Request](https://github.com/publicmain/codex-delegation-guard/pulls)。
在 Node >= 18 且 Git 可用的环境中运行：

```sh
node --test
```

测试通过真实 hook 脚本运行，用户目录、仓库、状态和日志均隔离在已忽略的 `.test-tmp/` 中。
如果它对你的工作有帮助，欢迎给 GitHub 仓库点一个 Star，让更多人找到它。

## 许可证

[MIT](LICENSE) — Copyright (c) 2026 publicmain。
