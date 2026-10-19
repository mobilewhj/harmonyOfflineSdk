# Validation scope for 0.3.1

This page records the scope of available implementation checks. It does not certify all devices or a host application's business flow. Published source, HAR and consumer identities are separate from the development-candidate observations below.

## Development-candidate observations

- Host source and resolved-HAR regressions cover managed startup, lifecycle, cancellation, event boundaries, files/ZIP handling, Demo behavior and file-backed SQLite. Memory/platform substitutes, host SQLite and native ArkData are distinct evidence layers; no aggregate count is described as entirely native.
- Isolated API26 database runs exercised first-schema creation with pooled connections, failed-cursor rejection, transaction rollback, immutable SHA and unique stages, migration retention, ordinary-read protection and confirmed closed-owned-file corruption recovery. Runtime empty-table protection used SQL DELETE and did not inject corruption into a live cached handle.
- Isolated API26 ZIP/package runs rejected actual body bytes in selected nonempty-path directory entries, accepted empty directories, selected the root entry first and produced a physical version/index.html for dist-only input. They also retained the process in-use bytes when preparation failed.
- Native download checks covered successful preparation, zero-byte connection failure, Local input-open failure, configuration diagnostics, real partial-transfer cancellation and same-manager retry. A close check awaited native settlement and observed a finite no-write interval; it is not an indefinite absence-of-writes or FD-leak proof. ZIP extraction cancellation and privacy withdrawal during an actual transfer were not covered by those partial-transfer cases.
- Development-candidate process checks observed ready activation after a real cold process without another Prepared event, and the unchanged default 300000ms foreground scheduler. Foreground overdue checks and accelerated host clocks are separate from natural timing.
- Generic ArkWeb checks observed original HTTP(S) origin/path/query/hash, local resource consumption, missing-resource fallback, Range fallback and resource-cache effects with and without an associated page on API26. Cookie, localStorage and Bridge values were retained in the read-only probes. These checks do not certify an application's authentication flow or independently audit descriptor leaks.

The initial native schema-visibility and failed-cursor defects were corrected. Their earlier failures and the subsequent scoped results are not treated as the same artifact run. Repackaging documentation or metadata does not convert a development HAR's runtime record into a new artifact's run.

## Platform and host boundaries

| Area | Boundary |
| --- | --- |
| API12 | Runtime testing is skipped; declared minimum API12 is unchanged. Higher-version results do not establish API12 behavior. |
| Resource cache | API18+ can synchronously initiate clearing with WebviewController.removeAllCache(true) without an associated page. API12–17 require a Web-associated controller; no-page clearing remains unavailable there. A void API return alone is not evidence of the effect. |
| ZIP | ZIP32 Store/Deflate and supported entry/name formats apply. ZIP64, encryption, multi-volume, symlinks and special files are not supported. Actual disk/memory constraints remain; no extra package-size, expanded-total, entry-count or name-length product caps are imposed. |
| Remote transfer | The current total deadline is 120 seconds, with at most ten same-protocol redirects. This is an implementation limit, separate from package-size policy. |
| Host integration | Preserve existing privacy, configuration, authentication, navigation and reporting chains. Ordinary offline failure only ends offline waiting; it does not require a notice or manual retry and does not bypass business gates. |
| Events | Only Prepared and PrepareFailed represent installation reporting. Diagnostic, progress, activation and resource failures are not additional installation reports. Client HTTP success does not establish backend receipt. |

## Release identity

The release package is the SDK HAR and SHA256SUMS. Compare the declared package/version, complete HAR members and independently resolved consumer bytes. Actual registry download establishes remote availability; source metadata, prepublish or a successful local build alone does not. Host applications validate their affected behavior with the bytes they actually consume.

Historical 0.1.x/0.2.0 results apply to their own APIs and artifacts. Private signing inputs, accounts, device identifiers, local evidence and host-specific resources are not part of the public package.
