# 2026-11-07 一次换提示词快照

| 项目 | 记录 |
| --- | --- |
| 包及 CLI 版本 | `0.1.0` |
| 恢复标签 | `metasocli-0.1.0-snapshot-20261107-prompt-replace` |
| 分支 | `codex/bootstrap-metasocli` |
| 上一版换图标签 | `metasocli-0.1.0-snapshot-20261107-image-replace` |
| 上一版换图完整提交 | `899e443d8ff8e73f6d0b4c731b7d674213ebbff5` |

本版保留上一版全部同 ID 换图行为，新增 `prompts replace`。三个 Skill（metasoclitk、metasocli-video-prompts、metasocli-video-prompts-旁白）在目标集段和完整新稿明确时，一次调用完成替换及回执校验。沿用原集 ID、段 ID，保留资产、引用顺序、时长、参数和其他段正文。共用[使用说明](PROMPT_REPLACEMENT.md)，上一版见[换图版本记录](VERSION_SNAPSHOT_20261107_IMAGE_REPLACEMENT.md)。

只改目标正文及必要的源文位置、旁白范围。保留输入稳定读取、哈希、源文覆盖、Unicode 长度、旁白归属、并发冲突、幂等和原子恢复校验。纯换稿不加载凭据、不读媒体、不访问共享账本或网络，不自动执行导入、计划、生成或图库导出。旧未提交计划需要按最新 Story 冻结；已受理旧任务仍使用原任务号恢复。

## 离线验证

2026-11-07 独立重建并复测：提示词、实际 CLI 和原换图回归 55/55；图片 Skill 22/22；提示词中断/并发进程检查 13 组；原视频执行进程检查 9 组，均通过。首次沙箱实际子进程发生 spawn EPERM，按正常审批流程获准重跑后通过，未修改业务代码或跳过失败用例。另核对实施者全量原始记录 50 个文件、555/555 通过，以及正式视频与图片 API 恢复进程测试退出 0；不把查验已有日志混同于独立复跑。

实测合成 6 集/11 段/5 资产，一次 PowerShell 调用含 CLI 与回执校验 1.562 秒；27 集/152 段/526 资产为 2.967 秒。对应纯 CLI 启动至返回为 0.922/2.354 秒。这些不是固定速度承诺，不包含 Codex 写稿、响应或远端生成等待。

本地独立证据位于 `.work/prompt-replacement-review-20261107-125704/`，业务数据与测试产物不入 Git。本次发布没有真实供应商请求或付费生成。公共锁、API 传输、图片并发、视频四名额调度与依赖版本保持原值。

## 定位与恢复

本页不写入会自我改变的本提交号；带注释标签永久指向本版完整提交，同时记录提交号。上一版换图已在上表固定为完整 SHA。

```powershell
git fetch origin tag metasocli-0.1.0-snapshot-20261107-prompt-replace
git rev-parse 'metasocli-0.1.0-snapshot-20261107-prompt-replace^{commit}'
```

需要恢复时，先保存本地修改并确认工作树干净，再检出所需标签，按锁文件安装依赖并构建。

```powershell
git switch --detach metasocli-0.1.0-snapshot-20261107-prompt-replace
npm ci --ignore-scripts
npm run build
```

恢复程序源码不会回滚故事数据、素材、凭据或远端已受理任务。只要已使用本版更换正文，正式 Story 中的新正文仍保留，不能拿旧导出文件重新导入来冒充程序回退。
