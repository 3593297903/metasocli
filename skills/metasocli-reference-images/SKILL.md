---
name: metasocli-reference-images
description: 通过宿主原生生图或导入已有图片准备 metasocli 的人物、场景、道具、首帧素材并按哈希登记。
---

# 参考图片准备

使用当前任务宿主的原生生图能力或用户指定的现有文件。视频 H3 接口不负责生图，本技能不调用旧项目的补图工具。

从当前 `metasocli.yaml` 和 `assets list --root <story>` 获取素材 ID、完整配方、精确文字及依赖顺序。配方依赖按顺序准备，只复用身份、配方及文件哈希一致的图片。先准备缺失项；changed 需查明文件变化并按用户当前意图重新登记，不能假装 ready。

将完整配方和真实依赖图交给宿主。首次返回图片保存并展示。无需额外视觉评分、OCR 门槛或自动重画；用户主动要求修订时才修改相应素材。原生调用失败时先恢复文件；仍无文件则报告该资产缺失并停止依赖段，可继续其他独立准备。

本版支持 PNG/JPEG/WebP，单图不超过 30 MiB、宽高 256–5760、宽高比 0.4–2.5。CLI 检查格式头与尺寸，不进行视觉内容评判。

登记已有图片：

```text
node <package-root>/dist/cli/main.js assets register --root <story> --id <asset-id> --file <saved-image> --provenance user
```

宿主原生生成图片使用 `--provenance imagegen`，保留已有配方，不伪造生成模型或来源。登记会将字节复制到当前故事的独立 assets 目录。

需要大素材 URL 传输时使用 `--url <public-https-url>`，程序先下载核验并保存副本，提交前再次校验 URL 字节。程序不会自动上传到云存储。链接可能过期或被供应商拒绝，真实兼容性需单独验收；日志不显示完整链接。
