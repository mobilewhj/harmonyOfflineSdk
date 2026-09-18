// Real ArkTS inspection/install code, real local filesystem, simulated Harmony system API boundaries.
// This does not execute HarmonyOS zlib; API behaviour on a device is a separate acceptance check.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const ts = require(process.env.OFFLINE_TEST_TYPESCRIPT ||
  'typescript');
const source = path.resolve(__dirname, '../src/main/ets');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-official-zip-'));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
let sequence = 0;

function load(name, dependencies = {}) {
  const file = path.join(source, name + '.ets');
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const module = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + output + '\n})', { filename: file })(
    name => {
      if (!(name in dependencies)) throw new Error('Missing system double: ' + name);
      return dependencies[name];
    }, module, module.exports);
  return module.exports;
}

const positions = new Map();
const io = {
  OpenMode: { READ_ONLY: 0, READ_WRITE: fs.constants.O_RDWR, CREATE: fs.constants.O_CREAT,
    TRUNC: fs.constants.O_TRUNC, NOFOLLOW: fs.constants.O_NOFOLLOW },
  openSync(file, flags) { const fd = fs.openSync(file, flags); positions.set(fd, 0); return { fd }; },
  closeSync(file) { const fd = typeof file === 'number' ? file : file.fd; fs.closeSync(fd); positions.delete(fd); },
  lseek(fd, position) { positions.set(fd, position); return position; },
  readSync(fd, buffer) {
    const count = fs.readSync(fd, new Uint8Array(buffer), 0, buffer.byteLength, positions.get(fd));
    positions.set(fd, positions.get(fd) + count); return count;
  },
  writeSync(fd, buffer) {
    const count = fs.writeSync(fd, new Uint8Array(buffer), 0, buffer.byteLength, positions.get(fd));
    positions.set(fd, positions.get(fd) + count); return count;
  },
  statSync: file => typeof file === 'number' ? fs.fstatSync(file) : fs.statSync(file),
  lstatSync(file) { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') error.code = 13900002; throw error; } },
  listFileSync: file => fs.readdirSync(file),
  mkdirSync: (file, recursive) => fs.mkdirSync(file, { recursive }),
  unlinkSync: fs.unlinkSync, rmdirSync: fs.rmdirSync, renameSync: fs.renameSync, accessSync: fs.existsSync
};
const types = load('OfflineTypes');
const inspection = load('ZipInspection', { '@kit.CoreFileKit': { fileIo: io }, './OfflineTypes': types,
  '@kit.ArkTS': { util: { TextDecoder: { create: (encoding, options) => {
    const decoder = new TextDecoder(encoding, options);
    return { decodeToString: value => decoder.decode(value) };
  } } } } });
const files = load('PackageFiles', { '@kit.CoreFileKit': { fileIo: io }, '@kit.BasicServicesKit': {},
  './ZipInspection': inspection, './OfflineTypes': types });

// ZIP32 fixture writer: stored or deflate, no reliance on the production metadata inspector.
function zipBytes(entries) {
  const local = [], central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), body = Buffer.from(entry.body || '');
    const packed = entry.stored ? body : zlib.deflateRawSync(body);
    const crc = zlib.crc32(body), method = entry.stored ? 0 : 8;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(method, 8); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(body.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, packed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x314, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(method, 10); directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(packed.length, 20); directory.writeUInt32LE(body.length, 24);
    directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(((entry.mode || 0) << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42); central.push(directory, name);
    offset += header.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function fixture(entries, mutate) {
  const root = path.join(temporary, String(++sequence)); fs.mkdirSync(root);
  const zip = path.join(root, 'package.zip'), content = path.join(root, 'content'); fs.mkdirSync(content);
  const data = zipBytes(entries); if (mutate) mutate(data);
  fs.writeFileSync(zip, data);
  return { root, zip, content, entries };
}
function platform(fixture, options = {}) {
  const calls = [];
  const api = {
    createChecksumSync: () => ({ crc32: async (crc, bytes) => zlib.crc32(new Uint8Array(bytes), crc) }),
    async getOriginalSize() { calls.push('size'); return options.declaredSize ?? fixture.entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.body || ''), 0); },
    async decompressFile(zip, destination) {
      calls.push('extract'); options.started?.();
      if (options.wait) await options.wait;
      if (options.fail) throw new Error('platform failure');
      for (const entry of fixture.entries) {
        const target = path.join(destination, entry.name);
        if (entry.name.endsWith('/')) { fs.mkdirSync(target, { recursive: true }); continue; }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, entry.body || '');
      }
      options.afterExtract?.(destination);
    }
  };
  const archive = load('PackageArchive', { '@kit.CoreFileKit': { fileIo: io }, '@kit.BasicServicesKit': { zlib: api },
    './ZipInspection': inspection, './OfflineTypes': types });
  return { archive, calls };
}
const benign = [{ name: 'dist/' }, { name: 'dist/index.html', body: 'home' }, { name: 'dist/a.js', body: 'hello', stored: true }];

test('ordinary deflate/stored ZIP uses official size and decompression interfaces', async () => {
  const f = fixture(benign), p = platform(f);
  await p.archive.extractPackage(f.zip, f.content, () => {});
  assert.deepEqual(p.calls, ['size', 'extract']);
  assert.equal(files.contentRoot(f.content), f.content + '/dist');
});
test('unsafe ZIP names are rejected before any system extraction', async () => {
  for (const name of ['../escape', '/escape', 'C:/escape', 'a\\b', 'a//b', './file', 'a/../b', 'nul\0name']) {
    const f = fixture([{ name, body: 'bad' }]), p = platform(f);
    await assert.rejects(p.archive.extractPackage(f.zip, f.content, () => {}));
    assert.equal(p.calls.length, 0, name);
  }
});
test('duplicates and file-directory conflicts are rejected before extraction', () => {
  for (const entries of [[{ name: 'a' }, { name: 'a' }], [{ name: 'a' }, { name: 'a/b' }]]) {
    assert.throws(() => inspection.inspectZip(fixture(entries).zip, () => {}), /INVALID_ARCHIVE/);
  }
});
test('symlinks and special ZIP entries are rejected before extraction', () => {
  for (const mode of [0o120777, 0o010600, 0o020600]) {
    assert.throws(() => inspection.inspectZip(fixture([{ name: 'link', body: '../other', mode }]).zip, () => {}));
  }
});
test('local/central filename mismatch and overlapping data cannot reach extraction', () => {
  const f = fixture([{ name: 'index.html', body: 'home' }], data => { data[30] = 'x'.charCodeAt(0); });
  assert.throws(() => inspection.inspectZip(f.zip, () => {}), /INVALID_ARCHIVE/);
});
test('declared per-file and total limits are enforced before extraction', () => {
  for (const count of [1, 5]) {
    const f = fixture(Array.from({ length: count }, (_, i) => ({ name: String(i), body: 'a' })), data => {
      let start = 0;
      while ((start = data.indexOf(Buffer.from('504b0102', 'hex'), start)) >= 0) {
        data.writeUInt32LE(64 * 1024 * 1024 + (count === 1 ? 1 : 0), start + 24);
        const offset = data.readUInt32LE(start + 42);
        data.writeUInt32LE(64 * 1024 * 1024 + (count === 1 ? 1 : 0), offset + 22);
        start += 4;
      }
    });
    assert.throws(() => inspection.inspectZip(f.zip, () => {}), /SIZE_LIMIT/);
  }
});
test('archive entry count, split archives and encrypted archives are rejected', () => {
  for (const mutate of [data => data.writeUInt16LE(10001, data.length - 12),
    data => data.writeUInt16LE(1, data.length - 18),
    data => data.writeUInt16LE(1, data.indexOf(Buffer.from('504b0102', 'hex')) + 8)]) {
    const f = fixture([{ name: 'index.html' }], mutate);
    assert.throws(() => inspection.inspectZip(f.zip, () => {}));
  }
});
test('truncated ZIP is rejected', () => {
  const f = fixture(benign); fs.truncateSync(f.zip, fs.statSync(f.zip).size - 8);
  assert.throws(() => inspection.inspectZip(f.zip, () => {}));
});
test('official original-size disagreement rejects before decompression', async () => {
  const f = fixture(benign), p = platform(f, { declaredSize: 999 });
  await assert.rejects(p.archive.extractPackage(f.zip, f.content, () => {}), /SIZE_LIMIT/);
  assert.deepEqual(p.calls, ['size']);
});
test('platform decompression errors become explicit installation errors', async () => {
  const f = fixture(benign), p = platform(f, { fail: true });
  await assert.rejects(p.archive.extractPackage(f.zip, f.content, () => {}), /DECOMPRESS_FAILED/);
});
test('post-extraction CRC detects same-length corrupt contents', async () => {
  const f = fixture(benign), p = platform(f, { afterExtract: root => fs.writeFileSync(path.join(root, 'dist/index.html'), 'evil') });
  await assert.rejects(p.archive.extractPackage(f.zip, f.content, () => {}), /CRC_MISMATCH/);
});
test('post-extraction inspection rejects unexpected files and links', async () => {
  for (const afterExtract of [root => fs.writeFileSync(path.join(root, 'extra'), 'bad'),
    root => fs.symlinkSync('/tmp', path.join(root, 'link'))]) {
    const f = fixture(benign), p = platform(f, { afterExtract });
    await assert.rejects(p.archive.extractPackage(f.zip, f.content, () => {}));
  }
});
test('resource serving rejects an intermediate directory symlink', () => {
  const root = path.join(temporary, 'resource-root'); fs.mkdirSync(root);
  const other = path.join(temporary, 'other'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'secret'), 'x');
  fs.symlinkSync(other, path.join(root, 'link'));
  assert.equal(files.regularFilePath(root, 'link/secret'), '');
  files.removeTree(root);
  assert.equal(fs.readFileSync(path.join(other, 'secret'), 'utf8'), 'x');
});
test('cancel during official extraction waits, then discards without publication', async () => {
  const f = fixture(benign);
  let release, started, cancelled = false, settled = false;
  const waiting = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { started = resolve; });
  const p = platform(f, { wait: waiting, started });
  const progress = [];
  const signal = new SharedArrayBuffer(4);
  const worker = load('InstallWorker', {
    '@kit.CoreFileKit': { fileIo: io }, '@kit.BasicServicesKit': {},
    '@kit.ArkTS': { url: { URL }, taskpool: { Task: { isCanceled: () => cancelled, sendData: value => progress.push(value) } } },
    '@kit.RemoteCommunicationKit': { rcp: {
      Request: class { constructor(url) { this.url = url; } },
      createSession: () => ({ close() {}, cancel() {}, async fetch(request) {
        const bytes = fs.readFileSync(f.zip);
        request.configuration.tracing.httpEventsHandler.onDataReceive(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
        return { statusCode: 200, headers: {} };
      } })
    } },
    '@kit.CryptoArchitectureKit': { cryptoFramework: { createMd: () => {
      const hash = crypto.createHash('sha256');
      return { updateSync: ({ data }) => hash.update(data), digestSync: () => ({ data: hash.digest() }) };
    } } },
    './PackageArchive': p.archive, './PackageFiles': files, './OfflineTypes': types
  });
  const spec = { version: 100000, sha256: crypto.createHash('sha256').update(fs.readFileSync(f.zip)).digest('hex'), url: 'https://example.com/package.zip' };
  const root = path.join(f.root, 'versions');
  const installing = worker.runInstall(root, spec, false, signal).then(value => { settled = true; return value; });
  await began; cancelled = true; Atomics.store(new Int32Array(signal), 0, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(fs.readdirSync(root).some(name => name.startsWith('.install-')), true);
  release();
  const result = await installing;
  assert.equal(result.reason, 'CANCELLED');
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(progress.filter(value => value.stage === types.OfflineStage.EXTRACTING).every(value => value.percent === -1), true);
});
test('all opened file descriptors are closed', () => { assert.equal(positions.size, 0); });


function localWorker(f, progress = []) {
  return load('InstallWorker', {
    '@kit.CoreFileKit': { fileIo: io }, '@kit.BasicServicesKit': {},
    '@kit.ArkTS': { url: { URL }, taskpool: { Task: { sendData: value => progress.push(value) } } },
    '@kit.RemoteCommunicationKit': { rcp: { createSession() { throw new Error('Local install must not use network'); } } },
    '@kit.CryptoArchitectureKit': { cryptoFramework: { createMd: () => {
      const hash = crypto.createHash('sha256');
      return { updateSync: ({ data }) => hash.update(data), digestSync: () => ({ data: hash.digest() }) };
    } } },
    './PackageArchive': platform(f).archive, './PackageFiles': files, './OfflineTypes': types
  });
}
function localSpec(f) {
  return { version: 10000, sha256: crypto.createHash('sha256').update(fs.readFileSync(f.zip)).digest('hex'), url: '' };
}
test('local install verifies, extracts and publishes without network or modifying its input', async () => {
  const f = fixture(benign), progress = [], spec = localSpec(f), original = fs.readFileSync(f.zip);
  const root = path.join(f.root, 'versions');
  const result = await localWorker(f, progress).runInstall(root, spec, false, new SharedArrayBuffer(4), f.zip);
  assert.equal(result.success, true);
  assert.equal(files.usablePackage(root, spec), result.directory + '/dist');
  assert.deepEqual(fs.readFileSync(f.zip), original);
  assert.deepEqual(fs.readdirSync(root), [path.basename(result.directory)]);
  assert.deepEqual(progress.map(x => x.stage), ['preparing', 'verifying', 'extracting', 'saving']);
});
test('local hash failure leaves no published package and a subsequent retry succeeds', async () => {
  const f = fixture(benign), spec = localSpec(f), root = path.join(f.root, 'versions');
  const worker = localWorker(f);
  const bad = await worker.runInstall(root, { ...spec, sha256: '0'.repeat(64) }, false, new SharedArrayBuffer(4), f.zip);
  assert.equal(bad.reason, 'HASH_MISMATCH'); assert.deepEqual(fs.readdirSync(root), []);
  const good = await worker.runInstall(root, spec, false, new SharedArrayBuffer(4), f.zip);
  assert.equal(good.success, true);
});
test('local install cannot overwrite an already published version', async () => {
  const f = fixture(benign), spec = localSpec(f), root = path.join(f.root, 'versions'), worker = localWorker(f);
  const first = await worker.runInstall(root, spec, false, new SharedArrayBuffer(4), f.zip);
  const second = await worker.runInstall(root, spec, false, new SharedArrayBuffer(4), f.zip);
  assert.equal(first.success, true); assert.equal(second.reason, 'TARGET_EXISTS');
  assert.equal(fs.readFileSync(first.directory + '/dist/index.html', 'utf8'), 'home');
});
test('cancelled local install and symlink archive do not publish', async () => {
  const f = fixture(benign), spec = localSpec(f), root = path.join(f.root, 'versions');
  const signal = new SharedArrayBuffer(4); Atomics.store(new Int32Array(signal), 0, 1);
  const cancelled = await localWorker(f).runInstall(root, spec, false, signal, f.zip);
  assert.equal(cancelled.reason, 'CANCELLED');
  const link = path.join(f.root, 'link.zip'); fs.symlinkSync(f.zip, link);
  const linked = await localWorker(f).runInstall(root, spec, false, new SharedArrayBuffer(4), link);
  assert.equal(linked.success, false);
  assert.deepEqual(fs.readdirSync(root), []);
});
test('download URLs require standard secure origins unless HTTP is explicitly enabled', () => {
  const worker = localWorker(fixture(benign));
  for (const url of ['http://example.com/a.zip', 'https://user:pass@example.com/a', 'file:///a', 'https://example.com:444/a', 'https://example.com/a#hash']) {
    assert.equal(worker.validDownloadUrl(url, false), false, url);
  }
  assert.equal(worker.validDownloadUrl('https://example.com/a.zip?sig=abc', false), true);
  assert.equal(worker.validDownloadUrl('http://example.com/a.zip', true), true);
});
test('resource mapping is confined to its immutable directory and configured URL prefix', () => {
  const api = load('ResourceInterceptor', { '@kit.ArkTS': { url: { URL } }, '@kit.CoreFileKit': { fileIo: io }, './PackageFiles': files });
  const base = 'https://example.com/app/';
  assert.equal(api.relativeResource(base + 'index.html?v=1', base), 'index.html');
  assert.equal(api.relativeResource(base, base), 'index.html');
  for (const url of ['https://evil.com/app/index.html', 'https://example.com/app2/index.html',
    base + '../secret', base + '%2e%2e/secret', base + 'a%2fb/../../secret', base + '%255csecret', 'http://example.com/app/index.html']) {
    assert.equal(api.relativeResource(url, base), '', url);
  }
  assert.equal(api.mimeType('app.js'), 'application/javascript');
  const f = fixture(benign);
  const binding = new api.ResourceInterceptor(f.content, base);
  assert.equal(binding.open(base, 'POST', false), undefined);
  assert.equal(binding.open(base, 'GET', true), undefined);
});
test('bundled demo ZIP matches the pinned SHA-256 and contains all referenced assets', () => {
  const zip = path.resolve(__dirname, '../../entry/src/main/resources/rawfile/sample.zip');
  const config = fs.readFileSync(path.resolve(__dirname, '../../entry/src/main/ets/data/DemoConfig.ets'), 'utf8');
  assert.ok(config.includes(crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex')));
  assert.deepEqual(inspection.inspectZip(zip, () => {}).map(x => x.name).sort(), ['app.js', 'index.html', 'style.css']);
});
test('local installation paths leave no file descriptors open', () => { assert.equal(positions.size, 0); });
