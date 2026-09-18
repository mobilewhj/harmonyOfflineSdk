# Harmony Offline SDK

[中文](README.md)

A standalone ArkTS HAR for HarmonyOS API 12+: official ZIP extraction, SHA-256 verification, TaskPool installation and immutable ArkWeb resource mapping. No native C++ or third-party decompressor.

Open the root directory in DevEco Studio (validated compiler: 26.0.0.821 / SDK 26), sync, select `entry`, configure your own automatic signing and run. The sample installs a bundled ZIP, so even first launch requires no network. Its Splash screen shows real stages, a progress bar, completion and retry. The sample deliberately waits for “进入离线页面” after completion for easy visual inspection. Use “模拟失败” on the offline page to exercise a real hash failure and retry.

`offlineSdk` is the reusable library; `entry` owns UI, preferences and activation. The demo is intentionally a fixed-version local sample, not a production update manager. Remote ZIP installation is available through `PackageInstaller.install`; configure a trusted URL and expected hash in your own repository. A trusted expected hash must come from authenticated configuration, not from the downloaded file itself.

Download the versioned HAR from [GitHub Releases](https://github.com/mobilewhj/harmonyOfflineSdk/releases) and declare a `file:../libs/com.offline.demo-0.1.2.har` dependency named `com.offline.demo`. Once the OHPM version is approved and available, run `ohpm install com.offline.demo@0.1.2` in the consuming module. Until then, use the local HAR.

Run `./scripts/build.sh` to build the HAR and unsigned sample HAP, or `./scripts/package-release.sh` to collect release files and checksums. Set `DEVECO_HOME` for non-default installations. Host tests: Node >= 22.15, `npm ci && npm test`. They mock Harmony platform boundaries; a successful host test/build is not device acceptance.

See [SDK API](offlineSdk/README.md), [demo instructions](docs/DEMO.md), [validation](docs/VALIDATION.md) and [release instructions](docs/RELEASING.md). Apache-2.0.
