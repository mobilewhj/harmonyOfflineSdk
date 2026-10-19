const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require(process.env.OFFLINE_TEST_TYPESCRIPT || 'typescript');

// 此组运行真实会话/类型/来源校验；IO边界模拟故障，不声称ArkWeb或Preferences设备成绩。
function loadSessionFile(name, dependencies, runtime = {}) {
  const output = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/main/ets', name + '.ets'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const module = { exports: {} };
  vm.runInThisContext('(function(require,module,exports,setTimeout,clearTimeout){' + output + '\n})')(
    id => { if (!Object.hasOwn(dependencies, id)) throw new Error('Unexpected import ' + id); return dependencies[id]; },
    module, module.exports, runtime.setTimeout ?? setTimeout, runtime.clearTimeout ?? clearTimeout);
  return module.exports;
}
const sessionTypes = loadSessionFile('ManagedOfflineTypes', {});
const lowTypes = loadSessionFile('OfflineTypes', {});
const worker = loadSessionFile('InstallWorker', {
  '@kit.CoreFileKit': {}, '@kit.CryptoArchitectureKit': {}, '@kit.RemoteCommunicationKit': {},
  '@kit.ArkTS': { url: { URL } }, '@kit.BasicServicesKit': {}, './PackageArchive': {},
  './OfflineTypes': lowTypes, './PackageFiles': {}
});
const shaA = 'a'.repeat(64), shaB = 'b'.repeat(64);
const recordA = { version: 10001, sha256: shaA };
const configB = { enabled: true, version: 10002, sha256: shaB, url: 'https://fixture.test:8443/package.zip' };
function pending() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function turn() { await new Promise(resolve => setImmediate(resolve)); }
function sessionHarness(options = {}) {
  const directories = new Map(options.empty ? [] : [[10001, { exists: true, usable: true }]]);
  const media = { active: options.empty ? undefined : { ...recordA }, history: options.history ??
    (options.empty ? { initialPreparationFinished: false } : { initialPreparationFinished: true }),
    enabled: true, cacheDirty: options.dirty ?? false };
  const calls = [], diagnostics = [], progress = [];
  const hooks = {};
  let cancellationCalls = 0, installedCount = 0, reloadCount = 0, loadCount = 0;
  const storage = {
    async reopenIfFaulted() { calls.push('reopen'); if (hooks.reopen) await hooks.reopen(); },
    async load() { loadCount++; if (hooks.load) return hooks.load(); return { ...media, cacheReadFailed: false }; },
    async reloadActive() { reloadCount++; if (hooks.reload) return hooks.reload(); return media.active; },
    async writeActive(record) { calls.push('active:' + (record?.version ?? 'empty'));
      if (hooks.active) return hooks.active(record); media.active = record && { ...record }; return true; },
    async writeEnabled(value) { calls.push('enabled:' + value); if (hooks.enabled) return hooks.enabled(value); media.enabled = value; return true; },
    async writeHistory(value) { calls.push('history:' + value.initialPreparationFinished);
      if (hooks.history) return hooks.history(value); media.history = { ...value }; return true; },
    async writeCacheDirty(value) { calls.push('cache:' + value); if (hooks.cache) return hooks.cache(value); media.cacheDirty = value; return true; }
  };
  const installer = {
    cancel() { cancellationCalls++; },
    async cleanupManaged(root, keep) { calls.push('cleanup:' + keep); if (hooks.cleanup) await hooks.cleanup();
      for (const version of directories.keys()) if (version !== keep) directories.delete(version); },
    async removeUnboundManaged(root, version) { calls.push('remove:' + version);
      if (hooks.remove) await hooks.remove(version); directories.delete(version); },
    async installManaged(root, target, callback) { installedCount++; calls.push('install:' + target.version);
      if (hooks.install) return hooks.install(target, callback);
      directories.set(target.version, { exists: true, usable: true });
      return { success: true, reason: '', stage: lowTypes.OfflineStage.SAVING, factStage: lowTypes.InstallFactStage.PUBLISHING,
        directory: root + '/' + target.version, requestStarted: true, publishedRecord: target }; }
  };
  const { ManagedPackageSession } = loadSessionFile('ManagedPackageSession', {
    './PackageInstaller': { PackageInstaller: class {}, async observePackage(root, record) {
      calls.push('observe:' + record.version);
      if (hooks.observe) return hooks.observe(record);
      const value = directories.get(record.version);
      return { exists: !!value?.exists, directory: value?.usable ? root + '/' + record.version : '' };
    } }, './InstallWorker': worker, './ManagedStorage': {}, './OfflineTypes': lowTypes, './ManagedOfflineTypes': sessionTypes
  });
  const session = new ManagedPackageSession('/sandbox/managed', installer, storage, 10000, value => diagnostics.push(value));
  const cancellation = () => new sessionTypes.OfflineCancellation();
  return { session, SessionClass: ManagedPackageSession, storage, installer, media, hooks, directories, calls, diagnostics, progress, cancellation,
    prepare: cancel => session.prepareLocal(cancel ?? cancellation()),
    check: (config = configB, cancel = cancellation(), canStart = () => true) => session.check(config, cancel, value => progress.push(value), canStart),
    counts: () => ({ cancellationCalls, installedCount, reloadCount, loadCount }) };
}

test('session: unknown initial facts never authorize cleanup; next entry retries complete reads', async () => {
  const h = sessionHarness({ empty: true }); h.hooks.load = async () => { throw new Error('read failed'); };
  assert.equal(await h.prepare(), false); assert.equal(h.calls.some(value => value.startsWith('cleanup')), false);
  assert.equal(h.session.getState().active, undefined); assert.equal(h.diagnostics[0].reason, 'LOCAL_STATE_READ');
  delete h.hooks.load; assert.equal(await h.prepare(), true); assert.equal(h.counts().loadCount, 2);
});

test('session: legal missing active is initial completion evidence and prevents downgrade', async () => {
  const h = sessionHarness(); h.media.history = undefined; h.directories.clear();
  assert.equal(await h.prepare(), true); assert.equal(h.session.needsInitial(), false);
  assert.equal(h.session.currentVersion(), undefined); assert.equal(h.media.history.initialPreparationFinished, true);
  const result = await h.check({ ...configB, version: 10000 });
  assert.equal(result.outcome, undefined); assert.equal(h.counts().installedCount, 0);
  assert.equal(h.session.getState().active.version, 10001);
});

test('session: cache read failure is conservative dirty without rejecting package facts', async () => {
  const h = sessionHarness(); h.hooks.load = async () => ({ ...h.media, cacheDirty: undefined, cacheReadFailed: true });
  assert.equal(await h.prepare(), true); assert.equal(h.session.getState().usable, true);
  assert.equal(h.session.needsResourceCacheClear(), true);
  assert.equal(h.diagnostics[0].stage, 'RESOURCE_CACHE');
});

test('session: readable but business-invalid initial active is filtered; unknown refresh is stricter', async () => {
  const h = sessionHarness(); h.media.active = { version: 5, sha256: shaA }; h.media.history = undefined;
  assert.equal(await h.prepare(), true); assert.equal(h.session.getState().active, undefined);
  assert.equal(h.session.needsInitial(), true);
});

test('session: ordinary save failure and medium reopen never adopt failed B from persistent media', async () => {
  const h = sessionHarness(); await h.prepare();
  h.hooks.active = async record => { h.media.active = record; return false; };
  const result = await h.check(); assert.equal(result.outcome.reason, 'SAVE_ACTIVE');
  assert.equal(h.session.getState().active.version, 10001);
  await h.session.finishRegular(result.outcome, h.cancellation());
  await h.prepare(); const observation = await h.session.observePage(h.cancellation());
  assert.equal(h.counts().reloadCount, 0); assert.equal(h.session.getState().active.version, 10001);
  assert.equal(h.session.finalBinding(observation, false), undefined); // 已知onlineVersion=B使本次线上。
  assert.equal(h.session.getState().highestFailedVersion, 10002);
  assert.equal((await h.check()).outcome, undefined); assert.equal(h.counts().installedCount, 1);
});

test('session: cancellation while native active write is pending settles then permits dedicated active refresh', async () => {
  const h = sessionHarness(); await h.prepare(); const saving = pending(), started = pending();
  h.hooks.active = async record => { started.resolve(); await saving.promise; h.media.active = record; return true; };
  const cancel = h.cancellation(); const run = h.check(configB, cancel); await started.promise;
  cancel.cancel(); let settled = false; run.finally(() => { settled = true; }).catch(() => {});
  await turn(); assert.equal(settled, false); saving.resolve();
  await assert.rejects(run, sessionTypes.OfflineCancelledError);
  assert.equal(h.session.getState().active.version, 10001);
  delete h.hooks.active; await h.prepare(); assert.equal(h.counts().reloadCount, 1);
  assert.equal(h.session.getState().active.version, 10002); assert.equal(h.session.getState().highestFailedVersion, undefined);
});

test('session: download cancellation neither refreshes active nor records a failed version', async () => {
  const h = sessionHarness(); await h.prepare(); const download = pending(), started = pending();
  h.hooks.install = async () => { started.resolve(); await download.promise;
    return { success: false, reason: 'CANCELLED', factStage: lowTypes.InstallFactStage.DOWNLOADING }; };
  const cancel = h.cancellation(); const run = h.check(configB, cancel); await started.promise;
  cancel.cancel(); assert.equal(h.counts().cancellationCalls, 1); download.resolve();
  await assert.rejects(run, sessionTypes.OfflineCancelledError); await h.prepare();
  assert.equal(h.counts().reloadCount, 0); assert.equal(h.session.getState().highestFailedVersion, undefined);
});

test('session: final confirmation failure rolls back, preserves old memory and exposes rollback failure', async () => {
  const h = sessionHarness(); await h.prepare(); let targetObservations = 0;
  h.hooks.observe = async record => record.version === 10002 ?
    { exists: ++targetObservations > 1, directory: targetObservations === 2 ? '/sandbox/managed/10002' : '' } :
    { exists: true, directory: '/sandbox/managed/10001' };
  h.hooks.active = async record => { if (record.version === 10002) { h.media.active = record; return true; } return false; };
  const result = await h.check(); assert.equal(result.outcome.reason, 'VERIFY_ACTIVE');
  assert.equal(result.outcome.activeRollbackFailed, true); assert.equal(h.session.getState().active.version, 10001);
  await h.prepare(); assert.equal(h.counts().reloadCount, 0); assert.equal(h.session.getState().active.version, 10001);
});

test('session: existing target after page binding is TARGET_IN_USE at PREPARING with zero download', async () => {
  const h = sessionHarness(); await h.prepare(); h.session.markPageBound();
  h.directories.set(10002, { exists: true, usable: false }); const result = await h.check();
  assert.equal(result.outcome.reason, 'TARGET_IN_USE'); assert.equal(result.outcome.stage, 'PREPARING');
  assert.equal(h.counts().installedCount, 0); assert.equal(h.calls.includes('remove:10002'), false);
  assert.equal(h.session.getState().highestFailedVersion, 10002);
  assert.equal((await h.check()).outcome, undefined);
});

test('session: page observation captured during destructive target removal remains invalid after completion', async () => {
  const h = sessionHarness(); await h.prepare(); h.directories.set(10002, { exists: true, usable: false });
  const removing = pending(), started = pending(); h.hooks.remove = async () => { started.resolve(); await removing.promise; };
  const run = h.check(); await started.promise; const observed = await h.session.observePage(h.cancellation());
  assert.equal(observed.destructive, true); removing.resolve(); await run;
  assert.equal(h.session.finalBinding(observed, false), undefined);
});

test('session: ordinary higher-version download never holds page observation until install completion', async () => {
  const h = sessionHarness(); await h.prepare(); const installing = pending(), started = pending();
  h.hooks.install = async () => { started.resolve(); await installing.promise; return {
    success: false, reason: 'DOWNLOAD', factStage: lowTypes.InstallFactStage.DOWNLOADING }; };
  const run = h.check(); await started.promise;
  const observed = await h.session.observePage(h.cancellation()); assert.equal(observed.record.version, 10001);
  assert.equal(h.session.finalBinding(observed, false), undefined); // 新配置B已经使新页线上。
  installing.resolve(); await run;
});

test('session: disabled needs no metadata and immediately revokes bound permission even if save fails', async () => {
  const h = sessionHarness(); await h.prepare(); const observed = await h.session.observePage(h.cancellation());
  const bound = h.session.finalBinding(observed, false); assert.equal(bound.isEnabled(), true);
  h.session.markPageBound(); h.hooks.enabled = async () => false;
  assert.equal((await h.check({ enabled: false })).outcome, undefined); assert.equal(bound.isEnabled(), false);
  assert.equal(h.counts().installedCount, 0); assert.equal(h.session.getState().highestFailedVersion, undefined);
  assert.equal(h.diagnostics.at(-1).reason, 'SAVE_ENABLED');
});

test('session: same-version SHA conflict blocks new binding even if enabled persistence fails; old binding reads only enabled', async () => {
  const h = sessionHarness(); await h.prepare(); const observed = await h.session.observePage(h.cancellation());
  const bound = h.session.finalBinding(observed, false); h.hooks.enabled = async () => false;
  await h.check({ ...configB, version: 10001 }); assert.equal(h.session.getState().shaConflict, true);
  assert.equal(h.session.finalBinding(observed, false), undefined); assert.equal(bound.isEnabled(), true);
  h.session.closeCacheAck(); assert.equal(bound.isEnabled(), true); assert.equal(h.session.finalBinding(observed, true), undefined);
});

test('session: skip and disabled complete normally; only actual candidate conditions return Deferred', async () => {
  const h = sessionHarness(); await h.prepare();
  assert.equal((await h.check({ enabled: false }, h.cancellation(), () => false)).deferred, false);
  assert.equal((await h.check({ enabled: true, version: 10001 }, h.cancellation(), () => false)).deferred, false);
  assert.equal((await h.check(configB, h.cancellation(), () => false)).deferred, true);
  assert.equal(h.counts().installedCount, 0);
});

test('session: only final activated success emits COMPLETE; known download100 caps99 and unknown remains -1', async () => {
  const h = sessionHarness(); await h.prepare();
  h.hooks.install = async (target, callback) => {
    callback({ stage: lowTypes.OfflineStage.DOWNLOADING, percent: 100, downloadTotalKnown: true });
    callback({ stage: lowTypes.OfflineStage.DOWNLOADING, percent: 100, downloadTotalKnown: false });
    callback({ stage: lowTypes.OfflineStage.SAVING, percent: 99 });
    callback({ stage: lowTypes.OfflineStage.COMPLETE, percent: 100 });
    h.directories.set(target.version, { exists: true, usable: true });
    return { success: true, factStage: lowTypes.InstallFactStage.PUBLISHING };
  };
  const result = await h.check(); assert.equal(result.outcome.success, true);
  assert.deepEqual(h.progress.map(value => [value.stage, value.percent]), [
    ['preparing', -1], ['downloading', 99], ['downloading', -1], ['saving', -1], ['confirming', -1], ['complete', 100]
  ]);
  assert.equal(h.session.getState().active.version, 10002); assert.equal(h.session.needsResourceCacheClear(), true);
});

test('session: History false finishes this process; cancellation during History preserves established active without initial completion', async () => {
  const failed = sessionHarness({ empty: true }); await failed.prepare(); failed.hooks.history = async () => false;
  await failed.session.finishInitial(failed.cancellation()); assert.equal(failed.session.needsInitial(), false);
  assert.equal(failed.media.history.initialPreparationFinished, false); assert.equal(failed.diagnostics.at(-1).reason, 'HISTORY_SAVE');
  const h = sessionHarness({ empty: true }); await h.prepare(); const result = await h.check(); assert.equal(result.outcome.success, true);
  const saving = pending(), started = pending(); h.hooks.history = async () => { started.resolve(); await saving.promise; return true; };
  const cancel = h.cancellation(); const run = h.session.finishInitial(cancel); await started.promise; cancel.cancel(); saving.resolve();
  await assert.rejects(run, sessionTypes.OfflineCancelledError);
  assert.equal(h.session.getState().active.version, 10002); assert.equal(h.session.getState().initialFinished, false);
});

test('session: cache acknowledgement is asynchronous, stale failures stay silent and latest invalidation persists last', async () => {
  const h = sessionHarness({ dirty: true }); await h.prepare(); const clear = pending(), started = pending();
  h.hooks.cache = async value => { if (!value) { started.resolve(); await clear.promise; return false; } h.media.cacheDirty = true; return true; };
  h.session.ackResourceCache(h.session.resourceCacheGeneration()); await started.promise;
  assert.equal(h.session.needsResourceCacheClear(), true);
  const checking = h.check({ enabled: false }); await turn(); assert.equal(h.session.getState().enabled, false);
  clear.resolve(); await checking; assert.equal(h.media.cacheDirty, true);
  assert.equal(h.diagnostics.some(value => value.reason === 'CACHE_STATE_SAVE'), false);
  assert.deepEqual(h.calls.filter(value => value.startsWith('cache:')), ['cache:false', 'cache:true']);
});

test('session: current ack failure stays dirty; later page retries; close prevents pending ack confirming clean', async () => {
  const h = sessionHarness({ dirty: true }); await h.prepare(); h.hooks.cache = async () => false;
  h.session.ackResourceCache(h.session.resourceCacheGeneration()); await turn();
  assert.equal(h.session.needsResourceCacheClear(), true); assert.equal(h.diagnostics.at(-1).reason, 'CACHE_STATE_SAVE');
  delete h.hooks.cache; h.session.ackResourceCache(h.session.resourceCacheGeneration()); await turn();
  assert.equal(h.session.needsResourceCacheClear(), false);
  const closed = sessionHarness({ dirty: true }); await closed.prepare(); const writing = pending(), started = pending();
  closed.hooks.cache = async () => { started.resolve(); await writing.promise; return true; };
  closed.session.ackResourceCache(closed.session.resourceCacheGeneration()); await started.promise;
  closed.session.closeCacheAck(); writing.resolve(); await turn(); assert.equal(closed.session.needsResourceCacheClear(), true);
});

test('session: failed target gate is process-only, higher success does not lower it, and bad config cannot raise it', async () => {
  const h = sessionHarness(); h.media.history.latestFailure = { success: false, targetVersion: 99999,
    targetSha256: shaB, reason: 'INSTALL', stage: 'DOWNLOADING', installReason: 'DOWNLOAD' };
  await h.prepare(); assert.equal(h.session.getState().highestFailedVersion, undefined);
  await h.check({ ...configB, sha256: 'invalid' }); assert.equal(h.session.getState().highestFailedVersion, undefined);
  h.hooks.install = async () => ({ success: false, reason: 'HASH_MISMATCH', factStage: lowTypes.InstallFactStage.VERIFYING });
  const failed = await h.check(); assert.equal(failed.outcome.installReason, 'HASH_MISMATCH');
  delete h.hooks.install; assert.equal((await h.check({ ...configB, version: 10003 })).outcome.success, true);
  assert.equal(h.session.getState().highestFailedVersion, 10002);
});

test('session: existing same-version repair remains protected after bound file becomes unusable', async () => {
  const h = sessionHarness(); await h.prepare(); h.session.markPageBound();
  h.directories.set(10001, { exists: true, usable: false }); await h.prepare();
  const result = await h.check({ ...configB, version: 10001, sha256: shaA });
  assert.equal(result.outcome.reason, 'TARGET_IN_USE'); assert.equal(result.outcome.targetVersion, 10001);
  assert.equal(h.counts().installedCount, 0); assert.equal(h.calls.includes('remove:10001'), false);
});

test('session: preexisting page observation is invalidated across destructive removal even if active and config return to A', async () => {
  const h = sessionHarness(); await h.prepare(); const observed = await h.session.observePage(h.cancellation());
  assert.equal(h.session.finalBinding(observed, false).version, 10001);
  h.directories.set(10002, { exists: true, usable: false });
  h.hooks.install = async () => ({ success: false, reason: 'DOWNLOAD', factStage: lowTypes.InstallFactStage.DOWNLOADING });
  await h.check(); await h.check({ enabled: true, version: 10001 });
  assert.equal(h.session.getState().active.version, 10001); assert.equal(h.session.getState().onlineVersion, 10001);
  assert.equal(h.session.finalBinding(observed, false), undefined);
  assert.equal(h.session.finalBinding(await h.session.observePage(h.cancellation()), false).version, 10001);
});

test('session: URL-only changes do not invalidate resource cache while first effective config does', async () => {
  const h = sessionHarness(); await h.prepare(); const before = h.session.resourceCacheGeneration();
  await h.check({ ...configB, version: 10001, sha256: shaA });
  assert.equal(h.session.resourceCacheGeneration(), before + 1);
  await h.check({ ...configB, version: 10001, sha256: shaA, url: 'http://fixture.test:8080/other.zip' });
  assert.equal(h.session.resourceCacheGeneration(), before + 1);
});

test('session: unknown active refresh failure keeps old facts and blocks this entry until successful retry', async () => {
  const h = sessionHarness(); await h.prepare(); const cancel = h.cancellation();
  h.hooks.active = async record => { h.media.active = record; cancel.cancel(); return true; };
  await assert.rejects(h.check(configB, cancel), sessionTypes.OfflineCancelledError);
  delete h.hooks.active; h.hooks.reload = async () => { throw new Error('active read failed'); };
  assert.equal(await h.prepare(), false); assert.equal(h.session.getState().active.version, 10001);
  assert.equal(h.session.getState().onlineVersion, 10002); assert.equal(h.session.getState().enabled, true);
  delete h.hooks.reload; assert.equal(await h.prepare(), true); assert.equal(h.counts().reloadCount, 2);
  assert.equal(h.session.getState().active.version, 10002);
});

test('session: managed source allows explicit ports and refuses credentials or fragments before preparation', async () => {
  for (const url of ['https://user:pass@fixture.test/package.zip', 'https://fixture.test/package.zip#fragment', 'file:///tmp/a.zip']) {
    const h = sessionHarness(); await h.prepare(); const result = await h.check({ ...configB, url });
    assert.equal(result.outcome, undefined); assert.equal(h.counts().installedCount, 0);
    assert.equal(h.diagnostics.at(-1).detail, 'source_invalid'); assert.equal(h.session.getState().highestFailedVersion, undefined);
  }
  const h = sessionHarness(); await h.prepare(); assert.equal((await h.check({ ...configB, url: 'http://fixture.test:8080/a.zip' })).outcome.success, true);
});

// 从create/conditions/startup/load/close公开入口串联真实Manager与Session；时钟和IO只作为平台边界。
function publicClock(start = 0) {
  let now = start, next = 1;
  const timers = new Map(), clockCalls = [];
  return {
    now: () => now, clockCalls,
    systemDateTime: { TimeType: { STARTUP: 'STARTUP' }, getUptime(type, nano) { clockCalls.push([type, nano]); return now; } },
    setTimeout(callback, delay) { const id = next++; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    dueTimes: () => [...timers.values()].map(value => value.at).sort((a, b) => a - b),
    async advanceTo(value) {
      now = value;
      for (let pass = 0; pass < 30; pass++) {
        const due = [...timers].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at);
        if (!due.length) { await turn(); if (![...timers.values()].some(timer => timer.at <= now)) return; continue; }
        for (const [id, timer] of due) { if (timers.delete(id)) timer.callback(); }
        await turn();
      }
      throw new Error('Unexpected zero-delay monitor loop');
    }
  };
}
async function publicHarness(options = {}) {
  const h = sessionHarness(options), clock = publicClock(options.start ?? 0), events = [], outcomes = [], requests = [];
  const { ManagedOfflineSdk } = loadSessionFile('ManagedOfflineSdk', {
    '@kit.AbilityKit': {}, '@kit.BasicServicesKit': { systemDateTime: clock.systemDateTime },
    './PackageInstaller': { normalizePackageRoot: value => value, claimManagedRoot: async () => h.installer },
    './ManagedStorage': { ManagedStorage: class { constructor() { return h.storage; } } },
    './ManagedPackageSession': { ManagedPackageSession: h.SessionClass }, './ManagedPage': {}, './ManagedOfflineTypes': sessionTypes
  }, clock);
  let sdk;
  sdk = await ManagedOfflineSdk.create({ filesDir: '/sandbox', preferencesDir: '/sandbox/preferences' }, {
    root: '/sandbox/managed',
    configProvider: async request => { requests.push({ start: clock.now(), currentVersion: request.currentVersion,
      cancellation: request.cancellation }); events.push('provider');
      return options.provider ? options.provider(request, sdk) : configB; },
    onInstallationOutcome: outcome => { events.push('outcome'); outcomes.push({ outcome, checking: sdk.getState().checking });
      options.onOutcome?.(outcome, sdk); },
    onDiagnostic: value => { h.diagnostics.push(value); events.push('diagnostic:' + value.reason); options.onDiagnostic?.(value); }
  });
  return { ...h, sdk, clock, events, outcomes, requests,
    allow: () => sdk.updateConditions({ privacyAccepted: true, foreground: true }) };
}
function publicPage(events, options = {}) {
  let generation = 0, closed = false;
  return {
    binding: undefined, urls: [], clears: 0,
    startLoad() { return ++generation; },
    isLoadCurrent(id, cancellation) { return !closed && generation === id && !cancellation.isCancelled; },
    canBindUrl() { return true; }, // URL资格由真实Page组合用例覆盖；此double仅隔离UI边界。
    runScopedTask(callback) { events.push('scope'); options.beforeScope?.(); callback(); },
    clearResourceCache() { this.clears++; events.push('clear'); if (options.clearFails) throw new Error('cache clear'); },
    commitLoad(originalUrl, binding) { this.binding = binding; this.urls.push(originalUrl); events.push('load'); },
    close() { closed = true; generation++; this.binding = undefined; }
  };
}

test('public startup: concurrent waiter cancellation is isolated from owner and one provider/install completes', async () => {
  const configuration = pending(), providerStarted = pending();
  const h = await publicHarness({ empty: true, provider: async () => { providerStarted.resolve(); return configuration.promise; } });
  h.allow(); const owner = h.sdk.prepareStartup(); await providerStarted.promise;
  const waiterCancel = h.cancellation(); const waiter = h.sdk.prepareStartup({ cancellation: waiterCancel });
  await turn(); waiterCancel.cancel(); await assert.rejects(waiter, sessionTypes.OfflineCancelledError);
  assert.equal(h.requests[0].cancellation.isCancelled, false); assert.equal(h.counts().cancellationCalls, 0);
  const joining = h.sdk.prepareStartup(); configuration.resolve(configB);
  const [first, shared] = await Promise.all([owner, joining]);
  assert.equal(first.kind, 'CONTINUE'); assert.equal(shared.outcome.targetVersion, 10002);
  assert.equal(h.requests.length, 1); assert.equal(h.counts().installedCount, 1);
  assert.equal(h.outcomes.length, 1); assert.equal(h.outcomes[0].checking, false);
  await h.sdk.close();
});

test('public startup: owner cancellation waits native install settlement and cancels joined work without fake outcome', async () => {
  const h = await publicHarness({ empty: true }); const native = pending(), installStarted = pending();
  h.hooks.install = async () => { installStarted.resolve(); await native.promise;
    return { success: false, reason: 'CANCELLED', factStage: lowTypes.InstallFactStage.EXTRACTING }; };
  h.allow(); const ownerCancel = h.cancellation(); const owner = h.sdk.prepareStartup({ cancellation: ownerCancel });
  await installStarted.promise; const waiter = h.sdk.prepareStartup(); await turn(); ownerCancel.cancel();
  let ownerSettled = false; owner.then(() => { ownerSettled = true; }, () => { ownerSettled = true; });
  await turn(); assert.equal(ownerSettled, false); assert.equal(h.counts().cancellationCalls, 1);
  native.resolve(); await assert.rejects(owner, sessionTypes.OfflineCancelledError);
  await assert.rejects(waiter, sessionTypes.OfflineCancelledError);
  assert.equal(h.sdk.getState().initialFinished, false); assert.equal(h.outcomes.length, 0);
  assert.equal(h.sdk.getState().checking, false); await h.sdk.close();
});

test('public startup: established success is offered once after cancelled History settles and releases operation', async () => {
  const h = await publicHarness({ empty: true }); const history = pending(), historyStarted = pending();
  h.hooks.history = async () => { h.events.push('history-start'); historyStarted.resolve(); await history.promise;
    h.events.push('history-settled'); return true; };
  h.allow(); const cancel = h.cancellation(); const progress = [];
  const owner = h.sdk.prepareStartup({ cancellation: cancel, onProgress: value => progress.push(value) });
  await historyStarted.promise; cancel.cancel(); assert.equal(h.outcomes.length, 0);
  assert.equal(h.sdk.getState().checking, true); history.resolve();
  await assert.rejects(owner, sessionTypes.OfflineCancelledError);
  assert.equal(h.outcomes.length, 1); assert.equal(h.outcomes[0].outcome.success, true);
  assert.equal(h.outcomes[0].checking, false); assert.equal(h.sdk.getState().initialFinished, false);
  assert.equal(h.sdk.getState().active.version, 10002);
  assert.equal(progress.filter(value => value.stage === 'complete').length, 1);
  assert.ok(h.events.indexOf('history-settled') < h.events.indexOf('outcome'));
  await h.sdk.close();
});

test('public startup: established failed target survives History cancellation, while callback sees released permit', async () => {
  const h = await publicHarness({ empty: true }); const history = pending(), historyStarted = pending();
  h.hooks.install = async () => ({ success: false, reason: 'DOWNLOAD', factStage: lowTypes.InstallFactStage.DOWNLOADING });
  h.hooks.history = async () => { historyStarted.resolve(); await history.promise; return true; };
  h.allow(); const cancel = h.cancellation(); const run = h.sdk.prepareStartup({ cancellation: cancel });
  await historyStarted.promise; cancel.cancel(); history.resolve(); await assert.rejects(run, sessionTypes.OfflineCancelledError);
  assert.equal(h.outcomes.length, 1); assert.equal(h.outcomes[0].outcome.reason, 'INSTALL');
  assert.equal(h.outcomes[0].checking, false); assert.equal(h.sdk.getState().highestFailedVersion, 10002);
  assert.equal(h.sdk.getState().initialFinished, false); await h.sdk.close();
});

test('public startup: ordinary first failure Continue has no fake 100; provider diagnostic has no installation outcome', async () => {
  const h = await publicHarness({ empty: true }); h.hooks.install = async () => ({
    success: false, reason: 'HASH_MISMATCH', factStage: lowTypes.InstallFactStage.VERIFYING });
  h.allow(); const progress = []; const result = await h.sdk.prepareStartup({ onProgress: value => progress.push(value) });
  assert.equal(result.kind, 'CONTINUE'); assert.equal(result.outcome.reason, 'INSTALL');
  assert.equal(h.sdk.getState().initialFinished, true); assert.equal(h.outcomes.length, 1);
  assert.equal(progress.some(value => value.percent === 100 || value.stage === 'complete'), false);
  await h.sdk.close();
  const fault = await publicHarness({ empty: true, provider: async () => { throw new Error('provider'); } });
  fault.allow(); assert.equal((await fault.sdk.prepareStartup()).kind, 'CONTINUE');
  assert.equal(fault.outcomes.length, 0); assert.equal(fault.counts().installedCount, 0);
  assert.equal(fault.diagnostics[0].reason, 'CONFIGURATION'); assert.equal(fault.sdk.getState().initialFinished, true);
  await fault.sdk.close();
});

test('public monitor: default300000 uses actual provider-start STARTUP milliseconds, provider failure consumes TTL and no catch-up queue', async () => {
  const firstResponse = pending(), started = pending(); let attempts = 0;
  const h = await publicHarness({ empty: true, start: 1000, provider: async () => {
    attempts++; if (attempts === 1) { started.resolve(); return firstResponse.promise; }
    if (attempts === 2) throw new Error('provider failed'); return { enabled: false };
  } });
  h.allow(); const first = h.sdk.prepareStartup(); await started.promise;
  await h.clock.advanceTo(101000); firstResponse.resolve({ enabled: false }); await first; await turn();
  assert.deepEqual(h.clock.dueTimes(), [301000]); assert.equal(h.requests[0].start, 1000);
  await h.clock.advanceTo(300999); assert.equal(attempts, 1);
  await h.clock.advanceTo(301000); assert.equal(attempts, 2); assert.deepEqual(h.clock.dueTimes(), [601000]);
  h.sdk.updateConditions({ privacyAccepted: true, foreground: false }); assert.deepEqual(h.clock.dueTimes(), []);
  await h.clock.advanceTo(1501000); assert.equal(attempts, 2);
  h.allow(); await h.clock.advanceTo(1501000); assert.equal(attempts, 3);
  assert.deepEqual(h.clock.dueTimes(), [1801000]);
  assert.ok(h.clock.clockCalls.length > 0); assert.ok(h.clock.clockCalls.every(call => call[0] === 'STARTUP' && call[1] === false));
  h.sdk.updateConditions({ privacyAccepted: false, foreground: true });
  await h.clock.advanceTo(2501000); assert.equal(attempts, 3); await h.sdk.close();
});

test('public conditions: background before target yields Deferred; background after install starts permits active/History completion', async () => {
  const response = pending(), started = pending();
  const before = await publicHarness({ empty: true, provider: async () => { started.resolve(); return response.promise; } });
  before.allow(); const first = before.sdk.prepareStartup(); await started.promise;
  before.sdk.updateConditions({ privacyAccepted: true, foreground: false }); response.resolve(configB);
  assert.equal((await first).kind, 'DEFERRED'); assert.equal(before.sdk.getState().initialFinished, false);
  assert.equal(before.counts().installedCount, 0); await before.sdk.close();
  const after = await publicHarness({ empty: true }); const installing = pending(), installStarted = pending();
  after.hooks.install = async target => { installStarted.resolve(); await installing.promise;
    after.directories.set(target.version, { exists: true, usable: true }); return { success: true, factStage: lowTypes.InstallFactStage.PUBLISHING }; };
  after.allow(); const second = after.sdk.prepareStartup(); await installStarted.promise;
  after.sdk.updateConditions({ privacyAccepted: true, foreground: false }); installing.resolve();
  assert.equal((await second).kind, 'CONTINUE'); assert.equal(after.sdk.getState().active.version, 10002);
  assert.equal(after.sdk.getState().initialFinished, true); assert.equal(after.counts().cancellationCalls, 0);
  assert.deepEqual(after.clock.dueTimes(), []); await after.sdk.close();
});

test('public conditions: ordinary preparation bypasses first-only gates and disabled response after background remains Continue', async () => {
  const regular = await publicHarness(); assert.equal((await regular.sdk.prepareStartup()).kind, 'CONTINUE');
  assert.equal(regular.requests.length, 0); await regular.sdk.close();
  const response = pending(), started = pending();
  const first = await publicHarness({ empty: true, provider: async () => { started.resolve(); return response.promise; } });
  first.allow(); const run = first.sdk.prepareStartup(); await started.promise;
  first.sdk.updateConditions({ privacyAccepted: true, foreground: false }); response.resolve({ enabled: false });
  assert.equal((await run).kind, 'CONTINUE'); assert.equal(first.sdk.getState().initialFinished, true); await first.sdk.close();
});

test('public pages: pending cacheDirty=false persistence never holds first or following load, including online choice', async () => {
  const h = await publicHarness({ dirty: true }); const clean = pending(), started = pending();
  h.hooks.cache = async value => { assert.equal(value, false); started.resolve(); await clean.promise; return true; };
  const originalUrl = 'https://fixture.test/page/index.html?token=opaque#section';
  const page = publicPage(h.events); const result = await h.sdk.loadPage(page, originalUrl); await started.promise;
  assert.equal(result.offline, true); assert.deepEqual(page.urls, [originalUrl]); assert.ok(page.binding);
  const another = publicPage(h.events); assert.equal((await h.sdk.loadPage(another, originalUrl)).offline, true);
  assert.equal(another.clears, 1); assert.equal(h.events.filter(value => value === 'load').length, 2);
  clean.resolve(); await turn(); await h.sdk.close();
  const online = await publicHarness({ empty: true, dirty: true }); const holding = pending();
  online.hooks.cache = async () => { await holding.promise; return true; };
  const onlinePage = publicPage(online.events);
  assert.equal((await online.sdk.loadPage(onlinePage, originalUrl)).offline, false);
  assert.deepEqual(onlinePage.urls, [originalUrl]); holding.resolve(); await turn(); await online.sdk.close();
});

test('public pages: cache-clear exception preserves offline choice, loads originalUrl, then reports diagnostic and retries next page', async () => {
  const h = await publicHarness({ dirty: true }); const page = publicPage(h.events, { clearFails: true });
  const url = 'http://fixture.test:8080/original?a=1#b'; const result = await h.sdk.loadPage(page, url);
  assert.equal(result.offline, true); assert.deepEqual(page.urls, [url]); assert.equal(h.calls.includes('cache:false'), false);
  assert.ok(h.events.indexOf('load') < h.events.indexOf('diagnostic:CACHE_CLEAR'));
  const next = publicPage(h.events); await h.sdk.loadPage(next, url); assert.equal(next.clears, 1);
  await turn(); await h.sdk.close();
});

test('public pages: manager close and privacy withdrawal preserve old enabled binding; alive new page loads original URL online', async () => {
  const h = await publicHarness(); const old = publicPage(h.events); const url = 'https://fixture.test/original';
  assert.equal((await h.sdk.loadPage(old, url)).offline, true); const binding = old.binding;
  h.sdk.updateConditions({ privacyAccepted: false, foreground: false }); assert.equal(binding.isEnabled(), true);
  await h.sdk.close(); assert.equal(binding.isEnabled(), true); assert.equal(old.binding, binding);
  const next = publicPage(h.events); const result = await h.sdk.loadPage(next, url);
  assert.equal(result.offline, false); assert.equal(next.binding, undefined); assert.deepEqual(next.urls, [url]);
});

test('public pages: remote disabled changes old permission while single-load cancellation commits neither load nor ack', async () => {
  const h = await publicHarness({ dirty: true, provider: async () => ({ enabled: false }) });
  const old = publicPage(h.events); await h.sdk.loadPage(old, 'https://fixture.test/index.html');
  const binding = old.binding; await turn(); h.allow(); await h.clock.advanceTo(0);
  assert.equal(binding.isEnabled(), false); assert.equal(h.outcomes.length, 0); await h.sdk.close();
  const cancelled = await publicHarness({ dirty: true }); const cancel = cancelled.cancellation();
  const page = publicPage(cancelled.events, { beforeScope: () => cancel.cancel() });
  await assert.rejects(cancelled.sdk.loadPage(page, 'https://fixture.test/index.html', { cancellation: cancel }), sessionTypes.OfflineCancelledError);
  assert.equal(page.urls.length, 0); assert.equal(page.clears, 0); assert.equal(cancelled.calls.includes('cache:false'), false);
  await cancelled.sdk.close();
});

test('public startup: outcome callback reentry joins the existing first owner lifetime even when failed History was cancelled', async () => {
  let reentry;
  const h = await publicHarness({ empty: true, onOutcome: (_outcome, sdk) => {
    reentry = sdk.prepareStartup(); reentry.catch(() => {});
  } });
  const history = pending(), historyStarted = pending();
  h.hooks.install = async () => ({ success: false, reason: 'DOWNLOAD', factStage: lowTypes.InstallFactStage.DOWNLOADING });
  h.hooks.history = async () => { historyStarted.resolve(); await history.promise; return true; };
  h.allow(); const cancellation = h.cancellation(); const run = h.sdk.prepareStartup({ cancellation });
  await historyStarted.promise; cancellation.cancel(); history.resolve();
  await assert.rejects(run, sessionTypes.OfflineCancelledError);
  await assert.rejects(reentry, sessionTypes.OfflineCancelledError);
  assert.equal(h.requests.length, 1); assert.equal(h.outcomes.length, 1); await h.sdk.close();
});

test('public conditions: privacy withdrawal cancels only SDK owner work and waits native settlement', async () => {
  const h = await publicHarness({ empty: true }); const native = pending(), started = pending();
  h.hooks.install = async () => { started.resolve(); await native.promise; return {
    success: false, reason: 'CANCELLED', factStage: lowTypes.InstallFactStage.DOWNLOADING }; };
  h.allow(); const run = h.sdk.prepareStartup(); await started.promise;
  h.sdk.updateConditions({ privacyAccepted: false, foreground: true });
  assert.equal(h.requests[0].cancellation.isCancelled, true); assert.equal(h.counts().cancellationCalls, 1);
  let settled = false; run.then(() => { settled = true; }, () => { settled = true; });
  await turn(); assert.equal(settled, false); native.resolve(); await assert.rejects(run, sessionTypes.OfflineCancelledError);
  assert.equal(h.outcomes.length, 0); assert.equal(h.sdk.getState().initialFinished, false);
  await h.clock.advanceTo(1000000); assert.equal(h.requests.length, 1); await h.sdk.close();
});

test('public startup: cancellation in active save remains unknown until native settles; next natural startup refreshes only active', async () => {
  const h = await publicHarness({ empty: true }); const writing = pending(), started = pending();
  h.hooks.active = async record => { started.resolve(); await writing.promise; h.media.active = record; return true; };
  h.allow(); const cancellation = h.cancellation(); const run = h.sdk.prepareStartup({ cancellation });
  await started.promise; cancellation.cancel(); writing.resolve(); await assert.rejects(run, sessionTypes.OfflineCancelledError);
  assert.equal(h.sdk.getState().active, undefined); assert.equal(h.sdk.getState().initialFinished, false);
  assert.equal(h.outcomes.length, 0); delete h.hooks.active;
  assert.equal((await h.sdk.prepareStartup()).kind, 'CONTINUE'); assert.equal(h.sdk.getState().active.version, 10002);
  assert.equal(h.counts().reloadCount, 1); assert.equal(h.requests.length, 1); assert.equal(h.outcomes.length, 0);
  await h.sdk.close();
});

test('public startup: outcome callback can reenter normally and throw without revoking established success', async () => {
  let joining;
  const h = await publicHarness({ empty: true, onOutcome: (_outcome, sdk) => {
    joining = sdk.prepareStartup(); throw new Error('host outcome observer');
  } });
  h.allow(); assert.equal((await h.sdk.prepareStartup()).outcome.success, true);
  assert.equal((await joining).kind, 'CONTINUE'); assert.equal(h.requests.length, 1);
  assert.equal(h.outcomes.length, 1); assert.equal(h.sdk.getState().initialFinished, true); await h.sdk.close();
});

test('public startup: waiter arriving after COMPLETE still waits original first History and receives its shared result', async () => {
  const h = await publicHarness({ empty: true }); const history = pending(), started = pending();
  h.hooks.history = async () => { started.resolve(); await history.promise; return true; };
  h.allow(); const owner = h.sdk.prepareStartup(); await started.promise;
  const waiter = h.sdk.prepareStartup(); let settled = false;
  waiter.then(() => { settled = true; }, () => { settled = true; }); await turn();
  assert.equal(settled, false); assert.equal(h.outcomes.length, 0);
  history.resolve(); const [first, second] = await Promise.all([owner, waiter]);
  assert.equal(second.outcome.targetVersion, first.outcome.targetVersion);
  assert.equal(h.requests.length, 1); assert.equal(h.outcomes.length, 1); await h.sdk.close();
});

test('public startup: pending active save stays SAVING and ordinary save failure never confirms or completes', async () => {
  const h = await publicHarness({ empty: true }); const writing = pending(), started = pending(), progress = [];
  h.hooks.active = async () => { started.resolve(); await writing.promise; return false; };
  h.allow(); const work = h.sdk.prepareStartup({ onProgress: value => progress.push(value) });
  await started.promise;
  assert.equal(progress.at(-1).stage, 'saving'); assert.equal(progress.at(-1).percent, -1);
  assert.equal(progress.some(value => value.stage === 'confirming' || value.stage === 'complete'), false);
  assert.equal(h.sdk.getState().active, undefined); assert.equal(h.outcomes.length, 0);
  writing.resolve(); const result = await work;
  assert.equal(result.kind, 'CONTINUE'); assert.equal(result.outcome.reason, 'SAVE_ACTIVE');
  assert.equal(progress.some(value => value.stage === 'confirming' || value.percent === 100), false);
  assert.equal(h.outcomes.length, 1); await h.sdk.close();
});

test('public startup: pending final entry confirmation stays CONFIRMING and emits COMPLETE only after actual activation', async () => {
  const h = await publicHarness({ empty: true }); const confirmation = pending(), started = pending(), progress = [];
  let observations = 0;
  h.hooks.observe = async record => {
    observations++;
    if (observations === 3) { started.resolve(); await confirmation.promise; }
    return { exists: observations > 1, directory: observations > 1 ? '/sandbox/managed/' + record.version : '' };
  };
  h.allow(); const work = h.sdk.prepareStartup({ onProgress: value => progress.push(value) });
  await started.promise;
  assert.equal(progress.at(-1).stage, 'confirming'); assert.equal(progress.at(-1).percent, -1);
  assert.equal(progress.some(value => value.stage === 'complete'), false);
  assert.equal(h.sdk.getState().active, undefined); assert.equal(h.media.active.version, 10002);
  assert.equal(h.outcomes.length, 0);
  confirmation.resolve(); assert.equal((await work).outcome.success, true);
  assert.equal(h.sdk.getState().active.version, 10002);
  assert.equal(progress.filter(value => value.stage === 'complete' && value.percent === 100).length, 1);
  await h.sdk.close();
});

test('public silent update: History settlement keeps target outcome inside permit until normal or cancelled release', async () => {
  for (const succeeds of [false, true]) {
    for (const cancelHistory of [false, true]) {
      const h = await publicHarness(); const history = pending(), started = pending();
      assert.equal((await h.sdk.prepareStartup()).kind, 'CONTINUE');
      if (!succeeds) h.hooks.install = async () => ({ success: false, reason: 'DOWNLOAD',
        factStage: lowTypes.InstallFactStage.DOWNLOADING });
      h.hooks.history = async () => { h.events.push('history-start'); started.resolve();
        await history.promise; h.events.push('history-settled'); return true; };
      h.allow(); await h.clock.advanceTo(0); await started.promise;
      assert.equal(h.sdk.getState().checking, true); assert.equal(h.outcomes.length, 0);
      assert.equal(h.sdk.getState().active.version, succeeds ? 10002 : 10001);
      if (!succeeds) assert.equal(h.sdk.getState().highestFailedVersion, 10002);
      if (cancelHistory) h.sdk.updateConditions({ privacyAccepted: false, foreground: true });
      history.resolve(); await turn();
      assert.equal(h.sdk.getState().checking, false); assert.equal(h.outcomes.length, 1);
      assert.equal(h.outcomes[0].checking, false); assert.equal(h.outcomes[0].outcome.success, succeeds);
      assert.ok(h.events.indexOf('history-settled') < h.events.indexOf('outcome'));
      assert.equal(h.sdk.getState().initialFinished, true, 'regular work retains prior first completion');
      assert.equal(h.diagnostics.some(value => value.reason === 'LOCAL_STATE_READ'), false);
      await h.sdk.close();
    }
  }
});

// HM-R1：只通过公开入口验证monitor；保留publicClock的30轮循环保护。
test('HM-R1 public monitor: persistent cold cleanup failure without provider origin yields one normal interval and natural recovery', async () => {
  const h = await publicHarness({ provider: async () => ({ enabled: false }) });
  h.hooks.cleanup = async () => { throw new Error('cleanup unavailable'); };
  const originalUrl = 'https://fixture.test/index.html?keep=1#origin';
  try {
    h.allow(); const page = publicPage(h.events); const loaded = await h.sdk.loadPage(page, originalUrl);
    assert.equal(loaded.offline, false); assert.deepEqual(page.urls, [originalUrl]);
    assert.equal(h.sdk.getState().initialFinished, true); assert.equal(h.requests.length, 0);
    assert.equal(h.calls.filter(value => value.startsWith('cleanup:')).length, 1);
    await h.clock.advanceTo(0);
    assert.equal(h.calls.filter(value => value.startsWith('cleanup:')).length, 2);
    assert.equal(h.diagnostics.length, 2); assert.deepEqual(h.clock.dueTimes(), [300000]);
    await h.clock.advanceTo(299999);
    assert.equal(h.calls.filter(value => value.startsWith('cleanup:')).length, 2);
    assert.equal(h.diagnostics.length, 2); assert.equal(h.requests.length, 0);
    await h.clock.advanceTo(300000);
    assert.equal(h.calls.filter(value => value.startsWith('cleanup:')).length, 3);
    assert.equal(h.diagnostics.length, 3); assert.deepEqual(h.clock.dueTimes(), [600000]);
    assert.equal(h.requests.length, 0); assert.equal(h.counts().installedCount, 0);
    delete h.hooks.cleanup;
    const restored = publicPage(h.events); assert.equal((await h.sdk.loadPage(restored, originalUrl)).offline, true);
    assert.deepEqual(restored.urls, [originalUrl]); assert.equal(h.requests.length, 0);
    assert.deepEqual(h.clock.dueTimes(), [600000]);
    await h.clock.advanceTo(600000); assert.equal(h.requests.length, 1); assert.equal(h.requests[0].start, 600000);
    assert.deepEqual(h.clock.dueTimes(), [900000]);
  } finally { await h.sdk.close(); }
});

test('HM-R1 public monitor: persistent medium recovery failure without provider origin retries only on normal expiry', async () => {
  const h = await publicHarness({ provider: async () => ({ enabled: true, version: 10001 }) });
  try {
    assert.equal((await h.sdk.prepareStartup()).kind, 'CONTINUE');
    h.hooks.reopen = async () => { throw new Error('medium unavailable'); };
    h.allow(); const before = h.calls.filter(value => value === 'reopen').length;
    await h.clock.advanceTo(0);
    assert.equal(h.calls.filter(value => value === 'reopen').length, before + 1);
    assert.equal(h.diagnostics.at(-1).reason, 'LOCAL_STATE_READ'); assert.equal(h.requests.length, 0);
    assert.deepEqual(h.clock.dueTimes(), [300000]);
    await h.clock.advanceTo(299999);
    assert.equal(h.calls.filter(value => value === 'reopen').length, before + 1);
    await h.clock.advanceTo(300000);
    assert.equal(h.calls.filter(value => value === 'reopen').length, before + 2);
    assert.equal(h.diagnostics.length, 2); assert.deepEqual(h.clock.dueTimes(), [600000]);
    delete h.hooks.reopen; await h.clock.advanceTo(600000);
    assert.equal(h.requests.length, 1); assert.equal(h.requests[0].currentVersion, 10001);
    assert.equal(h.requests[0].start, 600000); assert.deepEqual(h.clock.dueTimes(), [900000]);
    assert.equal(h.counts().installedCount, 0);
  } finally { await h.sdk.close(); }
});

test('HM-R1 public monitor: already expired real provider TTL plus medium failure yields once, then natural entry and real TTL resume', async () => {
  const h = await publicHarness({ start: 1000, provider: async () => ({ enabled: true, version: 10001 }) });
  try {
    await h.sdk.prepareStartup(); h.allow(); await h.clock.advanceTo(1000);
    assert.equal(h.requests.length, 1); assert.equal(h.requests[0].start, 1000);
    assert.deepEqual(h.clock.dueTimes(), [301000]);
    h.hooks.reopen = async () => { throw new Error('medium unavailable'); };
    const before = h.calls.filter(value => value === 'reopen').length;
    await h.clock.advanceTo(901000);
    assert.equal(h.calls.filter(value => value === 'reopen').length, before + 1);
    assert.equal(h.requests.length, 1); assert.equal(h.diagnostics.length, 1);
    assert.deepEqual(h.clock.dueTimes(), [1201000]);
    await h.clock.advanceTo(1200999); assert.equal(h.requests.length, 1);
    assert.equal(h.calls.filter(value => value === 'reopen').length, before + 1);
    delete h.hooks.reopen; const page = publicPage(h.events);
    assert.equal((await h.sdk.loadPage(page, 'https://fixture.test/index.html')).offline, true);
    assert.deepEqual(h.clock.dueTimes(), [1201000]); assert.equal(h.requests.length, 1);
    await h.clock.advanceTo(1201000);
    assert.equal(h.requests.length, 2); assert.equal(h.requests[1].start, 1201000);
    assert.deepEqual(h.clock.dueTimes(), [1501000]);
    await h.clock.advanceTo(1500999); assert.equal(h.requests.length, 2);
    await h.clock.advanceTo(1501000); assert.equal(h.requests.length, 3);
    assert.equal(h.requests[2].start, 1501000); assert.equal(h.counts().installedCount, 0);
  } finally { await h.sdk.close(); }
});

test('HM-R1 public monitor: repeated conditions and failing page entries preserve the no-provider yield deadline', async () => {
  const h = await publicHarness(); h.hooks.cleanup = async () => { throw new Error('cleanup unavailable'); };
  try {
    h.allow(); await h.sdk.loadPage(publicPage(h.events), 'https://fixture.test/index.html');
    await h.clock.advanceTo(0); assert.deepEqual(h.clock.dueTimes(), [300000]);
    for (let entry = 0; entry < 3; entry++) {
      await h.clock.advanceTo(10000 + entry * 10000); h.allow(); h.allow();
      assert.equal((await h.sdk.loadPage(publicPage(h.events), 'https://fixture.test/index.html')).offline, false);
      assert.deepEqual(h.clock.dueTimes(), [300000]);
      const attempts = h.calls.filter(value => value.startsWith('cleanup:')).length;
      const diagnostics = h.diagnostics.length; await h.clock.advanceTo(h.clock.now());
      assert.equal(h.calls.filter(value => value.startsWith('cleanup:')).length, attempts);
      assert.equal(h.diagnostics.length, diagnostics); assert.equal(h.requests.length, 0);
    }
    await h.clock.advanceTo(299999); assert.equal(h.requests.length, 0);
    const attempts = h.calls.filter(value => value.startsWith('cleanup:')).length;
    await h.clock.advanceTo(300000);
    assert.equal(h.calls.filter(value => value.startsWith('cleanup:')).length, attempts + 1);
    assert.deepEqual(h.clock.dueTimes(), [600000]); assert.equal(h.requests.length, 0);
  } finally { await h.sdk.close(); }
});

test('HM-R1 public monitor: background privacy withdrawal and close stop yield waits; resume creates one round without backlog', async () => {
  for (const stop of ['background', 'privacy', 'close']) {
    const h = await publicHarness({ provider: async () => ({ enabled: true, version: 10001 }) });
    h.hooks.cleanup = async () => { throw new Error('cleanup unavailable'); };
    try {
      h.allow(); await h.sdk.loadPage(publicPage(h.events), 'https://fixture.test/index.html');
      await h.clock.advanceTo(0); assert.deepEqual(h.clock.dueTimes(), [300000]);
      const attempts = h.calls.filter(value => value.startsWith('cleanup:')).length;
      if (stop !== 'close') {
        const diagnostics = h.diagnostics.length;
        await h.clock.advanceTo(100000);
        h.sdk.updateConditions({ privacyAccepted: stop !== 'privacy', foreground: stop !== 'background' });
        assert.deepEqual(h.clock.dueTimes(), []);
        await h.clock.advanceTo(150000);
        assert.equal(h.calls.filter(value => value.startsWith('cleanup:')).length, attempts);
        assert.equal(h.diagnostics.length, diagnostics); assert.equal(h.requests.length, 0);
        h.allow(); assert.deepEqual(h.clock.dueTimes(), [300000]);
        await h.clock.advanceTo(299999);
        assert.equal(h.calls.filter(value => value.startsWith('cleanup:')).length, attempts);
        assert.equal(h.diagnostics.length, diagnostics); assert.equal(h.requests.length, 0);
      }
      if (stop === 'close') await h.sdk.close();
      else h.sdk.updateConditions({ privacyAccepted: stop !== 'privacy', foreground: stop !== 'background' });
      assert.deepEqual(h.clock.dueTimes(), []); await h.clock.advanceTo(1500000);
      assert.equal(h.calls.filter(value => value.startsWith('cleanup:')).length, attempts);
      assert.equal(h.requests.length, 0);
      if (stop === 'close') {
        h.allow(); await h.clock.advanceTo(1800000); assert.deepEqual(h.clock.dueTimes(), []);
        assert.equal(h.calls.filter(value => value.startsWith('cleanup:')).length, attempts); continue;
      }
      h.allow(); const next = h.clock.dueTimes();
      assert.equal(next.length, 1); assert.ok(next[0] >= h.clock.now() && next[0] <= h.clock.now() + 300000);
      await h.clock.advanceTo(next[0]);
      assert.equal(h.calls.filter(value => value.startsWith('cleanup:')).length, attempts + 1);
      assert.equal(h.requests.length, 0); assert.deepEqual(h.clock.dueTimes(), [h.clock.now() + 300000]);
      delete h.hooks.cleanup; await h.clock.advanceTo(h.clock.dueTimes()[0]);
      assert.equal(h.requests.length, 1); assert.equal(h.counts().installedCount, 0);
      assert.deepEqual(h.clock.dueTimes(), [h.requests[0].start + 300000]);
    } finally { await h.sdk.close(); }
  }
});

test('HM-R1 public monitor: long real provider request keeps its origin, yields no artificial tail interval and accumulates no parallel work', async () => {
  const response = pending(), started = pending(); let attempts = 0, running = 0, maximum = 0;
  const h = await publicHarness({ provider: async () => {
    attempts++; running++; maximum = Math.max(maximum, running);
    try { if (attempts === 1) { started.resolve(); return await response.promise; }
      return { enabled: true, version: 10001 }; } finally { running--; }
  } });
  try {
    await h.sdk.prepareStartup(); h.allow(); await h.clock.advanceTo(0); await started.promise;
    assert.equal(h.requests[0].start, 0); assert.equal(h.sdk.getState().checking, true);
    await h.clock.advanceTo(900000); h.allow(); h.allow();
    h.sdk.updateConditions({ privacyAccepted: true, foreground: false }); h.allow();
    assert.equal(h.requests.length, 1); assert.deepEqual(h.clock.dueTimes(), []);
    response.resolve({ enabled: true, version: 10001 }); await turn();
    assert.deepEqual(h.clock.dueTimes(), [900000], 'expired actual provider TTL schedules now, not finish+300000');
    await h.clock.advanceTo(900000);
    assert.equal(h.requests.length, 2); assert.equal(h.requests[1].start, 900000); assert.equal(maximum, 1);
    assert.deepEqual(h.clock.dueTimes(), [1200000]);
    await h.clock.advanceTo(1199999); assert.equal(h.requests.length, 2);
    await h.clock.advanceTo(1200000); assert.equal(h.requests.length, 3); assert.equal(maximum, 1);
    assert.equal(h.counts().installedCount, 0);
  } finally { response.resolve({ enabled: false }); await h.sdk.close(); }
});
