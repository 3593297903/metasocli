# metasocli

独立的 Node.js / TypeScript CLI，将完整剧本或成品视频提示词整理为 Metaso `MiniMax-H3` 请求计划，并管理提交、查询、恢复及视频下载。当前版本 **0.1.0，已完成离线实现与测试，未做付费或真实生成验收**。

## 构建与本地运行

需要 Node.js 24+。在本项目执行：

```powershell
npm ci --ignore-scripts
npm run check
node .\dist\cli\main.js --help
```

依赖固定版本，缓存留在本项目 `.npm-cache`。程序不依赖 LibTV CLI、旧源码、旧 Skill 或旧登录状态。不创建全局安装、MCP 注册或用户运行目录。四份独立 Skill 位于 `skills/`，开发时在项目中阅读；本版没有用户级 Skill 安装器。npm 包的唯一 bin 为 `metasocli`。

## 两个离线入口

下面的演示只写本项目 `.work`；真实故事应使用独立目录。每条命令显式指定 `--root`，不会自动寻找附近项目。

```powershell
$cli = 'E:\metasocli\dist\cli\main.js'
$story = 'E:\metasocli\.work\demo-finished'
node $cli init --root $story --name '成品提示词演示'
node $cli import --root $story --file E:\metasocli\examples\finished.txt --kind video-prompts --episode ep-1 --duration 6
$plan = node $cli plan --root $story --episode ep-1 | ConvertFrom-Json
$plan
node $cli status --root $story
node $cli doctor --root $story
```

剧本草稿入口支持分段、保留原文的摄影说明和图片配方：

```powershell
$story = 'E:\metasocli\.work\demo-script'
node $cli init --root $story --name '剧本演示'
node $cli import --root $story --draft E:\metasocli\examples\script.draft.json
node $cli plan --root $story --episode ep-script
```

[草稿契约与多图示例](docs/INPUT_FORMAT.md)说明来源范围、完整台词校验、图片配方及引用。CLI 直接读取 UTF-8 TXT/Markdown；不自动创作分镜或解析 DOCX/PDF。四份 Skill 负责宿主中的内容编排与原生图片准备。

## 素材与 H3 计划

先在草稿中声明配方。`assets register --root <story> --id <asset-id> --file <image>` 将图片独立复制并登记哈希。原生生图文件加 `--provenance imagegen`；已有文件默认 user。`--url <https-url>` 会下载并核验图片，保存本地副本，提交前再次核对远端字节；不会自动上传到任何云存储。

支持 PNG/JPEG/WebP。`assets list --root <story>` 显示 missing/ready/changed。缺图或哈希变化必须登记恢复后重新计划；程序不静默降级为文字生成。

第一版请求支持文字、单首帧、多参考图。固定 MiniMax-H3，4–15 秒整数，768P/2K，最多 9 张参考图；首帧不能与参考图混合，实际比例为 adaptive。Context IR 与水印均显式写入计划，默认 false。计划同时记录请求字节数、原文和渲染哈希、配方与图片哈希、引用顺序。7000 字符或 64 MiB 请求上限超出时拒绝，不截断。[契约依据与真实验收范围](docs/METASO_CONTRACT.md)

## 授权后的生成与恢复

本次开发未执行下面的付费命令。以后只有在用户明确授权该计划的生成后运行；`METASO_API_KEY` 必须是 Metaso 的 Key，不与 MiniMax 官方 Key 混用。

```powershell
# 先通过当前进程环境配置 METASO_API_KEY，不把密钥写进文件或命令参数。
node $cli generate --root $story --plan <plan-id> --confirm
```

默认串行处理计划各段，提交后有界查询并下载；`--segment <id>` 限定单段，`--submit-only` 只提交。`--max-polls` 默认 60（上限 720），`--poll-ms` 默认 5000。达到轮询限额保留原任务，不判定远端失败。CLI 退出后远端任务可能继续；本地没有常驻服务。

```text
status      --root <story>                           本地只读，不需要 Key
status      --root <story> --operation <id> --remote  只查询一次远端，不下载、不生成
resume      --root <story> --operation <id>          查询原任务并保存结果
download    --root <story> --operation <id>          查询并恢复原任务下载
download    --root <story> --operation <id> --redownload-missing
```

提交前先落盘 prepared/submitting 请求记录，取得 taskId 后先保存独立回执。同一请求重复执行复用已有操作，创建请求不自动重试；本地哈希不代表服务端幂等。

- `submit_unknown`：可能已被接受，禁止重发。通过供应商核实原 taskId 与操作的关系后，执行 `attach-task --root <story> --operation <id> --task <task-id> --confirm-task-link`，再 resume。CLI 无法替供应商证明任务归属。
- `query_unknown`：保留已脱敏响应证据和原 taskId，随后再查。未知状态、缺失结果地址或错误响应不会当作 queued/success。
- `generated` 加下载错误：只恢复下载。MP4 经流式大小限制、容器/时长/尺寸及 SHA-256 检查后原子保存；落盘回执允许恢复“已重命名但最终状态未写入”。校验不等于完整解码或视觉质量保证。
- `failed/cancelled`：默认不再次提交。主动重生成必须指定单段和 `--retry-of <latest-operation-id>`，形成独立尝试；未知任务不允许这样重试。
- 进程锁只在同一主机、原 PID 已不存在且记录完整时恢复。活进程或不明锁不按等待时长强删。损坏锁/中断的 recovery.lock 保留供人工检查。

JSON 是默认输出，`--json` 可选。退出码：0 已完成本次动作；1 参数、契约或本地错误；2 任务失败、未知、轮询限额或下载未完成。日志不输出密钥、认证头或完整签名链接。故事清单中的输入 URL 是本地私有数据，勿提交真实故事目录。

## 验证及边界

`npm run check` 执行构建和假客户端/临时文件测试，测试默认封锁真实 fetch。详见 [交付验证记录](docs/VERIFICATION.md)。真实文字、首帧、多图生成与 URL/Data URL 接受情况仍需凭据、明确授权和预算另行验收。

进程中断验证：先构建，再执行 `npm run test:process`。Windows 临时安装隔离验证：`./scripts/package-smoke.ps1`，需要已填充的本项目 npm 缓存。两项均使用假客户端或本地包，不调用视频生成。

尾帧、参考视频/音频、完整旧项目转换、DOCX/PDF 解析、用户级 Skill 安装器、MCP 和常驻后台服务未开放。新项目只单向复制明确提供的原文或图片；不接管旧目录、旧命令或账户。

设计与来源：[AGENTS.md](AGENTS.md)、[ARCHITECTURE.md](docs/ARCHITECTURE.md)、[源码复制记录](docs/SOURCE_MANIFEST.json)、[移植说明](docs/MIGRATION_NOTES.md)。
