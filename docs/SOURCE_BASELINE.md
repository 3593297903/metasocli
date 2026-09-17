# 来源基线与阅读顺序

本文件记录可读来源，不建立运行时依赖。metasocli 运行时只能使用自身的源码、依赖和业务数据。

## 版本事实

- 旧项目根：`E:\libcli`，package.json 为 0.2.5，存在用户已有修改。
- 当前全局安装：`story-to-libtv@0.2.22`。
- 本次指定复用快照：`E:\libcli\.story2libtv-work\video-prompt-entry-0.2.22-20260916\source`。
- 候选 0.2.23：`E:\libcli\.story2libtv-work\image-fallback-handoff-0.2.23-20260917\source`，仅供审查适用修复，不整体替代基线。

复制前确认指定快照的版本及文件；记录所选源码和测试的相对路径与哈希。不要通过旧仓库当前分支名推断快照版本，也不要修改旧仓库来整理来源。

## 重点阅读

以下路径相对于 0.2.22 快照：

| 路径 | 理解目标 |
| --- | --- |
| README.md | 旧产品停在 LibTV configure-only 的边界 |
| src/core/contracts.ts | 故事与素材契约，以及需要剥离的 Seedance/LibTV 字段 |
| src/core/project.ts、state.ts、references.ts | 本地真相、版本、素材文件身份和登记 |
| src/core/prompt.ts | 完整原文、时长、有序资产与平台引用渲染 |
| src/core/io.ts、locking.ts、file-identity.ts | 原子写入、锁、文件身份与恢复原则 |
| src/core/libtv-query-recovery.ts、libtv-runner.ts | 只读重试与未知写入不重发的差别，不直接复制其 CLI 耦合 |
| src/setup/skill.ts、runtime.ts、codex.ts | 旧安装归属、四份 Skill、运行目录与 MCP 命名 |
| skills/story-to-libtv | 剧本入口、素材交接、登记及旧 LibTV 依赖 |
| skills/video-prompt-to-libtv | 成品提示词入口，保留正文与来源追溯 |
| skills/seedance-segment-prompt-engine | 镜头/生成段设计、台词完整性和待替换的模型规则 |
| skills/story-reference-image-builder | 图片配方与原生生图，移除跨入旧 LibTV 补图的路径 |
| tests | 按被迁入能力选择测试，并补充 Metaso 与隔离的独立测试 |

## 服务资料

- Metaso H3：https://metaso.cn/minimax-h3
- Metaso 教程：https://metaso.cn/minimax-h3/new-api-guide
- Metaso 提供的适配源码：https://metaso.cn/minimax-h3/new-api-guide/minimax-h3-metaso.plugin.js
- H3 请求契约：https://platform.minimax.cn/docs/api-reference/video-generation-v2-create
- H3 查询契约：https://platform.minimax.cn/docs/api-reference/video-generation-v2-query

选用原生 Metaso 路线，源码中的实际地址为：

- POST https://metaso.cn/api/minimax/v2/video_generation
- GET https://metaso.cn/api/minimax/v2/query/video_generation/{task_id}

MiniMax 官方文档用于核对模型契约，不能将 MiniMax 官方密钥与 Metaso 密钥混用。第三方接口会变化，开始实现适配时再核对支持范围；尚未执行本项目的真实生成验收。
