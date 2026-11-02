# 故事隔离、共享容量与冷切换

2026-11-02。使用同一安装运行目录的不同故事可同时运行。图片与视频各持故事内的 `.metasocli/image-scheduler.lock`、`.metasocli/batch-scheduler.lock`；同一故事即使改路径大小写、profile 或 runtime，仍不能取得第二份运行权。不要更换 runtime/quotaGroup 绕开共享容量。项目短写锁和 receiver/submission/download 操作锁仍保留。

共享图片 `ledger.lock` 和视频 `coordinator.lock` 仅保护短事务。锁顺序是故事运行权 → 共享协调短锁 → 项目短写锁；HTTP、下载、依赖等待和轮询均在短锁外执行。

## 默认隔离与恢复

同步只读取当前故事的 Job、计划、回执和身份。其他故事记录保留为通过共享表哈希/身份校验的快照，其目录缺失、Job 损坏、图片阶段未结束和业务未知均不否决本故事的空余容量。共享表本身损坏、重复 operationId/taskId、同 UUID 在不同实际根登记仍报错；不会通过过滤隐藏协调器完整性故障。

视频本地 prepared 若与账本既有提交意图、taskId 或终态证据不一致，拒绝再次发送并保留旧证据。仅确实未发送的 prepared/reserved 可恢复首次提交；不能用本地状态回退冲掉共享表中的可能在途名额。

视频批次只查询当前故事的原 taskId，**不自动查询其他故事**。其他故事由自己的 `resume`、`batch resume` 或 `batch register` 更新共享占位。其他故事查询超时、401/402/403、query_unknown 不进入当前批次的 halt，也不占当前批次轮询预算。本故事错误仍按原规则处理。

归档完成故事前先确认终态并执行 `batch register --root <story>`。此后别的故事只看终态快照，不再需要旧目录；旧 `retiredAt` 仍兼容。活动或未知故事移走后仍保留可能名额，不能靠移动目录释放；恢复原目录后用原 ID 继续。同项目复制到另一个根不自动成为合法迁移。

本项目的未确认未知仍阻断本项目新派发，原一次性明确重试、祖先链和授权范围不变。`acceptedExistingUnknown` / `acceptedUnknown` 继续读取和验哈希，旧 `--accept-existing-unknown` 参数继续校验所提供身份；跨项目条目仅保留审计意义，正常运行不再需要它。无需另建故事或 runtime，原 prepared/waiting_dependency 项通过原计划 resume 复用 operationId、attempt 和授权。未知请求不自动重发，下载失败只恢复原结果。

## 视频容量与等待

本机同一 runtime 所有故事合计最多 **4 个**生成名额。当前故事的 concurrency=1–4 是附加上限：A 占2个、B concurrency=1 时 B 可占另1个。收到 taskId 不释放名额；只有已持久化的终态才释放。没有实际预留的 prepared 队列不占名额；已有 reserved 在中断后保留。各批次最多2个下载，下载不占生成容量。

其他故事有1个未知，当前故事可用剩余3个；有4个可能占位时等待。等待不会取消远端任务、伪造终态或新增重试授权。容量检查和预留在共享短事务内原子完成，争抢最后一个名额只有一方成功。

```text
node E:\metasocli\dist\cli\main.js batch run --root <story> --batch <id> --confirm --capacity-wait-ms 30000 --capacity-poll-ms 250
node E:\metasocli\dist\cli\main.js batch resume --root <story> --batch <id> --capacity-wait-ms 30000 --capacity-poll-ms 250
node E:\metasocli\dist\cli\main.js batch status --root <story> --batch <id>
```

新增参数也适用于 `batch retry`。容量等待默认总预算30000ms、检查间隔250ms；范围分别0–300000ms和10–60000ms，0预算立即保存可恢复暂停。等待从首次容量不足计时；耗尽后保存 pending/paused 与 `waiting-shared-capacity` / `capacity-wait-budget-ended` 轨迹，`batch resume` 沿用原授权继续。既有任务查询/下载有各自预算，不被此容量预算取消。

`batch status` 的 summary 是当前批次，capacity 是共享快照：`sharedLimit/sharedOccupied/currentProjectOccupied/otherProjectsOccupied/available`，`liveCheckPerformed:false`；状态命令不新建任务、不同步其他目录。`batch register` 仅同步指定故事。普通 `generate` 占满时仍返回 `CAPACITY_FULL`。`--scheduler-wait-ms`（默认30000，范围0–300000）只等待同故事批次运行权；同故事新建返回 `SCHEDULER_BUSY`，已有任务仍可按 ID 恢复。

不实现全局公平队列，不承诺各故事轮流获得名额。另一故事退出后远端可能继续；须由它自己的恢复命令落盘终态，等待方才能看见空位。

## 图片 all-ready 与已知额度

保持 `gpt-image-2.5 / all-ready`，有效请求上限300秒。无已知额度配置时不加任意并发数字；所有 ready 项可进入 HTTP，实际依赖登记后解锁。缺图、依赖等待、暂停和未知仅影响所属故事。

冻结 profile 若含 `providerLimits`，同 quotaGroup 的 concurrent/RPM 按共享短事务的预留和请求时间核验。可选 limits/requestStartedAt 保存在受哈希保护的协调表；旧字段缺失仍可读。活动或最近一分钟快照中的较严格已知限制继续适用，未知不释放配置所约束的容量；无时间的旧可能在途项保守计入 RPM，不能靠猜测超时释放。batch 限制用于冻结待提交范围，不当作全局并发上限。

`images run/resume/retry` 支持同样的 `--capacity-wait-ms`、`--capacity-poll-ms` 及默认/范围。额度不足保存 `run.waiting={code:IMAGE_CAPACITY_WAIT,reason:concurrent|rpm,since}`；Job 保持 prepared/waiting_dependency，不计为已发、失败或未知。原计划 `images resume` 继续等待并复用身份，不新建计划。

`images status` 的 summary 仅含本项目；`waitingDependency` 是依赖未就绪，`unknown` 是本项目未知，`run.waiting` 是已知共享额度不足。同故事运行权冲突为 `LOCK_BUSY`；共享表缺失/篡改为 `IMAGE_LEDGER_MISSING/IMAGE_LEDGER_TAMPERED`，不能都描述成“其他项目卡住”。恢复已有响应不发新 POST。

## 升级必须冷切换

先停止旧版本运行（不强杀真实生成进程），再统一启用新构建与本包 Skill。新入口检测旧安装级 `batch.lock`、图片 `scheduler.lock`：活跃或无法证明死亡的 owner 不放行；完整、同主机且 PID 已不存在的残留按原 lease 协议回收。不可读 owner 或中断的 recovery 锁保留并报错。新进程之间不持旧全局运行锁。

仅启动时检测旧锁不能消除旧二进制之后启动的竞态；**不支持任意新旧版本热混跑**。旧 Plan/Story/Job/Run 不批量重写；新增等待字段可选且不注入旧冻结计划，不改变原计划/授权哈希。正文、图序、小数向上取整、旁白归属和 H3 的 `context_ir_enabled:true` 保持不变。

本次离线验证不能证明供应商实际并发容量、账户额度、网络稳定性或生成效果；真实接口验收仍须另有授权。
