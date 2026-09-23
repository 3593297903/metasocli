# ts1 四并发修复二次独立核验

日期：2026-09-21。对象：任务 `ts1` 最新修复后的 `E:\metasocli` 本地源码。

结论：首次核验指出的两处问题均已修复，本轮独立离线复核通过；未发现新的阻断交付问题。真实付费四并发、供应商账户限额及实际限流行为仍未验收，本轮没有发起付费请求。

## 两项历史发现的关闭证据

原样复制并运行首次核验的 `repro-boundaries.mjs`，已核对脚本字节哈希一致，没有改写原脚本的复现步骤，也没有覆盖首次核验的历史结果。新结果位于 `.work/ts1-concurrency-recheck-20260921/boundary-reproductions.json`。

| 项目 | 首次核验 | 本轮独立复现 |
| --- | --- | --- |
| Windows 同目录大小写切换 | POST 成功后 `RECEIPT_PERSISTENCE`，Job 为未知且无 taskId | CLI 退出0，只有1次 POST，Job 为 queued，保存 `fake-case-task` |
| 已完成项目移动后生成新项目 | 活动名额为0仍报 `NOT_INITIALIZED`，新项目零 POST | 原项目 complete、活动名额为0，新项目正常产生1次 POST 并完成，无错误 |

正式新增回归还覆盖：原任务 ID 查询和下载、再次执行不增加 POST、旧 ledger 等价路径合并、批次查询事件保留段落序号、实际不同目录的身份冲突、旧版终态记录归档及恢复原目录。以上回归在本轮完整套件中实际运行通过。

## 未决任务保护没有被放宽

检查源码及本轮回归证据，归档不是直接忽略找不到的目录：

- 共享 ledger 先校验原哈希，再兼容 Windows 等价路径。
- `retiredAt` 不能自行释放名额；必须存在完整终态记录，成功类终态还必须有 taskId。
- reserved、prepared、submitting、queued、running、submit_unknown、query_unknown 七种状态的目录缺失测试，后续新项目 POST 均为0，原占位仍保留。
- 克隆到另一真实目录不能冒用项目身份；只有空登记而缺少终态证据的目录，也不会被当成已安全完成。

归档兼容的范围是“终态历史不再阻塞其他项目”；没有宣称支持把活动项目迁到另一目录后自动接管其身份。恢复旧项目到原路径时仍重新验证项目和任务。

## 本轮独立执行结果

| 检查 | 实际结果 |
| --- | --- |
| `npm run build` | 退出0 |
| `npm test` | 退出0，22个文件、178项全部通过，92.19秒，无跳过项 |
| `npm run test:process` | 退出0；旧视频2个、独立 IR 6个、批次10个强制中断边界，以及跨项目/四进程竞争、等待和接管通过 |
| `npm run test:image-skill` | 退出0，11项通过 |
| 原始问题复现脚本 | 两项均得到正确结果 |
| 16段持续补位 | 原顺序1—16，HTTP峰值4、生成占位峰值4、下载峰值2；最终16个合格输出，恢复后总 POST 仍16 |
| 请求与素材回归 | 实际假传输层 JSON 继续为 `context_ir_enabled:true`，原文、图序、时长、旁白绑定回归通过 |
| 旧环境隔离 | 53个保护文件、旧 Git 状态、全局命令路径与实施前基线一致 |
| 核验期间源码 | 89份源码/测试/脚本/Skill 哈希不变；9份受保护核心文件仍与初次实施前一致 |
| `git diff --check` | 退出0 |

完整套件和进程测试使用允许 Windows 系统子进程的执行环境，以实际运行 DPAPI 和强制中断检查；测试只使用临时合成凭据及假客户端，不读取真实 API Key，不使用真实生成接口。没有以跳过测试代替通过。

本轮未重新执行临时安装测试，没有把旧的安装测试结果计入上表。与首次独立核验时的文件哈希比较，本轮产品修改限于 `jobs/coordinator.ts`、`jobs/batch.ts`、`storage/paths.ts`、`storage/locking.ts`，另新增13项边界回归；原提示词、H3 请求构造器和旁白 Skill 内容未改变。

## 留存证据

目录：`E:\metasocli\.work\ts1-concurrency-recheck-20260921`。

- `build.log`、`unit-tests.log`、`process-tests.log`、`image-skill-tests.log`：独立执行日志。
- `repro-boundaries.mjs`、`boundary-reproductions.json`：原样复现及正确结果。
- `independent-boundary-regressions.json`：大小写、原 ID 恢复、归档及七种未决状态证据。
- `independent-trace.json`、`independent-process-evidence.json`：补位轨迹与无重复 POST 证据。
- `isolation-review.json`、`source-before.json`：隔离与核验期间源码基线。
- `ts1-fix-*`：开始独立复跑前保存的 ts1 修复报告和原验收记录。

本轮只执行核验、重新构建和离线测试，未改产品源码、现有业务故事、旧安装、全局配置或凭据，未发送新的开发任务，未推送 Git。
