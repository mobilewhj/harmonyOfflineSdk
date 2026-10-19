// 执行真实 Page/资源/路径代码，Node 文件系统与 ArkWeb/UI API double 只验证源码行为。
// 此处不证明真实 removeCache 效果、Web FD 释放或回调线程；这些仍需设备证据。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const ts = require(process.env.OFFLINE_TEST_TYPESCRIPT || 'typescript');
const source = process.env.OFFLINE_TEST_SDK_ETS_ROOT || path.resolve(__dirname, '../src/main/ets');
const lifecycleStorageTypes = { PackageStage: { ACTIVE: 'active', READY: 'ready', DOWNLOADING: 'downloading', DOWNLOADED: 'downloaded' } };
const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'harmony-managed-page-'));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

function load(name, dependencies = {}, responseType) {
  const file = path.join(source, name + '.ets');
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const module = { exports: {} };
  vm.runInThisContext('(function(require,module,exports,WebResourceResponse){' + output + '\n})', { filename: file })(
    name => { if (!(name in dependencies)) throw new Error('Missing system double: ' + name); return dependencies[name]; },
    module, module.exports, responseType);
  return module.exports;
}

function setup(baseUrl = 'http://fixture.test:9080/site/', shareHttpAndHttps = false) {
  const closed = [], events = [];
  const io = {
    OpenMode: { READ_ONLY: fs.constants.O_RDONLY, NOFOLLOW: fs.constants.O_NOFOLLOW },
    lstatSync(file) { try { return fs.lstatSync(file); } catch (error) {
      if (error.code === 'ENOENT') error.code = 13900002; throw error;
    } },
    openSync(file, flags) { return { fd: fs.openSync(file, flags) }; },
    statSync: fd => fs.fstatSync(fd),
    readSync: (fd, buffer) => fs.readSync(fd, new Uint8Array(buffer), 0, buffer.byteLength, null),
    closeSync(file) { const fd = typeof file === 'number' ? file : file.fd; closed.push(fd); fs.closeSync(fd); }
  };
  const types = load('OfflineTypes');
  const inspection = load('ZipInspection', { '@kit.CoreFileKit': { fileIo: io }, './OfflineTypes': types,
    '@kit.ArkTS': { util: { TextDecoder: { create: encoding => {
      const decoder = new TextDecoder(encoding); return { decodeToString: value => decoder.decode(value) };
    } } } } });
  const files = load('PackageFiles', { '@kit.CoreFileKit': { fileIo: io }, '@kit.BasicServicesKit': {},
    './ZipInspection': inspection, './OfflineTypes': types });
  const resources = load('ResourceInterceptor', { '@kit.CoreFileKit': { fileIo: io }, './PackageFiles': files,
    '@kit.ArkTS': { url: { URL } } });
  const responseFault = { value: '' };
  class Response {
    constructor() { if (responseFault.value === 'constructor') throw new Error('response'); }
    setResponseMimeType(value) { this.mime = value; }
    setResponseEncoding(value) { this.encoding = value; }
    setResponseCode(value) { this.code = value; }
    setReasonMessage(value) { this.reason = value; }
    setResponseHeader(value) { this.headers = value; }
    setResponseData(value) { if (responseFault.value === 'data') throw new Error('response data'); this.fd = value; }
  }
  const { ArkWebPage } = load('ManagedPage', { './ResourceInterceptor': resources,
    '@kit.CoreFileKit': { fileIo: io } }, Response);
  const controller = {
    removeCache(clearRom) { events.push(['cache', clearRom]); },
    loadUrl(originalUrl) { events.push(['load', originalUrl]); }
  };
  const uiContext = { runScopedTask(callback) { events.push(['scope']); callback(); } };
  const page = new ArkWebPage(uiContext, controller, { resourceBaseUrl: baseUrl, shareHttpAndHttps });
  const directory = fs.mkdtempSync(path.join(temporary, 'package-'));
  fs.writeFileSync(path.join(directory, 'index.html'), 'local index');
  fs.writeFileSync(path.join(directory, 'app.js'), 'local js');
  fs.writeFileSync(path.join(directory, 'empty.js'), '');
  let enabled = true;
  const binding = { directory, version: 10001, isEnabled: () => enabled };
  const request = (relative = 'app.js', method = 'GET', headers = []) => ({
    getRequestUrl: () => baseUrl + relative, getRequestMethod: () => method, getRequestHeader: () => headers
  });
  return { page, controller, events, closed, directory, binding, request, responseFault, io, files,
    enable: value => { enabled = value; } };
}

test('UI scope keeps cache then bind/load synchronous and passes the original HTTP URL unchanged', () => {
  const h = setup();
  const originalUrl = 'http://fixture.test:9080/site/index.html?ticket=a%2Fb#start';
  h.page.runScopedTask(() => { h.page.clearResourceCache(); h.page.commitLoad(originalUrl, h.binding); });
  assert.deepEqual(h.events, [['scope'], ['cache', true], ['load', originalUrl]]);
  const response = h.page.intercept(h.request('index.html?ticket=a%2Fb#start'));
  assert.equal(response instanceof Promise, false);
  assert.equal(response.code, 200); assert.equal(response.mime, 'text/html');
  assert.equal(fs.readFileSync(response.fd, 'utf8'), 'local index');
  assert.equal(h.closed.length, 0, 'SDK must not close the FD handed to Web');
  fs.closeSync(response.fd); // 模拟 system Web 消费完毕；并非设备释放验证。
});

test('each request reads only enabled and retains the fixed package until page close or online selection', () => {
  const h = setup(); h.page.commitLoad('http://fixture.test:9080/site/index.html', h.binding);
  h.enable(false); assert.equal(h.page.intercept(h.request()), undefined);
  h.enable(true); let response = h.page.intercept(h.request());
  assert.equal(fs.readFileSync(response.fd, 'utf8'), 'local js'); fs.closeSync(response.fd);
  h.page.commitLoad('http://fixture.test:9080/site/index.html');
  assert.equal(h.page.intercept(h.request()), undefined, 'online selection clears the previous binding');
  h.page.commitLoad('http://fixture.test:9080/site/index.html', h.binding); h.page.close();
  assert.equal(h.page.intercept(h.request()), undefined);
});

test('missing, empty, metadata errors, POST, Range and other origin return undefined synchronously', () => {
  const h = setup(); h.page.commitLoad('http://fixture.test:9080/site/index.html', h.binding);
  assert.equal(h.page.intercept(h.request('missing.js')), undefined);
  assert.equal(h.page.intercept(h.request('empty.js')), undefined);
  assert.equal(h.closed.length, 1, 'empty file closes the unhanded FD once');
  assert.equal(h.page.intercept(h.request('app.js', 'POST')), undefined);
  assert.equal(h.page.intercept(h.request('app.js', 'GET', [{ headerKey: 'rAnGe', headerValue: 'bytes=0-1' }])), undefined);
  assert.equal(h.page.intercept({ ...h.request(), getRequestUrl: () => 'https://other.test/site/app.js' }), undefined);
  assert.equal(h.page.intercept({ ...h.request(), getRequestHeader() { throw new Error('metadata'); } }), undefined);
  assert.equal(h.page.intercept(h.request('%2e%2e/escape.js')), undefined);
});

test('response construction and FD assignment failures close each unhanded descriptor once', () => {
  const h = setup(); h.page.commitLoad('http://fixture.test:9080/site/index.html', h.binding);
  for (const step of ['constructor', 'data']) {
    h.responseFault.value = step; assert.equal(h.page.intercept(h.request()), undefined);
  }
  assert.equal(h.closed.length, 2);
});

test('new calls, explicit call cancellation and page close reject late observations without changing old binding', () => {
  const h = setup(); h.page.commitLoad('http://fixture.test:9080/site/index.html', h.binding);
  const first = h.page.startLoad(), second = h.page.startLoad();
  assert.equal(h.page.isLoadCurrent(first), false); assert.equal(h.page.isLoadCurrent(second), true);
  assert.equal(h.page.isLoadCurrent(second, { isCancelled: true }), false);
  const response = h.page.intercept(h.request());
  assert.equal(fs.readFileSync(response.fd, 'utf8'), 'local js'); fs.closeSync(response.fd);
  h.page.close(); assert.equal(h.page.isLoadCurrent(second), false);
});

// 实际Manager/Session与实际Page/Resource规则交叉执行；持久及TaskPool边界仍是double。
async function managerForPage(h) {
  const managedTypes = load('ManagedOfflineTypes'), lowTypes = load('OfflineTypes');
  const record = { version: 10001, sha256: 'a'.repeat(64) };
  const storage = {
    async load() { return [{ ...record, stage: 'active' }]; }
  };
  const installer = { async cleanupLifecycle() {}, cancel() {} };
  const packageApi = { normalizePackageRoot: value => value, claimManagedRoot: async () => installer,
    async observePackage() { return { directory: h.directory, exists: true }; } };
  const { ManagedPackageSession } = load('ManagedPackageSession', {
    './PackageInstaller': packageApi, './InstallWorker': { validManagedDownloadUrl: () => true },
    './ManagedStorage': lifecycleStorageTypes, './OfflineTypes': lowTypes, './ManagedOfflineTypes': managedTypes
  });
  const { ManagedOfflineSdk } = load('ManagedOfflineSdk', {
    '@kit.AbilityKit': {}, '@kit.BasicServicesKit': { systemDateTime: { TimeType: { STARTUP: 0 },
      getUptime: () => performance.now() } }, './PackageInstaller': packageApi,
    './ManagedStorage': { ManagedStorage: class { constructor() { return storage; } } },
    './ManagedPackageSession': { ManagedPackageSession }, './ManagedPage': {}, './ManagedOfflineTypes': managedTypes
  });
  return ManagedOfflineSdk.create({ filesDir: temporary, preferencesDir: temporary + '/preferences' }, {
    configProvider: async () => { throw new Error('Page selection must not call provider'); }
  });
}

test('public manager with actual Page: unmatched origin/base path/unsafe raw traversal stays online without directory protection', async () => {
  for (const original of ['http://other.test:9080/site/index.html?original=1#x',
    'https://fixture.test:9080/site/index.html', 'http://fixture.test:9081/site/index.html',
    'http://fixture.test:9080/another/index.html', 'http://fixture.test:9080/site/%2e%2e/site/index.html',
    'file:///site/index.html']) {
    const h = setup(), sdk = await managerForPage(h);
    const result = await sdk.loadPage(h.page, original);
    assert.equal(result.offline, false, original); assert.equal(result.version, undefined);
    assert.equal(sdk.getState().pagesBound, false, 'unmatched original URL must not protect a package');
    assert.deepEqual(h.events.filter(value => value[0] === 'load'), [['load', original]]);
    assert.equal(h.page.intercept(h.request()), undefined);
    await sdk.close();
  }
});

test('public manager with actual Page: same origin preserves query/hash and explicit default-port protocol sharing', async () => {
  for (const [base, original, sharing] of [
    ['http://fixture.test:9080/site/', 'http://fixture.test:9080/site/index.html?ticket=a%2Fb#start', false],
    ['https://fixture.test/site/', 'http://fixture.test/site/index.html?original=1#x', true]
  ]) {
    const h = setup(base, sharing), sdk = await managerForPage(h);
    const result = await sdk.loadPage(h.page, original);
    assert.equal(result.offline, true); assert.equal(result.version, 10001);
    assert.equal(sdk.getState().pagesBound, true);
    assert.deepEqual(h.events.filter(value => value[0] === 'load'), [['load', original]]);
    const response = h.page.intercept({ ...h.request(), getRequestUrl: () => original });
    assert.equal(response.code, 200); assert.equal(fs.readFileSync(response.fd, 'utf8'), 'local index');
    fs.closeSync(response.fd); await sdk.close();
  }
});

test('public manager with actual Page: unsafe original base path cannot broaden package scope after URL normalization', async () => {
  for (const base of ['http://fixture.test:9080/site/../',
    'http://fixture.test:9080/site/%2e%2e/', 'http://fixture.test:9080/site\\..\\']) {
    const h = setup(base), sdk = await managerForPage(h), original = 'http://fixture.test:9080/index.html?keep=1#x';
    const result = await sdk.loadPage(h.page, original);
    assert.equal(result.offline, false, base); assert.equal(sdk.getState().pagesBound, false);
    assert.deepEqual(h.events.filter(value => value[0] === 'load'), [['load', original]]);
    assert.equal(h.page.intercept({ ...h.request(), getRequestUrl: () => original }), undefined);
    await sdk.close();
  }
});

test("actual entry read failure retains cold ready and page-only observation cannot mutate in-use facts", async () => {
  for (const phase of ['cold-ready', 'page-only', 'final-race']) {
    const h = setup(), managedTypes = load('ManagedOfflineTypes'), lowTypes = load('OfflineTypes');
    const root = fs.mkdtempSync(path.join(temporary, 'entry-read-'));
    const previous = { version: 10001, sha256: 'a'.repeat(64), stage: 'active' };
    const target = { version: 10002, sha256: 'b'.repeat(64), stage: 'ready' };
    for (const version of [previous.version, target.version]) {
      fs.mkdirSync(root + '/' + version); fs.writeFileSync(root + '/' + version + '/index.html', 'entry');
    }
    let rejectVersion = phase === 'cold-ready' ? target.version : undefined;
    const read = h.io.readSync;
    h.io.readSync = (fd, buffer) => {
      if (rejectVersion && fs.fstatSync(fd).ino === fs.statSync(root + '/' + rejectVersion + '/index.html').ino) throw new Error('Injected read fault');
      return read(fd, buffer);
    };
    const rows = phase === 'cold-ready' ? [previous, target] : [previous], activations = [];
    const storage = { async load() { return structuredClone(rows); }, async activate(record) { activations.push(record.version); } };
    const installer = { async cleanupLifecycle() {}, cancel() {} };
    const { ManagedPackageSession } = load('ManagedPackageSession', {
      './PackageInstaller': { async observePackage(directory, record) { return h.files.observePackageFiles(directory, record); } },
      './InstallWorker': { validManagedDownloadUrl: () => true }, './ManagedStorage': lifecycleStorageTypes,
      './OfflineTypes': lowTypes, './ManagedOfflineTypes': managedTypes
    });
    const session = new ManagedPackageSession(root, installer, storage, 10000, () => {});
    assert.equal(await session.prepareLocal(new managedTypes.OfflineCancellation()), true);
    const observed = await session.observePage(new managedTypes.OfflineCancellation());
    const closedBefore = h.closed.length;
    if (phase === 'cold-ready') {
      assert.deepEqual(activations, []); assert.equal(fs.existsSync(root + '/' + target.version), true);
    } else {
      rejectVersion = previous.version;
      if (phase === 'page-only') {
        const failed = await session.observePage(new managedTypes.OfflineCancellation());
        assert.equal(session.finalBinding(failed, false), undefined); assert.equal(session.getState().usable, true);
      } else {
        await session.prepareLocal(new managedTypes.OfflineCancellation());
        assert.equal(session.getState().usable, false); assert.equal(session.finalBinding(observed, false), undefined);
      }
      assert.equal(h.closed.length - closedBefore, 1, 'failed entry observation closes its FD exactly once');
    }
    assert.equal(session.getState().active.version, previous.version);
  }
});
