const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require(process.env.OFFLINE_TEST_TYPESCRIPT || 'typescript');
function compile(file, imports = {}) {
  const module = { exports: {} };
  const output = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, experimentalDecorators: true }
  }).outputText;
  vm.runInThisContext('(function(require,module,exports,Observed){' + output + '\n})')(
    name => { if (!(name in imports)) throw new Error('Unexpected import ' + name); return imports[name]; },
    module, module.exports, value => value);
  return module.exports;
}
const types = compile('../src/main/ets/ManagedOfflineTypes.ets');
const stages = types.ManagedProgressStage;
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  let calls = 0, resolve, reject, progress, cancellation, privacy = true, foreground = true, businessReady;
  const listeners = [];
  const manager = { prepareStartup(options) {
    calls++; progress = options.onProgress; cancellation = options.cancellation;
    return new Promise((yes, no) => { resolve = yes; reject = no; });
  } };
  const DemoOffline = { create: async () => manager, get privacyAccepted() { return privacy; },
    get canNavigate() { return privacy && foreground; },
    setPrivacyAccepted(value) { privacy = value; listeners.forEach(listener => listener()); },
    observe(listener) { listeners.push(listener); return () => listeners.splice(listeners.indexOf(listener), 1); } };
  const exports = compile('../../entry/src/main/ets/viewmodel/SplashViewModel.ets', {
    'com.offline.tool': types, '../data/DemoOffline': { DemoOffline }
  });
  const model = new exports.SplashViewModel();
  model.attach({ resourceManager: { getStringByName: () => new Promise(resolve => { businessReady = resolve; }) } });
  return { model, startupText: exports.startupText, calls: () => calls,
    resolve: value => resolve(value), reject: value => reject(value), progress: value => progress(value),
    cancellation: () => cancellation, businessReady: () => businessReady('demo'),
    foreground(value) { foreground = value; listeners.forEach(listener => listener()); },
    privacy: value => DemoOffline.setPrivacyAccepted(value) };
}

test('retry resets all visible state before awaiting work and a duplicate call does not start an owner', async () => {
  const h = setup(); const first = h.model.start(); await tick();
  h.reject(new Error('unexpected')); await first;
  assert.equal(h.model.failed, true);
  const retry = h.model.start();
  assert.equal(h.model.failed, false); assert.equal(h.model.running, true);
  assert.equal(h.model.text, '正在准备启动配置…'); assert.equal(h.model.percent, -1);
  assert.equal(h.model.showProgress, false); assert.equal(h.model.diagnostic, '');
  await h.model.start(); await tick(); assert.equal(h.calls(), 2);
  h.resolve({ kind: types.StartupKind.CONTINUE }); await retry;
  assert.equal(h.model.ready, false);
  h.businessReady(); await tick(); assert.equal(h.model.ready, true);
});

test('Managed stage UI is complete; Checking is neutral, unknown download/extraction stay indeterminate', async () => {
  const h = setup(); const pending = h.model.start(); await tick();
  const texts = ['正在检查离线配置…', '正在准备离线资源…', '正在下载资源包…', '正在校验资源包…',
    '正在解压资源包…', '正在保存版本记录…', '正在确认离线资源…', '离线资源准备完成'];
  Object.values(stages).forEach((stage, index) => {
    assert.equal(h.startupText(stage), texts[index]);
    h.progress({ stage, percent: -1 });
    assert.equal(h.model.showProgress, stage !== stages.CHECKING);
    assert.equal(h.model.percent, stage === stages.COMPLETE ? 100 : -1);
  });
  h.progress({ stage: stages.DOWNLOADING, percent: 42 }); assert.equal(h.model.percent, 42);
  h.progress({ stage: stages.DOWNLOADING, percent: 100 }); assert.equal(h.model.percent, 99);
  for (const stage of [stages.EXTRACTING, stages.SAVING, stages.CONFIRMING]) {
    h.progress({ stage, percent: 99 }); assert.equal(h.model.percent, -1);
    assert.equal(h.model.ready, false);
  }
  h.resolve({ kind: types.StartupKind.CONTINUE }); await pending;
});

test('ordinary offline failure Continue waits for business readiness and lawful navigation conditions', async () => {
  const h = setup(); const pending = h.model.start(); await tick();
  h.resolve({ kind: types.StartupKind.CONTINUE, outcome: { success: false, targetVersion: 10000,
    targetSha256: 'a'.repeat(64), reason: types.ManagedFailureReason.INSTALL,
    stage: types.ManagedFailureStage.VERIFYING } });
  await pending;
  assert.equal(h.model.failed, false); assert.equal(h.model.ready, false);
  assert.equal(h.model.text, '离线资源准备未完成，将继续在线加载');
  h.model.enterPage(); assert.equal(h.model.showWeb, false);
  h.businessReady(); await tick(); assert.equal(h.model.ready, true);
  h.foreground(false); h.model.enterPage(); assert.equal(h.model.showWeb, false);
  h.foreground(true); h.privacy(false); h.model.enterPage(); assert.equal(h.model.showWeb, false);
  h.privacy(true); h.model.enterPage(); assert.equal(h.model.showWeb, true);
});

test('Deferred and true cancellation remain resumable without premature navigation', async () => {
  const h = setup(); h.businessReady(); const first = h.model.start(); await tick();
  h.resolve({ kind: types.StartupKind.DEFERRED }); await first;
  assert.equal(h.model.deferred, true); assert.equal(h.model.ready, false); assert.equal(h.model.failed, false);
  const second = h.model.start(); await tick(); assert.equal(h.model.deferred, false);
  h.reject(new types.OfflineCancelledError()); await second;
  assert.equal(h.model.deferred, true); assert.equal(h.model.ready, false);
});

test('disposed startup cancels only its caller and ignores late progress/result', async () => {
  const h = setup(); const pending = h.model.start(); await tick();
  h.model.dispose(); assert.equal(h.cancellation().isCancelled, true);
  h.progress({ stage: stages.DOWNLOADING, percent: 45 });
  h.resolve({ kind: types.StartupKind.CONTINUE }); await pending;
  h.businessReady(); await tick(); assert.equal(h.model.ready, false);
  assert.equal(h.model.text, '正在准备启动配置…');
});

test('application singleton preserves one manager and updates the latest host facts synchronously after creation', async () => {
  let creates = 0, finish, conditions = [], observed = 0;
  const manager = { updateConditions: value => conditions.push(value) };
  const { DemoOffline } = compile('../../entry/src/main/ets/data/DemoOffline.ets', {
    'com.offline.tool': { ManagedOfflineSdk: { create(context, options) {
      creates++; assert.equal(typeof options.configProvider, 'function'); assert.equal(options.keyValueStore, undefined);
      return new Promise(resolve => { finish = resolve; });
    } } }, './DemoRepository': { DemoRepository: class { fetchConfig() {} } },
    './DemoKeyValueStore': { DemoKeyValueStore: class {} }, './DemoConfig': { DEMO_USE_KEY_VALUE_STORE: false }
  });
  const a = DemoOffline.create({ filesDir: '/app' }), b = DemoOffline.create({ filesDir: '/app' });
  assert.equal(a, b); assert.equal(creates, 1);
  DemoOffline.setPrivacyAccepted(true); DemoOffline.setForeground(true);
  const stop = DemoOffline.observe(() => observed++);
  finish(manager); await a; await tick();
  assert.deepEqual(conditions.at(-1), { privacyAccepted: true, foreground: true });
  DemoOffline.setForeground(false);
  assert.deepEqual(conditions.at(-1), { privacyAccepted: true, foreground: false });
  assert.equal(observed, 1); stop(); DemoOffline.setForeground(true); assert.equal(observed, 1);
  assert.equal(DemoOffline.canNavigate, true);
});

test('thin config provider maps cancellation back to caller and closes its own RCP session', async () => {
  let reject, cancelled = 0, closed = 0;
  const { DemoRepository } = compile('../../entry/src/main/ets/data/DemoRepository.ets', {
    '@kit.RemoteCommunicationKit': { rcp: { Request: class {}, createSession: () => ({
      fetch: () => new Promise((resolve, no) => { reject = no; }),
      cancel: () => { cancelled++; reject(new Error('native cancellation')); }, close: () => closed++
    }) } }, './DemoConfig': { DEMO_CONFIG_URL: 'http://demo.test/config.json' }
  });
  const cancellation = new types.OfflineCancellation();
  const pending = new DemoRepository().fetchConfig({ cancellation }); cancellation.cancel();
  await assert.rejects(pending, types.OfflineCancelledError);
  assert.equal(cancelled, 1); assert.equal(closed, 1);
});

test('config provider forwards a typed response without choosing versions or changing original URLs', async () => {
  const config = { enabled: true, version: 3, sha256: 'invalid-business-sha', url: 'http://demo.test/sample.zip?key=a#original' };
  let request, closed = 0;
  const { DemoRepository } = compile('../../entry/src/main/ets/data/DemoRepository.ets', {
    '@kit.RemoteCommunicationKit': { rcp: {
      Request: class { constructor(url) { this.url = url; request = this; } },
      createSession: () => ({ fetch: async () => ({ statusCode: 200, toJSON: () => config }),
        cancel() {}, close: () => closed++ })
    } }, './DemoConfig': { DEMO_CONFIG_URL: 'http://demo.test/config.json' }
  });
  const result = await new DemoRepository().fetchConfig({ cancellation: new types.OfflineCancellation() });
  assert.equal(result, config); assert.equal(result.version, 3);
  assert.equal(result.url, config.url); assert.equal(request.url, 'http://demo.test/config.json');
  assert.equal(closed, 1);
});

test('privacy agreement is a host fact and prevents premature startup calls', async () => {
  const h = setup(); h.privacy(false); await h.model.start();
  assert.equal(h.calls(), 0); assert.equal(h.model.needsConsent, true);
  h.model.acceptPrivacy(); await tick(); assert.equal(h.calls(), 1);
  h.resolve({ kind: types.StartupKind.CONTINUE }); await tick();
  assert.equal(h.model.ready, false); h.businessReady(); await tick(); assert.equal(h.model.ready, true);
});
