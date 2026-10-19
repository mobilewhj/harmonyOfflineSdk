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
const source = process.env.OFFLINE_TEST_SDK_ETS_ROOT || (process.env.OFFLINE_SDK_ROOT ? path.resolve(process.env.OFFLINE_SDK_ROOT, 'src/main/ets') : path.resolve(__dirname, '../src/main/ets'));
// 本机 /var 等系统别名不是 App 沙盒根；host fixture 显式取得真实测试目录。
const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'harmony-official-zip-'));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
let sequence = 0;
const systemDateTime = { TimeType: { STARTUP: 0 }, getUptime: () => performance.now() };

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
  mkdirSync(file, recursive) {
    // API24实测：recursive不代表目标本身可重复创建；Node会吞掉这类EEXIST。
    try { fs.lstatSync(file); } catch (error) {
      if (error.code === 'ENOENT') return fs.mkdirSync(file, { recursive });
      throw error;
    }
    const error = new Error('Harmony mkdir target already exists'); error.code = 13900015; throw error;
  },
  fsyncSync: fs.fsyncSync,
  unlinkSync: fs.unlinkSync, rmdirSync: fs.rmdirSync, renameSync: fs.renameSync, accessSync: fs.existsSync
};
const types = load('OfflineTypes');
const inspection = load('ZipInspection', { '@kit.CoreFileKit': { fileIo: io }, './OfflineTypes': types,
  '@kit.ArkTS': { util: { TextDecoder: { create: (encoding, options) => {
    const decoder = new TextDecoder(encoding, options);
    return { decodeToString: value => decoder.decode(value) };
  } } } } });
const files = load('PackageFiles', { '@kit.CoreFileKit': { fileIo: io }, '@kit.BasicServicesKit': { systemDateTime },
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
  let endedEntries = 0;
  const api = {
    createChecksumSync: () => ({ crc32: async (crc, bytes) => zlib.crc32(new Uint8Array(bytes), crc) }),
    ReturnStatus: { OK: 0, STREAM_END: 1 }, CompressFlushMode: { NO_FLUSH: 0 },
    async createZip() {
      calls.push('createZip');
      let packed = Buffer.alloc(0), output = Buffer.alloc(0), delivered = 0, ended = false;
      let totalIn = 0, totalOut = 0, state = { availableIn: 0, availableOut: 0, totalIn: 0, totalOut: 0 };
      return {
        async inflateInit2(stream, bits) { assert.equal(bits, -15); return 0; },
        async getZStream() { return state; },
        async inflate(stream) {
          calls.push('inflate'); options.started?.(); if (options.wait) await options.wait;
          if (options.fail) throw new Error('platform failure');
          let consumed = 0;
          if (delivered === output.length && stream.availableIn) {
            const previous = packed.length;
            packed = Buffer.concat([packed, Buffer.from(stream.nextIn, 0, stream.availableIn)]);
            try {
              const result = zlib.inflateRawSync(packed, { info: true });
              output = result.buffer; ended = true;
              consumed = result.engine.bytesWritten - previous;
            } catch (error) {
              if (error.code !== 'Z_BUF_ERROR') throw error;
              output = zlib.inflateRawSync(packed, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
              consumed = stream.availableIn;
            }
          }
          const produced = Math.min(stream.availableOut, output.length - delivered);
          new Uint8Array(stream.nextOut).set(output.subarray(delivered, delivered + produced));
          delivered += produced; totalIn += consumed; totalOut += produced;
          state = { availableIn: stream.availableIn - consumed, availableOut: stream.availableOut - produced, totalIn, totalOut };
          return ended && delivered === output.length ? 1 : 0;
        },
        async inflateEnd() { calls.push('end'); if (++endedEntries === fixture.entries.filter(entry => !entry.stored).length) options.afterExtract?.(fixture.content); return 0; }
      };
    },
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

test('ordinary deflate/stored ZIP uses native entry streams and physical Android layout', async () => {
  const f = fixture(benign), p = platform(f);
  await p.archive.extractPackage(f.zip, f.content, () => {});
  assert.deepEqual(p.calls, ['createZip', 'inflate', 'end', 'createZip', 'inflate', 'end']);
  assert.equal(files.contentRoot(f.content), f.content);
  assert.equal(fs.readFileSync(f.content + '/a.js', 'utf8'), 'hello');
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
test('former per-file and total product limits do not reject metadata', () => {
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
    assert.equal(inspection.inspectZip(f.zip, () => {}).length, count);
  }
});
test('inconsistent archive entry count, split archives and encrypted archives are rejected', () => {
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
test('actual stream size disagreement is rejected after native completion', async () => {
  const f = fixture([{name:'index.html',body:'home'}],data=>{
    const central=data.indexOf(Buffer.from('504b0102','hex'));data.writeUInt32LE(999,22);data.writeUInt32LE(999,central+24);
  }), p=platform(f);
  await assert.rejects(p.archive.extractPackage(f.zip,f.content,()=>{}), /CRC_MISMATCH/);
  assert.deepEqual(p.calls,['createZip','inflate','end']);
});
test('platform decompression errors become explicit installation errors', async () => {
  const f = fixture(benign), p = platform(f, { fail: true });
  await assert.rejects(p.archive.extractPackage(f.zip, f.content, () => {}), /DECOMPRESS_FAILED/);
});
test('post-extraction CRC detects same-length corrupt contents', async () => {
  const f = fixture(benign), p = platform(f, { afterExtract: root => fs.writeFileSync(path.join(root, 'index.html'), 'evil') });
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
    '@kit.CoreFileKit': { fileIo: io }, '@kit.BasicServicesKit': { systemDateTime },
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
  assert.deepEqual(fs.readdirSync(root).sort(), ['100000.zip.tmp', '100000_temp']);
  release();
  const result = await installing;
  assert.equal(result.reason, 'CANCELLED');
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(progress.filter(value => value.stage === types.OfflineStage.EXTRACTING).every(value => value.percent === -1), true);
});
test('all opened file descriptors are closed', () => { assert.equal(positions.size, 0); });


function localWorker(f, progress = [], fileApi = files) {
  return load('InstallWorker', {
    '@kit.CoreFileKit': { fileIo: io }, '@kit.BasicServicesKit': { systemDateTime },
    '@kit.ArkTS': { url: { URL }, taskpool: { Task: { sendData: value => progress.push(value) } } },
    '@kit.RemoteCommunicationKit': { rcp: { createSession() { throw new Error('Local install must not use network'); } } },
    '@kit.CryptoArchitectureKit': { cryptoFramework: { createMd: () => {
      const hash = crypto.createHash('sha256');
      return { updateSync: ({ data }) => hash.update(data), digestSync: () => ({ data: hash.digest() }) };
    } } },
    './PackageArchive': platform(f).archive, './PackageFiles': fileApi, './OfflineTypes': types
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
  assert.equal(files.usablePackage(root, spec), result.directory);
  assert.equal(result.directory, path.join(root, '10000'));
  assert.equal(fs.existsSync(path.join(result.directory, 'dist')), false);
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
  assert.equal(fs.readFileSync(first.directory + '/index.html', 'utf8'), 'home');
});
test('cancelled local install and symlink archive do not publish', async () => {
  const f = fixture(benign), spec = localSpec(f), root = path.join(f.root, 'versions');
  const signal = new SharedArrayBuffer(4); Atomics.store(new Int32Array(signal), 0, 1);
  const cancelled = await localWorker(f).runInstall(root, spec, false, signal, f.zip);
  assert.equal(cancelled.reason, 'CANCELLED');
  const link = path.join(f.root, 'link.zip'); fs.symlinkSync(f.zip, link);
  const linked = await localWorker(f).runInstall(root, spec, false, new SharedArrayBuffer(4), link);
  assert.equal(linked.success, false);
  assert.equal(fs.existsSync(root), false); // 删除前拒绝，连根目录也没有创建。
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
  for (const url of ['https://other.example/app/index.html', 'https://example.com/app2/index.html',
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

function installWorker(f, p, progress = [], options = {}) {
  return load('InstallWorker', {
    '@kit.CoreFileKit': { fileIo: io }, '@kit.BasicServicesKit': { systemDateTime: options.clock || systemDateTime },
    '@kit.ArkTS': { url: { URL }, taskpool: { Task: { sendData: value => progress.push(value) } } },
    '@kit.RemoteCommunicationKit': { rcp: {
      Request: class { constructor(url) { this.url = url; } },
      createSession: () => options.session || ({ close() {}, cancel() {}, async fetch(request) {
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
}
function packageSpec(f) {
  return { version: 100000, sha256: crypto.createHash('sha256').update(fs.readFileSync(f.zip)).digest('hex'), url: 'https://example.com/package.zip' };
}

test('installation publishes root and dist packages with Android names and removes stale temporary files', async () => {
  for (const entries of [benign, [{ name: 'index.html', body: 'home' }]]) {
    const f = fixture(entries), p = platform(f), worker = installWorker(f, p);
    const root = path.join(f.root, 'versions'); fs.mkdirSync(root);
    fs.mkdirSync(path.join(root, '100000_temp'));
    fs.writeFileSync(path.join(root, '100000_temp/stale'), 'old');
    fs.writeFileSync(path.join(root, '100000.zip.tmp'), 'interrupted download');
    const result = await worker.runInstall(root, packageSpec(f), false, new SharedArrayBuffer(4));
    assert.equal(result.success, true);
    assert.equal(result.directory, path.join(root, '100000'));
    assert.equal(fs.readFileSync(path.join(result.directory, 'index.html'), 'utf8'), 'home');
    assert.equal(fs.existsSync(path.join(result.directory, 'dist')), false);
    assert.equal(fs.existsSync(path.join(result.directory, 'stale')), false);
    assert.deepEqual(fs.readdirSync(root), ['100000']);
    assert.equal(files.usablePackage(root, packageSpec(f)), result.directory);
    const again = await worker.runInstall(root, packageSpec(f), false, new SharedArrayBuffer(4));
    assert.equal(again.reason, 'TARGET_EXISTS');
    assert.equal(fs.readFileSync(path.join(result.directory, 'index.html'), 'utf8'), 'home');
  }
});
test('hash failure cleans fixed paths and allows a successful retry', async () => {
  const f = fixture(benign), p = platform(f), worker = installWorker(f, p);
  const root = path.join(f.root, 'versions');
  const bad = await worker.runInstall(root, { ...packageSpec(f), sha256: '0'.repeat(64) }, false, new SharedArrayBuffer(4));
  assert.equal(bad.reason, 'HASH_MISMATCH');
  assert.deepEqual(p.calls, []);
  assert.deepEqual(fs.readdirSync(root), []);
  const retry = await worker.runInstall(root, packageSpec(f), false, new SharedArrayBuffer(4));
  assert.equal(retry.success, true);
  assert.deepEqual(fs.readdirSync(root), ['100000']);
});
test('cold cleanup preserves current version and unrelated files, removes new and legacy leftovers without following links', () => {
  const root = path.join(temporary, 'cleanup'); fs.mkdirSync(root);
  const outside = path.join(temporary, 'cleanup-outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep'), 'safe');
  for (const name of ['100000', '100001', '100002_temp', '100000-' + 'a'.repeat(64), '.install-100000-123', 'unrelated']) {
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, 'index.html'), name);
  }
  fs.writeFileSync(path.join(root, '100002.zip.tmp'), 'zip');
  fs.symlinkSync(outside, path.join(root, '100003_temp'));
  files.cleanPackages(root, '100000');
  assert.deepEqual(fs.readdirSync(root).sort(), ['100000', 'unrelated']);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'safe');
  files.cleanPackages(root, '100000');
  assert.deepEqual(fs.readdirSync(root).sort(), ['100000', 'unrelated']);
  assert.equal(fs.readFileSync(path.join(root, '100000/index.html'), 'utf8'), '100000');
});

test('same version with a different hash cannot overwrite the existing published directory', async () => {
  const f = fixture(benign), spec = localSpec(f), root = path.join(f.root, 'versions'), worker = localWorker(f);
  const installed = await worker.runInstall(root, spec, false, new SharedArrayBuffer(4), f.zip);
  assert.equal(installed.success, true);
  const conflict = await worker.runInstall(root, { ...spec, sha256: '0'.repeat(64) }, false, new SharedArrayBuffer(4), f.zip);
  assert.equal(conflict.reason, 'TARGET_EXISTS');
  assert.equal(fs.readFileSync(path.join(root, '10000/index.html'), 'utf8'), 'home');
});
test('local ZIP in fixed work paths is rejected without deleting the input', async () => {
  for (const relative of ['10000.zip.tmp', '10000_temp/input.zip', '10000_temp/../10000.zip.tmp']) {
    const f = fixture(benign), spec = localSpec(f), root = path.join(f.root, 'versions');
    fs.mkdirSync(path.join(root, '10000_temp'), { recursive: true });
    const input = root + '/' + relative;
    fs.copyFileSync(f.zip, input);
    const bytes = fs.readFileSync(input);
    const result = await localWorker(f).runInstall(root, spec, false, new SharedArrayBuffer(4), input);
    assert.equal(result.reason, 'INVALID_SOURCE');
    assert.deepEqual(fs.readFileSync(input), bytes);
    assert.equal(fs.existsSync(path.join(root, '10000')), false);
  }
});
test('all Android-layout installation descriptors are closed', () => { assert.equal(positions.size, 0); });

test('local ZIP parent symlink alias is rejected before stale work paths are removed', async () => {
  const f = fixture(benign), spec = localSpec(f), root = path.join(f.root, 'versions');
  fs.mkdirSync(root);
  const input = path.join(root, '10000.zip.tmp'); fs.copyFileSync(f.zip, input);
  const alias = path.join(f.root, 'alias'); fs.symlinkSync(root, alias);
  const original = fs.readFileSync(input);
  for (const source of [alias + '/10000.zip.tmp', alias + '/./10000.zip.tmp', alias + '/../versions/10000.zip.tmp']) {
    const result = await localWorker(f).runInstall(root, spec, false, new SharedArrayBuffer(4), source);
    assert.equal(result.reason, 'INVALID_SOURCE'); assert.equal(result.requestStarted, false);
    assert.deepEqual(fs.readFileSync(input), original);
    assert.deepEqual(fs.readdirSync(root), ['10000.zip.tmp']);
  }
});
test('unsafe root is rejected before input or target paths change', async () => {
  const f = fixture(benign), real = path.join(f.root, 'real'); fs.mkdirSync(real);
  const alias = path.join(f.root, 'alias'); fs.symlinkSync(real, alias);
  fs.writeFileSync(real + '/10000.zip.tmp', 'sentinel');
  for (const root of [alias, alias + '/..' + '/real', f.root + '/missing/../alias']) {
    const result = await localWorker(f).runInstall(root, localSpec(f), false, new SharedArrayBuffer(4), f.zip);
    assert.equal(result.reason, 'UNSAFE_PATH');
    assert.equal(fs.readFileSync(real + '/10000.zip.tmp', 'utf8'), 'sentinel');
  }
});
test('published directory is a typed fact even when final temporary cleanup fails', async () => {
  const f = fixture(benign), root = path.join(f.root, 'versions'), spec = localSpec(f);
  const fileApi = { ...files, removeTree(target) {
    if (target.endsWith('.zip.tmp') && fs.existsSync(root + '/10000')) throw new Error('cleanup failure');
    return files.removeTree(target);
  } };
  const result = await localWorker(f, [], fileApi).runInstall(root, spec, false, new SharedArrayBuffer(4), f.zip);
  assert.equal(result.success, false); assert.equal(result.reason, 'CLEANUP');
  assert.equal(result.factStage, types.InstallFactStage.CLEANUP); assert.equal(result.requestStarted, false);
  assert.deepEqual(result.publishedRecord, { version: spec.version, sha256: spec.sha256 });
  assert.equal(fs.readFileSync(result.directory + '/index.html', 'utf8'), 'home');
});
test('managed download ports and resource origins retain strict legacy defaults', () => {
  const worker = localWorker(fixture(benign));
  for (const value of ['http://example.com:9080/p.zip', 'https://example.com:9443/p.zip', 'https://example.com:0/p.zip']) {
    assert.equal(worker.validManagedDownloadUrl(value), true); assert.equal(worker.validDownloadUrl(value, true), false);
  }
  for (const value of ['https://example.com:65536/p.zip', 'http://u:p@example.com/p.zip', 'ftp://example.com/p.zip', 'https://example.com/p.zip#x']) {
    assert.equal(worker.validManagedDownloadUrl(value), false);
  }
  const api = load('ResourceInterceptor', { '@kit.ArkTS': { url: { URL } }, '@kit.CoreFileKit': { fileIo: io }, './PackageFiles': files });
  const base = 'http://example.com:9080/app/';
  assert.equal(api.relativeResource(base + 'a.js?q=1#x', base, false, true), 'a.js');
  assert.equal(api.relativeResource(base + 'a.js', base), '');
  for (const value of ['http://example.com:9081/app/a.js', 'https://example.com:9080/app/a.js', 'http://other.com:9080/app/a.js']) {
    assert.equal(api.relativeResource(value, base, true, true), '');
  }
  assert.equal(api.relativeResource('http://example.com/app/a.js', 'https://example.com/app/', true, true), 'a.js');
});
test('empty resources close undelivered FD and normal resource FD remains open for Web', () => {
  const root = path.join(temporary, 'fd-root'); fs.mkdirSync(root);
  fs.writeFileSync(root + '/empty.js', ''); fs.writeFileSync(root + '/ok.js', 'ok');
  const api = load('ResourceInterceptor', { '@kit.ArkTS': { url: { URL } }, '@kit.CoreFileKit': { fileIo: io }, './PackageFiles': files });
  const interceptor = new api.ResourceInterceptor(root, 'http://example.com:9080/app/', false, true);
  assert.equal(interceptor.open('http://example.com:9080/app/empty.js', 'GET', false), undefined);
  assert.equal(positions.size, 0);
  const local = interceptor.open('http://example.com:9080/app/ok.js', 'GET', false);
  assert.equal(local.size, 2); assert.equal(positions.has(local.fd), true);
  io.closeSync(local.fd); // host double 模拟 system Web 接管后的关闭责任。
});
test('download total facts do not invent known progress for absent or invalid totals', async () => {
  for (const total of [undefined, 0, NaN, Infinity, -1]) {
    const f = fixture(benign), progress = [], bytes = fs.readFileSync(f.zip);
    const session = { close() {}, cancel() {}, async fetch(request) {
      const events = request.configuration.tracing.httpEventsHandler;
      if (total !== undefined) events.onDownloadProgress(total, bytes.length);
      events.onDataReceive(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
      return { statusCode: 200, headers: {} };
    } };
    const result = await installWorker(f, platform(f), progress, { session }).runInstall(path.join(f.root, 'v'), packageSpec(f), false, new SharedArrayBuffer(4));
    assert.equal(result.success, true); assert.equal(result.requestStarted, true);
    for (const value of progress.filter(value => value.stage === 'downloading')) assert.equal(value.downloadTotalKnown, false);
    assert.equal(progress.findLast(value => value.stage === 'downloading').percent, 100); // 旧末尾100保留，内部事实仍未知。
  }
});
test('valid download callback total accompanies known terminal progress', async () => {
  const f = fixture(benign), progress = [], bytes = fs.readFileSync(f.zip);
  const session = { close() {}, cancel() {}, async fetch(request) {
    const events = request.configuration.tracing.httpEventsHandler;
    events.onDownloadProgress(bytes.length, bytes.length);
    events.onDataReceive(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    return { statusCode: 200, headers: {} };
  } };
  const result = await installWorker(f, platform(f), progress, { session }).runInstall(path.join(f.root, 'v'), packageSpec(f), false, new SharedArrayBuffer(4));
  assert.equal(result.success, true); assert.equal(result.httpStatus, 200);
  assert.equal(progress.findLast(value => value.stage === 'downloading').downloadTotalKnown, true);
});
test('redirects share a monotonic total deadline despite wall-clock jumps', async () => {
  const f = fixture(benign), requests = [], originalDateNow = Date.now;
  let mono = 0;
  const clock = { TimeType: { STARTUP: 0 }, getUptime: () => mono };
  const session = { close() {}, cancel() {}, async fetch(request) {
    requests.push(request); mono += 70000;
    Date.now = () => originalDateNow() + (requests.length === 1 ? 100000000 : -100000000);
    return { statusCode: 302, headers: { location: '/next.zip' } };
  } };
  try {
    const result = await installWorker(f, platform(f), [], { session, clock }).runInstall(path.join(f.root, 'v'), packageSpec(f), false, new SharedArrayBuffer(4));
    assert.equal(result.reason, 'TIMEOUT'); assert.equal(result.httpStatus, undefined);
    assert.deepEqual(requests.map(value => value.configuration.transfer.timeout.transferMs), [120000, 50000]);
    assert.equal(result.factStage, 'downloading'); assert.equal(positions.size, 0);
  } finally { Date.now = originalDateNow; }
});
test('cross-protocol redirect target is never sent and preserves received HTTP status', async () => {
  const f = fixture(benign), requests = [];
  const session = { close() {}, cancel() {}, async fetch(request) {
    requests.push(request.url); return { statusCode: 307, headers: { location: 'http://example.com:9080/new.zip' } };
  } };
  const result = await installWorker(f, platform(f), [], { session }).runInstall(path.join(f.root, 'v'), packageSpec(f), true, new SharedArrayBuffer(4), '', true);
  assert.equal(result.reason, 'INVALID_URL'); assert.equal(result.httpStatus, 307);
  assert.equal(requests.length, 1); assert.equal(result.requestStarted, true);
});
test('network cancellation waits native settlement before closing download FD', async () => {
  const f = fixture(benign), signal = new SharedArrayBuffer(4);
  let release, fetched, settled = false, cancels = 0;
  const started = new Promise(resolve => { fetched = resolve; });
  const native = new Promise(resolve => { release = resolve; });
  const session = { close() {}, cancel() { cancels++; }, async fetch() {
    fetched(); await native; return { statusCode: 200, headers: {} };
  } };
  const installing = installWorker(f, platform(f), [], { session }).runInstall(path.join(f.root, 'v'), packageSpec(f), false, signal).then(value => { settled = true; return value; });
  await started; Atomics.store(new Int32Array(signal), 0, 1);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(settled, false); assert.equal(positions.size, 1); assert.ok(cancels > 0);
  release(); assert.equal((await installing).reason, 'CANCELLED'); assert.equal(positions.size, 0);
});

function installerModule(workerOverride) {
  let gate;
  class Task {
    constructor(fn, ...args) { this.fn = fn; this.args = args; }
    onReceiveData(callback) { this.progress = callback; }
  }
  const taskpool = { Task, async execute(task) {
    if (gate?.name === task.fn.name && gate.remaining > 0) { gate.remaining--; gate.started(); await gate.wait; }
    return task.fn(...task.args);
  } };
  const worker = { async runInstall(root, spec, allowHttp, signal) {
    return { success: !Atomics.load(new Int32Array(signal), 0), reason: Atomics.load(new Int32Array(signal), 0) ? 'CANCELLED' : '',
      stage: 'saving', directory: root + '/' + spec.version, requestStarted: true, factStage: 'publishing' };
  } };
  worker.managedArchiveReusable = () => false;
  worker.runManagedDownload = (root, spec, signal) => worker.runInstall(root, spec, true, signal);
  worker.runManagedExtract = (root, spec, signal) => worker.runInstall(root, spec, true, signal);
  const api = load('PackageInstaller', { '@kit.ArkTS': { taskpool }, './InstallWorker': workerOverride || worker, './PackageFiles': files, './OfflineTypes': types });
  return { api, block(name, remaining = Infinity) {
    let release, started;
    const wait = new Promise(resolve => { release = resolve; });
    const began = new Promise(resolve => { started = resolve; });
    gate = { name, wait, started, remaining };
    return { release, began };
  } };
}
test('API24 existing-root mkdir throws but public cleanup and cleanupManaged remain repeatable', async () => {
  const { api } = installerModule(), root = path.join(temporary, 'api24-repeat-cleanup');
  const legacy = new api.PackageInstaller();
  await legacy.cleanup(root, '10000'); // 缺根首次仍须真正创建。
  assert.equal(fs.lstatSync(root).isDirectory(), true);
  assert.throws(() => io.mkdirSync(root, true), error => error.code === 13900015);
  fs.mkdirSync(root + '/10000'); fs.writeFileSync(root + '/10000/index.html', 'active A');
  fs.writeFileSync(root + '/unrelated', 'host-owned');
  fs.mkdirSync(root + '/10001_temp'); fs.writeFileSync(root + '/10001_temp/partial', 'stale');
  await legacy.cleanup(root, '10000'); await legacy.cleanup(root, '10000');
  const owner = await api.claimManagedRoot(root);
  fs.writeFileSync(root + '/10001.zip.tmp', 'stale zip');
  await owner.cleanupManaged(root, 10000); await owner.cleanupManaged(root, 10000);
  assert.deepEqual(fs.readdirSync(root).sort(), ['10000', 'unrelated']);
  assert.equal(fs.readFileSync(root + '/10000/index.html', 'utf8'), 'active A');
  assert.equal(fs.readFileSync(root + '/unrelated', 'utf8'), 'host-owned');
});

test('API24 existing-root cold public startup reaches provider and binds persisted A across fresh process registries', async () => {
  const root = path.join(temporary, 'api24-cold-root'), active = { version: 10000, sha256: 'a'.repeat(64) };
  fs.mkdirSync(root + '/10000', { recursive: true }); fs.writeFileSync(root + '/10000/index.html', 'active A');
  const facts = [{ ...active, stage: 'active' }];
  // 每轮重载注册表模拟真正冷进程；close不会、也不应让同进程重新认领root。
  // 存储与Web仍是平台边界，Manager/Session/Installer/PackageFiles均执行真实源码。
  for (let coldProcess = 0; coldProcess < 2; coldProcess++) {
    fs.mkdirSync(root + '/10001_temp'); fs.writeFileSync(root + '/10001_temp/partial', 'old partial');
    const { api } = installerModule(), managedTypes = load('ManagedOfflineTypes'), diagnostics = [], requests = [];
    const storage = {
      async load() { return structuredClone(facts); }, async evictInactive() {}
    };
    const sessionApi = load('ManagedPackageSession', {
      './PackageInstaller': api, './InstallWorker': { validManagedDownloadUrl: () => true },
      './ManagedStorage': { PackageStage: { ACTIVE: 'active', READY: 'ready', DOWNLOADING: 'downloading', DOWNLOADED: 'downloaded' } }, './OfflineTypes': types, './ManagedOfflineTypes': managedTypes
    });
    const { ManagedOfflineSdk } = load('ManagedOfflineSdk', {
      '@kit.AbilityKit': {}, '@kit.BasicServicesKit': { systemDateTime }, './PackageInstaller': api,
      './ManagedStorage': { ManagedStorage: class { constructor() { return storage; } } },
      './ManagedPackageSession': sessionApi, './ManagedPage': {}, './ManagedOfflineTypes': managedTypes
    });
    let providerReached; const providerStarted = new Promise(resolve => { providerReached = resolve; });
    const sdk = await ManagedOfflineSdk.create({ filesDir: temporary, preferencesDir: temporary + '/preferences' }, {
      root, configProvider: async request => { requests.push(request.currentVersion); providerReached();
        return { enabled: true, version: active.version, sha256: active.sha256, url: 'https://fixture.test/package.zip' }; },
      onDiagnostic: value => diagnostics.push(value)
    });
    let deadline;
    try {
      sdk.updateConditions({ privacyAccepted: true, foreground: true });
      assert.equal((await sdk.prepareStartup()).kind, managedTypes.StartupKind.CONTINUE);
      assert.deepEqual(diagnostics, [], 'ordinary existing directory must not emit INSTALL/CLEANUP');
      assert.deepEqual(fs.readdirSync(root), ['10000']);
      assert.equal(sdk.getState().usable, true); assert.equal(sdk.getState().initialFinished, true);
      await Promise.race([providerStarted, new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Cold startup failed to reach provider')), 1000);
      })]);
      assert.deepEqual(requests, [10000]);
      const page = { urls: [], startLoad: () => 1, isLoadCurrent: () => true, canBindUrl: () => true,
        runScopedTask(callback) { callback(); }, clearResourceCache() {},
        commitLoad(url, binding) { this.urls.push(url); this.binding = binding; } };
      const original = 'https://fixture.test/site/index.html?cold=' + coldProcess + '#preserved';
      assert.equal((await sdk.loadPage(page, original)).offline, true);
      assert.deepEqual(page.urls, [original]); assert.equal(page.binding.directory, root + '/10000');
      assert.deepEqual(facts, [{ ...active, stage: 'active' }]); assert.equal(sdk.getState().initialFinished, true);
      assert.equal(fs.readFileSync(root + '/10000/index.html', 'utf8'), 'active A');
      assert.deepEqual(diagnostics, []);
    } finally { clearTimeout(deadline); await sdk.close(); }
  }
});

test('cleanup owns the write permit across all instances and root claim is atomic', async () => {
  const { api, block } = installerModule(), root = path.join(temporary, 'permit-root');
  const old = new api.PackageInstaller(), second = new api.PackageInstaller();
  const blocked = block('cleanupTask'), cleaning = old.cleanup(root, ''); await blocked.began;
  await assert.rejects(old.install(root, { version: 10000, sha256: 'a'.repeat(64), url: 'https://e.com/p' }, () => {}), /ROOT_IN_USE/);
  await assert.rejects(second.cleanup(root + '/child', ''), /ROOT_IN_USE/);
  await assert.rejects(api.claimManagedRoot(root), /ROOT_IN_USE/);
  const observation = await api.observePackage(root, { version: 10000, sha256: 'a'.repeat(64) });
  assert.deepEqual(observation, { directory: '', exists: false }); // 不等待长写任务。
  blocked.release(); await cleaning;
  const claims = await Promise.allSettled([api.claimManagedRoot(root), api.claimManagedRoot(root + '/./')]);
  assert.equal(claims.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(claims.find(result => result.status === 'rejected').reason.message, /ROOT_IN_USE/);
  const owner = claims.find(result => result.status === 'fulfilled').value;
  await assert.rejects(old.cleanup(root, ''), /ROOT_IN_USE/);
  await assert.rejects(owner.cleanup(root, ''), /ROOT_IN_USE/); // 同实例旧入口也不是授权入口。
  await assert.rejects(new api.PackageInstaller().installManaged(root, { version: 10000, sha256: 'a'.repeat(64), url: 'https://e.com/p' }), /ROOT_IN_USE/);
  await owner.cleanupManaged(root);
  const installed = await owner.installManaged(root, { version: 10000, sha256: 'a'.repeat(64), url: 'http://e.com:9080/p' });
  assert.equal(installed.success, true);
  await assert.rejects(api.claimManagedRoot(root + '/child'), /ROOT_IN_USE/);
});
test('root claim rejects state-space overlap and visible parent aliases without deletion', async () => {
  const { api } = installerModule(), root = path.join(temporary, 'claim-root'); fs.mkdirSync(root);
  fs.writeFileSync(root + '/sentinel', 'safe');
  const alias = path.join(temporary, 'claim-alias'); fs.symlinkSync(root, alias);
  await assert.rejects(api.claimManagedRoot(alias), /UNSAFE_PATH/);
  await assert.rejects(api.claimManagedRoot(root, root + '/state'), /UNSAFE_PATH/);
  assert.equal(fs.readFileSync(root + '/sentinel', 'utf8'), 'safe');
});
test('readonly observation distinguishes missing, unusable and usable targets', async () => {
  const { api } = installerModule(), root = path.join(temporary, 'observe-root'), record = { version: 10000, sha256: 'a'.repeat(64) };
  assert.deepEqual(await api.observePackage(root, record), { directory: '', exists: false });
  fs.mkdirSync(root + '/10000', { recursive: true });
  assert.deepEqual(await api.observePackage(root, record), { directory: '', exists: true });
  fs.writeFileSync(root + '/10000/index.html', 'home');
  assert.deepEqual(await api.observePackage(root, record), { directory: root + '/10000', exists: true });
});

test('non-200 responses have typed status and never publish', async () => {
  for (const statusCode of [204, 206, 404]) {
    const f = fixture(benign), session = { close() {}, cancel() {}, async fetch() { return { statusCode, headers: {} }; } };
    const result = await installWorker(f, platform(f), [], { session }).runInstall(path.join(f.root, 'v'), packageSpec(f), false, new SharedArrayBuffer(4));
    assert.equal(result.reason, 'HTTP_' + statusCode); assert.equal(result.httpStatus, statusCode);
    assert.equal(result.factStage, 'downloading'); assert.equal(result.requestStarted, true);
    assert.equal(result.publishedRecord, undefined); assert.equal(result.success, false);
  }
});
test('successful response delivered after total deadline is still a timeout', async () => {
  const f = fixture(benign), bytes = fs.readFileSync(f.zip); let mono = 0;
  const clock = { TimeType: { STARTUP: 0 }, getUptime: () => mono };
  const session = { close() {}, cancel() {}, async fetch(request) {
    request.configuration.tracing.httpEventsHandler.onDataReceive(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    mono = 120001; return { statusCode: 200, headers: {} };
  } };
  const result = await installWorker(f, platform(f), [], { session, clock }).runInstall(path.join(f.root, 'v'), packageSpec(f), false, new SharedArrayBuffer(4));
  assert.equal(result.reason, 'TIMEOUT'); assert.equal(result.httpStatus, undefined); assert.equal(result.publishedRecord, undefined);
});
test('same-protocol redirects have a maximum of ten followed locations', async () => {
  const f = fixture(benign); let requests = 0;
  const session = { close() {}, cancel() {}, async fetch() {
    requests++; return { statusCode: 302, headers: { location: '/again.zip' } };
  } };
  const result = await installWorker(f, platform(f), [], { session }).runInstall(path.join(f.root, 'v'), packageSpec(f), false, new SharedArrayBuffer(4));
  assert.equal(requests, 11); assert.equal(result.reason, 'TOO_MANY_REDIRECTS'); assert.equal(result.httpStatus, 302);
});
test('independent legacy removal handles a file and a leaf symlink without following it', async () => {
  const { api } = installerModule(), root = path.join(temporary, 'legacy-remove'); fs.mkdirSync(root);
  fs.writeFileSync(root + '/file.tmp', 'temporary'); fs.writeFileSync(root + '/outside', 'keep');
  fs.symlinkSync(root + '/outside', root + '/link');
  const installer = new api.PackageInstaller();
  await installer.removeUnbound(root + '/file.tmp'); await installer.removeUnbound(root + '/link');
  assert.equal(fs.existsSync(root + '/file.tmp'), false); assert.equal(fs.existsSync(root + '/link'), false);
  assert.equal(fs.readFileSync(root + '/outside', 'utf8'), 'keep');
});
test('lower-level regression completion leaves no open SDK FD', () => { assert.equal(positions.size, 0); });


test('old writer reserves overlapping roots while only its background validation is pending', async () => {
  const { api, block } = installerModule(), root = path.join(temporary, 'pending-validation-root');
  const old = new api.PackageInstaller(), other = new api.PackageInstaller();
  const blocked = block('validateRootTask', 1);
  const cleaning = old.cleanup(root, ''); await blocked.began;
  assert.equal(fs.existsSync(root), false); // 背景路径检查挂起，尚无任何写 IO。
  await assert.rejects(api.claimManagedRoot(root), /ROOT_IN_USE/);
  await assert.rejects(other.cleanup(root + '/child', ''), /ROOT_IN_USE/);
  await assert.rejects(other.cleanup(temporary, ''), /ROOT_IN_USE/);
  assert.equal(fs.existsSync(root), false);
  blocked.release(); await cleaning;
  assert.equal(fs.existsSync(root), true);
  const owner = await api.claimManagedRoot(root);
  await owner.cleanupManaged(root);
});
test('unsafe pending root validation releases only its own reservation for a natural retry', async () => {
  const { api, block } = installerModule(), root = path.join(temporary, 'failed-validation-root');
  const outside = path.join(temporary, 'failed-validation-outside'); fs.mkdirSync(outside);
  fs.writeFileSync(outside + '/sentinel', 'safe'); fs.symlinkSync(outside, root);
  const blocked = block('validateRootTask', 1), old = new api.PackageInstaller();
  const cleaning = old.cleanup(root, ''); const rejected = assert.rejects(cleaning, /UNSAFE_PATH/);
  await blocked.began; assert.equal(fs.readFileSync(outside + '/sentinel', 'utf8'), 'safe');
  blocked.release(); await rejected;
  fs.unlinkSync(root); // fixture移除不安全别名；新合法入口须能自然认领同一词法键。
  const owner = await api.claimManagedRoot(root);
  await owner.cleanupManaged(root);
  assert.equal(fs.readFileSync(outside + '/sentinel', 'utf8'), 'safe');
});

test('manager create rejects original root symlink dot-dot before normalization with real filesystem', async () => {
  const f = fixture(benign), real = path.join(f.root, 'real'); fs.mkdirSync(real);
  fs.writeFileSync(real + '/sentinel', 'safe');
  const alias = path.join(f.root, 'alias'); fs.symlinkSync(real, alias);
  const managedTypes = load('ManagedOfflineTypes');
  const { api } = installerModule();
  const { ManagedOfflineSdk } = load('ManagedOfflineSdk', {
    '@kit.AbilityKit': {}, '@kit.BasicServicesKit': {}, './PackageInstaller': api,
    './ManagedStorage': { ManagedStorage: class {} }, './ManagedPackageSession': { ManagedPackageSession: class {} },
    './ManagedPage': {}, './ManagedOfflineTypes': managedTypes
  });
  await assert.rejects(ManagedOfflineSdk.create({ filesDir: f.root, preferencesDir: f.root + '/state' }, {
    root: alias + '/../real', configProvider: async () => ({ enabled: false })
  }), /UNSAFE_PATH/);
  assert.equal(fs.readFileSync(real + '/sentinel', 'utf8'), 'safe');
});

test('background entry observation rejects open failure and closes FD on read failure', async () => {
  const { api } = installerModule(), f = fixture(benign), root = path.join(f.root, 'versions');
  const target = root + '/10000'; fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(target + '/index.html', 'readable on disk');
  const originalOpen = io.openSync, originalRead = io.readSync, originalClose = io.closeSync;
  for (const fault of ['open', 'read']) {
    let opens = 0, closes = 0;
    io.openSync = (file, flags) => {
      if (file === target + '/index.html') {
        opens++; if (fault === 'open') throw new Error('entry open fault');
      }
      return originalOpen(file, flags);
    };
    io.readSync = () => { throw new Error('entry read fault'); };
    io.closeSync = file => { closes++; return originalClose(file); };
    try {
      assert.equal(files.contentRoot(target), '', fault);
      assert.deepEqual(await api.observePackage(root, localSpec(f)), { exists: true, directory: '' });
      assert.equal(opens, 2); assert.equal(closes, fault === 'read' ? 2 : 0);
      assert.equal(positions.size, 0);
      assert.equal(fs.readFileSync(target + '/index.html', 'utf8'), 'readable on disk');
    } finally { io.openSync = originalOpen; io.readSync = originalRead; io.closeSync = originalClose; }
  }
});
test('background entry qualification reads exactly one byte and closes before returning root or dist', () => {
  const f = fixture(benign), target = f.content;
  fs.writeFileSync(target + '/index.html', 'home content');
  const originalRead = io.readSync, readLengths = [];
  io.readSync = (fd, buffer) => { readLengths.push(buffer.byteLength); return originalRead(fd, buffer); };
  try {
    assert.equal(files.contentRoot(target), target);
    assert.deepEqual(readLengths, [1]); assert.equal(positions.size, 0);
    fs.writeFileSync(target + '/index.html', ''); fs.mkdirSync(target + '/dist'); fs.writeFileSync(target + '/dist/index.html', 'dist content');
    readLengths.length = 0;
    assert.equal(files.contentRoot(target), target + '/dist');
    assert.deepEqual(readLengths, [1]); assert.equal(positions.size, 0);
  } finally { io.readSync = originalRead; }
});


for (const operation of ['unlink', 'rmdir']) {
  test('lifecycle cleanup continues after an ordinary ' + operation + ' failure and preserves kept bytes', () => {
    const root = fs.mkdtempSync(path.join(temporary, 'lifecycle-ordinary-' + operation + '-'));
    const outside = fs.mkdtempSync(path.join(temporary, 'lifecycle-sentinel-'));
    const failed = root + '/01-failed', laterFile = root + '/02-later.zip', laterDirectory = root + '/03-later';
    const sentinel = outside + '/sentinel', link = root + '/04-link';
    const active = Buffer.from([0, 1, 2, 255, 42]), zip = Buffer.from('kept downloaded archive');
    fs.mkdirSync(root + '/10001'); fs.writeFileSync(root + '/10001/index.html', active);
    fs.writeFileSync(root + '/10002.zip', zip); fs.writeFileSync(sentinel, 'external bytes'); fs.symlinkSync(outside, link);
    if (operation === 'unlink') { fs.writeFileSync(failed, 'undeletable file'); }
    else { fs.mkdirSync(failed); fs.writeFileSync(failed + '/child', 'child removed before failed rmdir'); }
    fs.writeFileSync(laterFile, 'stale ZIP'); fs.mkdirSync(laterDirectory); fs.writeFileSync(laterDirectory + '/child', 'stale contents');
    const unlink = io.unlinkSync, rmdir = io.rmdirSync, list = io.listFileSync;
    const attempted = []; let failures = 0, failure;
    io.listFileSync = target => list(target).sort(); // Make the failing child the first real traversal entry.
    io.unlinkSync = target => {
      attempted.push(['unlink', target]);
      if (operation === 'unlink' && target === failed) { failures++; const error = new Error('Injected ordinary unlink failure'); error.code = 'EACCES'; throw error; }
      return unlink(target);
    };
    io.rmdirSync = target => {
      attempted.push(['rmdir', target]);
      if (operation === 'rmdir' && target === failed) { failures++; const error = new Error('Injected ordinary rmdir failure'); error.code = 'EACCES'; throw error; }
      return rmdir(target);
    };
    try { files.cleanLifecyclePackages(root, ['10001', '10002.zip']); }
    catch (error) { failure = error; }
    finally { io.unlinkSync = unlink; io.rmdirSync = rmdir; io.listFileSync = list; }
    // The RED assertion must show a later actual file was left behind, not merely an exception mismatch.
    assert.equal(fs.existsSync(laterFile), false, 'a later file must be removed after an earlier child deletion fails');
    assert.equal(fs.existsSync(laterDirectory), false, 'a later directory must also be removed');
    assert.equal(fs.existsSync(link), false, 'the leaf symlink itself is removed');
    assert.equal(failures, 1); assert.equal(fs.existsSync(failed), true); assert.equal(failure, undefined);
    assert.ok(attempted.some(([kind, target]) => kind === 'unlink' && target === laterFile));
    assert.ok(attempted.some(([kind, target]) => kind === 'rmdir' && target === laterDirectory));
    assert.ok(attempted.some(([kind, target]) => kind === 'unlink' && target === link));
    assert.equal(attempted.some(([, target]) => target.startsWith(outside + '/')), false);
    assert.deepEqual(fs.readFileSync(root + '/10001/index.html'), active);
    assert.deepEqual(fs.readFileSync(root + '/10002.zip'), zip);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'external bytes');
    assert.equal(attempted.some(([, target]) => target === root + '/10002.zip' || target.startsWith(root + '/10001/')), false);
  });
}

test('lifecycle cleanup propagates the exact cancellation error instead of continuing deletion', () => {
  const root = fs.mkdtempSync(path.join(temporary, 'lifecycle-cancel-error-'));
  const first = root + '/01-cancel', later = root + '/02-later';
  fs.writeFileSync(first, 'first'); fs.writeFileSync(later, 'later'); fs.mkdirSync(root + '/10001');
  fs.writeFileSync(root + '/10001/index.html', 'active');
  const cancellation = new types.OfflineError('CANCELLED'), unlink = io.unlinkSync, list = io.listFileSync;
  const attempted = [];
  io.listFileSync = target => list(target).sort();
  io.unlinkSync = target => { attempted.push(target); if (target === first) { throw cancellation; } return unlink(target); };
  try { assert.throws(() => files.cleanLifecyclePackages(root, ['10001']), error => error === cancellation); }
  finally { io.unlinkSync = unlink; io.listFileSync = list; }
  assert.deepEqual(attempted, [first]);
  assert.equal(fs.readFileSync(first, 'utf8'), 'first'); assert.equal(fs.readFileSync(later, 'utf8'), 'later');
  assert.equal(fs.readFileSync(root + '/10001/index.html', 'utf8'), 'active');
});

test('lifecycle cleanup validates its root before deleting through aliases or non-directory roots', () => {
  const root = fs.mkdtempSync(path.join(temporary, 'lifecycle-root-check-'));
  const alias = root + '/alias', directory = root + '/real', ordinaryFile = root + '/file';
  fs.mkdirSync(directory); fs.writeFileSync(directory + '/sentinel', 'safe directory');
  fs.writeFileSync(ordinaryFile, 'safe file'); fs.symlinkSync(directory, alias);
  for (const unsafe of [alias, alias + '/..', ordinaryFile]) {
    assert.throws(() => files.cleanLifecyclePackages(unsafe, []), error => error instanceof types.OfflineError && error.reason === 'UNSAFE_PATH');
    assert.equal(fs.readFileSync(directory + '/sentinel', 'utf8'), 'safe directory');
    assert.equal(fs.readFileSync(ordinaryFile, 'utf8'), 'safe file');
    assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
  }
});

test('lifecycle cleanup retains its existing task-entry cancellation checkpoint and releases its writer', async () => {
  const { api, block } = installerModule(), root = fs.mkdtempSync(path.join(temporary, 'lifecycle-task-cancel-'));
  fs.mkdirSync(root + '/10001'); fs.writeFileSync(root + '/10001/index.html', 'active'); fs.writeFileSync(root + '/stale.zip', 'stale');
  const owner = await api.claimManagedRoot(root), blocked = block('lifecycleCleanupTask', 1);
  const work = owner.cleanupLifecycle(root, ['10001']);
  const rejected = assert.rejects(work, error => error instanceof types.OfflineError && error.reason === 'CANCELLED');
  await blocked.began; owner.cancel(); blocked.release(); await rejected;
  assert.equal(fs.readFileSync(root + '/stale.zip', 'utf8'), 'stale');
  assert.equal(fs.readFileSync(root + '/10001/index.html', 'utf8'), 'active');
  await owner.cleanupLifecycle(root, ['10001']);
  assert.equal(fs.existsSync(root + '/stale.zip'), false);
  assert.equal(fs.readFileSync(root + '/10001/index.html', 'utf8'), 'active');
});


// Current Android-boundary regressions. Real input bytes/files; the native inflater is a host facade.
test('android boundary pinned actual directory body is rejected and empty directory is accepted', async () => {
  const pinned = path.resolve(__dirname, './fixtures/directory-nonempty.zip');
  const bytes = fs.readFileSync(pinned);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), '0c838ccfc64080fe99ff4d84c0cdf08cb4a241d29c6b9e226a5ea9c527aae9e4');
  const entries = [{name:'dist/index.html',body:'home'}, {name:'dist/assets/'}];
  const bad = fixture(entries); fs.writeFileSync(bad.zip, bytes);
  // Historical whole-file boundary suppresses directory bodies and trusts declared size: reproduce it faithfully.
  const declared = (() => { let size = 0; for (let at = 0; (at = bytes.indexOf(Buffer.from('504b0102','hex'), at)) >= 0; at += 4) size += bytes.readUInt32LE(at + 24); return size; })();
  const p = platform(bad, {declaredSize:declared});
  // Use actual archived index contents in the old facade so RED reaches the missing body guard.
  const first = bytes.indexOf(Buffer.from('504b0102','hex'));
  const off = bytes.readUInt32LE(first + 42), start = off + 30 + bytes.readUInt16LE(off + 26) + bytes.readUInt16LE(off + 28);
  entries[0].body = zlib.inflateRawSync(bytes.subarray(start, start + bytes.readUInt32LE(first + 20)));
  await assert.rejects(p.archive.extractPackage(bad.zip, bad.content, () => {}), /INVALID_ARCHIVE/);
  const good = fixture([{name:'dist/'},{name:'dist/index.html',body:'home'},{name:'dist/assets/'}]);
  await platform(good).archive.extractPackage(good.zip, good.content, () => {});
  assert.equal(fs.readFileSync(good.content + '/index.html','utf8'),'home');
  assert.equal(fs.lstatSync(good.content + '/assets').isDirectory(),true);
});
test('android boundary root entry wins and dist only output is physically normalized', async () => {
  const root = fixture([{name:'dist/index.html',body:'nested'}, {name:'index.html',body:'root'}, {name:'shared.js',body:'shared'}]);
  await platform(root).archive.extractPackage(root.zip,root.content,()=>{});
  assert.equal(fs.readFileSync(root.content+'/index.html','utf8'),'root');
  assert.equal(fs.readFileSync(root.content+'/dist/index.html','utf8'),'nested');
  const dist = fixture([{name:'dist/',body:'discard container'}, {name:'outside/',body:'discard directory'},
    {name:'outside.txt',body:'discard file'}, {name:'dist/index.html',body:'home'}, {name:'dist/assets/a.js',body:'resource'}]);
  await platform(dist).archive.extractPackage(dist.zip,dist.content,()=>{});
  assert.equal(fs.readFileSync(dist.content+'/index.html','utf8'),'home');
  assert.equal(fs.readFileSync(dist.content+'/assets/a.js','utf8'),'resource');
  assert.deepEqual(fs.readdirSync(dist.content).sort(),['assets','index.html']);
  const empty=fixture([{name:'index.html',body:''},{name:'dist/index.html',body:'nested'}]);
  await assert.rejects(platform(empty).archive.extractPackage(empty.zip,empty.content,()=>{}),/MISSING_ENTRY/);
  const versions=path.join(empty.root,'versions');fs.mkdirSync(versions);fs.mkdirSync(versions+'/10001');fs.writeFileSync(versions+'/10001/index.html','in use A');
  const spec=packageSpec(empty);fs.copyFileSync(empty.zip,versions+'/'+spec.version+'.zip');
  const result=await installWorker(empty,platform(empty)).runManagedExtract(versions,spec,new SharedArrayBuffer(4));
  assert.equal(result.success,false);assert.equal(result.reason,'MISSING_ENTRY');
  assert.equal(fs.existsSync(versions+'/'+spec.version),false);
  assert.equal(fs.readFileSync(versions+'/10001/index.html','utf8'),'in use A');
});
test('android boundary metadata accepts former size count and name thresholds', () => {
  const many = fixture([{name:'index.html',body:'home'},...Array.from({length:10000},(_,i)=>({name:'f'+i,body:''}))]);
  assert.equal(inspection.inspectZip(many.zip,()=>{}).length,10001);
  const large = fixture([{name:'index.html',body:'a'}],data=>{
    const central=data.indexOf(Buffer.from('504b0102','hex')); data.writeUInt32LE(256*1024*1024+1,central+24); data.writeUInt32LE(256*1024*1024+1,22);
  });
  assert.equal(inspection.inspectZip(large.zip,()=>{})[0].size,256*1024*1024+1);
  assert.equal(inspection.inspectZip(fixture([{name:'a'.repeat(4097),body:''}]).zip,()=>{}).length,1);
});
test('android boundary cancellation between top level cleanup items stops the next actual deletion', () => {
  const root=path.join(temporary,'cancel-between-items'); fs.mkdirSync(root);
  fs.writeFileSync(root+'/a','old');fs.writeFileSync(root+'/b','later');fs.mkdirSync(root+'/keep');fs.writeFileSync(root+'/keep/index.html','active');
  const originalList=io.listFileSync,originalUnlink=io.unlinkSync;let cancelled=false,attempts=[];
  io.listFileSync=file=>file===root?['a','b','keep']:originalList(file);
  io.unlinkSync=file=>{attempts.push(file);originalUnlink(file);if(file===root+'/a')cancelled=true;};
  try{assert.throws(()=>files.cleanLifecyclePackages(root,['keep'],()=>{if(cancelled)throw new types.OfflineError('CANCELLED');}),/CANCELLED/);}
  finally{io.listFileSync=originalList;io.unlinkSync=originalUnlink;}
  assert.deepEqual(attempts,[root+'/a']);assert.equal(fs.readFileSync(root+'/b','utf8'),'later');assert.equal(fs.readFileSync(root+'/keep/index.html','utf8'),'active');
});

test('android boundary real stored ZIP above former transfer and file limit completes Local and Remote', async () => {
  const f=fixture([{name:'index.html',body:Buffer.alloc(64*1024*1024+1,65),stored:true}]);
  assert.ok(fs.statSync(f.zip).size>64*1024*1024);
  for(const local of [true,false]){
    const root=path.join(f.root,local?'large-local':'large-remote'), worker=installWorker(f,platform(f));
    fs.mkdirSync(root);
    const spec={...packageSpec(f),...(local?{localArchive:f.zip}:{})};
    const downloaded=await worker.runManagedDownload(root,spec,new SharedArrayBuffer(4));
    assert.equal(downloaded.success,true,downloaded.reason);
    const extracted=await worker.runManagedExtract(root,spec,new SharedArrayBuffer(4));
    assert.equal(extracted.success,true,extracted.reason);
    assert.equal(fs.statSync(root+'/'+spec.version+'/index.html').size,64*1024*1024+1);
    assert.equal(fs.existsSync(root+'/'+spec.version+'/dist'),false);
  }
  assert.equal(positions.size,0);
});
