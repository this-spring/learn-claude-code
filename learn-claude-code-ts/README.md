# Learn Claude Code · TypeScript 学习版

对照仓库中的 Python 版本，按原课程顺序学习并实现 TypeScript 版本。**所有学习内容统一记录在本目录，不修改原版课程。**

原版入口：[中文总览](../README-zh.md)。

## 当前进度

s01–s17 和附属资源已按 Python 原版重新校准，保持各章独立实现、内容范围与执行流程；内部实现允许采用惯用 TS 写法。仅保留原版明确存在的 s15 → s09 记忆加载、s16 → s15 宿主加载。

验证结果和运行时适配见[对齐记录](./docs/parity-audit.md)。代码迁移完成不代表个人课程学习完成；已有 `.env` 和 Python 原版保持原样。

## 学习目录

状态随实际学习更新：待学习 → 学习中 → 已完成。只有完成原理记录、实现和验证后才标记已完成；存在未验证项时明确说明。

| 章节 | 学习主题 | 状态 |
| --- | --- | --- |
| [s01_agent_loop](./s01_agent_loop/README.zh.md) | Agent Loop · 智能体循环 | 学习中：TS 与离线验证已完成 |
| [s02_tool_use](./s02_tool_use/README.zh.md) | Tool Use · 工具分发 | 学习中：TS 与离线验证已完成 |
| [s03_permission](./s03_permission/README.zh.md) | Permission · 权限控制 | 学习中：TS 与离线验证已完成 |
| [s04_hooks](./s04_hooks/README.zh.md) | Hooks · 生命周期扩展 | 迁移与验证完成；待学习 |
| [s05_todo_write](./s05_todo_write/README.zh.md) | TodoWrite · 执行清单 | 迁移与验证完成；待学习 |
| [s06_subagent](./s06_subagent/README.zh.md) | Subagent · 子智能体 | 迁移与验证完成；待学习 |
| [s07_skill_loading](./s07_skill_loading/README.zh.md) | Skill Loading · 按需加载技能 | 迁移与验证完成；待学习 |
| [s08_context_compact](./s08_context_compact/README.zh.md) | Context Compact · 上下文压缩 | 迁移与验证完成；待学习 |
| [s09_memory](./s09_memory/README.zh.md) | Memory · 跨会话记忆 | 迁移与验证完成；待学习 |
| [s10_task_system](./s10_task_system/README.zh.md) | Task System · 任务系统 | 迁移与验证完成；待学习 |
| [s11_background_tasks](./s11_background_tasks/README.zh.md) | Background Tasks · 后台任务 | 迁移与验证完成；待学习 |
| [s12_cron_scheduler](./s12_cron_scheduler/README.zh.md) | Cron Scheduler · 定时调度 | 迁移与验证完成；待学习 |
| [s13_agent_teams](./s13_agent_teams/README.zh.md) | Agent Teams · 多智能体协作 | 迁移与验证完成；待学习 |
| [s14_mcp_plugin](./s14_mcp_plugin/README.zh.md) | MCP Tools · 外部工具接入 | 迁移与验证完成；待学习 |
| [s15_integrated_harness](./s15_integrated_harness/README.zh.md) | Integrated Harness · 机制集成 | 迁移与验证完成；待学习 |
| [s16_workflow_runtime](./s16_workflow_runtime/README.zh.md) | Workflow Runtime · 工作流运行时 | 迁移与验证完成；待学习 |
| [s17_goal_loop](./s17_goal_loop/README.zh.md) | Goal Loop · 目标闭环 | 迁移与验证完成；待学习 |

课程顺序用于组织学习，不代表每章代码都继承上一章的全部能力。实现范围以对应 Python 章节为准。

## 内容放在哪里

| 内容 | 位置 |
| --- | --- |
| 学习路线、章节状态、下一步 | 本文件 |
| 后续协作与记录约定 | [AGENTS.md](./AGENTS.md) |
| 原理、源码分析、问答、实验与复盘 | 各章 `README.md`；多语言章节的中文入口为 `README.zh.md` |
| TypeScript 实现 | 各章 `code.ts`，开始实现时创建 |
| 章节示例、图示与实验材料 | 对应章节目录内，按需创建 |
| 跨章节知识与环境说明 | 本目录 `docs/`，按需创建 |
| TS 工程配置与依赖 | 本目录根部的 `package.json`、`tsconfig.json` 与锁文件 |

当前 s01–s17 均包含实现与测试。全部章节 沿用原版文档命名：`README.md` 为英文、`README.zh.md` 为中文、`README.ja.md` 为日文；学习目录默认链接中文，图片保存在本章 `images/` 中。

## 运行当前章节

使用 Node.js 22.17 或更高版本，在本目录安装依赖：`npm install`。按照 [s01 运行说明](./s01_agent_loop/README.zh.md#试一下) 配置本目录的 `.env`；已有配置不需要覆盖。

`npm run s01` 到 `npm run s17` 分别启动对应章节。例如 `npm run s04` 学 Hooks，`npm run s15` 运行集成宿主。程序可能执行模型生成的 shell 命令，教学权限规则不是完整沙箱，请先在临时工作区体验。

`npm run typecheck` 检查类型，`npm test` 运行全部离线测试，`npm run test:s04` 等命令分别测试对应章节，`npm run check:materials` 核对全部 17 章的文档、图片、链接、资源清单和跨章引用；这些验证不需要真实 API 密钥。差分测试另需 Python 3、PyYAML；生产实现不调用 Python。

`npm run check:cli` 在临时项目中跑真实 SDK 与本地 HTTP 服务；`npm run check:live` 使用当前 `.env` 跑实际 API 冒烟，不覆盖原配置。两者会生成不含密钥和模型正文的验证记录。

`npm run s16 -- demo` 演示离线工作流，`npm run s16 -- resume` 用 journal 续跑；默认 `npm run s16` 则是接入真实模型的 s15 宿主加 Workflow 工具。不要混淆这两种模式。

## 每章怎么学

1. **读原版**：先看对应的 `README.zh.md` 和 `code.py`，确认本章解决的问题及实现边界。
2. **讲清原理**：记录执行流程、关键状态、输入输出与结束条件。
3. **对照实现**：用 TS 实现本章机制，说明类型、异步、文件或进程处理上的差异。
4. **做实验**：记录执行目录、命令、输入、预期与实际结果；未运行的部分明确标注。
5. **留结论**：把讨论中的问题、排错过程、取舍和下一步写回本章，再更新学习状态。

每章沿用同一组记录小节：核心原理、Python 源码导读、TypeScript 实现、实验与验证、问题与复盘。随着学习补充，不提前把未学习内容写成完成总结。
