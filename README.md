# metasocli

独立的 Metaso H3 剧本视频项目，计划复用 story-to-libtv 已验证的内容与素材处理能力，通过 Metaso 原生 API 完成视频任务提交、查询、恢复和下载。

## 当前状态

这是项目初始化与开发交接，业务代码尚未迁入，CLI 尚未实现，也没有进行付费生成。

- 本地项目：`E:\metasocli`
- GitHub：<https://github.com/3593297903/metasocli>
- 拟定 npm 包名及命令：`metasocli`
- 拟定首版：`0.1.0`
- 接入方式：Metaso H3 原生 API
- 旧项目 `E:\libcli` 仅作为只读来源

先阅读 [开发约束](AGENTS.md)、[启动说明](START_HERE.md)、[架构方案](docs/ARCHITECTURE.md) 和 [来源基线](docs/SOURCE_BASELINE.md)。

## 第一阶段交付

建立完全独立的 CLI、故事清单和状态目录；保留剧本与成品提示词两个入口；以离线测试完成素材登记、H3 请求计划、任务恢复和下载流程。真实生成在具备相应授权与凭据后验收。

新项目的安装、升级、卸载和运行必须与旧 LibTV 项目隔离。密钥、私人剧本、真实素材、运行日志和任务结果不进入仓库。
