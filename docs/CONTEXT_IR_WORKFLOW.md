# 独立 Context IR 使用与核对契约

**历史流程记录（2026-09-21 已切换默认模式）。当前三个 Skill 使用 [内联 IR 视频流程](INLINE_CONTEXT_IR_WORKFLOW.md)，每次视频请求明确发送 `context_ir_enabled:true`。下文旧 prepare/derived 结构及模块为历史读取、恢复和独立文本任务保留；旧 false 派生计划不能直接通过当前 CLI 新建视频，应对原始集重新 plan。本文以下命令与旧默认说明不可作为当前默认生成指令。**

实现日期：2026-09-19。CLI 和假客户端闭环已实现；真实 Metaso IR 路由、媒体接受情况和生成效果尚未验收，详见 [接口依据](METASO_CONTRACT.md)。本文件供三个原入口 Skill 共用，不增加新 Skill 名称、收费文本模型或常驻服务。

## 默认准备与授权

1. 保持原入口的原文导入、时长向上取整、图片 Skill 和已有素材登记流程。普通入口不自动添加旁白；旁白入口仅给明确含旁白的段绑定原音频。
2. 执行 `plan --root <story> --episode <id> --workflow h3-context-ir`。这一步离线、不读取凭据、不创建任务，保留原始渲染文本及完整段清单。
3. 展示准备 planId/hash、集/段范围、原目标与执行秒数、有序图片/音频及哈希、模型/比例/清晰度，并明确后续包含 **IR 增强、视频生成两个收费阶段**。默认在此暂停。准备计划中 `requestHash` 是原基础视频请求摘要；真正的 IR 请求哈希在 IR operation 中单独保存。
4. 只有用户明确授权本次范围的 IR 和视频后才开始下一步。此前只授权普通视频不自动包含新增 IR 费用。相同范围已授权无需再次询问；新费用、新范围或修订后重跑须按实际授权判断。不要用未授权创建试探路由。

## 授权后逐段执行

```text
context-ir --root <story> --plan <prepare-plan-id> --segment <segment-id> --confirm
```

该命令只创建或复用 IR，并有界查询。可用 `--submit-only`，或沿用 `--max-polls <正整数>`、`--poll-ms <整数>`；退出码 2 代表尚未完成或失败，应先看状态，不能直接执行视频。已知任务用 `resume --root <story> --operation <ir-operation-id>`；看到 `enhanced` 后才进入核对。

读取以下材料，不能只看 IR 输出或几个通过标志：

- `metasocli.yaml` 对应段的原始 `prompt`、`promptHash`、来源范围、参数、引用和原旁白 `cues`，以及导入保存的原文。
- 本次选定的当前准备计划该段的基础 `renderedPrompt`、有序 `assets`、原目标及实际执行时长。复用历史 IR 时，仍以当前准备计划作为视频执行依据；IR operation 的 `planId/planHash` 保留的是最初创建来源。
- `status --root <story> --operation <ir-operation-id>` 返回的 IR 身份、结果路径与哈希；完整读取 `result.path` 指向的 UTF-8 原文。

由发起业务的当前入口 Skill 核对：完整台词、说话人和顺序；明确动作/镜头/时间关系；人物造型、场景、道具和图序号；用户限制；旁白音频只用于指定画外叙述，不复述参考录音、不替代角色对白或驱动角色口型。没有旁白的段不得新增音频。原目标 `12.378/6.666/6.963` 与执行值 `13/7/7` 可不同，这是正常向上取整；不能因此逐段询问或裁剪。

## 核对文件

在当前故事内保存 UTF-8 JSON。下列占位内容必须从上述真实材料填入；哈希与 ID 不手工编造。`preparePlanId/preparePlanHash` 必须取自本次选定的当前准备计划，不能在复用 IR 时直接照抄 operation 的历史 `planId/planHash`。`dialogueQuotes` 按原顺序列出需逐字保留的全部对白（包含没有引号的对白文字）；没有对白时才使用空数组。`findings` 四项均写具体原句、角色、序号或约束以及核对结果，不填“true”充当证明。

```json
{
  "schemaVersion": 1,
  "preparePlanId": "本次选定的当前准备计划 UUID",
  "preparePlanHash": "该当前准备计划的 64 位 SHA-256",
  "segmentId": "原段 ID",
  "sourcePromptHash": "原段 promptHash",
  "irOperationId": "IR operation UUID",
  "irTaskId": "IR taskId",
  "promptHash": "IR operation.result.sha256",
  "verdict": "approved",
  "reviewer": "当前入口 Skill 名称及本次核对者",
  "reviewedAt": "实际 ISO 8601 UTC 时间",
  "dialogueQuotes": ["按原顺序完整摘录对白"],
  "findings": {
    "dialogue": "逐句及说话人核对的具体依据；无对白则说明对应段无对白。",
    "references": "按素材编号说明人物/场景/道具绑定与增强文本一致的依据。",
    "narration": "有旁白则说明原句、音频归属、角色对白/口型保护；无旁白则说明未新增音频。",
    "constraints": "说明镜头动作、时间关系、执行时长及用户限制的核对依据。"
  }
}
```

CLI 对身份、哈希、文本长度、已知引号内文本、`dialogueQuotes`、原旁白原句/顺序及常见引用编号做确定性检查；这不能证明所有自然语言语义都正确，Skill 仍必须实际核对。IR 原文超限、缺句或引用错误时保存原结果，不截断或自动重写。若发现问题，记录 `verdict: "needs_review"` 与准确差异，并调用下面的离线命令存档；它返回 `IR_REVIEW_REQUIRED` 并阻止视频，不把成功的 IR 错标为供应商失败，也不自动再跑 IR。

```text
plan --root <story> --from-context-ir <ir-operation-id> --review <review.json>
```

核对通过时，该命令将 review 复制到受管理目录，按当前准备计划先预留派生 planId/createdAt，再原子写入单段视频计划并回写哈希。同一准备计划下，相同 review 重复执行会得到同一身份；已经预留的派生计划不能替换 review。中断恢复应使用已保存的 review，不能仅为重试更新 `reviewedAt` 等字段。不同准备计划分别保留核对和派生记录，不覆盖之前的计划。无需用户逐段批准正常的核对结果。

派生计划保留准备计划和 IR/review 的来源身份，提交前可重建验证。只替换实际请求的 text，原 Story/prompt/hash/cues 不变；图片/音频角色、顺序、字节身份及执行参数不变。旁白 cues 仍指向原文，不能套到 IR 文本，不再给最终文本追加原文或旁白列表。最终请求显式为 `context_ir_enabled:false`。

```text
generate --root <story> --plan <derived-video-plan-id> --confirm
```

该命令复用原 H3 视频提交、查询和下载；准备计划不能直接用于 generate。`plan --episode` 普通计划仍可用于原 H3 流程，不带 workflow、不自动升级历史计划。

## 恢复边界

- IR 与视频独立落盘意图和回执。IR 位于 `.metasocli/context-ir/`，原视频仍位于 `.metasocli/jobs/`；`enhanced` 不等于核对通过或视频完成。
- `status` 本地读取不联网；`status --remote` 对选定 ID 查询一次。IR 查询成功可以保存文本，视频状态查询不下载。`resume` 只恢复原阶段；`download` 只接受视频。上述命令均不创建下一阶段。
- 任一阶段创建结果未知时禁止新收费创建；不要换路径重发。核实原 taskId 后 `attach-task --root <story> --operation <id> --task <task-id> --confirm-task-link`。IR 还校验模型与任务类型，跨阶段不能重复绑定 taskId。
- IR 明确失败/取消且用户授权重试时，在 context-ir 上使用 `--retry-of <latest-ir-operation-id>`。视频失败用原 generate 的 `--segment` 和 `--retry-of`，复用已通过的 IR。下载失败只恢复原视频。
- 原文或素材变化会阻止新的付费请求；已接受的 IR/视频仍按原 ID 取回。IR 成功后自动继续也必须显式调用离线派生和 generate，不能修改 resume 的语义。
- 如果只是修改其他段落或新增其他集，先执行 `plan --root <story> --episode <id> --workflow h3-context-ir` 建立当前准备计划。选定段的原文、有序素材及执行参数完全一致时，`context-ir` 返回原 IR operation，不再创建 IR。原入口 Skill 对照当前准备计划完成核对，将它的 ID/hash 写入新的 review，再执行原 `plan --from-context-ir ... --review ...`；已有范围授权仍然有效时不增加逐段确认。
- 复用时仍完整校验当前准备计划，并重建当前段请求，核对项目/集/段身份、原文哈希、基础输入哈希及 IR 请求哈希。当前段本身变化时拒绝复用旧 IR；旧 review 仍引用过期准备计划时也不会放行。不要删除成功任务或用 `--retry-of` 强制重新收费。
- IR operation 的原始 `planId/planHash/revision`、任务回执和结果不变。原准备计划的 `review/derived` 继续使用原字段；其他准备计划的核对与派生身份另存于可选 `planBindings`。旧视频按原 taskId 恢复；相同最终视频输入重复提交仍复用已有任务。
- 每个阶段自己持有项目锁，协调者不要再包一层项目锁；锁内跨阶段检查未知/活跃任务及重复身份。进程中断后的派生计划按预留身份继续，不生成另一份 UUID。
