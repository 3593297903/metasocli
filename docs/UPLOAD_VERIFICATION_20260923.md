# 2026-09-23 上传前核验

本次按用户要求上传当前 metasocli 源码，目标仓库为 `3593297903/metasocli`，分支为 `codex/bootstrap-metasocli`。上传前 GitHub 分支为 `eea3028ef8b8251d37cd1d6531aa9ff46fdd6ef2`，本地最新四并发实现及修复尚未提交。

## 当前使用入口

两个用户级成品提示词 Skill 均转入 `E:/metasocli/skills/` 正文，程序入口为 `node E:\metasocli\dist\cli\main.js`。本次从当前源码重新构建，CLI 帮助确认包含 batch plan/run/status/resume/register。

包版本仍为 0.1.0；本次用 Git 提交记录区分源码更新，不发布 npm 包、不覆盖旧全局安装、不创建额外版本标签。

## 本次实际检查

| 检查 | 结果 |
| --- | --- |
| npm run build | 通过 |
| npm test | 22 个文件、178 项全部通过，无跳过；112.00 秒 |
| npm run test:process | 通过：视频 2 个、独立 IR 6 个、批次 10 个中断边界及跨项目四进程竞争 |
| npm run test:image-skill | 11 项全部通过；3.553 秒 |
| CLI --help | 正常输出当前批次命令和 inline Context IR 说明 |
| 与 2026-09-21 独立复核基线比较 | 89 份源码、测试、脚本和 Skill 哈希一致 |
| 上传文件范围 | 源码、模板、示例、离线测试和项目文档；排除 .local、.work、dist、业务故事、生成素材和凭据 |

首次沙箱内单元测试为 177 项通过、1 项 Windows DPAPI 凭据用例失败；没有将其计为通过。随后在允许系统子进程的环境中重跑完整套件，得到表中 178 项通过的结果。凭据用例只使用临时假密钥，进程用例使用假客户端和合成媒体，没有调用真实图片或视频生成接口。

本地完整日志保存在 `.work/upload-20260923/`，未纳入上传。上传范围扫描命中的两个疑似密钥/签名链接均为原有测试中的合成数据：Windows 临时加密测试密钥，以及 example.com 假视频响应中的签名参数。

## 功能边界

- 已实现：视频四个生成占位持续补位、两个独立下载、安装级共享协调、恢复及去重保护。
- 已修复：Windows 路径大小写造成的回执保存异常，以及具有完整终态记录的项目归档后阻塞其他项目。
- 本次新增文档：[Image 2 / 2.5 接入分析](IMAGE_API_INTEGRATION_ANALYSIS.md)。外部图片 API、图片任务队列及真实接口验收尚未实现。
- 本次上传验证不新增任何真实付费测试，不把离线检查通过表述为供应商效果或稳定性保证。

历史实施与核验细节见 [实施报告](VIDEO_BATCH_CONCURRENCY_IMPLEMENTATION_REPORT.md) 和 [独立复核](VIDEO_BATCH_CONCURRENCY_RECHECK.md)。
