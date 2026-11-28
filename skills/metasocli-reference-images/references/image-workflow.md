# 固定图片准备与结果交接

这是已实现的 API 机械流程，六个本包入口共用。各入口仍负责原文、素材身份、完整类型模板和旁白语义；本流程不重新设计已确认配方。`metasoclitk` 保留自己的三类模板，普通入口不自动绑定旁白。明确选择 built_in 时继续原宿主生图流程。

执行前完整读取 [图片执行授权与连续执行](../../../docs/IMAGE_EXECUTION_AUTHORIZATION.md)。当前用户已经要求生成、补齐或再试一次时，沿用该约定中的供应商及必要素材发送授权，直接完成指定范围；不在 prepare 完成、逐图提交、容量恢复或结果登记时重复等待同一确认。若宿主拒绝，按该文档核对授权证据并及时报告；以正式记录更新当前状态，不绕过审批或把旧拒绝误当成新的阻塞。

来自 metasocli、metasoclitk、yiciyuang2 或两个独立成品提示词入口的新配方，先按[图片去噪规则](denoise-policy.md)用包内 append_asset_denoise.py 批量 compose/check，再把同一份最终提示词和对应哈希写入交接与草稿，执行下列校验和 prepare。ready 素材照原记录复用。旧 preparation、plan、job 的恢复继续使用当时冻结的提示词和哈希。

以当前安装根定位 `dist/cli/main.js`。先收齐本次全部集/段的 `draft`、`reference-image-request`、`reference-image-recipe`；保存一份清单，不现场编写导入/执行/结果拼装脚本：

```json
{
  "schemaVersion": 1,
  "projectId": "当前故事 UUID",
  "entries": [{"episodeId":"ep-01","draftPath":".metasocli/drafts/ep-01/draft.json","requestPath":".metasocli/drafts/ep-01/reference-image-request.json","recipePath":".metasocli/drafts/ep-01/reference-image-recipe.json","replace":false}],
  "scope": {"episodes":["ep-01"]},
  "profilePath": ".metasocli/drafts/ep-01/batch-profile.json"
}
```

所有输入相对路径以显式故事根为基准，scope 只能是 episodes、selection、assets 三者之一，entries 覆盖所选各集。由 metasocli、yiciyuang2 或 metasoclitk 准备新的竖幅人物时，执行 Skill 运行下列命令，每份交接传一次 --recipe，每个本次新竖幅人物传一次 --asset。工具按结构化的 assetId、kind、planned 状态匹配，保留其他配置与旧人物规格。全部 planned 人物都采用新版时可省略 --asset。存在显式基础配置时传 --profile。将 --out 的结果填入本批 profilePath，独立 images plan 则传同一文件的 --profile。未选新竖幅人物时直接沿用原配置。尺寸冲突先解决再提交。

```text
node <安装根>/skills/metasocli-reference-images/scripts/character-board-profile.mjs --recipe <新配方.json> --asset <新竖幅人物ID> --out <故事内新批次配置.json>
```

profilePath=null 解析本安装原有配置并冻结，不读取图片 Key。

```text
node <package-root>/dist/cli/main.js images prepare --root <story> --batch <batch.json>
# 已有授权覆盖当前图片供应商、冻结范围和本次尝试后：
node <package-root>/dist/cli/main.js images run --root <story> --plan <返回的planId> --confirm --summary
node <package-root>/dist/cli/main.js images collect --root <story> --preparation <返回的preparationId>
```

prepare 固定调用包内 Python 3.10+ 校验器、现有逐集导入和 all-ready 计划器。可用 `--python <本机可执行文件>`；缺 Python 明确失败，不假称校验完成，不自动安装。成功准备不授权收费；沿用已有授权，不新增口令或逐图确认。图片 Key 缺失时停在本地计划，不自动换后端。

prepare 返回准备ID、计划ID、已导入/剩余集、记录与计时路径及当前执行摘要。同输入重复调用复用同一ID；正常图片登记推进不会重建计划。输入/摘要索引不是授权凭证。新配方用新assetId和新输入；旧记录保留。逐集导入不是整剧事务，中断时已有集可能已落盘，失败摘要同时记录观察到的实际集。

| 实际状态 | 后续动作 |
| --- | --- |
| 准备中断 | `images prepare --root <story> --preparation <id>`；或重复原 --batch，定位原记录 |
| 计划已落盘但准备状态没完成 | 同上，验原 plan-intent 后复用原计划，绝不再建第二计划 |
| 已有旧正式计划，没有准备记录 | 直接原 status/run/resume/recover；不要求重建、迁移或补准备目录 |
| 执行中或部分结果 | `images status --root <story> --plan <id> --summary`；collect 只收本地证据 |
| 有原授权，尚未发出的项 | 原 `images resume --root <story> --plan <id> --summary`，范围不扩大 |
| 已接收但下载/登记失败 | 原 `images recover --root <story> --operation <id>`，不重生 |
| submit_unknown | 保留原记录，不转为失败；按原正式恢复/一次性授权规则处理，prepare/collect不重发 |

collect 从冻结计划和 run 的确切 operationId 核对 Job、execution、receipt、原暂存图及正式登记文件。`executionSha256` 是文件字节哈希，`recipeSha256` 是规范化提示词哈希，reportedModel 缺报为 null。只给可完整表达的集输出并校验 1.1.0 result；未知、进行中、待下载/登记、范围外或证据未齐的条目保留在 collection-report.json，不伪造完整交接，不把未知写成 failed。不重新登记、下载、编码或覆盖图片。

每次 collect 写新的 `collections/<UUID>/`；已完成图片可从摘要路径展示，无需等全批。结果/失败/缺项交回原入口，必要素材 ready 后按原 H3 流程继续；未经视频授权仍停在视频提交前。prepare/collect 都不联网、不加载或解密真实 Key、不授权、不运行图片生成。summary 仅改变输出，旧命令不带开关时保持原 JSON；大列表保留总数、截断标记及完整文件位置。

准备租约仅在本故事 `.metasocli/image-preparation.lock`；不会重新引入全局运行锁。图片仍 all-ready、有效600秒、原共享额度，视频仍全机最多4个生成名额、MiniMax-H3/context_ir_enabled:true。计时使用本地单调时钟；requestStartedAt 不是供应商受理时点，无法由本地数据推出远端排队或推理耗时。
