# Harmony Offline SDK

[中文](README.md)

A standalone ArkTS HAR for HarmonyOS API 12+: official ZIP extraction, SHA-256 verification, TaskPool installation and immutable ArkWeb resource mapping. No native C++ or third-party decompressor.

Open the root directory in DevEco Studio (validated compiler: 26.0.0.821 / SDK 26), sync, select `entry`, configure your own automatic signing and run. The sample installs a bundled ZIP, so even first launch requires no network. Its Splash screen shows real stages, a progress bar, completion and retry. The sample deliberately waits for “进入离线页面” after completion for easy visual inspection. Use “模拟失败” on the offline page to exercise a real hash failure and retry.

`offlineSdk` is the reusable library; `entry` owns UI, preferences and activation. The demo is intentionally a fixed-version local sample, not a production update manager. Remote ZIP installation is available through `PackageInstaller.install`; configure a trusted URL and expected hash in your own repository. A trusted expected hash must come from authenticated configuration, not from the downloaded file itself.

The published SDK package and import name is `harmony-offline-sdk`; the sample application bundle remains `com.offline.demo.sample`.

After OHPM review and listing, run `ohpm install harmony-offline-sdk@0.1.4` in the consuming module, or declare `"harmony-offline-sdk": "0.1.4"` in that module's `oh-package.json5` and sync. OHPM downloads the HAR automatically.

Alternatively download `harmony-offline-sdk-0.1.4.har` from [GitHub v0.1.4](https://github.com/mobilewhj/harmonyOfflineSdk/releases/tag/v0.1.4), and declare `"harmony-offline-sdk": "file:../libs/harmony-offline-sdk-0.1.4.har"`. Use either the registry or the local HAR dependency. Import from `harmony-offline-sdk` in both cases.

Migrating from `com.offline.demo@0.1.2`: remove the old SDK dependency, add the new package and replace SDK imports. Do not change your application's bundle name. APIs and runtime behavior are unchanged.

The repository demo uses `file:../offlineSdk` for source development. To run it against the registry package, change that dependency value in `entry/oh-package.json5` to `0.1.4` and sync after the new package is listed.

Run `./scripts/build.sh` to build the HAR and unsigned sample HAP, or `./scripts/package-release.sh` to collect release files and checksums. Set `DEVECO_HOME` for non-default installations. Host tests: Node >= 22.15, `npm ci && npm test`. They mock Harmony platform boundaries; a successful host test/build is not device acceptance.

See [SDK API](offlineSdk/README.md), [demo instructions](docs/DEMO.md), [validation](docs/VALIDATION.md) and [release instructions](docs/RELEASING.md). Apache-2.0.

Since 0.1.4 the root contains `<version>/`, `<version>.zip.tmp` and `<version>_temp/`, matching Android. A ZIP's dist directory is flattened at publication. The demo root is `filesDir/offline/packages`. Hosts choose their own root and must serialize install/cleanup. Previous version-hash caches need reinstallation; cold cleanup can remove them before any pages bind. Local ZIP inputs must be outside the SDK-owned root, including through path aliases.
