# Managed lifecycle integration

This guide describes the implemented `0.3.1` managed API. Use the exact dependency `"com.offline.tool": "0.3.1"` and normal `ohpm install --all`; actual registry resolution establishes availability. For isolated or offline use, select the reviewed `com.offline.tool-0.3.1.har` instead. See the [validation scope](VALIDATION.md).

## Application ownership

Create one `ManagedOfflineSdk` per application process. Supply the original configuration network adapter, resource cache callback and event callback before any startup call. The SDK owns the single `offline_package(version, sha256, stage)` table, preparation, immutable identities, first eligibility, cold cleanup, ready activation and the only five-minute scheduler.

```typescript
const manager = await ManagedOfflineSdk.create(context, {
  configProvider: (request: ConfigRequest) => repository.fetchConfig(request),
  resourceCacheCleaner: () => clearHostResourceCache(),
  onEvent: (event: ManagedEvent) => reporter.accept(event)
});
manager.updateConditions({ privacyAccepted, foreground });
```

The cache callback must synchronously initiate resource-cache clearing. On API18+ the host can guard and call `webview.WebviewController.removeAllCache(true)` without a business Web page. On API12–17 use one Web-associated controller and `removeCache(true)`; the instance operation already covers all Web components in the same application. Without an associated Web, throw a finite error: this lower-version no-page difference remains open, and the SDK emits a diagnostic and continues preparation without retrying the cache call for that target. Never call an unattached controller as a successful substitute. Neither path should clear cookies, localStorage, authentication or business data. The void return alone does not prove completed native clearing. Resource-cache effects with and without an associated page were observed in an isolated API26 development candidate; that result does not close the API12–17 gap or prove every host configuration.

Default package root is `context.filesDir + '/offline/lifecycle-packages'`. The root-derived relational database is stored in the application database directory outside package cleanup. The old low-level and managed Preferences roots and keys are neither imported nor deleted. Do not maintain an App package ledger or derive the active version from directory names. The legacy keyValueStore type remains exported for source compatibility, but passing that field to ManagedOfflineSdk.create is rejected.

Database opening defaults to `allowRebuild: false`. Only numeric ArkData error code `14800011` from `getRdbStore` allows one reopen with platform `allowRebuild: true`; the SDK does not manually delete the database. A confirmed corruption error on a cached handle closes it and still fails the current invocation; the next natural entry may reopen it through that platform path. Ordinary IO, permission, schema or migration failures are surfaced, never treated as an empty table or permission to clear packages. A successfully recovered empty database is read normally. Recovery in an existing process does not replace its in-use identity or repeat cold cleanup. Native schema visibility and failed-cursor handling are corrected. Isolated API26 development runs exercised the corrected database paths, including confirmed closed-file corruption recovery. Ordinary read failures did not recreate schema or clean package bytes; an actual runtime DELETE was a separate test, not live-corruption injection. Host-specific behavior remains distinct.

`configProvider` forwards the SDK currentVersion unchanged through the existing App network/authentication chain and maps configuration facts. Disabled configuration may omit metadata. Do not select versions, repair directories or convert configuration errors into installation reports. Connect cancellation to this request only; never cancel a shared business client or sibling request.

## Startup and conditions

```typescript
const cancellation = new OfflineCancellation();
const result = await manager.prepareStartup({ cancellation, onProgress: renderProgress });
if (result.kind === StartupKind.CONTINUE) {
  finishOfflineWaiting();
  enterOnlyWhenOriginalBusinessGatesAreReady();
}
```

The first successful database read determines first eligibility; the startup decision is made once per process. Read failures continue startup without deleting files. Ordinary configuration/preparation failure releases only the offline wait; do not add a new business notice, dialog or manual-retry gate for this case. The SDK handles subsequent checks silently. Privacy, business configuration or valid cached fallback, advertisements, login and navigation deduplication stay with the App. DEFERRED and cancellation do not navigate or synthesize completion.

Progress is actual work. Unknown percentage stays `-1`; download/extraction display must not infer success from progress. Confirmed ready persistence is preparation success. Old state or an Idle activity is not completion. Page destruction cancels only its invocation and suppresses late UI updates.

Only the SDK schedules subsequent checks, by default every 300000ms. First preparation requires foreground at invocation, before configuration and before preparation; ordinary background after download/extraction begins allows it to finish. A started silent check continues in background, including preparation after its configuration returns. Background stops new scheduling; privacy withdrawal and SDK close cancel work. Close the report privacy gate before forwarding withdrawal to the manager.

The first caller owns first preparation. Other callers wait for that result. A waiter cancels only its wait; owner/privacy/close cancellation reaches real preparation. The SDK serializes first and silent work.

## Lifecycle and retry

Stages are `downloading`, `downloaded`, `ready`, `active`. Registration checks the existing same-version SHA in a transaction before removing any row or package file. A reusable ZIP must match its actual SHA; otherwise download overwrites and syncs it. Preparation writes directly into the target version directory and confirms a ready row before success. Root `index.html` takes precedence. Only when it is absent and `dist/index.html` exists does extraction select the dist subtree and remove its prefix, producing the physical `<version>/index.html`; unselected content is not output. All input names still receive path and duplicate checks. Directory entries with a nonempty selected output path are checked against actual decompressed bytes and must be empty, rather than trusting a zero size in metadata. The directory-body and physical root/dist behavior was exercised in an isolated API26 development candidate; these are scoped results rather than a claim about every platform format.

The in-use identity is fixed for the process even if its files become unavailable. With an in-use package, a newly prepared package remains ready until the next real cold process. Without one, the SDK may enable it immediately. An unavailable in-use package is not repaired in place and uses the original online URL until a higher target is available in a later process.

Retry state is memory-only per version/SHA. Network transfer/timeouts and the specified retryable HTTP statuses do not consume the extra nonnetwork attempt. Other preparation failures allow one additional attempt; cancellation consumes none. Retries occur on normal SDK ticks, never an App timer or a permanent failed-version lock. Download Retry-After applies independently of configuration scheduling.

## Page loading

Keep the original URL, controller, cookies, localStorage and bridge. Web starts with `about:blank`; after controller and original cookie/bridge readiness, call once for this component:

```typescript
const page = new ArkWebPage(uiContext, controller, { resourceBaseUrl: originalResourceBaseUrl });
await manager.loadPage(page, originalUrl, { cancellation });
// Synchronous onInterceptRequest:
return page.intercept(request);
// Component destruction:
cancellation.cancel();
page.close();
```

Protocol, host, port, path, query/hash and business origin remain unchanged. The SDK chooses eligibility from the in-use package and memory-only online policy. Unknown configuration permits a usable in-use package; disabled configuration forces online; accepted version/SHA policy must match. Invalid configuration or a same-version SHA conflict keeps the previous policy and emits a diagnostic. Already opened pages keep their version; disabling stops future local interceptions without refreshing the page.

Only qualifying GET resources return local file descriptors synchronously. Missing/empty files, Range, unsupported methods, different origin and failed response construction return undefined for original online fallback. The SDK closes an undelivered descriptor; after successful response assignment ArkWeb owns consumption. Device evidence is still required for native FD lifetime and interruption behavior.

For a higher silent target with an in-use package, order is policy update, synchronous resource-cache request, preparation. Cache is requested at most once for this target in the process, including callback errors; there is no persisted dirty ledger or per-page cache acknowledgment.

## Installation events

Consume only `Prepared` and `PrepareFailed` for installation reports. `Prepared` follows a confirmed ready write exactly once; activation/recheck/progress/navigation never adds another success. `PrepareFailed` keeps the real download, verification, extraction, file or ready-write category and the event version snapshot. Every `Diagnostic` is ignored for installation reporting.

Statistics start immediately before an actual remote request, including zero-byte connection failure, at the local input-open boundary, or after a matching reusable ZIP enters processing. Configuration, candidate validation, registration and ZIP/root preflight faults before that boundary are diagnostic only. Their retry budget is evaluated separately. Cancellation adds no failure event. Event/report callback errors do not affect preparation or navigation; callbacks must hand off network upload without blocking.

## Platform limits

API12 remains the declared minimum and its runtime testing is skipped. The SDK does not add fixed package-size, expanded-total, entry-count or name-length product caps; ZIP-format bounds and actual platform resources still apply. ZIP32/Store/Deflate and the supported filename/entry formats still constrain inputs; ZIP64, encryption, multi-volume and special-file support are not added. Platform memory/disk limits remain. Included-directory body validation, physical dist-only layout and selected database/cache paths have isolated API26 development results. API12–17 clearing with no associated Web remains open. Native FD delivery was observed; descriptor leak accounting and untested host/platform cases are not implied. No complete platform equivalence is claimed. The existing network download deadline remains 120 seconds with at most ten same-protocol redirects; this is a separate current implementation limit, not a package-size cap.
