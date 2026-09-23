---
name: metasocli-video-prompts
description: 将成品视频提示词按原文导入 metasocli，准备素材和显式启用 Context IR 的视频计划；授权后直接生成 H3 视频，不自动绑定统一旁白。
---

# 成品视频提示词入口

完整读取用户指定的全部 UTF-8 TXT/Markdown。不要重新分镜、缩短台词或倒推剧本。DOCX/PDF 需由宿主先可靠提取并经用户任务范围认可；CLI 本版不直接解析这两种格式。

读取 [草稿契约](../../docs/INPUT_FORMAT.md)。选择 `kind: video-prompts`。分段 `start/end` 是规范文本的 UTF-16 范围，必须按序覆盖全部正文；用程序计算，不手抄长正文或哈希。`duration` 可填原始目标秒数，例如 `12.378`；程序自动向上取整为 H3 实际请求的 13 秒，并在计划保留原始目标。正常小数适配不逐段询问、不改原文、不裁剪成片。单段可直接用 `import --file ... --kind video-prompts --episode ... --duration ...`。

按用户明确引用清单的顺序绑定素材；同名不同造型分配不同 assetId。没有明确来源的台词提及对象不自动认定为出镜素材。只有 `{{ref:assetId}}` 被技术渲染为按输入顺序编号的自然语言标签；姓名、普通“图1”、空白和其他正文不替换。旧节点标记必须先明确映射，不能直接发送。

统一分析全部素材，保存逐集图片交接请求：每个人物的固定造型、场景状态、关键连续性道具分别使用独立 assetId；只给实际出镜或明确需要该参考的段分配素材，不把一份全体人物合照绑定给每段。记录原文事实、生成设定、连续性、图片依赖和 requiredBySegments，具体结构见 [图片交接契约](../metasocli-reference-images/references/handoff-contract.md)。优先遵守用户明确指定的素材及引用。

调用 [参考图片 Skill](../metasocli-reference-images/SKILL.md) 第一阶段，将完整人物/场景/道具/首帧模板落实为完整配方，校验后原样写入导入草稿，不能先写几句简化配方再生图。CLI import 后执行该 Skill 第二阶段，复用准确 ready 素材，仅生成缺失必需项并正式登记。两阶段自动衔接，不要求用户另调图片技能或逐图批准。缺图不悄悄降级为纯文字，首帧不能与多参考图或旁白音频混用。仅缺少明确目标、无法解释的时长冲突或超出允许范围时报告准确段落；正常小数向上取整不是冲突，也不自动删减。

后续使用 [剧本入口的公开命令与恢复规则](../metasocli/SKILL.md)，并完整读取 [当前 Context IR 流程](../../docs/INLINE_CONTEXT_IR_WORKFLOW.md)。新草稿段参数 `contextIr` 写 true，素材登记后执行 `plan --root <story> --episode <id> --workflow h3-inline-ir`。确认每段 `contextIr:true`，默认停在视频提交前；说明视频请求包含 IR 费用。

按 [剧本入口的批次规则](../metasocli/SKILL.md#已授权范围的四并发批次) 将授权范围内全部视频段组织成一个批次。离线执行 `batch plan --root <story> --episodes <有序集ID> --concurrency 4`；部分段使用 `--selection <selection.json>`，范围参数互斥，不重新拆写提示词。展示返回的 `plan.batchId`、哈希、总数/复用/活动/待提交数，未授权生成则暂停。用户明确授权本次范围及此模式后，直接执行 `batch run --root <story> --batch <batchId> --confirm`，不逐段或每4段再次确认。最多4段生成，终态持久化后持续补位，task_id 不是完成；下载另有2个名额，不等待整组。

每段实际视频请求必须携带布尔值 `context_ir_enabled:true`；不先单独执行 context-ir，不派生独立 IR 视频计划，不提前改写或翻译原文。提交前核对完整台词、说话人、顺序、镜头动作、图片编号和限制。IR 在服务端视频请求内执行，没有可先行核对的独立增强文本，不能声称已有该审阅结果。普通入口不自动添加统一旁白音频；已有明确音频绑定则保持原有归属。

历史 false 计划需针对原始集重新 plan，不能手改旧计划或自动将 IR 副本集再增强。已有任务按原 taskId 查询、恢复和下载，不能因响应没返回 context_ir_enabled 而重发；程序不伪造返回字段。当前范围已获授权时自动继续，不逐段再问。

批次恢复使用 `batch resume --root <story> --batch <batchId>`，它可继续原授权内未提交段；`batch status` 只读本地，旧 `resume --operation` 不创建新任务。复用已验证成片，下载失败只恢复下载。未知创建保留名额并停止新增，禁止用新批次/运行目录绕过；明确失败不自动重做，安全429重试受保存预算限制。已有独立 IR 副本不能自动进入 `--all-episodes`，范围不明时显式选择原始集和段。
