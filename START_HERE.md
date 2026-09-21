# 在 Codex 新项目中开始

第一版 0.1.0 已实现，离线使用与命令见 [README](README.md)，验收记录见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。下面保留最初的开发交接说明，后续任务应先检查当前实现与测试，不必重复初始化。

直接制作视频时，在 `E:\metasocli` 的本地任务中使用 `$metasocli-video-prompts`（成品提示词）或 `$metasocli`（剧本），附上输入并指定故事目录与生成范围。需要沿用已配置的统一旁白声线时，使用独立的 `$metasocli-video-prompts-旁白`。项目技能由 `.agents/skills/` 加载；详细示例见 [README 的 Skill 用法](README.md#在-codex-中使用-skill)。

本机已经用户授权，将 `$metasocli-video-prompts` 和 `$metasocli-video-prompts-旁白` 两个入口另外安装到用户级 Skill 目录，因此可在 `mttest1` 等其他项目调用。两个入口仍读取本项目正文并使用本机程序；原 Skill、旧 CLI 及全局配置文件不被覆盖。2026-09-21 起三个入口默认使用 `plan --workflow h3-inline-ir`，完成素材与离线计划后停在视频提交前。用户授权当前范围及包含 IR 的视频模式后直接 generate；真实视频请求明确带 `context_ir_enabled:true`，不先单独创建 IR。已授权范围不逐段再问。见 [当前流程](docs/INLINE_CONTEXT_IR_WORKFLOW.md)。本次切换仅做离线验证，不发起付费生成。

两个入口会自动调用本包 `$metasocli-reference-images`。现已带入完整人物/场景/道具/首帧模板，先形成并校验完整配方，导入后只为缺失必需素材原样调用宿主生图，再正式登记。无需在新视频任务中单独再调用图片 Skill；现有故事和图片不会因模板更新自动被改写。

在 Codex 左侧选择 `metasocli`，新建一个聊天/任务，选择直接使用 `E:\metasocli` 的本地模式。新任务会获得这个项目的工作目录与上下文。可将下面的消息作为开场：

```text
开始实现当前 metasocli 项目。先完整读取 AGENTS.md、docs/ARCHITECTURE.md 和 docs/SOURCE_BASELINE.md。

只在当前 E:\metasocli 内开发，以 https://github.com/3593297903/metasocli.git 为独立远端。E:\libcli 及其已安装命令、Skill、运行目录、Git 和业务数据保持只读。

以 docs/SOURCE_BASELINE.md 指定的 0.2.22 源码快照为参考，迁入经过阅读验证的通用能力，保留剧本和成品提示词两个入口。项目、命令、配置、状态、Skill 和安装归属全部使用 AGENTS.md 的 metasocli 命名空间。

完成第一版可独立构建和测试的 CLI：本地故事与素材管理、H3 参数校验和生成计划、Metaso 原生 API 适配、任务提交记录、查询、中断恢复和视频下载。用假客户端和临时文件测试付费提交结果未知、重复执行、下载失败和隔离边界。

先完成离线可验收闭环。当前没有授权发起付费生成、覆盖旧安装或推送到 GitHub。不要因缺少 API Key 停止不依赖凭据的实现。最后报告已实现内容、实际执行的测试、尚待真实接口验证的部分，并检查旧项目未被改动。
```

项目约束由 AGENTS.md 统一维护；上述开场消息只是将本次讨论的目标交给新任务。
