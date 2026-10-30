# metasoclitk 安装与升级

`metasoclitk` 与 CLI、图片交接校验器和完整模板一同保存在本仓库，无需 jianc 或 LibTV 安装。包版本仍为 `0.1.0`，必须用上传回执中的 Git 提交 SHA 判断版本；旧 `e781ccb` 和 `127f901` 都不包含本技能。不要仅以 `--version` 相同认定升级成功。

本次技能交付是在 `127f9017d2738e6e4bf741f6ce2fb96d2775f85a` 上增加新技能、六技能打包检查和本部署文档，并带入多参考图 multipart 字段由 `images` 修正为重复 `image[]` 的兼容修复及对应测试。其他未提交的本地图片/视频恢复改动不属于本次发布；新设备只获得所检出提交中的功能，不能把源设备工作区的所有行为都归入这个提交。

## 新设备

1. 验证实际可运行的 Git、Node.js 24+、npm 和 Python 3.10+；Python 校验只用标准库。复用可用环境，缺少的再从官方来源或可信包管理器安装。
2. 选择独立、真实可写的安装目录，如 `C:\metasocli`、`D:\metasocli` 或 `E:\metasocli`。下文 `INSTALL_ROOT` 表示其实际路径；不要覆盖其他项目或使用目录联接。在选定目录的父目录运行：

```powershell
git clone --branch codex/bootstrap-metasocli https://github.com/3593297903/metasocli.git metasocli
Set-Location -LiteralPath .\metasocli
git rev-parse HEAD
```

分支可能继续更新。需要本次准确版本时，在新克隆中检出上传回执给出的完整提交 SHA，然后再次核对；不要继续固定旧安装说明中的旧 SHA。

3. 在安装根运行；任一命令失败时处理实际错误后再继续：

```powershell
npm ci --ignore-scripts
npm run build
npm test
npm run test:image-skill
npm run test:process
npm run test:image-api:process
node .\dist\cli\main.js --version
node .\dist\cli\main.js --help
```

Windows 可另运行 `scripts/package-smoke.ps1` 验证临时前缀安装、重装和卸载。该脚本会再次构建并执行全量 npm test；可用它替代上面的重复全量 npm test。脚本默认最多2个离线测试工作线程，可用 `-TestWorkers 1` 进一步降低测试资源占用；这不改变图片 API 的 all-ready 或视频四并发。测试临时目录应设在本安装 `.work` 下独立真实目录，避免目录联接、共享生产运行目录和测试间竞争。安装测试使用假客户端，不需要生成授权。

## 已有设备升级

在原安装根先核对仓库地址、分支、提交及未提交改动。暂停该安装正在运行的生成进程，保留真实故事、图片、任务回执、`.local` 凭据和原运行账本。

```powershell
git remote get-url origin
git branch --show-current
git status --short
git rev-parse HEAD
```

仅在来源为本仓库、当前分支为 `codex/bootstrap-metasocli` 且工作区干净时执行：

```powershell
git pull --ff-only origin codex/bootstrap-metasocli
npm ci --ignore-scripts
npm run build
npm test
npm run test:image-skill
git rev-parse HEAD
```

有本地修改、分叉或其他分支时，先记录和处理差异，不执行强制 reset、clean、覆盖或自动 stash。用户级入口指向原安装根时通常不必重装，只需确认新正文存在并刷新 Codex；指向另一份旧安装时须更新实际路径。升级不会自动迁移业务项目，也不会清除旧未知任务或解除图片/视频阶段阻塞。

## 让 Codex 找到技能

在实际安装根新建 Codex 任务，项目入口 `.agents/skills/metasoclitk/SKILL.md` 随 Git 下载，其相对链接会读取 `skills/metasoclitk/SKILL.md`。正文从自身路径确定 `INSTALL_ROOT`，继承文档中的 `E:\metasocli` 示例映射到本机目录。未观察到技能选择器前，不声称已被发现；必要时新建任务或重启 Codex。

需要在其他故事项目里调用时，另安装一个用户级入口，不能只把正文复制到用户目录导致相对链接失效。检查当前 Codex 实际发现的用户 Skill 目录（通常为用户 `.agents/skills`，旧安装也可能已有 `.codex/skills`）；同名入口只保留一个归属，不覆盖其他来源，不同时复制到多个目录。用户入口保留正文相同的 `name: metasoclitk` 和 description，并明确写入：

```text
完整读取 <INSTALL_ROOT>/skills/metasoclitk/SKILL.md。
程序入口为 <INSTALL_ROOT>/dist/cli/main.js，使用已验证的 Node.js 24+。
正文及继承文档中的 E:\metasocli 示例解析为 <INSTALL_ROOT>；
每份文档的相对链接以该文档所在目录为基准。
所有业务命令显式传用户选定的独立故事目录 --root。
```

这里的 `<INSTALL_ROOT>` 必须替换为真实绝对路径；保留正文和四份模板在源安装内，不复制原电脑的用户入口路径、密钥或私人素材。macOS/Linux 使用真实安装目录及本机可用解释器；本次 Windows 离线验收不等于已在这些系统完成验收。

## 凭据、网络与验收范围

Git 不携带 API Key、DPAPI 密文、旁白音频、业务图片、故事或运行账本。新 Windows 设备在安装根逐个运行：

```powershell
node .\scripts\connect-local.mjs
node .\scripts\connect-image-local.mjs
```

分别在它们打印的本机 URL 中保存本机 Metaso Key 和创艺坊 Key；每个连接流程结束后再启动下一个。有效的已有凭据先复用，不覆盖或复制另一台电脑的 DPAPI 文件。随后检查：

```powershell
node .\dist\cli\main.js auth status
node .\dist\cli\main.js images auth-status
```

这两个命令只证明本地配置可读取，不证明余额、远端认证或真实生成成功。非 Windows 使用安全方式向实际 CLI 进程提供 `METASO_API_KEY` 和 `METASOCLI_IMAGE_API_KEY`，本程序不自动加载任意 `.env`。

默认图片仍是创艺坊 `gpt-image-2.5 / all-ready`，视频仍为 `MiniMax-H3`、`context_ir_enabled:true`、本机最多4个生成名额持续补位。图片 API 域名为 `api.yiciyuang.com`；代理规则不随 Git 迁移，各设备需核对自身网络。源设备收到的 `503 / task_interrupted` 不会因安装此 Skill 自动修复，供应商成功率与额度须另外验收。两台设备的本地并发账本不会自动共享。

在 Codex 中使用：

```text
$metasoclitk
读取我的完整视频提示词，使用指定的独立故事目录。
先完成素材配方与计划，未获授权的生成先不提交。
```

需要统一旁白时再明确说明并提供/配置对应音频；本技能默认不附加统一旁白。安装成功、技能被发现、本地凭据可读、远端认证成功、付费生成成功是不同验收结果，分别按实际证据报告。
