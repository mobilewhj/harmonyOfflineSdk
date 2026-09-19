# Harmony Offline SDK

[English](README.en.md) · [Demo](docs/DEMO.md) · [接入说明](offlineSdk/README.md) · [发布](docs/RELEASING.md) · [验证记录](docs/VALIDATION.md)

纯 ArkTS 的 HarmonyOS 离线 ZIP SDK。官方 ZIP 解压 API、SHA-256 校验、TaskPool 后台安装、固定版本的 ArkWeb 资源映射，不依赖第三方解压库或 C++。

- `offlineSdk/`：可独立分发的 HAR，包名 `com.offline.tool`。
- `entry/`：可运行的 Splash Demo，页面 → ViewModel → Repository → SDK。
- `sample-web/`：内置示例网页源码；Demo 首次运行也无需联网。

## 运行 Demo

1. 用 **DevEco Studio 26.0.0.821 或兼容版本**打开仓库根目录，等待 Sync 完成。本仓库使用 HarmonyOS SDK 26 编译，最低兼容 API 12。
2. 选择 `entry` 和 `default`。真机运行前在 **Project Structure → Signing Configs** 用自己的华为开发者账号自动签名；仓库不包含签名或设备配置。
3. 点击 Run。首次启动真实安装内置 ZIP，底部显示阶段文本和进度条。完成后点击“进入离线页面”。
4. 页面底部“重放启动”重新安装；“模拟失败”使用错误 SHA-256 触发真实校验失败。点击“重试”使用正确值完成安装。

Demo 保留完成页供检查文案与进度；产品可在 `ready` 后自行导航。检查 [Demo 文档](docs/DEMO.md) 了解缓存和在线接入方式。

## SDK 与 Demo 命名

| 用途 | 名称 |
| --- | --- |
| OHPM 包名 / ArkTS import | `com.offline.tool` |
| HAR 附件 | `com.offline.tool-0.2.0.har` |
| Demo 应用 bundleName | `com.offline.tool.sample` |

SDK 名称来自 `offlineSdk/oh-package.json5`；Demo 应用名来自 `AppScope/app.json5`，两者独立。SDK 不依赖 Demo。

## OHPM 远程依赖（推荐）

新包在 OHPM 中心仓审核上架后，在宿主模块（例如 `entry`）目录执行：

```sh
ohpm install com.offline.tool@0.2.0
```

也可以在宿主模块的 `oh-package.json5` 中添加依赖，然后执行 `ohpm install --all` / DevEco Sync：

```json5
{
  "dependencies": {
    "com.offline.tool": "0.2.0"
  }
}
```

OHPM 自动下载 HAR，无需复制 SDK 源码或引入 Demo。导入示例：

```typescript
import { PackageInstaller, ResourceInterceptor, usablePackage } from 'com.offline.tool';
```

- [OHPM 包页面](https://ohpm.openharmony.cn/#/cn/detail/com.offline.tool)（审核上架后可用）
- [SDK API 与资源拦截说明](offlineSdk/README.md)
- [Splash Demo 使用说明](docs/DEMO.md)

## GitHub HAR 接入

从 [GitHub v0.2.0](https://github.com/mobilewhj/harmonyOfflineSdk/releases/tag/v0.2.0) 下载 `com.offline.tool-0.2.0.har`，放到宿主工程的 `libs/` 中，将宿主模块依赖配置为：

```json5
{
  "dependencies": {
    "com.offline.tool": "file:../libs/com.offline.tool-0.2.0.har"
  }
}
```

执行 `ohpm install --all` / DevEco Sync。远程依赖与本地 HAR 二选一，代码 import 相同。OHPM 尚未上架时可先采用此方式。

## 从旧包迁移

旧包为 `harmony-offline-sdk@0.1.4`（更早为 `com.offline.demo@0.1.2`）。移除旧依赖，添加 `com.offline.tool@0.2.0`，将 SDK import 改为 `from 'com.offline.tool'`。业务应用自身的 bundleName 无需修改。SDK 安装逻辑不变。

仓库内 Demo 默认使用 `"com.offline.tool": "file:../offlineSdk"`，便于联调源码。要验证发布版本，将 `entry/oh-package.json5` 中该值改成 `"0.2.0"` 后 Sync；下载依赖完成后，Demo 的内置离线 ZIP 仍可断网运行。

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

## 缓存目录（0.1.4 起）

root 由宿主指定。与 Android 一致的 root 内布局：

```text
root/
  100000/             # 正式资源：index.html、JS、CSS 等
  100001.zip.tmp      # 下载或复制中的 ZIP，成功/失败/取消后删除
  100001_temp/        # 解压临时目录，成功/失败/取消后删除
```

包内入口为 `dist/index.html` 时，发布的是 dist 内容，最终为 `<version>/index.html`。Demo 的 root 是 `filesDir/offline/packages`；业务宿主可继续使用自己的 `filesDir/offline/webview`。

使用 `packageDirectory(root, record)` 获取正式路径，清理时传入当前版本目录名（例如 `cleanup(root, '100000')`）。SHA-256 仍用于完整性校验并由宿主保存；同版本不同摘要由宿主拒绝，已存在的版本目录返回 `TARGET_EXISTS`，不会覆盖。

0.1.3 的 `<version>-<sha256>` 缓存不会自动迁移；升级后需重新安装包。冷启动、尚无页面绑定时，可调用 cleanup 清理历史缓存和遗留临时文件；已有 `<version>/` 布局可继续复用。禁止在已有页面使用旧目录时清理。

每个 root 的安装和清理必须由宿主串行调度。`installFromFile` 输入 ZIP 必须位于 SDK root 之外，不能通过路径别名指向该目录内部；工作目录内输入返回 `INVALID_SOURCE`，不执行清理。

## 本地生成示例包

Demo ZIP 仅由仓库 `sample-web/` 中可审阅的示例文件生成，脚本不接收下载地址或外部 ZIP。使用 Python 3，固定文件顺序、时间戳和权限，生成 ZIP 时同步更新 Demo 的 SHA-256。

```sh
python3 scripts/generate-sample.py
python3 scripts/generate-sample.py --check
```

CI 会检查已提交 ZIP、示例源码和配置摘要是否一致。修改网页后，应提高 Demo 的离线包版本号再测试已有安装，或清除 Demo 应用数据。测试 ZIP 由测试夹具在本地构造；Demo 和测试均无需业务网页或真实账号。

[0.2.0 migration / 改名接入说明](docs/MIGRATION-0.2.0.md)
