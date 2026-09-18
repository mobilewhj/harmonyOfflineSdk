# harmony-offline-sdk

HarmonyOS API 12+，纯 ArkTS HAR。官方 ZIP 解压、SHA-256 校验及 ArkWeb 本地资源映射。

## 安装

OHPM 中心仓审核上架后，在宿主模块（例如 `entry`）目录执行：

```sh
ohpm install harmony-offline-sdk@0.1.4
```

对应宿主模块的 `oh-package.json5`：

```json5
{
  "dependencies": {
    "harmony-offline-sdk": "0.1.4"
  }
}
```

OHPM 自动下载 HAR。源码和 Demo 位于 [GitHub](https://github.com/mobilewhj/harmonyOfflineSdk)，[Demo 说明](https://github.com/mobilewhj/harmonyOfflineSdk/blob/main/docs/DEMO.md)。

也可下载 [GitHub v0.1.4](https://github.com/mobilewhj/harmonyOfflineSdk/releases/tag/v0.1.4) 的 HAR，放入宿主工程 `libs/`，将模块依赖设为 `"harmony-offline-sdk": "file:../libs/harmony-offline-sdk-0.1.4.har"` 后执行 `ohpm install --all`。远程依赖与本地 HAR 二选一；审核上架前可使用本地 HAR。

从旧 `com.offline.demo@0.1.2` 迁移时，删除旧依赖并替换 SDK import 为 `harmony-offline-sdk`，不需要改变宿主应用 bundleName。SDK API 保持不变。

## 主要 API

```typescript
import { PackageInstaller, PackageSpec, OfflineProgress, usablePackage } from 'harmony-offline-sdk';

const installer = new PackageInstaller();
// spec: { version: 10000, sha256: '<来自可信配置的64位小写SHA-256>', url: '<HTTPS ZIP URL>' }
// root 必须是宿主私有目录，所有操作按 root 串行。
const result = await installer.install(root, spec, (p: OfflineProgress) => {
  // p.stage 表示阶段；仅 DOWNLOADING 的 percent >= 0 表示真实下载比例。
});
if (result.success) {
  const directory = usablePackage(root, spec);
  // directory 非空后，再持久化激活记录并绑定新页面。
}
```

| API | 行为 |
| --- | --- |
| `install(root, spec, progress, allowHttp = false)` | 下载、验证、解压、原子改名发布目录；不会保存宿主激活记录 |
| `installFromFile(root, record, archivePath, progress)` | 复制本地 ZIP 后使用相同验证流程；不修改或删除输入 ZIP |
| `cancel()` | 标记取消；等待正在进行的官方解压结束和清理，必须等待安装 Promise 落定后重试 |
| `usablePackage(root, record)` | 检查 `index.html` 或 `dist/index.html` 并返回内容根目录；无可用入口返回空串 |
| `cleanup(root, keepDirectoryName)` | 清理该 root 下其他版本及临时目录，仅在没有旧页面绑定时使用 |
| `removeUnbound(path)` | 删除宿主确认无人使用的目录；切勿对任意外部路径调用 |
| `new ResourceInterceptor(directory, baseUrl)` | 页面生命周期内固定目录和来源；baseUrl 必须以 `/` 结束 |
| `open(url, method, hasRange)` | 返回 `{ fd, mime, size }` 或 undefined；仅拦截命中的 GET 静态资源 |

`PackageRecord`: 整数版本号 >= 10000，64 位小写 SHA-256。`PackageSpec` 增加 URL。
`InstallResult`: `success`、`reason`、`stage`、`directory`。安装错误返回失败结果；无效 record、重复调用和 TaskPool 平台异常可能直接拒绝 Promise，宿主仍需 try/catch。
`OfflineStage.COMPLETE` 供宿主保存激活记录后使用；安装器本身止于 SAVING，不能把解压完成当作宿主启动完成。

## Web 接入

在 `onInterceptRequest` 中调用 binding.open，命中时构造 `WebResourceResponse`：设置 MIME、200、Content-Length，并通过 `setResponseData(resource.fd)` 传给 ArkWeb。成功返回后 FD 由 ArkWeb 接管；构造响应失败时宿主关闭 FD。未命中返回 undefined，由 Web 正常请求网络。完整示例见仓库 `entry/src/main/ets/pages/Index.ets`。

默认仅允许 HTTPS 标准端口和同源路径。历史 HTTP 兼容需要明确启用；不应为方便绕过来源校验。不同来源、POST、Range、路径穿越或不存在的文件不由本地包响应。SDK 不拦截或重写业务接口。

## 安装和版本约束

- ZIP32、Store/Deflate、UTF-8 文件名；不支持 ZIP64、加密、多卷、符号链接或特殊文件。
- ZIP 最大 64 MiB，单文件解压上限 64 MiB，总解压上限 256 MiB，最多 10,000 条目；提取前后验证元数据、路径、大小和 CRC。
- 同版本的目标已存在返回 `TARGET_EXISTS`，不会覆盖。先用 `usablePackage` 判断复用；只可移除未绑定的损坏目录后重试。
- 下载默认 HTTPS:443，最长 120 秒、最多 10 次同协议跳转。HTTP:80 需显式 opt-in；拒绝 URL 用户名、密码、fragment 和非默认端口。
- `percent = -1` 为未知进度，校验和官方 ZIP 解压不伪造百分比。本地复制同样显示准备阶段。
- 宿主应把 SHA-256 与 URL 置于可信配置中；哈希校验本身不证明资源发布者身份。
- 单个安装器不能并发安装；宿主还必须协调安装、删除和清理，不可跨实例竞争同一 root。

SDK 不依赖 Demo、业务账号、业务域名、Cookie 或签名配置。Apache-2.0。

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
