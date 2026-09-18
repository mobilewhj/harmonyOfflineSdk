# Demo 验收

## 打开运行

DevEco Studio 打开工程根目录，Sync 后选择 `entry/default`。真机需要在 Project Structure → Signing Configs 设置自己的自动签名，然后 Run。`com.offline.demo.sample` 为示例包名。

Demo 使用内置 ZIP 和固定可信 SHA-256。安装、校验、官方解压、文件持久化、Web 映射均是真实调用；无需 OSS 地址、后端接口或登录。示例网页的三个文件均从本地映射，域名 `offline.example.invalid` 为保留示例域名，不依赖任何真实服务器。

## 手工检查

1. 清除 Demo 应用数据后启动：底部显示准备、校验、解压和初始化的阶段；小 ZIP 阶段可能很快结束。完成后进度条为 100%，点击“进入离线页面”。
2. 页面应显示“本地 CSS / JavaScript 加载成功”，按钮可累计点击次数。
3. 关闭网络再杀进程重启：仍可通过已保存记录进入离线页面。
4. “重放启动”：在新的 cache 目录真实重新安装；不删除当前 Web 绑定的目录。
5. “模拟失败”：错误预期哈希触发 HASH_MISMATCH，显示“启动配置准备失败，请稍后重试。”和“重试”。点击重试立即恢复加载文本与进度条，再用正确哈希安装成功。
6. 连点重试不能创建多个任务。安装过程中退出页面会标记取消；官方解压正在运行时允许先结束再清理。

重放目录属于系统 cache，示例不会在仍有 Web 使用时回收它们；频繁重放后可清除 Demo 应用缓存。演示仅固定一个版本，不提供后台版本检查、降级策略或业务 API 离线缓存。

## UI 规范

启动状态区域固定底部，左右 28vp、底部 28vp，在非沉浸式窗口中保留系统安全区。加载文字左对齐，真实下载百分比右对齐；3vp 橙色进度条。无已知比例时用扫描动画，避免伪造安装比例。失败文字居中、下方 48vp 高“重试”，不弹 Toast 或对话框。Demo 完成页保留入口按钮便于检查；产品可在 ready 后自动进入首页。

| 阶段 | 文案 |
| --- | --- |
| 准备 | 正在准备启动配置… |
| 下载（在线接入） | 正在下载资源包… |
| 校验 | 正在校验资源包… |
| 解压 | 正在解压资源包… |
| 保存 | 正在完成初始化… |
| 完成 | 启动配置准备完成 |
| 已明确检测到断网（宿主网络检测） | 网络未连接，请连接网络后重试。 |
| 其他失败 | 启动配置准备失败，请稍后重试。 |

本地 Demo 不需要网络，所以不会错误地把哈希或解压失败显示为断网。

## 接入 OSS / 后端配置

在 DemoRepository 相同位置使用 `installer.install(root, spec, progress)` 替换 `installFromFile`。spec 的 URL、版本和哈希由可信配置提供。实际下载会回调真实百分比；没有 Content-Length 时显示未知进度。宿主可将 OSS 配置源换成后端接口，SDK 安装和 UI 阶段无需变化。不要在公共仓库写入带私密签名的 URL 或凭据。

## Debug 签名与 `no signature file`

`debug` 构建模式不等于已经配置调试签名。`entry-default-unsigned.hap` 没有签名，真机拒绝安装属于预期。

个人华为开发者账号可以调试 Demo，不要求使用公司团队。在 DevEco 的“项目结构 → 项目 → 签名配置”中选择个人团队，勾选“自动生成签名文件”，确认包名是 `com.offline.demo.sample`，连接并解锁调试手机后应用配置。普通 Demo 无需关联已注册应用。生成成功后重新 Run，应安装 `entry-default-signed.hap`。若已生成签名文件却仍安装 unsigned HAP，检查工程级 `build-profile.json5` 中 `app.products` 的 `default` 产品是否配置了 `"signingConfig": "default"`，然后同步项目。账号认证或登录授权由账号本人完成。

自动生成的签名配置与密钥属于本机，不要提交到 GitHub。公开 HAR 无需应用签名；其他人运行 Demo 时使用自己的调试签名。

参考：[华为官方自动签名文档](https://developer.huawei.com/consumer/cn/doc/HarmonyOS-Guides/ide-signing-auto)。
