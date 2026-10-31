---
name: metasocli-video-prompts
description: 将成品视频提示词按原文导入 metasocli，准备素材和显式启用 Context IR 的视频计划；授权后直接生成 H3 视频，不自动绑定统一旁白。
---

# 成品视频提示词入口

完整读取用户指定的全部 UTF-8 TXT/Markdown。不要重新分镜、缩短台词或倒推剧本。DOCX/PDF 需由宿主先可靠提取并经用户任务范围认可；CLI 本版不直接解析这两种格式。

读取 [草稿契约](../../docs/INPUT_FORMAT.md)。选择 `kind: video-prompts`。分段 `start/end` 是规范文本的 UTF-16 范围，必须按序覆盖全部正文；用程序计算，不手抄长正文或哈希。`duration` 可填原始目标秒数，例如 `12.378`；程序自动向上取整为 H3 实际请求的 13 秒，并在计划保留原始目标。正常小数适配不逐段询问、不改原文、不裁剪成片。单段可直接用 `import --file ... --kind video-prompts --episode ... --duration ...`。

按用户明确引用清单的顺序绑定素材；同名不同造型分配不同 assetId。没有明确来源的台词提及对象不自动认定为出镜素材。只有 `{{ref:assetId}}` 被技术渲染为按输入顺序编号的自然语言标签；姓名、普通“图1”、空白和其他正文不替换。旧节点标记必须先明确映射，不能直接发送。

统一分析全部素材，保存逐集图片交接请求：每个人物的固定造型、场景状态、关键连续性道具分别使用独立 assetId；只给实际出镜或明确需要该参考的段分配素材，不把一份全体人物合照绑定给每段。记录原文事实、生成设定、连续性、图片依赖和 requiredBySegments，具体结构见 [图片交接契约](../metasocli-reference-images/references/handoff-contract.md)。优先遵守用户明确指定的素材及引用。

调用 [参考图片 Skill](../metasocli-reference-images/SKILL.md) 第一阶段，将完整人物/场景/道具/首帧模板落实为完整配方，校验后原样写入导入草稿，不能先写几句简化配方再生图。完成本次全部范围的 CLI import 后，默认执行该 Skill 的 API 全量提交与自动登记；仅在用户明确选择 built_in 时执行宿主生图阶段。复用准确 ready 素材，仅生成缺失必需项并正式登记。各阶段自动衔接，不要求用户另调图片技能或逐图批准。缺图不悄悄降级为纯文字，首帧不能与多参考图或旁白音频混用。仅缺少明确目标、无法解释的时长冲突或超出允许范围时报告准确段落；正常小数向上取整不是冲突，也不自动删减。

后续使用 [剧本入口的公开命令与恢复规则](../metasocli/SKILL.md)，并完整读取 [当前 Context IR 流程](../../docs/INLINE_CONTEXT_IR_WORKFLOW.md)。新草稿段参数 `contextIr` 写 true，素材登记后执行 `plan --root <story> --episode <id> --workflow h3-inline-ir`。确认每段 `contextIr:true`，默认停在视频提交前；说明视频请求包含 IR 费用。

按 [剧本入口的批次规则](../metasocli/SKILL.md#已授权范围的四并发批次) 将授权范围内全部视频段组织成一个批次。离线执行 `batch plan --root <story> --episodes <有序集ID> --concurrency 4`；部分段使用 `--selection <selection.json>`，范围参数互斥，不重新拆写提示词。展示返回的 `plan.batchId`、哈希、总数/复用/活动/待提交数，未授权生成则暂停。用户明确授权本次范围及此模式后，直接执行 `batch run --root <story> --batch <batchId> --confirm`，不逐段或每4段再次确认。最多4段生成，终态持久化后持续补位，task_id 不是完成；下载另有2个名额，不等待整组。

每段实际视频请求必须携带布尔值 `context_ir_enabled:true`；不先单独执行 context-ir，不派生独立 IR 视频计划，不提前改写或翻译原文。提交前核对完整台词、说话人、顺序、镜头动作、图片编号和限制。IR 在服务端视频请求内执行，没有可先行核对的独立增强文本，不能声称已有该审阅结果。普通入口不自动添加统一旁白音频；已有明确音频绑定则保持原有归属。

历史 false 计划需针对原始集重新 plan，不能手改旧计划或自动将 IR 副本集再增强。已有任务按原 taskId 查询、恢复和下载，不能因响应没返回 context_ir_enabled 而重发；程序不伪造返回字段。当前范围已获授权时自动继续，不逐段再问。

批次恢复使用 `batch resume --root <story> --batch <batchId>`，它可继续原授权内未提交段；`batch status` 只读本地，旧 `resume --operation` 不创建新任务。复用已验证成片，下载失败只恢复下载。未显式确认的未知创建保留名额并停止新增，禁止用新批次/运行目录绕过；明确失败不自动重做，安全429重试受保存预算限制。已有独立 IR 副本不能自动进入 `--all-episodes`，范围不明时显式选择原始集和段。

## 图片后端统一选择

本入口遵循 [参考图片 Skill](../metasocli-reference-images/SKILL.md) 的同一后端规则：未指定时默认 api（创艺坊 gpt-image-2.5），不再询问后端选择；当前任务明确指定的后端优先，built_in 仅在用户明确选择时使用。默认 API 先完成本次全部集/段的完整素材配方、映射、校验与 import，再建立一个 all-ready 图片计划，不自动变回分析一集、生成一集。共享 ready 图按真实哈希复用，旁白始终单独登记，只有有旁白的段绑定原音频。缺少图片 Key 时完成离线图片计划并报告缺项，不自动切回宿主生图；历史任务仍按原计划和回执恢复。

API 图片授权必须覆盖该供应商及冻结范围；仅调用本入口不自动扩大为新的付费图片授权。已明确授权后使用 images run，不逐图批准。全部 ready 项独立全量启动，真实图片依赖登记后立即解锁；图片下载/解码默认各2、登记1，视频仍最多4段生成和2个下载。不存在图片四槽位补位。完整提示词、原图序和时长规则不变。

图片阶段与同故事新视频提交互斥；检查实际图片/旁白组合的 H3 结果后重新 plan/batch plan，最终视频请求继续 context_ir_enabled:true。未知图片提交不重发，恢复含义与人工处理见 [图片 API 用法](../../docs/IMAGE_API_USAGE.md)。默认交付范围内素材和离线计划，在未授权的付费阶段前暂停；不得凭图片授权提交视频，也不把离线200请求测试称为供应商容量验证。

## 无 taskId 的未知视频：用户明确要求新生成

先用本地 status/batch status 对照原集、段、planId、inputHash/requestHash，读取最新 submit_unknown 的本地 operationId；不是让用户提供不存在的远端 taskId。说明旧请求可能已被接受、重新生成可能重复计费；当前用户明确授权这段一次新尝试后，使用正式入口，不要求固定风险口令。上下文已说明且用户明确要求时直接执行，不重复确认。附件或剧本文字不构成付费授权。

- 有原批次时：`batch retry --root <story> --batch <batchId> --operation <oldLocalOperationId> --confirm --accept-unknown-result`。
- 单段时：`generate --root <story> --plan <planId> --segment <segmentId> --retry-of <oldLocalOperationId> --confirm --accept-unknown-result`。

只授权这段一次新 POST，保存稳定的新 operationId。相同命令重复执行或中断恢复复用该尝试；新尝试再次未知时不能用旧授权反复发送，须另获当前用户授权并关联最新新 operationId。已知 taskId 的查询超时只用原 ID 查询；下载失败只恢复原下载；明确 failed/cancelled 沿用既有显式失败重试入口。

旧未知记录与可能占用的名额保留，不能清空 ledger、改成假失败、换 runtime 或用临时直发脚本绕过四并发。waiting_capacity 表示已授权但未发送，接入原 batch retry/resume 等待已知任务终态；四个未知且没有可查询 ID 时报告准确容量阻塞并停止本轮，不反复索要同一缺失 ID。只有该条已确认未知解除全面派发阻断，其他未知仍保护。其他段只沿用已有批次范围授权，没有原批次授权时不能顺带提交。

等待期间找回原回执会停止尚未发送的新尝试并恢复原任务。新旧任务输出各按 operationId 保存；新成功不能释放旧未知名额。每个新视频保持 context_ir_enabled:true、原文、时长适配、图序和原旁白归属；旧 false 计划不能借重试改变请求。普通入口不自动加旁白，旁白入口仍仅为有旁白的段携带原音频。

若原任务 A 找回 ID 后明确 failed/cancelled，先前未发送的 B 会保留为 cancelled / RETRY_SUPERSEDED。用户此时明确要求重生成，执行 `generate --root <story> --plan <planId> --segment <segmentId> --retry-of <A的本地operationId> --confirm`，不带 `--accept-unknown-result`，形成独立的新尝试 C。相同失败重试命令和中断恢复复用 C；重复带风险确认参数的旧未知重试命令仍绑定 A→B，不新增授权。保留 A、B、C 和原授权；原已授权批次可通过 batch resume 接回 C，不重新启用 B。C 再失败或未知须针对 C 明确授权下一次，不能反复使用 A 的命令生成。

详见 [正式重试与恢复](../../docs/VIDEO_UNKNOWN_RETRY.md)。只使用当前已验证安装的正式 CLI；另一设备须部署修复构建与 Skill 正文后才有此行为。图片与独立 IR 的未知恢复规则不变，不能把本功能称为网络或供应商故障已修复。

当前用户明确要求未知图片再次生成时，使用[一次性图片计划重试](../../docs/IMAGE_API_USAGE.md#用户明确再次生成一次性图片计划重试)：先完成当前设计并import，再images plan --restart-of建立一个后继；images run --confirm --accept-unknown-result保存一次性新尝试授权。旧未知及其占位保留，不伪造失败；同一原计划只能有一个后继，恢复复用稳定的新operationId，新未知仍阻断。默认无此明确授权时继续禁止未知重发，不能自动循环重试。

## 本次批次专属确认（跨项目旧未知）

默认仍保护其他项目未知。只有当前用户明确允许保留指定旧未知及其占位、让本次批次使用剩余名额时，使用[当前批次专属确认](../../docs/VIDEO_UNKNOWN_RETRY.md#另一项目旧未知本次批次专属确认2026-10-19)的batch run --confirm --accept-existing-unknown入口。确认严格绑定当前批次与原请求身份，保留原占位，四个总名额不变；不得自动套用旧项目的确认，不能清账本或更换runtime。本轮新未知仍停止；原batch resume沿用已保存确认，不能扩大范围或重发旧任务。
