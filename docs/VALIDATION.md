# Validation — 0.1.0

验证日期：2026-09-18。

| 检查 | 结果 |
| --- | --- |
| Node 24 + TypeScript 5.8.3，`npm ci && npm test` | 25 项主机测试通过 |
| SDK release HAR | DevEco / Hvigor 构建通过 |
| Demo 源码依赖构建 | ArkTS 检查和 unsigned HAP 构建通过 |
| 独立 HAR 消费工程 | 移除 SDK 源码目录，改用生成的 HAR，Demo 完整构建通过 |
| OHPM `prepublish` | 包结构预检通过；未上传中心仓 |
| 真机 / 模拟器完整交互 | 尚未验收；需配置自己的签名后执行 docs/DEMO.md |

主机测试使用真实 ZIP 元数据解析、文件操作、哈希、取消和状态逻辑，模拟 Harmony ZIP、RCP、TaskPool 和 UI 装饰器的系统边界。测试通过不等同于官方 ZIP 解压或 ArkWeb 在真机上已运行。

构建环境为 DevEco Studio 26.0.0.821、HarmonyOS SDK 26，最低兼容 API 12。编译保留系统 API 异常提示及 SDK 系统能力提醒；Hvigor 对 0.x 模块版本有版本规则警告，OHPM prepublish 接受 0.1.0。HAR 为开源源码包，prepublish 的源码提示符合预期。Demo 未提供 signingConfig，生成 unsigned HAP，不能直接安装到真机。

发布验收记录不包含商业宿主项目的签名、私有资源、业务域名或设备凭据。
