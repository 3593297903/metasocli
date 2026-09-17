# 0.2.22 来源审查与独立实现

来源固定为 `E:\libcli\.story2libtv-work\video-prompt-entry-0.2.22-20260916\source`，package.json 已核对为 0.2.22。旧根 0.2.5 和候选 0.2.23 未迁入。

实际复制仅两份通用文件，见 [来源及复制时 SHA-256](SOURCE_MANIFEST.json)：

- `src/core/canonical.ts` → `src/storage/canonical.ts`，保留独立的规范 JSON 与 SHA-256 实现。
- `src/core/file-identity.ts` → `src/storage/file-identity.ts`，保留 bigint 文件身份规则，改接本项目错误类。

哈希记录的是首次复制后的字节；Git 按仓库 .gitattributes 规范文本行尾。后续项目代码各自维护，不建立运行时旧路径依赖。

已阅读旧 prompt、hash、contracts、io、file-identity 与相关测试，审查 project/state/references 的依赖；阅读安装 Skill 归属、runtime 及两个入口技能。prompt 中的规范换行、全文与有序引用行为在新模块重写并增加回归测试；旧 LibTV transport trim、Node 标记、480p 默认、绑定与画布契约没有沿用。旧 prompt-contract 测试提供了 BOM、空白、台词和映射回归场景，新测试使用独立契约与夹具。

旧 project/state/contracts/service 耦合平台状态，未整体复制。存储、进程锁、单文件 manifest 提交、H3 请求计划、HTTP 客户端和任务日志重新实现。仅保留同版本必要依赖 yaml/zod/typescript/vitest/@types-node；未安装旧 MCP 依赖，未复制 node_modules 或旧锁文件的大量无关依赖。

没有迁入旧安装器、运行目录、业务数据、凭据、任务记录、图片补图 helper、发布包和 Git 元数据。四份新 Skill 使用 metasocli 名称，并且只引用本包文档和同包兄弟技能。生成请求计划完全离线；素材 URL 登记/校验只执行明确 URL 的读取。
