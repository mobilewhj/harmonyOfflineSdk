# Publishing com.offline.tool

SDK version: `0.3.1`. Repository: [mobilewhj/harmonyOfflineSdk](https://github.com/mobilewhj/harmonyOfflineSdk). Keep publishing credentials and signing inputs outside the public tree. A local package or version declaration does not assert that OHPM has accepted or served the release.

## Source and HAR

1. Select the reviewed public source paths and the exact SDK version in offlineSdk/oh-package.json5. Keep both changelog headings at `## 0.3.1`. The source Demo and private host-test tooling have independent versions.
2. Run checks appropriate to the actual changes, including `python3 scripts/generate-sample.py --check`. Preserve earlier source, resolved-HAR and device results under their original input identities; a documentation change does not require repeating unrelated runtime matrices.
3. Run `./scripts/package-release.sh` from a clean preparation checkout. It validates metadata/changelog headings, normally resolves dependencies and builds only offlineSdk's release HAR. It creates `dist/release-0.3.1/` with exactly `com.offline.tool-0.3.1.har` and `SHA256SUMS`. Existing output is preserved rather than overwritten.
4. Review the selected tree and complete HAR, including entrypoints, metadata, README, CHANGELOG, LICENSE and any source maps. Exclude private paths, host resources, identifiers, credentials, build caches and local test evidence. Compare an independent HAR-only consumer with the reviewed package. The [validation scope](VALIDATION.md) distinguishes native observations and remaining platform limits.

The release package and its attachments contain the SDK HAR and SHA256SUMS. The package script does not collect the source Demo HAP, any host application HAP or private verification application. Those applications are not part of this SDK release archive.

## GitHub

Check that v0.3.1 is unused. Review the exact commit paths, tree, author/committer and message, then publish that new version without overwriting an existing tag or artifact. Keep the HAR and checksum matched to that source. Historical changes or deletions are separate operations.

## OHPM and consumers

Use the reviewed HAR for `ohpm prepublish` or `ohpm publish`; keep credential output private. A prepublish check is not publication or download proof. If the exact version is occupied, do not overwrite it or silently change the package identity. See the [official HAR publication guide](https://developer.huawei.com/consumer/en/doc/harmonyos-guides/ide-har-publish).

After actual registry acceptance, resolve `com.offline.tool: 0.3.1` in a fresh consumer with an isolated dependency cache. Compare all resolved package members to the reviewed release and build from those remote bytes. A pending review or unavailable package remains unavailable; do not substitute a local HAR while calling it a remote result.

Host module declaration:

```json5
{ "dependencies": { "com.offline.tool": "0.3.1" } }
```

Run normal `ohpm install --all`, retain the generated locks and verify the actual resolution before the affected host build and smoke checks. Neither SDK package publication nor generic Demo behavior certifies a host's business flow. API12 testing is skipped, and the API12–17 no-associated-page cache limitation remains documented.
