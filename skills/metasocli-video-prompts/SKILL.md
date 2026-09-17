---
name: metasocli-video-prompts
description: 将已有成品视频提示词按原文及既定顺序导入 metasocli，绑定参考素材并形成 Metaso H3 计划。
---

# 成品视频提示词入口

完整读取用户指定的全部 UTF-8 TXT/Markdown。不要重新分镜、缩短台词或倒推剧本。DOCX/PDF 需由宿主先可靠提取并经用户任务范围认可；CLI 本版不直接解析这两种格式。

读取 [草稿契约](../../docs/INPUT_FORMAT.md)。选择 `kind: video-prompts`。分段 `start/end` 是规范文本的 UTF-16 范围，必须按序覆盖全部正文；用程序计算，不手抄长正文或哈希。单段可直接用 `import --file ... --kind video-prompts --episode ... --duration ...`。

按用户明确引用清单的顺序绑定素材；同名不同造型分配不同 assetId。没有明确来源的台词提及对象不自动认定为出镜素材。只有 `{{ref:assetId}}` 被技术渲染为按输入顺序编号的自然语言标签；姓名、普通“图1”、空白和其他正文不替换。旧节点标记必须先明确映射，不能直接发送。

先写素材配方，再按照 `../metasocli-reference-images/SKILL.md` 准备并登记实际图片。缺图不悄悄降级为纯文字，首帧不能与多参考图混用。时长冲突、未知身份或超出 7000 字符时报告准确段落，不自动删减。

后续 `plan/generate/status/resume/download` 使用 `../metasocli/SKILL.md` 的公开命令和任务恢复规则。用户仅要求准备时不生成视频；已授权的生成按原授权范围执行。
