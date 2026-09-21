---
name: metasocli
description: 将完整剧本导入独立 metasocli 故事项目，准备参考素材和 Metaso H3 计划，并在用户授权生成时查询、恢复与下载原任务。
---

# metasocli 剧本入口

这是当前仓库的 Codex 技能入口。执行前完整读取 [技能正文](../../../skills/metasocli/SKILL.md)，按其中的流程处理当前用户请求。

正文中的相对路径以正文所在目录 `skills/metasocli/` 为基准。使用当前仓库的 CLI 和独立故事目录；生成授权与恢复规则以正文和当前用户请求为准。
