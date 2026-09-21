---
name: metasocli-video-prompts-旁白
description: 沿用 metasocli 成品视频提示词流程，为明确含画外旁白的镜头绑定用户指定的统一旁白音频声线参考，保留角色对白及原图序。
---

# 成品视频提示词入口（统一旁白参考）

这是当前仓库的 Codex 技能入口。执行前完整读取 [技能正文](../../../skills/metasocli-video-prompts-旁白/SKILL.md)，按其中的流程处理当前用户请求。

正文中的相对路径以正文所在目录 `skills/metasocli-video-prompts-旁白/` 为基准。沿用原成品提示词流程，逐段识别旁白并使用当前安装的指定音频副本；纯对白段不加旁白参考。
