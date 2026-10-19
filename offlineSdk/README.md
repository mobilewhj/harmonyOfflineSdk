# com.offline.tool

HarmonyOS API 12+，纯 ArkTS HAR。官方 ZIP 解压、SHA-256 校验及 ArkWeb 本地资源映射。


当前 SDK 版本为 **0.3.1**。宿主模块使用精确依赖 `"com.offline.tool": "0.3.1"` 后执行 `ohpm install --all`；版本可用性以实际 OHPM 解析为准。离线分发可用核对过摘要的 `file:../libs/com.offline.tool-0.3.1.har`。历史0.2.0只适用于旧低层 API。API12运行测试跳过，最低版本不变；隔离API26开发候选的局部运行记录不能代表全部平台或真实宿主业务。

## 默认托管接入

```typescript
import { ManagedOfflineSdk, ArkWebPage } from 'com.offline.tool';
const offline = await ManagedOfflineSdk.create(context, { configProvider: fetchConfig });
offline.updateConditions({ privacyAccepted, foreground });
const result = await offline.prepareStartup({ onProgress: renderChineseProgress });
// CONTINUE 不代替 App 的隐私/前台/导航门禁；DEFERRED 下次自然入口再准备。
const page = new ArkWebPage(uiContext, controller, { resourceBaseUrl: originalResourceBaseUrl });
await offline.loadPage(page, originalPageUrl);
// onInterceptRequest: (event) => page.intercept(event.request)
```

应用级 manager 不随页面销毁关闭。首次实际 owner 才收到 ManagedProgress；普通配置/准备失败结束离线等待，不要求新增业务提示、弹窗或手动重试，真取消抛 OfflineCancelledError；后次/静默无首次 UI。默认五分钟按真正 provider 调用的 monotonic uptime 起点计算，后台停止新静默调度；已开始的静默检查可继续准备；首装遵守前台检查点，隐私撤回取消更新。

默认事务存储、版本决策和调度均归 SDK；托管入口不读取宿主包账本；旧 `keyValueStore` 类型仅为源码兼容保留；向 `ManagedOfflineSdk.create` 传入该字段会被拒绝。`offline_package(version, sha256, stage)` 是唯一持久事实。默认 `allowRebuild: false`，仅数据库打开返回数值 `14800011` 才交平台以 `allowRebuild: true` 重开一次；普通读取、权限和结构失败不能当空表或触发清包。`Prepared` 仅在 ready 写入确认后一次投递；`PrepareFailed` 保留实际阶段，`Diagnostic` 不作安装统计。回调异常不阻 SDK，不等待宿主上报 Promise。

更高静默目标按策略更新→同步资源缓存调用→准备执行，同目标一次，普通缓存失败仅诊断、不补清。宿主 API18+ 可用静态 `WebviewController.removeAllCache(true)` 无页面调用；API12–17 需要一个关联 Web 的 controller，无页面差异保持开放。只清资源缓存，不清 Cookie、localStorage、登录或 Bridge；API26 隔离开发候选已有数据库、ZIP、下载及部分ArkWeb运行记录；这些局部结果和主机测试都不代表全平台或真实宿主业务通过。

`loadPage` 保持原 HTTP(S) URL；同步 interception 对缺资源、空文件、POST、Range、元数据/FD/响应异常返回 undefined 回源。成功 FD 交系统 Web 读取，SDK 不提前关闭。绑定页仅动态遵守 enabled，manager.close 限制新离线绑定但不改旧绑定；page.close 只关闭本页。

完整生命周期与职责见[托管接入](https://github.com/mobilewhj/harmonyOfflineSdk/blob/main/docs/MANAGED-INTEGRATION.md)及[验证范围](https://github.com/mobilewhj/harmonyOfflineSdk/blob/main/docs/VALIDATION.md)；旧四原语示例不适用于当前托管事务存储。原低层 API 表保留在下方；托管与旧 writer 不得共享 root。

## 历史 0.2.0 低层安装

0.2.0 是已发布的旧低层 API。需要维护该版本时，可在宿主模块（例如 `entry`）目录执行：

```sh
ohpm install com.offline.tool@0.2.0
```

对应宿主模块的 `oh-package.json5`：

```json5
{
  "dependencies": {
    "com.offline.tool": "0.2.0"
  }
}
```

OHPM 自动下载 HAR。源码和 Demo 位于 [GitHub](https://github.com/mobilewhj/harmonyOfflineSdk)，[Demo 说明](https://github.com/mobilewhj/harmonyOfflineSdk/blob/main/docs/DEMO.md)。

从旧 `com.offline.demo@0.1.2` 迁移时，删除旧依赖并替换 SDK import 为 `com.offline.tool`，不需要改变宿主应用 bundleName。这段仅说明历史0.2.0命名迁移；0.3.1托管API请按上文和接入说明迁移。

## 旧低层 API

```typescript
import { PackageInstaller, PackageSpec, OfflineProgress, usablePackage } from 'com.offline.tool';

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
- SDK 不另设固定包大小、展开总量、条目数量或名称长度产品上限；保留路径、重复项、格式、实际文件大小和 CRC 校验，仍受 ZIP 格式及平台资源条件约束。被输出的目录条目按实际正文验证为空，元数据零长度不能单独证明。
- 同版本的目标已存在返回 `TARGET_EXISTS`，不会覆盖。先用 `usablePackage` 判断复用；只可移除未绑定的损坏目录后重试。
- 下载默认 HTTPS:443，最长 120 秒、最多 10 次同协议跳转。HTTP:80 需显式 opt-in；拒绝 URL 用户名、密码、fragment 和非默认端口。
- `percent = -1` 为未知进度，校验和官方 ZIP 解压不伪造百分比。本地复制同样显示准备阶段。
- 宿主应把 SHA-256 与 URL 置于可信配置中；哈希校验本身不证明资源发布者身份。
- 单个安装器不能并发安装；宿主还必须协调安装、删除和清理，不可跨实例竞争同一 root。

SDK 不依赖 Demo、业务账号、业务域名、Cookie 或签名配置。Apache-2.0。

## 缓存目录（0.2.0 起）

root 由宿主指定。与 Android 一致的 root 内布局：

```text
root/
  100000/             # 正式资源：index.html、JS、CSS 等
  100001.zip.tmp      # 下载或复制中的 ZIP，成功/失败/取消后删除
  100001_temp/        # 解压临时目录，成功/失败/取消后删除
```

包内 root `index.html` 优先；仅有 `dist/index.html` 时只输出 dist 子树、去前缀，最终物理入口为 `<version>/index.html`。dist-only 未选中的内容不输出，但所有输入仍做路径/重复检查。旧低层调用者仍可使用自己独立的私有root；不能与托管manager共享root。

使用 `packageDirectory(root, record)` 获取正式路径，清理时传入当前版本目录名（例如 `cleanup(root, '100000')`）。SHA-256 仍用于完整性校验并由宿主保存；同版本不同摘要由宿主拒绝，已存在的版本目录返回 `TARGET_EXISTS`，不会覆盖。

0.1.3 的 `<version>-<sha256>` 缓存不会自动迁移；升级后需重新安装包。冷启动、尚无页面绑定时，可调用 cleanup 清理历史缓存和遗留临时文件；已有 `<version>/` 布局可继续复用。禁止在已有页面使用旧目录时清理。

每个 root 的安装和清理必须由宿主串行调度。`installFromFile` 输入 ZIP 必须位于 SDK root 之外，不能通过路径别名指向该目录内部；工作目录内输入返回 `INVALID_SOURCE`，不执行清理。
