# 在 Codex 新项目中开始

第一版 0.1.0 已实现，离线使用与命令见 [README](README.md)，验收记录见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。下面保留最初的开发交接说明，后续任务应先检查当前实现与测试，不必重复初始化。

在 Codex 左侧选择 `metasocli`，新建一个聊天/任务，选择直接使用 `E:\metasocli` 的本地模式。新任务会获得这个项目的工作目录与上下文。可将下面的消息作为开场：

```text
开始实现当前 metasocli 项目。先完整读取 AGENTS.md、docs/ARCHITECTURE.md 和 docs/SOURCE_BASELINE.md。

只在当前 E:\metasocli 内开发，以 https://github.com/3593297903/metasocli.git 为独立远端。E:\libcli 及其已安装命令、Skill、运行目录、Git 和业务数据保持只读。

以 docs/SOURCE_BASELINE.md 指定的 0.2.22 源码快照为参考，迁入经过阅读验证的通用能力，保留剧本和成品提示词两个入口。项目、命令、配置、状态、Skill 和安装归属全部使用 AGENTS.md 的 metasocli 命名空间。

完成第一版可独立构建和测试的 CLI：本地故事与素材管理、H3 参数校验和生成计划、Metaso 原生 API 适配、任务提交记录、查询、中断恢复和视频下载。用假客户端和临时文件测试付费提交结果未知、重复执行、下载失败和隔离边界。

先完成离线可验收闭环。当前没有授权发起付费生成、覆盖旧安装或推送到 GitHub。不要因缺少 API Key 停止不依赖凭据的实现。最后报告已实现内容、实际执行的测试、尚待真实接口验证的部分，并检查旧项目未被改动。
```

项目约束由 AGENTS.md 统一维护；上述开场消息只是将本次讨论的目标交给新任务。
