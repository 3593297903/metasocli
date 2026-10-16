# 新设备部署此重试修复

2026-10-16：本说明随未知视频显式重试修复源码一同交付，包版本仍为 0.1.0。旧 `e781ccb1a4b0fefb63cf76b2eea1480ee4cbe59d` 只标识修复前基线，不能用它验收此功能，也不能仅以 `--version` 输出 0.1.0 判定升级成功。

新设备从 `https://github.com/3593297903/metasocli.git` 的 `codex/bootstrap-metasocli` 分支获取代码。使用本次上传回执中经远端核实的完整提交 SHA 作为固定版本；部署时用 `git rev-parse HEAD` 核对。该提交须包含 `src/contracts/video-retry.ts`、`src/jobs/video-retry.ts`、新 CLI、测试和三个 Skill 正文。将原新设备安装任务中的唯一验收提交改为该 SHA；不要仅跟随分支最新状态，不要填写猜测的 SHA，也不要检出旧 SHA 后另外补脚本冒充同一固定版本。

已有安装先核对来源、分支、本地修改及实际提交，不强制重置或覆盖。保留原安装、生产 runtime、故事、回执及凭据，不复制源设备凭据，也不创建空生产账本来绕开旧未知名额。Git 只交付源码、Skill、测试与文档；每台设备仍需重新安装锁文件依赖、构建和离线验收。源设备的密钥、生成素材、生产账本和旁白音频不随代码上传。

部署后核验 `--help` 包含 `batch retry` 与 `--accept-unknown-result`；运行构建、`tests/video-unknown-retry.test.ts`、`npm run test:process` 及原安装验收。安装路径中的三个 Skill 正文须含正式重试规则；已有用户入口若引用旧安装，按其原归属更新到已验证安装，不覆盖其他来源 Skill。

完整环境安装流程仍参考原新设备说明，但其中固定检出旧 SHA 和“未知视频不可显式 retry”的旧限制不适用于修复版本。临时生成脚本（包括 pollMs 拼写问题）不属于正式入口；升级后使用 CLI 调度，不迁入临时直发脚本。
