# 2026-11-07 一次视频流程与复用标记快照

| 项目 | 记录 |
| --- | --- |
| 包及 CLI 版本 | `0.1.0` |
| 恢复标签 | `metasocli-0.1.0-snapshot-20261107-video-run` |
| 分支 | `codex/bootstrap-metasocli` |
| 上一版换提示词标签 | `metasocli-0.1.0-snapshot-20261107-prompt-replace` |
| 上一版完整提交 | `d12ef288756d60cc1146f823f0ba7896c0ce7b48` |
| 原换图完整提交 | `899e443d8ff8e73f6d0b4c731b7d674213ebbff5` |

本版完整保存已核验的 `video run` 固定入口及 reused 标记修复。三个 Skill（metasoclitk、metasocli-video-prompts、metasocli-video-prompts-旁白）在素材、完整提示词和选段已明确、生成已获授权时，一次启动完成本地准备、冻结范围校验、生成、查询、下载和交付。内部复用原 video execute，不新增独立任务或授权状态机。用法见[视频执行说明](VIDEO_EXECUTE.md)。

保留同 ID 一次换图、原集段 ID 一次换提示词、共享四生成名额持续补位、两下载并发、原任务恢复、未知结果不自动重发和必要校验。单独换图或换提示词仍在替换完成后返回；不自动生成视频。

## 本次修正

已完成批次再次使用 `video run --batch <batchId> --confirm`，现在准确返回 `reused:true`。此前复用已经生效，只是错误显示 false。

执行器利用已有首次本地检查，将“成片是否全部齐全且校验通过”作为本次内存观察值传给外层；只有首次齐全且最终成功交付 complete 才标 true。首次生成、查询恢复或补下载后完成为 false。没有额外查询、重复哈希或 API 请求，标记不参与提交、收费或重试判断，旧持久化回执格式不变。

## 离线验证

2026-11-07 独立构建通过，相关 71 个不同测试及 11 组进程恢复检查通过。初次沙箱运行的 5 项子进程测试遇到 spawn EPERM，经正常权限流程复跑后全部通过；没有跳过失败后宣称完成。另核对实施者 216/216 回归原始日志，未将其计为本轮独立全量重跑。

实际观测完整成片复用时，新增提交、查询、下载均为 0，原任务 ID、输出路径和文件 SHA-256 不变。三个 Skill 公共命令测试各一次调用；换图、换提示词后的视频请求使用更新后的内容。8 段并发测试保持按序补位，生成峰值 4、下载峰值 2。进程中断与双进程重入保留原任务和未知结果，未重复提交。

本机独立证据位于 `.work/reused-minimal-review-20261107-170847/`，不入 Git。测试使用隔离假故事、假客户端及网络保护，真实连接尝试为 0；没有真实付费生成。本快照不承诺供应商响应速度或真实生成成功率。

## 定位与恢复

本页用带注释标签固定本版，标签指向本版完整提交并记录版本和提交号，避免把本提交号写入本页造成自引用。包版本 0.1.0 不能单独区分各次快照。

```powershell
git fetch origin tag metasocli-0.1.0-snapshot-20261107-video-run
git rev-parse 'metasocli-0.1.0-snapshot-20261107-video-run^{commit}'
git show --no-patch metasocli-0.1.0-snapshot-20261107-video-run
```

需要恢复本版时，先保存本地修改并确认工作树干净，再执行：

```powershell
git switch --detach metasocli-0.1.0-snapshot-20261107-video-run
npm ci --ignore-scripts
npm run build
```

需要恢复上一版时使用上表的 prompt-replace 标签及同样的安装、构建步骤。恢复源码不会回滚故事正文、资产文件、凭据、运行账本或远端已受理任务。
