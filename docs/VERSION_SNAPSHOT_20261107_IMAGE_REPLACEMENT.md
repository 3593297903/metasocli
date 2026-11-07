# 2026-11-07 同 ID 一次换图快照

| 项目 | 记录 |
| --- | --- |
| 包及 CLI 版本 | `0.1.0` |
| 恢复标签 | `metasocli-0.1.0-snapshot-20261107-image-replace` |
| 分支 | `codex/bootstrap-metasocli` |
| 上一快照提交 | `03567a833d0d6065634d38b300bb7670ed116661` |

此快照单独保存已核验的换图改动。三个 Skill（metasoclitk、metasocli-video-prompts、metasocli-video-prompts-旁白）在目标明确时沿用原资产 ID，一次本地调用完成图片哈希核验、一次正式登记和回执校验。选图已登记在另一个 ID 下时也可采用；所有原 ID 引用使用新版图片。

保留提示词、配方、分段引用、图序、旁白和图库；不自动导出预览或 ZIP，不发起图片或视频生成。另行明确要求修改部分镜头、配方或视频生成时仍走相应流程。没有增加业务命令或更改公共锁与视频调度。

离线验收：2026-11-06 独立复测三个 Skill 引用的实际 PowerShell 模板，每次仅一次 assets register、零网络尝试；资产登记测试 3/3、图片 Skill 22/22 通过。已查验实施者全量记录 503/503。2026-11-07 后续版本核验再次保留并通过原换图回归。当前发布仅记录和上传代码，不操作真实故事或付费生成。

本快照从提示词替换实施前保存的六文件基线分离，业务源码保持上一快照；后续提示词替换功能单独记录，不混入本回退点。README 的版本指向与本记录是发布时补充的元数据。

```powershell
git fetch origin tag metasocli-0.1.0-snapshot-20261107-image-replace
git rev-parse 'metasocli-0.1.0-snapshot-20261107-image-replace^{commit}'
```

需要恢复时先保存本地修改并确认工作树干净，再检出标签、按锁文件安装依赖并构建。恢复程序源码不会回滚故事数据、素材、密钥或已提交的远端任务。

```powershell
git switch --detach metasocli-0.1.0-snapshot-20261107-image-replace
npm ci --ignore-scripts
npm run build
```
