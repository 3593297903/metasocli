---
name: metasoclitk
description: 沿用 metasocli 成品视频提示词流程，以 jianc 风格的半写实奇幻CG人物五视图、场景空间板和道具结构板准备资产图，再绑定素材并形成 H3 视频计划。
---

# metasoclitk 项目入口

执行前完整读取 [技能正文](../../../skills/metasoclitk/SKILL.md)，按正文复用原视频提示词流程并应用此入口的三类资产图模板。

正文中的相对链接以正文所在目录 `skills/metasoclitk/` 为基准。程序使用本包 `dist/cli/main.js`，每个业务命令显式传独立故事目录 `--root`。生成授权、普通/旁白选择、首次结果交付和恢复规则以正文与当前用户请求为准。
