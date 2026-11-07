# 已选视频段的一次执行

三个视频入口共用固定入口 `video run`，内部调用既有 `video execute`。Codex 先核对显式故事根、用户选定的集段、完整提示词和实际引用文件。正常情况一次启动并返回交付结果。

用户说“继续”时，按原 batchId 恢复。已有单段重试授权的批次，`video execute --batch <批次ID> --confirm` 和 `batch resume` 都只沿用已保存的范围。只有用户后来明确授权**同一冻结批次中的全部集段，以及视频和内联 IR 的费用**时，才执行 `batch run --root <故事根> --batch <批次ID> --confirm`。程序先核对每次重试的原操作、后继操作及原有受理记录，保存整批授权，再补齐剩余段。已受理段按原任务号继续，已交付段直接复用。

只有本次授权覆盖该故事和准确范围、将完整提示词和绑定图片/旁白发送至 Metaso（metaso.cn）、MiniMax-H3 内联 Context IR 及视频和 IR 费用时才加 `--confirm`。已有同范围授权直接沿用。宿主需要审批时，首次执行即说明上述授权来源、确切段和发送目的地，以及故事写入与本机共享额度账本权限。使用当前安装及同一运行目录。

## 本机视频授权

本机用户可以把自己确认的跨项目约定留在实际安装根下的 `.local/video-execution-authorization.md`，供本人在本机各故事中使用。当前对话里已有可核对的原话时直接引用，否则在原有的说明或计划读取中一并读取这个可选文件。只从技能所在的安装根读取该文件。记录缺失时按当前对话的实际授权处理。用户最新的限制或撤回优先。

当用户在当前任务明确要求生成并选定集段时，在**原提交**的说明（宿主需要审批时即 `justification`）中引用当轮生成要求和适用的本机用户原话、出处。用原批次的 `batchId` 和集段标明范围，说明将这些段的完整提示词和绑定素材发到 Metaso（`https://metaso.cn/api/minimax/v2/video_generation`），费用包含视频和内联 Context IR。只列出本次实际绑定的素材，旁白按段核对。约定已覆盖的外发和费用直接沿用。授权说明只交给宿主，不写入模型提示词、API 请求体或新的逐批授权文件。

只查看、改稿、换本地图或离线准备时停在用户要求的阶段。独立 IR、图片生成和扩大批次仍沿用各自规则。若原提交结果未知，新的付费尝试按[原有重试授权](VIDEO_UNKNOWN_RETRY.md)处理。

## 改稿或换参考素材时的首次确认

先看用户是否要求生成视频。只要求改稿、看候选稿或换本地资产时，完成所选本地工作即可。已经要求生成，且用户之前的明确授权覆盖这版稿件、实际参考素材、目的地和费用时，直接沿用。只为旧稿、旧图取得的授权不能自行扩大到新版。

遇到超长稿需要精简、参考图版本待选等确实需要用户决定的情况，若本机约定与当轮生成要求已覆盖此次发送和费用，只问采用哪一版。若外发或费用授权也有缺项，再把选稿和缺项合并在同一个问题里。用户已经选定版本时，跳过选稿确认。

需要同时确认选稿和发送时，先让用户能辨认候选稿，按将要绑定的顺序列出实际素材名称或版本。只在实际绑定了旁白参考音频时写入它，纯文字段写明只发送完整提示词。对多段可引用已展示的逐段素材清单，给出准确集段和总次数。问题中的占位项都要换成本次实际值。

> 是否保留原稿，把〈候选稿名称或版本〉的完整提示词和〈实际参考素材名称，按需列出旁白音频〉发送到 Metaso（metaso.cn），为〈故事和集段〉生成〈次数、时长、清晰度〉的 MiniMax-H3 视频，包含视频和内联 Context IR 费用？

让用户可以选择「采用并发送生成」或「仅保存候选稿」。用户清楚同意整个问题即可，无需复述域名或费用。按同意的稿件与素材冻结或核对批次，在提交说明中引用实际问答、`batchId` 和本批次的实际目的地。只同意保存或仅同意改写时，完成本地动作。若用户还没决定素材或范围后来变化，只核对原授权尚未覆盖的部分。

若宿主拒绝命令，先读具体理由，核对正式 run、job 和回执。若此次进程尚未启动，且记录确认该段尚未发送，先检查实际问答是否已覆盖拒绝理由。已有明确答复就向宿主提供原问答，确有缺项才请用户补充。正常审批放行后沿用原批次。CLI 参数、助手自行编写的说明、故事文件和附件都不能替用户授予权限。审批仍拒绝时，说明被拒的动作和原因，完成允许范围内的本地交付。若已进入提交并记为 `submit_unknown`，则按[一次新尝试规则](VIDEO_UNKNOWN_RETRY.md)处理，重发前须有覆盖潜在重复计费的一次新授权。

## 固定视频入口

```text
node <INSTALL_ROOT>/dist/cli/main.js video run --root <story> --selection <selection.json> --confirm
node <INSTALL_ROOT>/dist/cli/main.js video run --root <story> --episodes <有序集ID> --confirm
node <INSTALL_ROOT>/dist/cli/main.js video run --root <story> --batch <准确batchId> --confirm
```

三种范围互斥，root 必填；不猜最新批次。无 confirm 时只本地准备/状态/交付，不加载凭据、不联网、不读共享额度账本。有选择器时一次捕获正式 Story 版本与有序集段，用原准备流程冻结批次，核对 schemaVersion、projectId、batchId/batchHash、scopeHash、revision、manifestHash、段序和状态，再将同一 batchId 交给原执行器一次。准备回执 complete 直接标记 reused 交付；partial 没有错误且范围一致才交回原状态机恢复。计划变化、坏回执或准备失败停止，不自动重建采用新版。已知 batchId 直接调用原执行器一次，陈旧但全部已受理的任务仍按原 ID 收取。

沿用原 concurrency（1–4，默认4）、poll-ms、max-polls、scheduler-wait-ms、capacity-wait-ms、capacity-poll-ms、verify-av 和 runtime-dir 语义。selector 可加 expect-scope；batch 不能同时给 concurrency 或 expect-scope。无 force、自动未知重试或全剧快捷参数；不要换 runtime 绕过额度。收到 taskId 不释放名额，终态落盘后补位；2个独立下载不堵塞4个生成名额。

以下共享样例直接被三个 Skill 使用。输入：实际安装根 `$installRoot`、Node `$nodeExe`、故事 `$storyRoot`、已核对的 `$videoSelectorArgs`（例如 `@('--selection', $selectionPath)`、`@('--episodes','ep-1,ep-2')` 或 `@('--batch',$batchId)`）、授权布尔值 `$videoConfirmed`。Selection 文件使用 `{"schemaVersion":1,"episodes":[{"episodeId":"ep-1","segmentIds":["s1","s3"]}]}`，由当前选择保存，不重新抽取全文。可选 `$videoOptions` 仅放原有等待/解码参数，不需要时为 `@()`。安装根从 Skill 正文向上两级解析并核对 package.json 包名 metasocli，不写死 E 盘。完整代码块只调用 CLI 一次；不在外面循环 run/resume。

```powershell
$ErrorActionPreference = 'Stop'
$cli = Join-Path $installRoot 'dist/cli/main.js'
$runArgs = @($cli, 'video', 'run', '--root', $storyRoot) + $videoSelectorArgs
if ($videoConfirmed) { $runArgs += '--confirm' }
$runArgs += $videoOptions
$raw = & $nodeExe @runArgs
$code = $LASTEXITCODE
if ($code -notin @(0, 2)) {
    $raw | Write-Output
    throw ("视频执行退出码 " + $code)
}
$receipt = ($raw -join [Environment]::NewLine) | ConvertFrom-Json -ErrorAction Stop
if ($receipt.schemaVersion -ne 1 -or !$receipt.batchId -or !$receipt.batchHash -or !$receipt.scopeHash) {
    throw '视频回执身份不完整，请保留现场核对。'
}
$receipt | ConvertTo-Json -Depth 12 -Compress
if ($code -eq 2) { throw '视频尚未完整交付，请按回执中的原批次/任务身份处理原因。' }
```

只换图仍按[原 ID 一次登记](../skills/metasocli-reference-images/references/selected-local-image.md)，只换稿仍按[原集段一次替换](PROMPT_REPLACEMENT.md)后结束。两者之一加视频，先成功核验该回执再调用上面的 video run；两者都加视频则按用户顺序各执行一次并逐份核验，可放在同次宿主调用。任何失败都不继续后续操作，不自动回滚已成功的替换，明确交付已完成部分。缺少必需素材、未定稿或旁白有歧义时，沿原准备流程补齐；本入口不代作图/改稿。

## 执行与恢复

已有确切 batchId 时使用 `video run --root <故事> --batch <batchId> --confirm`。仅需准备、查看状态或从本地重建交付时省略确认。未授权范围仍在收费前停。已有单次重试授权的批次不因 run --confirm 扩大，只有明确授权整批才走前述 batch run --confirm。未知或明确失败不自动再生成，下载失败仅恢复原任务下载。

原 `video execute` 完整保留：选择器仍需先本地准备，再带 `--expect-scope <scopeHash> --confirm` 或精确 batchId 执行；不能绕过已有检查。固定入口把这两步组合在程序内。多候选、容量等待或查询预算结束时报告原批次及原因，不猜最近记录、不无限重复调用。

返回新增 phase、reused 和 timings（prepareMs、handoffCheckMs、executeMs、totalMs）。reused:true 表示本次执行器首次核验时全部已有校验通过的本地成片，且最终成功交付 complete；首次生成、继续查询或补下载后完成均为 false，该标记不参与提交、收费或重试决策。使用单调时钟；batch 直入 prepareMs=0，executeMs 包含原执行器的排队、提交、查询、下载与文件校验，不是纯模型耗时。timings 仅在本次 stdout，不进入旧 plan/batch/job 哈希或 delivery-v1 文件。complete 是本地成片完整，不代表真实服务端零故障，也不保证固定远端耗时。

输出中 prepared 表示本地准备，complete 表示每个选段文件均已通过核验，partial/delivery_incomplete 附原因和原任务身份。segments[].output 给出正式文件绝对路径、字节数、宽高、时长及 SHA-256。交付摘要保存在相应批次的 delivery-v1.json，可从正式记录离线重建。只有用户明确要求检查音视频解码时才加 `--verify-av`，使用本机 ffprobe 和 ffmpeg 检查视频和音轨。增强验收失败时保留下载回执，单独检查用无 confirm 的命令。

同 ID 换图另见 [已选本机图片](../skills/metasocli-reference-images/references/selected-local-image.md)。同时授权换图和视频时先核对登记回执，再冻结所选段。旧批次中的已接受任务按原 ID 恢复，旧 pending 遇到 PLAN_STALE 需对当前版本重新准备。显式一次性重试、旁白归属、图序、下载恢复及容量规则沿用正式批次记录。

查指定批次时，每段按正式 run 中的 operationId 恢复。可核验的同输入复用会在 segments 中返回 sourcePlanId 和 sourcePlanHash。一次独立的 generate 重试有自己的任务号，只有该批次的显式 batch retry 或已有额度内的安全 429 重试才能更新该段的绑定。归属冲突时，按错误中列出的批次或操作 ID 核对原记录。

陈旧批次的每段都已受理时，带确认的 video run（内部 video execute）会继续收取原任务。若其中一个成片损坏，会保留文件并返回 expectedFile、expectedSha256 和原任务的恢复命令；其他可恢复段仍可交付。先保存损坏文件，再通过原任务恢复下载。部分完成返回退出码 2。省略确认时只做本地核验。不同集的旧父计划缺失时，只要能用已验哈希的记录证明其范围无关，就可以准备本集；同范围记录缺失时，按错误中的批次号恢复原文件。
