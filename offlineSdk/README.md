# harmony-offline-sdk

HarmonyOS API 12+，纯 ArkTS HAR。官方 ZIP 解压、SHA-256 校验及 ArkWeb 本地资源映射。

## 安装

下载 GitHub Release 的 HAR，在宿主模块声明 `"harmony-offline-sdk": "file:../libs/harmony-offline-sdk-0.1.0.har"`，执行 `ohpm install --all`。目前未上传 OHPM 中心仓。

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
- 同版本+哈希的目标已存在返回 `TARGET_EXISTS`，不会覆盖。先用 `usablePackage` 判断复用；只可移除未绑定的损坏目录后重试。
- 下载默认 HTTPS:443，最长 120 秒、最多 10 次同协议跳转。HTTP:80 需显式 opt-in；拒绝 URL 用户名、密码、fragment 和非默认端口。
- `percent = -1` 为未知进度，校验和官方 ZIP 解压不伪造百分比。本地复制同样显示准备阶段。
- 宿主应把 SHA-256 与 URL 置于可信配置中；哈希校验本身不证明资源发布者身份。
- 单个安装器不能并发安装；宿主还必须协调安装、删除和清理，不可跨实例竞争同一 root。

SDK 不依赖 Demo、业务账号、业务域名、Cookie 或签名配置。Apache-2.0。
