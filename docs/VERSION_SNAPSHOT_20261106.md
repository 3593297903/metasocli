# 2026-11-06 视频恢复修复快照

| 项目 | 记录 |
| --- | --- |
| 包及 CLI 版本 | `0.1.0` |
| 恢复标签 | `metasocli-0.1.0-snapshot-20261106-123755` |
| 分支 | `codex/bootstrap-metasocli` |
| 上一快照 | `metasocli-0.1.0-snapshot-20261105-094932` |
| 上一快照提交 | `8c57cce09c46922e0d3914960659529a587c2222` |

## 这个版本修复了什么

- 一段视频下载中途断流时，保留该段已生成状态和原任务 ID。同批其他段可以完成下载，失败段后续按原任务补下载。
- 已授权重试的取消任务在写入重试编号后中断时，新进程沿用预留编号，只执行一次新提交。
- 当其他集的旧计划文件缺失时，只要原任务与重试分别有可核验的冻结批次记录，就能继续离线准备当前集。
- 单段重试后的普通继续沿用原授权范围。显式授权同一冻结批次全部生成后，先保存整批授权，再补待处理段，已交付段直接复用。

该快照同时包含这些修复所依赖的 `video execute` 批次执行、已选图片资产替换和 Windows 公共锁处理。参见[视频执行说明](VIDEO_EXECUTE.md)和[单张资产替换说明](../skills/metasocli-reference-images/references/selected-local-image.md)。

## 离线验收

Windows 上重新构建并独立复测了四组原始故障，31 项专项测试全部通过。另用两个独立进程复验中断恢复，并用旧版本产生的连续重试记录复验整批授权。全量回归的 48 个测试文件共 499 项通过，已含这 31 项。Windows 公共锁三轮压力测试均为 0 失败。上述验收使用隔离数据和假服务，真实图片与视频生成调用均为 0。

## 按标签找到并恢复本版

在项目仓库中执行以下两条命令，可以取得标签并显示本版完整提交号。带注释的标签也记录了版本和提交号。

```powershell
git fetch origin tag metasocli-0.1.0-snapshot-20261106-123755
git rev-parse 'metasocli-0.1.0-snapshot-20261106-123755^{commit}'
```

需要实际恢复源码时，先确认 `git status --short` 为空，再执行以下命令。在已安装项目所需 Node.js 的设备上，按锁文件安装依赖并重新构建。

```powershell
git switch --detach metasocli-0.1.0-snapshot-20261106-123755
npm ci --ignore-scripts
npm run build
node dist/cli/main.js --version
```
