# Changelog

## 0.2.0

- OHPM 包名与 ArkTS import 统一为 `com.offline.tool`。
- Demo 标识改为 `com.offline.tool.sample`。
- 安装、校验、解压和缓存目录行为不变。
- 从旧包迁移时替换依赖名称和 import。

## 0.1.4

- 对齐 Android 缓存布局：`<version>/`、`<version>.zip.tmp`、`<version>_temp/`。
- 包内 `dist/` 内容直接发布到版本目录；取消及失败后清理固定临时路径。
- 冷启动清理兼容旧版 version-hash 和 `.install-` 遗留目录，保留宿主指定的当前版本。
- 本地 ZIP 输入须在 SDK root 之外，拒绝工作目录内输入以避免清理影响源文件。
- Demo 使用与 Android 示例相同的 `filesDir/offline/packages` 根目录。

## 0.1.3

- SDK 发布包名、依赖名称和 ArkTS import 统一改为 `harmony-offline-sdk`。
- 原 `com.offline.demo@0.1.2` 用户需移除旧依赖、添加新依赖，并替换 import；API 与运行逻辑不变。
- Demo 应用 bundleName 保持 `com.offline.demo.sample`，与 SDK 名称独立。
- 同步 Demo、主机测试、HAR 附件名称及 GitHub / OHPM 接入说明。

## 0.1.2

- 补充 GitHub 作者网址，修复 OHPM 发布缺少作者联系方式的校验错误。
- 补充 OHPM 中心仓安装说明；SDK API 和运行逻辑保持一致。

## 0.1.1

- SDK 包名和 ArkTS import 改为 `com.offline.demo`，与 Android SDK 公开包名一致。
- Demo bundleName 改为 `com.offline.demo.sample`，与 Android 示例应用一致。
- 补充个人账号 debug 自动签名及未签名 HAP 安装报错说明。

## 0.1.0

- 提供独立 ArkTS HAR：官方 ZIP API、SHA-256、ZIP 元数据与 CRC 校验。
- 支持 HTTPS ZIP 下载和本地 ZIP 安装、取消及固定版本 ArkWeb 映射。
- 新增内置离线网页、Splash 阶段文本和进度、真实校验失败/重试 Demo。
- GitHub 源码与 HAR 分发；OHPM 中心仓发布待配置。
