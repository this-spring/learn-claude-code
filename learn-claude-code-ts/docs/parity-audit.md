# Python → TypeScript 对齐验收

2026-10-25 完成 s01–s17 及附属资源的校准与验证。依据为仓库提交 `ce8f9f186058939da54c9d6fead78dfb5d0fd6c3` 中的 Python 源码；修改范围仅为 `learn-claude-code-ts/`，Python 原版及已有 `.env` 未改动。

## 实现范围

各章对齐原版的文件职责、内容范围、主要执行流程、工具定义、权限、Hooks、消息配对和结束条件。主要标识符目前保留以便对照，命名和内部写法允许采用 TS 习惯，不要求模拟 Python 的全部语言语义。原版独立的章节在本章定义运行逻辑及 CLI；生产实现不导入测试辅助代码，也不通过执行 Python 代替 TS 实现。

原版明确存在的两处跨章加载继续保留：

- s15 动态加载 s09 记忆模块。
- s16 动态加载 s15，并安装 Workflow 工具及本章 CLI。

| 章节 | 对齐内容与验证重点 |
| --- | --- |
| s01 | 单一 bash、模型循环、实际 tool_use 检测、输出截断与消息配对 |
| s02 | 五种工具、本章 TOOL_HANDLERS、路径限制、负行数与错误传播 |
| s03 | 拒绝列表 → 规则 → 用户询问的顺序、允许/拒绝和路径解析 |
| s04 | 四类 Hooks、首个非空返回、工具调用和 Stop 行为 |
| s05 | TodoManager 原版验证、字符串输入解析、三轮提醒 |
| s06 | BASE/SUB 工具集、独立子会话、30 轮限制、本章 CLI |
| s07 | SkillLoader 扫描、frontmatter、薄目录与按需加载 |
| s08 | 结果归档、snip/micro/history 压缩、一次 reactive retry |
| s09 | 记忆过滤、索引、召回、提取、整理及写入失败回滚 |
| s10 | Task/TaskStore、依赖、认领和完成；不混入后章字段或锁 |
| s11 | bg_0001 标识、异步子进程、通知、Hook 时序和退出清理 |
| s12 | cron 校验、队列、持久交付、确认/恢复与串行回合 |
| s13 | 真实 Git worktree、工作目录租约、任务锁、MessageBus、团队协议和队友循环 |
| s14 | MCP 发现、命名冲突、动态工具池、宿主权限与错误结果 |
| s15 | 完整集成机制、重试/降级、token 恢复、后台进程、团队事件和串行宿主 |
| s16 | 完整 SHA-256、原版 journal 键、缓存恢复、预算顺序、schema retry、并发与宿主安装 |
| s17 | 独立评估器原始提示词、GoalController 状态、续跑、后台恢复及限制 |

恢复了原先被占位说明替代的 skills 内容，并将 agent-builder 的 minimal-agent、tool-templates、subagent-pattern、init_agent 原生迁移为 TS。其他 skill 中介绍 Python/PDF/MCP 的知识文本保留原样，作为按需加载的数据。脚手架 0–4 级均验证；与原版一致，2–4 级目前生成 level 1 模板。生成项目额外提供 Node 必需的 `package.json`。

## 最终验证

执行目录为本目录根部。环境为 macOS、Node.js 22.21.1、Python 3.12、PyYAML 6.0.3。

| 命令或检查 | 结果 |
| --- | --- |
| `npm ci` | 从锁文件重新安装成功，包括原生 flock 依赖 |
| `npm run typecheck` | 通过；覆盖章节、测试、scripts、skill TS 资源及示例 |
| `npm test` | **186/186 通过**；无跳过项 |
| `npm run check:cli` | **104 次通过**；见 [CLI 记录](cli-verification.json) |
| `npm run check:live` | **17/17 章实际 API 通过**；见 [API 记录](live-api-verification.json) |
| `npm run check:materials` | **17 章、51 份 Markdown、74 张字节一致的原图、450 个本地链接、9 个 skill 资源通过** |
| 根部 hello、s05 hello 示例、脚手架帮助与全部生成级别 | 实际运行成功 |
| 原版顶层函数/类清单 | 17 章均有对应标识符 |
| Git 修改范围 | 仅本 TS 目录；无 Python 原版修改 |

差分测试直接加载未修改的 Python 文件，通过假模型比较 schemas、请求、消息轨迹、目标事件、工作流结果/用量、frontmatter、记忆规则、glob 和参数绑定。它们需要 Python 与 PyYAML；TS 运行程序不需要这些测试依赖。

CLI 检查使用独立临时项目和工作目录，调用真实 Anthropic SDK 访问本地 HTTP 服务，实际执行文件读写、编辑、glob、子任务、技能、任务、cron、MCP 和 Workflow，并检查 tool_result 回传。逐章验证 q、exit、EOF、SIGINT；s01–s16 另测空行退出。s17 按原版忽略空行。另跑 workflow demo/resume，确认缓存恢复后 agents/tokens 为 0，以及独立最小 Agent 的 SDK 调用。

实际 API 验证使用现有配置，要求每章回复 `LIVE_API_PASS`；s17 另经过独立评估器并得到 achieved。测试副本及临时工作目录在结束后清理，记录不含密钥或模型正文。这项检查证明服务连通、SDK 兼容和返回路径；具体机制由差分与离线测试覆盖。

## 必要的运行时适配

- Python 同步调用/线程对应 Promise、子进程 I/O、定时器和 AsyncLocalStorage；异步回合保留禁止交互审批、串行宿主与清理规则。
- s13/s15/s16 的 POSIX 文件锁使用 `fs-ext`，保留跨进程竞争和进程退出释放锁的语义；安装需要本机原生构建环境。
- ESM namespace 不允许 Python 式赋值，s15/s16 通过显式 setter 安装工具池及测试 runner；不引入共享 Agent Loop。
- 本地 `.env` 锚定 TS 工程，避免误用 Python 工程配置。CLI 主入口兼容真实路径和符号链接路径。
- 文件路径先解析符号链接再处理 `..`；glob 分别保持 Python glob 与 pathlib 的隐藏文件、目录和链接行为。kwargs 绑定区分缺参、额外参数与显式 null。
- 长度与截断按 Unicode 码点处理；保留 Python 源码中“bytes”提示实际使用字符数的行为。YAML 使用 PyYAML 的标量判定及重复键规则；序列化保持相同数据，排版可以不同。
- Todo 的安全字面量解析位于各自章节，支持数据表达式而不执行代码。Unicode 名称查询由随章数据表提供；大整数字面量使用 BigInt。SDK 的 JSON 数值仍采用 JS number。

上述是原生 TS 运行时的适配；不将异步执行模型、操作系统错误文本或 YAML 排版宣称为 Python 的逐字节复制。Windows 真机、非 UTF-8 系统 locale 和长时间压力运行未验证。

## 原版仓库的既存基线问题

同时运行了原版 `tests/`：**481 项及 100 个 subtests 通过，1 项失败**。失败为 `tests/test_web_scenarios.py::test_generated_s16_metadata_extends_s15_without_registry_false_positives`：原版 web 生成快照中的 Python source 与当前章节源码不同步。该项不执行 TS，属于原版生成材料的既存问题；按本次范围保留原文件，不修改它来掩盖基线失败。

代码迁移与上述验证已完成；个人课程学习进度仍按总索引记录。

## 2026-10-25：明确实现风格

用户明确：“一致”指各文件的职责、内容和功能对应，具体实现允许细小差异。已移除 12 章中仅为复刻 Python 真值而添加的 `python_truth`，使用 TS 原生条件判断及空值默认值。JS 的空数组、空对象为真，属于这里接受的语言差异；相应回归测试按 TS 合约检查。

日志中的 `\n` 用于换行，`\x1b[35m`/`\x1b[0m` 是标准终端颜色和重置转义，Node 原生支持。它们是展示细节，与逐文件逻辑对齐无关。其他兼容处理本轮未整体重写。

本次简化后重新运行：`npm run typecheck`、`npm test`（186/186）及 `npm run check:materials` 均通过。
