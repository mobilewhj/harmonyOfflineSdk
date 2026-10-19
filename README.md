# Harmony Offline SDK

[English](README.en.md) · [简单接入](docs/MANAGED-INTEGRATION.md) · [Demo](docs/DEMO.md) · [低层 API](offlineSdk/README.md) · [验证记录](docs/VALIDATION.md)

纯 ArkTS HAR，包名 `com.offline.tool`。SDK 版本为 `0.3.1`。使用官方 ZIP、SHA-256、TaskPool 与 ArkWeb，最低兼容 API 12，当前以 SDK 26 编译。

默认由 SDK 管理首次准备、版本决策、持久记录、失败门槛、目录保护和应用级五分钟静默更新。App 提供配置请求、隐私/前台事实、UI 导航和 Web 实例；无需自定义存储或计时器。页面调用一次 `loadPage`，仍加载原 HTTP(S) 地址、query/hash 与 origin，缺资源同步返回 `undefined` 交 ArkWeb 回源。业务接口、登录、Cookie 和 Bridge 仍由 App/H5 管理。

## 最短接入

```typescript
import { ManagedOfflineSdk, ArkWebPage } from 'com.offline.tool';

// 应用级只创建一次；fetchConfig 是 App 已有的可信配置请求。
const offline = await ManagedOfflineSdk.create(context, { configProvider: fetchConfig });
offline.updateConditions({ privacyAccepted: true, foreground: true });
const startup = await offline.prepareStartup({ onProgress: renderChineseProgress });
// CONTINUE 结束离线等待；仍遵守 App 自己的隐私、前台及导航门禁。
// Web.controllerAttached 后创建 page，并且从 onInterceptRequest 同步返回 page.intercept(request)。
const page = new ArkWebPage(uiContext, controller, { resourceBaseUrl: originalResourceBaseUrl });
await offline.loadPage(page, originalPageUrl);
```

完整生命周期、取消和存储职责见 [接入说明](docs/MANAGED-INTEGRATION.md)。`entry` 是可编译的完整示例，默认 `file:../offlineSdk` 用于源码联调；验收消费者必须仅依赖最终 HAR。

## 运行隔离 Demo

DevEco Studio 打开仓库，选择 `entry/default`。首次准备使用可控网络配置及 ZIP，不再安装内置 ZIP 来模拟托管更新。在开发机启动 fixture，把 DemoConfig 的 origin 改成开发机 LAN 地址，保持配置/包/页面同源：

```sh
node scripts/serve-demo-fixture.cjs --host 0.0.0.0 --port 8088 --origin http://192.168.1.2:8088/
```

首次 owner 显示真实阶段；未知比例用扫描条，ready 写入确认后才报告准备成功。普通离线失败结束离线等待，后续重试由 SDK 静默调度，不要求业务 App 新增提示、弹窗或手动重试；App 原业务门禁仍独立生效。后次和五分钟更新无首次 UI。Web 的初始 src 为 about:blank，controllerAttached 后由 SDK 加载原地址。[Demo 文档](docs/DEMO.md)说明运行配置及通用示例交互。`sample-web/` 与 rawfile/sample.zip 保留作为可审阅 fixture 和旧低层兼容输入。

## 依赖安装与本地 HAR

宿主模块 `oh-package.json5` 使用精确版本，随后执行 `ohpm install --all`：

```json5
{ "dependencies": { "com.offline.tool": "0.3.1" } }
```

版本可用性以 OHPM 实际解析结果为准。离线分发时，可改为已核对 SHA-256 的 `file:../libs/com.offline.tool-0.3.1.har`；远端依赖与本地 HAR 二选一。

执行 `ohpm install --all` / DevEco Sync。SDK import 为 `com.offline.tool`；宿主 bundleName 无需改变。只有完成实际远端下载后才切换正式远程依赖；历史 0.2.0 包只提供旧低层 API，不能用于上述托管示例。旧包迁移历史见 [0.2.0说明](docs/MIGRATION-0.2.0.md)。

## 构建与验证

```sh
npm ci
npm test
python3 scripts/generate-sample.py --check
./scripts/build.sh
```

Node >=22.15，默认 DevEco 路径 `/Applications/DevEco-Studio.app/Contents`，可设置 DEVECO_HOME。build.sh 构建 release HAR 与源码 Demo HAP；本机已有签名配置保持原样，隔离 HAR 消费者使用无签名配置。构建及主机模拟不能证明真实 ArkWeb cache/FD、API12运行、原生 ZIP 内容处理、自然五分钟或冷进程。当前验证单独记录在 [VALIDATION](docs/VALIDATION.md)，不继承历史设备成绩。

## 目录与兼容

默认 root 为 `filesDir/offline/lifecycle-packages`，数据库位于包根之外；SDK 只持久化 `offline_package(version, sha256, stage)`，不迁移或删除旧 Preferences。SDK 的设计契约默认禁用平台重建，仅 `getRdbStore` 返回数值错误码 `14800011` 时，以平台 `allowRebuild: true` 重开一次；普通读取、权限或结构失败按失败/诊断处理，不当作空表或删除包。托管布局为 `<version>.zip` 与 `<version>/`：root `index.html` 优先，只有 `dist/index.html` 时仅选 dist 子树并去前缀，物理入口为 `<version>/index.html`。被输出的目录条目须实际没有正文，不能仅相信元数据；所有输入仍检查路径与重复条目。冷清理只在首次成功读取后执行一次，进程内固定保护在用目录。旧页固定版本，只动态遵守 enabled。

宿主缓存回调只清资源缓存：API18+ 可同步调用 `WebviewController.removeAllCache(true)`，无需业务页面；API12–17 需一个已关联 Web 的 controller，无页面的差异仍开放。顺序为策略更新→同步发起清理→准备，同目标仅一次，普通失败仅诊断且不补清，不动 Cookie、localStorage、登录或 Bridge。隔离 API26 开发候选有数据库、ZIP、下载及部分 ArkWeb 运行记录；实际覆盖范围见验证说明，不代表所有设备或宿主业务都已验证。SDK 不额外设置包大小、展开总量、条目数量或名称长度的产品阈值；ZIP 格式和平台资源条件仍有限制。

旧 `PackageInstaller`、`ResourceInterceptor` 等签名与低层进度保持；独立 root 可继续由旧调用者串行操作。托管 root 在进程内独占，不能同时交给旧 writer。低层默认 HTTPS/标准端口策略保留，托管 HTTP(S) 策略允许合法端口并拒绝跨协议重定向。

## 示例包

```sh
python3 scripts/generate-sample.py
python3 scripts/generate-sample.py --check
```

生成器只读取审阅过的 `sample-web/`，固定 ZIP 元数据及摘要，不接受外部 ZIP。fixture 网络端提供同一份通用 ZIP，仅用于示例。Apache-2.0 · [mobilewhj](https://github.com/mobilewhj)
