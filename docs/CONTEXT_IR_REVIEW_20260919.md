# ts1 独立核验：Context IR 实现

日期：2026-09-19。当前结论：**本次核验发现的 P1 已完成定点修复，新增 12 项回归测试通过，完整构建及 137 项测试通过。真实服务验收仍待授权。** 下文保留修复前的发现与证据，修复后的验证见第 5 节。

最初核验读取 ts1 状态、当前源码及实施方案，独立运行测试并补充全新临时故事复现；该核验阶段没有修改产品源码或 Skill。随后按用户“怎么修复这个问题”的要求在当前任务定点修复，没有派发其他任务，也没有调用真实生成接口。

## 1. [P1，已修复] 修改其他段落后，已成功的 IR 卡在过期准备计划

触发场景：同一集有 s1/s2 两段；s1 的 IR 已完成，但尚未提交视频。用户只修订 s2，再生成当前版本的准备计划。s1 的原文、参考图、参数和 inputHash 完全不变。

修复前的实际结果：

1. `submitContextIr()` 根据 s1 的 inputHash 找到并返回原来的 IR operation，避免重新创建。
2. `createPlanFromContextIr()` 只能读取该 operation 原先绑定的准备计划，并要求它匹配当前整个故事的 revision/manifestHash。
3. s2 的正常修改已使整个故事 revision 增加，因此派生失败：`PLAN_STALE`。
4. 错误建议重新建计划，但再次建计划仍会返回同一个旧 IR operation。
5. 对该 operation 显式 retry 也返回 `RETRY_FORBIDDEN`，因为 IR 本身已经成功。

这是可重复的恢复死路，不是测试权限或第三方服务问题。它也影响新增其他集、修改其他素材等导致清单版本变化、但当前段输入仍相同的情况；已提交的视频仍可按原 ID 恢复，问题主要出现在后续派生/新提交阶段。

修复前涉及的代码位置：

- [submitContextIr](../src/jobs/context-ir.ts)：复用只按集、段和 baseInputHash 匹配，并直接返回原 operation。
- [createPlanFromContextIr / validatePlan](../src/core/planning.ts)：派生只从 operation.planId 读取旧准备计划，整个当前清单与旧准备计划不一致时拒绝派生。

独立复现命令：

```powershell
Set-Location -LiteralPath E:\metasocli
node .work/ts1-ir-review-probes-47d394ef.mjs
```

复现程序固定禁止真实 fetch，只使用假 IR 客户端和合成参考图片；每次运行在 `.work/ts1-ir-review-*` 新建独立故事。原业务项目完全不参与。

本次输出摘要：

```json
{
  "oldRevision": 2,
  "newRevision": 3,
  "segmentInputHashUnchanged": true,
  "reusedOldOperation": true,
  "irCreates": 1,
  "derivationError": { "code": "PLAN_STALE" },
  "retryError": { "code": "RETRY_FORBIDDEN" },
  "newPlanStillReusesStaleOperation": true
}
```

完整证据：[result.json](../.work/ts1-ir-review-7Z2KaV/result.json)；历史探针：[复现脚本](../.work/ts1-ir-review-probes-47d394ef.mjs)。历史探针故意沿用原准备计划的 review，修复后该过期 review 仍应被拒绝；新行为是以当前准备计划核对并继续。该场景已加入 [正式回归测试](../tests/context-ir-reuse.test.ts)，并在原复现故事的独立副本上通过恢复验证，原证据没有覆盖。

### 最小修复方向

保留已经成功的 IR 任务和原始来源，不通过删除记录、修改旧哈希或自动重跑收费 IR 来绕过。

将“IR 当时的来源证明”和“当前视频执行所用的准备计划”分开：允许已保存的同输入 IR 结果绑定到经过验证的当前准备计划，并产生新的不可变派生记录。重建当前段 IR 请求，精确检查源 promptHash、实际请求哈希、有序素材和执行参数一致后才允许复用；当前段确有变化时仍拒绝错误复用。

派生身份按当前准备计划与核对记录分别保留，不能覆盖已有派生计划，也不能破坏之前视频的恢复。旧 IR operation 的原始回执和创建来源保持不变。新增测试至少包含“仅修改同集另一段”和“只新增另一集”，证明当前段可继续派生/生成、IR 创建计数仍为 1、重复继续不会多建视频，以及旧视频恢复不受影响。

## 2. 修复前独立重跑的检查

| 检查 | 实际结果 |
| --- | --- |
| `npm run check` | 构建通过；16 个文件、125 项测试全部通过 |
| `npm run test:image-skill` | 11 项通过 |
| `npm run test:process` | 8 个进程中断恢复检查点通过；IR 提交和派生预留时的第二进程锁检查通过 |
| `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-smoke.ps1` | 临时源码离线安装/构建、125 项测试通过；临时 prefix 安装、重复安装、卸载通过；8 个旧安装哨兵不变 |
| `git -c safe.directory=E:/metasocli diff --check` | 通过；现有 package-smoke.ps1 有 LF/CRLF 提示 |
| 旧环境隔离 | 与 ts1 本轮开始基线相比，53 项受检文件哈希、旧 Git 状态和 3 个命令路径均未变；本次测试结束再次比对一致 |
| 产品源码与 Skill | 与 ts1 记录的本轮源码哈希相比，本次核验未改动源码或 Skill |

进程/DPAPI/临时安装检查在允许启动本机子进程的执行环境完成，使用临时目录和假客户端。没有修改真实全局安装。

## 3. 已确认符合方案的部分

- 独立 IR 创建和查询、IR 文本结果、独立意图/回执/结果记录已实现。
- 准备计划拒绝直接生成视频，最终派生视频明确关闭内联 `context_ir_enabled`。
- 图片和适用旁白音频的角色、顺序及哈希在两阶段保持；原 prompt/cues 不被改写。
- 小数时长两阶段均沿用向上取整；普通和旁白历史计划固定样本通过恢复测试。
- 普通 status/resume/download 不创建后续阶段；未知提交不盲目重发。
- 三个业务入口共用 IR 核对流程，默认暂停在收费 IR 之前。

## 4. 仍待真实服务验收

`CONTEXT_IR_CREATE_URL` 目前为 `https://metaso.cn/api/minimax/v2/h3_context_ir`，ts1 文档已明确这是尚待确认的 Metaso 路由。源码单独定义 IR URL，未修改原视频 API_BASE，也没有自动换路径重试。

真实 IR 创建/查询路径、媒体接受情况、增强文本及旁白效果、实际视频生成尚未验证。这个已披露的服务验收项与第 1 节的本地缺陷分别处理，不能将 125 项离线测试通过表述为真实流程全部跑通。

第 1 节现已完成本地修复及回归验证；后续按用户授权范围进行真实服务验收，无需回退整个项目。

## 5. 定点修复与验证

运行时仅修改 IR 契约、IR 存储校验和计划派生三个模块。IR 最初的计划身份、任务回执和文本结果保留；通过 review 选择当前准备计划，并完整验证清单、当前段原文、实际参数和有序素材，再与原 IR 请求身份逐项核对。同输入成功 IR 可以复用，当前段有实际变化时返回 `IR_PROVENANCE`。

原准备计划继续使用既有 `review/derived`；其他准备计划使用可选 `planBindings` 分别记录核对与预留派生身份。所有已保存的计划保持不可变，三个持久化中断点可继续同一 planId；旧视频恢复与同输入视频去重保持。CLI 命令和两个成品提示词 Skill 名称不变，共享 [核对契约](CONTEXT_IR_WORKFLOW.md) 已说明 current preparePlanId/hash 的填写与恢复方法。

- 新增 12 项覆盖修改同集其他段、新增其他集、旧视频恢复、四类当前段输入变化、跨集错误复用、三个新绑定中断点、并发与篡改。
- 完整 `npm run check`：17 个文件、137 项通过。
- 原复现故事副本继续成功：原 IR 直接复用，新增 IR 创建数 0；假视频创建数 1，重复继续复用同一视频。
- 修复前实际保存的三组 IR 准备/派生计划经新构建读取与验证通过，六份 planHash 及三个故事内全部文件哈希不变。
- 修复结束隔离复核：旧 Git、三个命令路径和 52 项文件哈希未变；共享 Codex 配置相较保留基线出现一处差异。本次未写该配置，来源未确认，差异已保留并记录，未将隔离检查报告为全通过。

具体恢复与兼容证据见 [.work/ir-reuse-fix-verification.json](../.work/ir-reuse-fix-verification.json)；其余完整检查记录见 [交付验证](VERIFICATION.md#context-ir-跨准备计划复用修复2026-09-19)。上述全部为离线验证，不代表真实 Metaso 出片成功。
