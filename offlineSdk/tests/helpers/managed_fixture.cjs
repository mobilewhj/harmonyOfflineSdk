const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(process.env.OFFLINE_TEST_TYPESCRIPT || 'typescript');
const source = process.env.OFFLINE_TEST_SDK_ETS_ROOT || (process.env.OFFLINE_SDK_ROOT ? path.resolve(process.env.OFFLINE_SDK_ROOT, 'src/main/ets') : path.resolve(__dirname, '../../src/main/ets'));
function load(name, dependencies = {}, runtime = {}) {
  const output = ts.transpileModule(fs.readFileSync(path.join(source, name + '.ets'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const module = { exports: {} };
  vm.runInThisContext('(function(require,module,exports,setTimeout,clearTimeout){' + output + '\n})')(
    id => { if (!(id in dependencies)) throw new Error('Unexpected import ' + id); return dependencies[id]; },
    module, module.exports, runtime.setTimeout ?? setTimeout, runtime.clearTimeout ?? clearTimeout);
  return module.exports;
}
const types = load('ManagedOfflineTypes'), low = load('OfflineTypes');
const worker = load('InstallWorker', { '@kit.CoreFileKit': {}, '@kit.CryptoArchitectureKit': {},
  '@kit.RemoteCommunicationKit': {}, '@kit.ArkTS': { url: { URL } }, '@kit.BasicServicesKit': {},
  './PackageArchive': {}, './OfflineTypes': low, './PackageFiles': {} });
const PackageStage = { DOWNLOADING: 'downloading', DOWNLOADED: 'downloaded', READY: 'ready', ACTIVE: 'active' };
class PackageIdentityConflictError extends Error {}
const storageApi = { PackageStage, PackageIdentityConflictError };
const A = { version: 10001, sha256: 'a'.repeat(64) }, B = { version: 10002, sha256: 'b'.repeat(64) };
const config = record => ({ enabled: true, ...record, url: 'http://fixture.test:9080/package.zip' });
const turn = () => new Promise(resolve => setImmediate(resolve));
function pending() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness(options = {}) {
  const media = options.media ?? { rows: options.empty ? [] : [{ ...A, stage: 'active' }] };
  const directories = options.directories ?? new Map(options.empty ? [] : [[A.version, '/sandbox/lifecycle/10001']]);
  const calls = [], events = [], diagnostics = [], progress = [], hooks = {};
  let installs = 0, cancels = 0, now = 0;
  const storage = {
    async load() { calls.push('read'); if (hooks.read) return hooks.read(); return structuredClone(media.rows); },
    async registerTarget(record) {
      calls.push('register:' + record.version); if (hooks.register) return hooks.register(record);
      const old = media.rows.find(row => row.version === record.version);
      if (old && old.sha256 !== record.sha256) throw new PackageIdentityConflictError();
      media.rows = media.rows.filter(row => row.version === record.version || row.stage === 'active');
      if (!old) media.rows.push({ version: record.version, sha256: record.sha256, stage: 'downloading' });
    },
    async setStage(record, stage) {
      calls.push(stage + ':' + record.version); if (hooks.stage) return hooks.stage(record, stage);
      const row = media.rows.find(row => row.version === record.version && row.sha256 === record.sha256);
      if (!row || row.stage === 'active') return false;
      if (stage === 'ready' && media.rows.some(value => value.stage === 'ready' && value !== row)) return false;
      row.stage = stage; return true;
    },
    async activate(record) {
      calls.push('activate:' + record.version); if (hooks.activate) return hooks.activate(record);
      const row = media.rows.find(row => row.version === record.version && row.sha256 === record.sha256 && row.stage === 'ready');
      if (!row) throw new Error('Not ready'); media.rows = media.rows.filter(value => value.stage !== 'active'); row.stage = 'active';
    },
    async evictInactive(keep) { calls.push('evict:' + keep); if (hooks.evict) return hooks.evict(keep);
      if (media.rows.some(row => row.version === keep && row.stage === 'active')) media.rows = media.rows.filter(row => row.version === keep); }
  };
  const installer = {
    cancel() { cancels++; },
    async cleanupLifecycle(root, keep) { calls.push('cleanup:' + keep.sort().join(',')); if (hooks.cleanup) await hooks.cleanup(keep);
      for (const version of directories.keys()) if (!keep.includes(String(version))) directories.delete(version); },
    async deleteManagedZip(root, version) { calls.push('deleteZip:' + version); if (hooks.deleteZip) await hooks.deleteZip(version); },
    async installManaged(root, target, callback, onStage) {
      installs++; calls.push('install:' + target.version); if (hooks.install) return hooks.install(target, callback, onStage);
      await onStage('downloading'); callback?.({ stage: 'downloading', percent: 43, downloadTotalKnown: true });
      await onStage('downloaded'); directories.set(target.version, root + '/' + target.version);
      return { success: true, requestStarted: true, factStage: 'extracting' };
    }
  };
  const packageApi = { PackageInstaller: class {}, normalizePackageRoot: value => value, claimManagedRoot: async () => installer,
    async observePackage(root, record) { calls.push('observe:' + record.version); if (hooks.observe) return hooks.observe(record);
      return { directory: directories.get(record.version) ?? '', exists: directories.has(record.version) }; } };
  const { ManagedPackageSession } = load('ManagedPackageSession', { './PackageInstaller': packageApi,
    './InstallWorker': worker, './ManagedStorage': storageApi, './OfflineTypes': low, './ManagedOfflineTypes': types });
  const session = new ManagedPackageSession('/sandbox/lifecycle', installer, storage, 10000,
    value => diagnostics.push(value), value => { calls.push('event:' + value.kind); events.push(value); hooks.event?.(value); },
    () => { calls.push('cache'); hooks.cleaner?.(); }, () => now);
  const cancel = () => new types.OfflineCancellation();
  return { session, Session: ManagedPackageSession, packageApi, media, directories, storage, installer, hooks,
    calls, events, diagnostics, progress, cancel, setNow: value => { now = value; }, counts: () => ({ installs, cancels }),
    prepare: token => session.prepareLocal(token ?? cancel()),
    check: (value = config(B), token = cancel(), canStart = () => true, initial = false) => session.check(value, token, value => progress.push(value), canStart, initial) };
}
function clock(start = 0) {
  let now = start, next = 1; const timers = new Map(), clockCalls = [];
  return { now: () => now, clockCalls, systemDateTime: { TimeType: { STARTUP: 0 }, getUptime: (type,nano) => { clockCalls.push([type,nano]); return now; } },
    setTimeout(callback, delay) { const id = next++; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, due: () => [...timers.values()].map(timer => timer.at).sort((a,b) => a-b),
    async advance(value) { now = value; for (let pass = 0; pass < 30; pass++) {
      const due = [...timers].filter(([, timer]) => timer.at <= now);
      for (const [id, timer] of due) if (timers.delete(id)) timer.callback();
      await turn(); if (![...timers.values()].some(timer => timer.at <= now)) return;
    } throw new Error('Unexpected zero-delay loop'); }
  };
}
async function publicHarness(options = {}) {
  const h = harness(options), time = clock(options.start ?? 0), requests = [], outcomes = [], events = [];
  const { ManagedOfflineSdk } = load('ManagedOfflineSdk', { '@kit.AbilityKit': {},
    '@kit.BasicServicesKit': { systemDateTime: time.systemDateTime }, './PackageInstaller': h.packageApi,
    './ManagedStorage': { ManagedStorage: class { constructor() { return h.storage; } } },
    './ManagedPackageSession': { ManagedPackageSession: h.Session }, './ManagedPage': {}, './ManagedOfflineTypes': types }, time);
  let sdk;
  sdk = await ManagedOfflineSdk.create({ filesDir: '/sandbox', preferencesDir: '/sandbox/prefs' }, {
    configProvider: async request => { requests.push({ ...request, at: time.now() }); return options.provider ? options.provider(request, sdk) : config(B); },
    onEvent: value => { events.push(value); options.onEvent?.(value, sdk); }, onDiagnostic: value => h.diagnostics.push(value),
    resourceCacheCleaner: () => { h.calls.push('cache'); h.hooks.cleaner?.(); },
    onInstallationOutcome: outcome => { outcomes.push(outcome); options.onOutcome?.(outcome, sdk); }
  });
  return { ...h, sdk, time, requests, outcomes, sdkEvents: events, allow: () => sdk.updateConditions({ privacyAccepted: true, foreground: true }) };
}
function page(hooks = {}) {
  let generation = 0;
  return { urls: [], binding: undefined, startLoad: () => ++generation, canBindUrl: () => true,
    isLoadCurrent: (value, token) => value === generation && !token.isCancelled,
    runScopedTask(callback) { hooks.scope?.(); callback(); }, commitLoad(url, binding) { this.urls.push(url); this.binding = binding; } };
}
module.exports = { load, types, low, worker, storageApi, A, B, config, harness, publicHarness, pending, turn, page };
