# 发布

发布主体为 [mobilewhj](https://github.com/mobilewhj)，仓库 [harmonyOfflineSdk](https://github.com/mobilewhj/harmonyOfflineSdk)。使用 GitHub 账号名称和 noreply 提交邮箱，不继承公司 GitLab 身份。

## GitHub + HAR

1. 更新根目录、SDK、Demo 的版本与 CHANGELOG。检查导出 API 和接入示例。
2. `npm ci && npm test`。
3. `./scripts/package-release.sh` 生成 `dist/harmony-offline-sdk-0.1.0.har`、未签名 Demo HAP、SHA256SUMS。
4. 用 HAR 替换临时验收工程的源码依赖，`ohpm install --all` 后完整编译 Demo。核对 HAR 包内的 README、CHANGELOG、LICENSE、Index.ets，且不含签名/业务配置。
5. 提交源码并创建 `v0.1.0` 标签；创建 GitHub Release，上传 HAR、未签名 HAP 和 SHA256SUMS。未签名 HAP 用于构建核对，真机请使用源码自行签名运行。

## OHPM（后续）

目前不自动发布 OHPM。可先运行 `ohpm prepublish dist/harmony-offline-sdk-0.1.0.har` 做本地包校验。申请可用包名/命名空间后，按照官方文档配置发布账号、公钥和 publish_id，在本机保存加密私钥，最后 `ohpm publish <har>`。账号、私钥和签名文件不得提交 Git。

官方文档：[HAR 发布](https://developer.huawei.com/consumer/en/doc/harmonyos-guides/ide-har-publish)。中心仓包名若需要调整，必须同步 oh-package.json5、Demo import 和文档再构建。
