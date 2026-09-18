# Harmony Offline SDK

[English](README.en.md) · [Demo](docs/DEMO.md) · [接入说明](offlineSdk/README.md) · [发布](docs/RELEASING.md) · [验证记录](docs/VALIDATION.md)

纯 ArkTS 的 HarmonyOS 离线 ZIP SDK。官方 ZIP 解压 API、SHA-256 校验、TaskPool 后台安装、固定版本的 ArkWeb 资源映射，不依赖第三方解压库或 C++。

- `offlineSdk/`：可独立分发的 HAR，包名 `harmony-offline-sdk`。
- `entry/`：可运行的 Splash Demo，页面 → ViewModel → Repository → SDK。
- `sample-web/`：内置示例网页源码；Demo 首次运行也无需联网。

## 运行 Demo

1. 用 **DevEco Studio 26.0.0.821 或兼容版本**打开仓库根目录，等待 Sync 完成。本仓库使用 HarmonyOS SDK 26 编译，最低兼容 API 12。
2. 选择 `entry` 和 `default`。真机运行前在 **Project Structure → Signing Configs** 用自己的华为开发者账号自动签名；仓库不包含签名或设备配置。
3. 点击 Run。首次启动真实安装内置 ZIP，底部显示阶段文本和进度条。完成后点击“进入离线页面”。
4. 页面底部“重放启动”重新安装；“模拟失败”使用错误 SHA-256 触发真实校验失败。点击“重试”使用正确值完成安装。

Demo 保留完成页供检查文案与进度；产品可在 `ready` 后自行导航。检查 [Demo 文档](docs/DEMO.md) 了解缓存和在线接入方式。

## 使用发布的 HAR

从 [GitHub Releases](https://github.com/mobilewhj/harmonyOfflineSdk/releases) 下载 `harmony-offline-sdk-0.1.0.har`，放到宿主工程的 `libs/` 中。宿主模块的 `oh-package.json5`：

```json5
{
  "dependencies": {
    "harmony-offline-sdk": "file:../libs/harmony-offline-sdk-0.1.0.har"
  }
}
```

执行 `ohpm install --all` / DevEco Sync，然后导入：

```typescript
import { PackageInstaller, ResourceInterceptor, usablePackage } from 'harmony-offline-sdk';
```

目前通过 GitHub + HAR 分发，**尚未发布 OHPM 中心仓**，不能直接用中心仓包名安装。与 Android 的 JitPack 不同，这里分发的是 HarmonyOS HAR。

## 构建与测试

```sh
# macOS 默认使用 /Applications/DevEco-Studio.app/Contents
./scripts/build.sh
./scripts/package-release.sh

# Node.js >= 22.15，测试依赖独立于鸿蒙运行时
npm ci
npm test
```

其他安装路径设置 `DEVECO_HOME`。脚本构建 HAR 和未签名 Demo HAP；不会创建或使用发布身份。`dist/` 为本机输出，产物通过 Releases 分发。

测试覆盖 ZIP 边界、路径穿越、CRC、SHA-256、取消、重试、来源约束与启动状态；主机测试模拟系统 API 边界，不能替代真机验收。参见 [验证记录](docs/VALIDATION.md)。

## 范围

SDK 安装并映射静态资源，不会让业务接口自动离线。服务端配置解析、版本选择、保存激活记录、Cookie 与业务请求由宿主处理。每个 root 使用单一串行安装器；Web 页面绑定固定版本，仍有页面使用的目录禁止删除。

Apache-2.0 · [mobilewhj](https://github.com/mobilewhj)
