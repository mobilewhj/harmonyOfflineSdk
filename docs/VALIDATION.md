# Validation — 0.1.4

2026-09-18：缓存布局对齐 Android。31 项主机测试通过，包含固定临时路径、root/dist 入口发布、摘要失败重试、取消后清理、历史目录清理、同版本不覆盖及本地 ZIP 输入保护。SDK release HAR、源码 Demo 和无 SDK 源码的独立 HAR 消费工程均 clean/build 成功；OHPM prepublish 通过，publish 已提交审核。0.1.4 尚未重复真机交互验收。

HAR SHA-256：`ad04ea54bc0a74c95d32db41c89017e9e7545c855727b5b2bbe03cae6680c04a`。

## 0.1.3 验证记录

2026-09-18：SDK 更名为 `harmony-offline-sdk`，版本 `0.1.3`。

| 检查 | 结果 |
| --- | --- |
| SDK release HAR 与源码依赖 Demo | clean 后完整构建通过 |
| 主机测试 | 25 项通过，启动测试使用新 import 名称 |
| 独立 HAR 消费工程 | 移除 SDK 源码模块，仅通过 `file:../libs/harmony-offline-sdk-0.1.3.har` 依赖，Demo 完整构建通过 |
| 包元数据和附件 | 新名称、版本、作者网址正确；未包含签名或密钥文件；已生成 SHA256SUMS |
| OHPM prepublish / publish | 预检通过，提交成功，返回审核中 |
| 真机交互 | 本次未重新验收，个人签名仅保留本地 |

SDK 运行逻辑和 API 不变；调整包名、依赖和 import。审核通过前中心仓依赖尚不可用，可先使用 GitHub HAR。

## 0.1.2 验证记录

2026-09-18：0.1.2 补充作者 GitHub URL。清理后重新构建 SDK release HAR 和 Demo HAP 成功，25 项主机测试通过，OHPM prepublish 通过；已提交 OHPM，个人中心显示 `com.offline.demo@0.1.2` 审核中。

本次只调整发布元数据、版本号与文档；下列独立 HAR 消费及真机记录来自 0.1.1，0.1.2 未重复真机验收。

## 0.1.1 验证记录

验证日期：2026-09-18。

| 检查 | 结果 |
| --- | --- |
| Node 24 + TypeScript 5.8.3，`npm ci && npm test` | 25 项主机测试通过 |
| SDK release HAR | DevEco / Hvigor 构建通过 |
| Demo 源码依赖构建 | ArkTS 检查和 unsigned HAP 构建通过 |
| 独立 HAR 消费工程 | 移除 SDK 源码目录，改用生成的 HAR，Demo 完整构建通过 |
| OHPM `prepublish` | 包结构预检通过；未上传中心仓 |
| 真机 debug 签名安装与启动 | 个人团队 debug 签名；Mate 60 Pro / HarmonyOS 6.1.1，hdc 安装和 DevEco 启动成功 |
| 真机完整离线交互 | 尚未完成整套验收，继续按 docs/DEMO.md 检查离线页面、重放和失败重试 |

主机测试使用真实 ZIP 元数据解析、文件操作、哈希、取消和状态逻辑，模拟 Harmony ZIP、RCP、TaskPool 和 UI 装饰器的系统边界。测试通过不等同于官方 ZIP 解压或 ArkWeb 在真机上已运行。

构建环境为 DevEco Studio 26.0.0.821、HarmonyOS SDK 26，最低兼容 API 12。编译保留系统 API 异常提示及 SDK 系统能力提醒；Hvigor 对 0.x 模块版本有版本规则警告，OHPM prepublish 接受 0.1.1。HAR 为开源源码包，prepublish 的源码提示符合预期。公共工程不包含个人 signingConfig，发布附件中的 unsigned HAP 不能直接安装到真机；本机通过个人调试签名生成 signed HAP 并安装启动成功。

发布验收记录不包含商业宿主项目的签名、私有资源、业务域名或设备凭据。
