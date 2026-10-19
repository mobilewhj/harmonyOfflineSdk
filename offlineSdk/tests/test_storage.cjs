const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require(process.env.OFFLINE_TEST_TYPESCRIPT || 'typescript');

// 这里只转译生产 ArkTS 以便主机执行；SQL 与事务实际落入文件 SQLite。
// 这份证据不等于 ArkTS 编译、ArkData 真库或设备运行。
function compile(imports) {
  const module = { exports: {} };
  const source = fs.readFileSync(process.env.OFFLINE_TEST_SDK_ETS_ROOT ?
    path.join(process.env.OFFLINE_TEST_SDK_ETS_ROOT, 'ManagedStorage.ets') :
    path.resolve(__dirname, '../src/main/ets/ManagedStorage.ets'), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }
  }).outputText;
  vm.runInThisContext('(function(require,module,exports){' + output + '\n})')(
    name => { if (!(name in imports)) throw new Error('Unexpected import ' + name); return imports[name]; },
    module, module.exports);
  return module.exports;
}
const A = { version: 10000, sha256: 'a'.repeat(64) };
const B = { version: 10001, sha256: 'b'.repeat(64) };
const C = { version: 10002, sha256: 'c'.repeat(64) };
const ROOT = '/private/app/offline/lifecycle-packages';
const DB_NAME = 'offline-lifecycle-' + crypto.createHash('sha256').update(ROOT).digest('hex') + '.db';

function harness(t, existingDirectory, packageRoot = ROOT, committedQueries = false, failedCursorQueries = false) {
  const directory = existingDirectory || fs.mkdtempSync(path.join(os.tmpdir(), 'offline-rdb-'));
  const opened = [], operations = [], stores = new Map();
  const name = 'offline-lifecycle-' + crypto.createHash('sha256').update(packageRoot).digest('hex') + '.db';
  let queryFailure, queryError, executeFailure, executeError, commitFailure, rollbackFailure;
  let openFailure, closeFailure, afterClose, cursorFailure, cursorTransform;
  let zeroUpdate = false, activeTransactions = 0, maxTransactions = 0;
  let cursorCount = 0, closeCount = 0, afterUpdate, afterExecute;
  class RdbPredicates {
    constructor(table) { this.table = table; this.parts = []; this.binds = []; }
    and() { return this; }
    equalTo(column, value) { this.parts.push(column + ' = ?'); this.binds.push(value); return this; }
    notEqualTo(column, value) { this.parts.push(column + ' != ?'); this.binds.push(value); return this; }
  }
  function resultSet(statement, values) {
    const columns = statement.columns().map(column => column.name);
    let index = -1, closed = false;
    cursorCount++;
    const valueAt = column => {
      if (closed || !values[index] || column < 0 || column >= columns.length) throw new Error('cursor');
      return values[index][columns[column]];
    };
    return {
      rowCount: values.length, columnCount: columns.length, columnNames: columns,
      goToNextRow() {
        if (closed) throw new Error('cursor closed');
        if (cursorFailure) { const error = cursorFailure; cursorFailure = undefined; throw error; }
        return ++index < values.length;
      },
      getColumnIndex(name) { return columns.indexOf(name); },
      getString(column) { return String(valueAt(column)); },
      getLong(column) { return Number(valueAt(column)); },
      close() { if (!closed) { closed = true; cursorCount--; } }
    };
  }
  const relationalStore = {
    SecurityLevel: { S1: 1 }, RdbPredicates,
    async getRdbStore(context, config) {
      opened.push({ ...config });
      if (openFailure) { const error = openFailure(config); if (error) throw error; }
      if (stores.has(config.name)) return stores.get(config.name);
      const filename = path.join(directory, config.name);
      let db;
      try { db = new DatabaseSync(filename); db.exec('PRAGMA journal_mode = WAL'); }
      catch (error) {
        if (db) db.close();
        if (![11, 26].includes(error.errcode)) throw error;
        if (!config.allowRebuild) throw Object.assign(new Error('native corruption classification'), { code: 14800011 });
        // 仅测试端口模拟 ArkData 的确定损坏恢复。真实 SQLite 先拒绝损坏文件，生产 SDK 不删库。
        operations.push({ kind: 'platform-rebuild-facade', sqliteCode: error.errcode, filename });
        for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(filename + suffix, { force: true });
        db = new DatabaseSync(filename); db.exec('PRAGMA journal_mode = WAL');
      }
      // ArkData querySql uses a separate read connection in WAL mode. This option
      // executes those reads on a real second SQLite connection, not synthetic rows.
      const reader = committedQueries ? new DatabaseSync(filename, { readOnly: true }) : db;
      let inTransaction = false;
      const store = {
        db, filename,
        get version() { return Number(db.prepare('PRAGMA user_version').get().user_version); },
        set version(value) { db.exec('PRAGMA user_version = ' + Number(value)); },
        beginTransaction() {
          operations.push({ kind: 'begin' }); db.exec('BEGIN IMMEDIATE');
          inTransaction = true; activeTransactions++; maxTransactions = Math.max(maxTransactions, activeTransactions);
        },
        commit() {
          operations.push({ kind: 'commit' });
          if (commitFailure) { const error = commitFailure; commitFailure = undefined; throw error; }
          db.exec('COMMIT'); inTransaction = false; activeTransactions--;
        },
        rollBack() {
          operations.push({ kind: 'rollback' });
          if (rollbackFailure) { const error = rollbackFailure; rollbackFailure = undefined; throw error; }
          db.exec('ROLLBACK'); inTransaction = false; activeTransactions--;
        },
        async executeSql(sql, args = []) {
          operations.push({ kind: 'execute', sql, args });
          if (executeFailure && executeFailure(sql)) throw executeError || new Error('injected execute failure');
          if (args.length) db.prepare(sql).run(...args); else db.exec(sql);
          if (afterExecute) await afterExecute(sql);
          await new Promise(resolve => setImmediate(resolve));
        },
        async querySql(sql, args = []) {
          operations.push({ kind: 'query', sql, args });
          if (queryFailure && queryFailure(sql)) throw queryError || new Error('injected read failure');
          let cursor;
          try {
            const statement = reader.prepare(sql);
            cursor = resultSet(statement, statement.all(...args));
          } catch (error) {
            if (!failedCursorQueries) throw error;
            // Actual SQLite failed this query. Model the observed native API cursor
            // boundary (-1 rows, no metadata, next=false), without inventing a native code.
            operations.push({ kind: 'failed-cursor-facade', sqliteCode: error.errcode, sql });
            let closed = false; cursorCount++;
            cursor = { rowCount: -1, columnCount: 0, columnNames: [], goToNextRow: () => false,
              getColumnIndex: () => -1, getString() { throw error; }, getLong() { throw error; },
              close() { if (!closed) { closed = true; cursorCount--; } } };
          }
          return cursorTransform ? cursorTransform(sql, cursor) : cursor;
        },
        async update(values, predicates) {
          operations.push({ kind: 'update', values, predicates });
          if (zeroUpdate) { zeroUpdate = false; return 0; }
          const columns = Object.keys(values);
          const sql = 'UPDATE ' + predicates.table + ' SET ' + columns.map(column => column + ' = ?').join(', ') +
            ' WHERE ' + predicates.parts.join(' AND ');
          const result = db.prepare(sql).run(...columns.map(column => values[column]), ...predicates.binds);
          if (afterUpdate) await afterUpdate(values);
          return Number(result.changes);
        },
        async close() {
          closeCount++;
          const operation = { kind: 'close', closed: false }; operations.push(operation);
          if (closeFailure) { const error = closeFailure; closeFailure = undefined; throw error; }
          if (reader !== db) reader.close();
          db.close(); operation.closed = true;
          if (inTransaction) { inTransaction = false; activeTransactions--; }
          stores.delete(config.name);
          if (afterClose) { const callback = afterClose; afterClose = undefined; await callback(filename); }
        }
      };
      stores.set(config.name, store); return store;
    }
  };
  const cryptoFramework = { createMd() {
    const hash = crypto.createHash('sha256');
    return { updateSync: blob => hash.update(blob.data), digestSync: () => ({ data: hash.digest() }) };
  } };
  const exports = compile({ '@kit.ArkData': { relationalStore }, '@kit.ArkTS': { util: { TextEncoder: class {
    encodeInto(value) { return new TextEncoder().encode(value); }
  } } }, '@kit.CryptoArchitectureKit': { cryptoFramework } });
  const storage = new exports.ManagedStorage({}, packageRoot);
  const closeAll = async () => { for (const store of [...stores.values()]) await store.close(); };
  if (t) t.after(async () => { await closeAll(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { storage, ...exports, directory, root: packageRoot, opened, operations, closeAll,
    db: () => stores.get(name).db, filename: path.join(directory, name),
    queryFailure: (value, error) => { queryFailure = value; queryError = error; },
    executeFailure: (value, error) => { executeFailure = value; executeError = error; },
    openFailure: value => { openFailure = value; }, closeFailure: error => { closeFailure = error; },
    afterClose: callback => { afterClose = callback; }, cursorFailure: error => { cursorFailure = error; },
    cursorTransform: value => { cursorTransform = value; },
    commitFailure: error => { commitFailure = error; }, rollbackFailure: error => { rollbackFailure = error; },
    zeroUpdate: () => { zeroUpdate = true; }, afterUpdate: callback => { afterUpdate = callback; },
    afterExecute: callback => { afterExecute = callback; },
    counters: () => ({ cursorCount, closeCount, maxTransactions }) };
}
async function makeActive(h, record = A) {
  await h.storage.registerTarget(record);
  assert.equal(await h.storage.setStage(record, h.PackageStage.READY), true);
  await h.storage.activate(record);
}
async function readyAfterActive(h) {
  await makeActive(h);
  await h.storage.registerTarget(B, A.version);
  assert.equal(await h.storage.setStage(B, h.PackageStage.READY), true);
}
function plainRows(db) { return db.prepare('SELECT version, sha256, stage FROM offline_package ORDER BY version').all().map(row => ({ ...row })); }

function nativeError(code, message = 'native boundary error') { return Object.assign(new Error(message), { code }); }
function corruptBytes() { return Buffer.from('confirmed corrupt SQLite fixture'.repeat(12)); }
function compileSdk(file, imports = {}) {
  const sourceRoot = process.env.OFFLINE_TEST_SDK_ETS_ROOT || path.resolve(__dirname, '../src/main/ets');
  const output = ts.transpileModule(fs.readFileSync(path.join(sourceRoot, file + '.ets'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const module = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + output + '\n})')(
    name => { if (!(name in imports)) throw new Error('Unexpected session import ' + name); return imports[name]; }, module, module.exports);
  return module.exports;
}
function sessionFixture(t, failedCursorQueries = false) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'offline-rdb-session-'));
  const h = harness(t, directory, path.join(directory, 'packages'), false, failedCursorQueries);
  fs.mkdirSync(h.root);
  const cleanup = [], events = [], diagnostics = [];
  const types = compileSdk('ManagedOfflineTypes');
  const observePackage = async (root, record) => {
    const directory = path.join(root, String(record.version));
    return { exists: fs.existsSync(directory), directory: fs.existsSync(path.join(directory, 'index.html')) ? directory : '' };
  };
  // 只隔离目录观测/清理端口；真实会话与存储执行。此组不执行安装或伪造 ZIP 输出。
  const { ManagedPackageSession } = compileSdk('ManagedPackageSession', {
    './PackageInstaller': { observePackage }, './InstallWorker': { validManagedDownloadUrl: () => true },
    './ManagedStorage': h, './OfflineTypes': compileSdk('OfflineTypes'), './ManagedOfflineTypes': types
  });
  const installer = {
    cancel() {},
    async cleanupLifecycle(root, keep) {
      cleanup.push([...keep]);
      for (const name of fs.readdirSync(root)) if (!keep.includes(name)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
    },
    async installManaged() { throw new Error('This DB/session test must never enter ZIP installation'); }
  };
  const session = new ManagedPackageSession(h.root, installer, h.storage, 10000,
    value => diagnostics.push(value), value => events.push(value));
  const bytes = Buffer.from('in-use package bytes must survive recovery');
  const packagePath = path.join(h.root, String(A.version));
  const writeA = () => { fs.mkdirSync(packagePath); fs.writeFileSync(path.join(packagePath, 'index.html'), bytes); };
  return { ...h, session, cleanup, events, diagnostics, types, writeA, bytes, packagePath };
}

if (process.argv[2] === '--interrupt-activation') {
  // 真实 UPDATE 后、生产 commit 前结束进程；新进程重开必须仍保有旧 active 和 ready。
  (async () => {
    const h = harness(undefined, process.argv[3]);
    await h.storage.load();
    h.afterUpdate(values => { if (values.stage === h.PackageStage.ACTIVE) process.exit(17); });
    await h.storage.activate(B);
    process.exit(18);
  })().catch(error => { process.stderr.write(String(error)); process.exit(19); });
} else {
  test('SQLite evidence: schema is exactly three columns; DB uses root identity outside package cleanup', async t => {
    const h = harness(t);
    assert.equal(h.opened.length, 0);
    assert.deepEqual(await h.storage.load(), []);
    assert.equal(h.opened[0].name, DB_NAME);
    assert.equal(h.opened[0].allowRebuild, false);
    assert.equal(h.opened[0].rootDir, undefined);
    assert.equal(h.opened[0].customDir, undefined);
    assert.equal(h.filename.startsWith(ROOT + path.sep), false);
    assert.equal(h.db().prepare('PRAGMA user_version').get().user_version, 1);
    const columns = h.db().prepare('PRAGMA table_info(offline_package)').all().map(row => ({
      name: row.name, type: row.type, pk: row.pk, notnull: row.notnull
    }));
    assert.deepEqual(columns, [
      { name: 'version', type: 'INTEGER', pk: 1, notnull: 0 },
      { name: 'sha256', type: 'TEXT', pk: 0, notnull: 1 },
      { name: 'stage', type: 'TEXT', pk: 0, notnull: 1 }
    ]);
    assert.deepEqual(h.db().prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name), ['offline_package']);
    await new h.ManagedStorage({}, '/private/app/offline/another-root').load();
    assert.notEqual(h.opened.at(-1).name, DB_NAME);
    assert.equal(h.counters().cursorCount, 0);
  });

  test('real pooled SQLite connections bootstrap a fresh schema after committed DDL visibility', async t => {
    const h = harness(t, undefined, ROOT, true);
    assert.deepEqual(await h.storage.load(), []);
    await makeActive(h); await h.storage.registerTarget(B, A.version);
    assert.equal(await h.storage.setStage(B, h.PackageStage.DOWNLOADED), true);
    assert.equal(await h.storage.setStage(B, h.PackageStage.READY), true);
    assert.deepEqual(await h.storage.load(), [{ ...A, stage: 'active' }, { ...B, stage: 'ready' }]);
    await h.storage.activate(B);
    assert.deepEqual(await h.storage.load(), [{ ...B, stage: 'active' }]);
    assert.equal(h.db().prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(h.counters().cursorCount, 0);
  });

  test('pooled SQLite reads preserve rows and version on actual additive migration failure', async t => {
    for (const duplicate of [false, true]) {
      const h = harness(t, undefined, ROOT, true);
      const seed = new DatabaseSync(h.filename);
      seed.exec('CREATE TABLE offline_package(version INTEGER PRIMARY KEY, sha256 TEXT NOT NULL, stage TEXT NOT NULL)');
      seed.prepare('INSERT INTO offline_package VALUES (?, ?, ?)').run(A.version, A.sha256, 'ready');
      if (duplicate) seed.prepare('INSERT INTO offline_package VALUES (?, ?, ?)').run(B.version, B.sha256, 'ready');
      const before = plainRows(seed); seed.close();
      if (duplicate) {
        await assert.rejects(h.storage.load(), /UNIQUE constraint failed/);
        const inspect = new DatabaseSync(h.filename);
        assert.equal(inspect.prepare('PRAGMA user_version').get().user_version, 0);
        assert.deepEqual(plainRows(inspect), before);
        assert.equal(inspect.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index'").get().count, 0);
        inspect.close();
      } else {
        assert.deepEqual(await h.storage.load(), before);
        assert.equal(h.db().prepare('PRAGMA user_version').get().user_version, 1);
      }
      assert.deepEqual(h.opened.map(config => config.allowRebuild), [false]);
    }
  });

  test('schema read failure precedes every mutation and a missing v1 table is never recreated as empty', async t => {
    const denied = harness(t, undefined, ROOT, true);
    const error = nativeError(14800023, 'schema read denied');
    denied.queryFailure(sql => sql.startsWith('PRAGMA table_info'), error);
    await assert.rejects(denied.storage.load(), value => value === error);
    assert.equal(denied.operations.some(operation => ['execute', 'update', 'begin'].includes(operation.kind)), false);
    assert.deepEqual(denied.opened.map(config => config.allowRebuild), [false]);
    const h = harness(t, undefined, ROOT, true); await makeActive(h); await h.closeAll();
    const native = new DatabaseSync(h.filename); native.exec('DROP TABLE offline_package'); native.close();
    const start = h.operations.length;
    await assert.rejects(new h.ManagedStorage({}, ROOT).load(), /STORAGE_SCHEMA/);
    assert.equal(h.operations.slice(start).some(operation => ['execute', 'update', 'begin'].includes(operation.kind)), false);
    const inspect = new DatabaseSync(h.filename);
    assert.equal(inspect.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(inspect.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='offline_package'").get().count, 0);
    inspect.close();
    assert.deepEqual(h.opened.map(config => config.allowRebuild), [false, false]);
  });

  test('all lifecycle stages use fixed lowercase values and persist across a new storage instance', async t => {
    const h = harness(t);
    await h.storage.registerTarget(A);
    assert.deepEqual(await h.storage.load(), [{ ...A, stage: 'downloading' }]);
    assert.equal(await h.storage.setStage(A, h.PackageStage.DOWNLOADED), true);
    assert.deepEqual(await h.storage.load(), [{ ...A, stage: 'downloaded' }]);
    assert.equal(await h.storage.setStage(A, h.PackageStage.READY), true);
    await h.closeAll();
    const reopened = new h.ManagedStorage({}, ROOT);
    assert.deepEqual(await reopened.load(), [{ ...A, stage: 'ready' }]);
    await reopened.activate(A);
    assert.deepEqual(await reopened.load(), [{ ...A, stage: 'active' }]);
    await reopened.activate(A);
    assert.deepEqual(await reopened.load(), [{ ...A, stage: 'active' }]);
  });

  test('same-version SHA conflicts precede every INSERT and DELETE and preserve all rows', async t => {
    const h = harness(t); await readyAfterActive(h);
    const before = await h.storage.load();
    for (const record of [A, B]) {
      const operationStart = h.operations.length;
      await assert.rejects(h.storage.registerTarget({ ...record, sha256: 'd'.repeat(64) }, A.version), h.PackageIdentityConflictError);
      assert.deepEqual(await h.storage.load(), before);
      assert.equal(h.operations.slice(operationStart).some(operation => operation.kind === 'execute' || operation.kind === 'update'), false);
    }
  });

  test('repeated registration preserves the existing SHA and stage', async t => {
    const h = harness(t); await readyAfterActive(h);
    await h.storage.registerTarget(B, A.version);
    assert.deepEqual(await h.storage.load(), [{ ...A, stage: 'active' }, { ...B, stage: 'ready' }]);
  });

  test('registration evicts nonactive in-use rows after runtime reset, including ready, without blocking new ready', async t => {
    for (const stage of ['downloaded', 'ready']) {
      const h = harness(t); await makeActive(h);
      h.db().prepare('UPDATE offline_package SET stage = ? WHERE version = ?').run(stage, A.version);
      await h.storage.registerTarget(B, A.version);
      assert.deepEqual(await h.storage.load(), [{ ...B, stage: 'downloading' }]);
      assert.equal(await h.storage.setStage(B, h.PackageStage.READY), true);
      assert.deepEqual(await h.storage.load(), [{ ...B, stage: 'ready' }]);
    }
  });

  test('real SQLite insert failure rolls registration back with active and previous target unchanged', async t => {
    const h = harness(t); await readyAfterActive(h);
    const before = await h.storage.load();
    h.db().exec(`CREATE TRIGGER fail_registration BEFORE INSERT ON offline_package WHEN NEW.version = ${C.version}
      BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END`);
    await assert.rejects(h.storage.registerTarget(C, A.version));
    assert.deepEqual(await h.storage.load(), before);
  });

  test('real SQLite eviction failure rolls the newly inserted target back', async t => {
    const h = harness(t); await readyAfterActive(h);
    const before = await h.storage.load();
    h.db().exec(`CREATE TRIGGER fail_eviction BEFORE DELETE ON offline_package WHEN OLD.version = ${B.version}
      BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END`);
    await assert.rejects(h.storage.registerTarget(C, A.version));
    assert.deepEqual(await h.storage.load(), before);
  });

  test('stage writes require exact version and SHA and never change active or bypass activation', async t => {
    const h = harness(t); await makeActive(h);
    assert.equal(await h.storage.setStage(B, h.PackageStage.READY), false);
    assert.equal(await h.storage.setStage(A, h.PackageStage.DOWNLOADED), false);
    await h.storage.registerTarget(B, A.version);
    assert.equal(await h.storage.setStage({ ...B, sha256: C.sha256 }, h.PackageStage.READY), false);
    assert.equal(await h.storage.setStage(B, h.PackageStage.ACTIVE), false);
    assert.deepEqual(await h.storage.load(), [{ ...A, stage: 'active' }, { ...B, stage: 'downloading' }]);
  });

  test('unique SQL indices prevent second active/ready; second ready stage update preserves previous ready', async t => {
    const h = harness(t); await readyAfterActive(h);
    assert.throws(() => h.db().prepare('INSERT INTO offline_package VALUES (?, ?, ?)').run(C.version, C.sha256, 'active'));
    assert.throws(() => h.db().prepare('INSERT INTO offline_package VALUES (?, ?, ?)').run(C.version, C.sha256, 'ready'));
    h.db().prepare('INSERT INTO offline_package VALUES (?, ?, ?)').run(C.version, C.sha256, 'downloaded');
    assert.equal(await h.storage.setStage(C, h.PackageStage.READY), false);
    assert.deepEqual(await h.storage.load(), [{ ...A, stage: 'active' }, { ...B, stage: 'ready' }, { ...C, stage: 'downloaded' }]);
  });

  test('schema trigger rejects direct SHA mutation without changing the row', async t => {
    const h = harness(t); await h.storage.registerTarget(A);
    assert.throws(() => h.db().prepare('UPDATE offline_package SET sha256 = ? WHERE version = ?').run(B.sha256, A.version), /same_version_sha256_conflict/);
    assert.deepEqual(await h.storage.load(), [{ ...A, stage: 'downloading' }]);
  });

  test('zero affected stage rows return false rather than confirming preparation', async t => {
    const h = harness(t); await h.storage.registerTarget(A);
    h.zeroUpdate();
    assert.equal(await h.storage.setStage(A, h.PackageStage.READY), false);
    assert.deepEqual(await h.storage.load(), [{ ...A, stage: 'downloading' }]);
    assert.equal(h.operations.at(-2).kind, 'rollback');
  });

  test('missing, nonready and mismatching SHA activation never delete old active', async t => {
    const h = harness(t); await makeActive(h); await h.storage.registerTarget(B, A.version);
    const before = await h.storage.load();
    await assert.rejects(h.storage.activate(C));
    await assert.rejects(h.storage.activate(B));
    await assert.rejects(h.storage.activate({ ...A, sha256: B.sha256 }));
    assert.deepEqual(await h.storage.load(), before);
  });

  test('real SQLite activation failure after old active DELETE restores both active and ready', async t => {
    const h = harness(t); await readyAfterActive(h);
    const before = await h.storage.load();
    h.db().exec(`CREATE TRIGGER fail_activation BEFORE UPDATE OF stage ON offline_package WHEN NEW.stage = 'active'
      BEGIN SELECT RAISE(ABORT, 'injected activation failure'); END`);
    await assert.rejects(h.storage.activate(B));
    assert.deepEqual(await h.storage.load(), before);
  });

  test('zero-row activation and commit failure roll old-active removal back', async t => {
    const h = harness(t); await readyAfterActive(h);
    const before = await h.storage.load();
    h.zeroUpdate(); await assert.rejects(h.storage.activate(B));
    assert.deepEqual(await h.storage.load(), before);
    h.commitFailure(new Error('injected commit failure'));
    await assert.rejects(h.storage.activate(B), /commit failure/);
    assert.deepEqual(await h.storage.load(), before);
  });

  test('rollback API failure discards the handle and reopens the same DB without deleting or rebuilding', async t => {
    const h = harness(t); await readyAfterActive(h);
    const before = await h.storage.load();
    h.zeroUpdate(); h.rollbackFailure(new Error('injected rollback API failure'));
    await assert.rejects(h.storage.activate(B), /STORAGE_ROLLBACK/);
    assert.equal(h.counters().closeCount, 1);
    assert.deepEqual(await h.storage.load(), before);
    assert.equal(h.opened.length, 2);
    assert.equal(h.opened[1].name, h.opened[0].name);
    assert.equal(h.opened[1].allowRebuild, false);
  });

  test('evictInactive requires matching persisted active; absent/nonactive keep preserves new rows', async t => {
    const h = harness(t); await h.storage.registerTarget(B);
    const before = await h.storage.load();
    await h.storage.evictInactive();
    await h.storage.evictInactive(A.version);
    await h.storage.evictInactive(B.version);
    assert.deepEqual(await h.storage.load(), before);
    await h.storage.setStage(B, h.PackageStage.READY); await h.storage.activate(B);
    await h.storage.registerTarget(C, B.version);
    await h.storage.evictInactive(B.version);
    assert.deepEqual(await h.storage.load(), [{ ...B, stage: 'active' }]);
  });

  test('concurrent production mutations serialize real SQLite transactions', async t => {
    const h = harness(t); await makeActive(h);
    await Promise.all([h.storage.registerTarget(B, A.version), h.storage.registerTarget(C, A.version)]);
    assert.deepEqual(await h.storage.load(), [{ ...A, stage: 'active' }, { ...C, stage: 'downloading' }]);
    assert.equal(h.counters().maxTransactions, 1);
    assert.equal(h.counters().cursorCount, 0);
  });

  test('read failure rejects instead of returning empty or permitting a registration mutation', async t => {
    const h = harness(t); await readyAfterActive(h);
    const before = plainRows(h.db());
    const start = h.operations.length;
    h.queryFailure(sql => sql.startsWith('SELECT version'));
    await assert.rejects(h.storage.load(), /read failure/);
    await assert.rejects(h.storage.registerTarget(C, A.version), /read failure/);
    assert.deepEqual(plainRows(h.db()), before);
    assert.equal(h.operations.slice(start).some(operation => operation.kind === 'execute' || operation.kind === 'update'), false);
    assert.equal(h.counters().cursorCount, 0);
  });

  test('native failed cursor from a real dropped SQLite table cannot become empty rows', async t => {
    const h = harness(t, undefined, ROOT, true, true); await makeActive(h);
    h.db().exec('DROP TABLE offline_package');
    await assert.rejects(h.storage.load(), /STORAGE_READ/);
    assert.equal(h.operations.filter(operation => operation.kind === 'failed-cursor-facade').length, 1);
    assert.equal(h.counters().cursorCount, 0);
    assert.deepEqual(h.opened.map(config => config.allowRebuild), [false]);
  });

  test('failed native cursor prevents Session first eligibility and preserves actual in-use directory bytes', async t => {
    const h = sessionFixture(t, true); await makeActive(h); h.writeA();
    const marker = path.join(h.root, '10009_temp'); fs.mkdirSync(marker); fs.writeFileSync(marker + '/evidence', 'read failure marker');
    h.db().exec('DROP TABLE offline_package');
    assert.equal(await h.session.prepareLocal(new h.types.OfflineCancellation()), false);
    assert.equal(h.session.isLocalReady(), false); assert.equal(h.session.needsInitial(), false);
    assert.equal(h.cleanup.length, 0);
    assert.deepEqual(fs.readFileSync(h.packagePath + '/index.html'), h.bytes);
    assert.equal(fs.readFileSync(marker + '/evidence', 'utf8'), 'read failure marker');
    assert.equal(h.events.every(event => event.kind === 'Diagnostic'), true);
    assert.equal(h.counters().cursorCount, 0);
  });

  test('negative schema cursor, missing required columns and incomplete iteration fail before mutation', async t => {
    const invalidSchema = harness(t);
    invalidSchema.cursorTransform((sql, cursor) => sql.startsWith('PRAGMA table_info') ?
      { ...cursor, rowCount: -1, columnCount: 0, columnNames: [], goToNextRow: () => false, getColumnIndex: () => -1 } : cursor);
    await assert.rejects(invalidSchema.storage.load(), /STORAGE_SCHEMA/);
    assert.equal(invalidSchema.operations.some(operation => ['begin', 'execute', 'update'].includes(operation.kind)), false);
    assert.equal(invalidSchema.counters().cursorCount, 0);
    for (const mode of ['negative', 'missing-column', 'incomplete']) {
      const h = harness(t); await readyAfterActive(h); const before = plainRows(h.db());
      const start = h.operations.length;
      h.cursorTransform((sql, cursor) => {
        if (!sql.startsWith('SELECT version')) return cursor;
        if (mode === 'negative') return { ...cursor, rowCount: -1 };
        if (mode === 'missing-column') return { ...cursor, getColumnIndex: name => name === 'stage_type' ? -1 : cursor.getColumnIndex(name) };
        return { ...cursor, goToNextRow: () => false };
      });
      await assert.rejects(h.storage.registerTarget(C, A.version), /STORAGE_READ/, mode);
      assert.deepEqual(plainRows(h.db()), before, mode);
      assert.equal(h.operations.slice(start).some(operation => ['execute', 'update'].includes(operation.kind)), false, mode);
      assert.equal(h.counters().cursorCount, 0, mode);
      assert.deepEqual(h.opened.map(config => config.allowRebuild), [false]);
    }
  });

  test('malformed durable fields reject and close cursor; no malformed record becomes an empty DB', async t => {
    for (const sql of [
      "UPDATE offline_package SET stage = 'unknown'",
      "UPDATE offline_package SET stage = NULL",
      "UPDATE offline_package SET version = 'invalid-version'",
      "UPDATE offline_package SET sha256 = 'short'"
    ]) {
      const nested = harness(t); await nested.storage.registerTarget(A);
      nested.db().exec('DROP TRIGGER offline_package_immutable_sha');
      nested.db().exec('PRAGMA ignore_check_constraints = ON');
      if (sql.includes('NULL') || sql.includes("'invalid-version'")) {
        // SQLite 的 NOT NULL / INTEGER PRIMARY KEY 约束在写入时拒绝这些值。
        assert.throws(() => nested.db().exec(sql));
      } else {
        nested.db().exec(sql); await assert.rejects(nested.storage.load());
      }
      assert.equal(nested.counters().cursorCount, 0);
    }
  });

  test('SQLite field types and corrupted active/ready uniqueness fail closed on read', async t => {
    for (const column of ['sha256', 'stage']) {
      const h = harness(t); await h.storage.registerTarget(A);
      h.db().exec('DROP TRIGGER offline_package_immutable_sha');
      h.db().exec('PRAGMA ignore_check_constraints = ON');
      h.db().prepare('UPDATE offline_package SET ' + column + ' = ?').run(Buffer.from(column === 'sha256' ? A.sha256 : 'ready'));
      await assert.rejects(h.storage.load(), /STORAGE_TYPE/);
      assert.equal(h.counters().cursorCount, 0);
    }
    for (const stage of ['active', 'ready']) {
      const h = harness(t); await makeActive(h);
      h.db().exec('DROP INDEX offline_package_one_active');
      h.db().exec('DROP INDEX offline_package_one_ready');
      h.db().prepare('UPDATE offline_package SET stage = ?').run(stage);
      h.db().prepare('INSERT INTO offline_package VALUES (?, ?, ?)').run(B.version, B.sha256, stage);
      await assert.rejects(h.storage.load(), /STORAGE_UNIQUENESS/);
      assert.equal(plainRows(h.db()).length, 2);
      assert.equal(h.counters().cursorCount, 0);
    }
  });

  test('confirmed corruption at open uses one labeled platform-facade recovery and then reads a real empty table', async t => {
    const h = harness(t);
    fs.writeFileSync(h.filename, Buffer.from('corrupt SQLite lifecycle database'.repeat(12)));
    assert.deepEqual(await h.storage.load(), []);
    assert.deepEqual(h.opened.map(config => config.allowRebuild), [false, true]);
    assert.equal(h.operations.filter(operation => operation.kind === 'platform-rebuild-facade').length, 1);
    assert.equal(h.db().prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(h.db().prepare('SELECT COUNT(*) AS count FROM offline_package').get().count, 0);
  });

  test('ordinary open codes and cancellation never authorize platform rebuild or an empty result', async t => {
    for (const code of [14800000, 14800010, 14800014, 14800021, 14800023, 14800024, 14800027, 14800028, 14800030, '14800011']) {
      const h = harness(t); await makeActive(h); const before = plainRows(h.db()); await h.closeAll();
      const error = nativeError(code);
      h.openFailure(() => error);
      const start = h.opened.length;
      await assert.rejects(new h.ManagedStorage({}, ROOT).load(), value => value === error);
      assert.deepEqual(h.opened.slice(start).map(config => config.allowRebuild), [false]);
      assert.equal(h.operations.filter(operation => operation.kind === 'platform-rebuild-facade').length, 0);
      const inspect = new DatabaseSync(h.filename); assert.deepEqual(plainRows(inspect), before); inspect.close();
    }
    const h = harness(t); await h.storage.load();
    const { OfflineCancelledError } = compileSdk('ManagedOfflineTypes');
    const cancelled = new OfflineCancelledError();
    h.executeFailure(sql => sql.startsWith('INSERT'), cancelled);
    await assert.rejects(h.storage.registerTarget(A), error => error === cancelled);
    assert.deepEqual(await h.storage.load(), []);
    assert.equal(h.counters().closeCount, 0);
    assert.equal(h.opened.length, 1);
  });

  test('ordinary live reads preserve the original error and cached rows without reopening', async t => {
    for (const code of [14800021, 14800023, 14800024, 14800028]) {
      const h = harness(t); await readyAfterActive(h); const before = plainRows(h.db());
      const error = nativeError(code);
      h.queryFailure(sql => sql.startsWith('SELECT version'), error);
      await assert.rejects(h.storage.load(), value => value === error);
      assert.deepEqual(plainRows(h.db()), before);
      assert.equal(h.counters().closeCount, 0);
      assert.deepEqual(h.opened.map(config => config.allowRebuild), [false]);
      h.queryFailure(undefined);
      assert.deepEqual(await h.storage.load(), before);
    }
  });

  test('confirmed live query/cursor corruption closes then throws; next natural load recovers', async t => {
    for (const source of ['query', 'cursor']) {
      const h = harness(t); await readyAfterActive(h);
      const error = nativeError(14800011, 'confirmed live corruption');
      if (source === 'query') h.queryFailure(sql => sql.startsWith('SELECT version'), error);
      else h.cursorFailure(error);
      h.afterClose(filename => fs.writeFileSync(filename, corruptBytes()));
      await assert.rejects(h.storage.load(), value => value === error);
      assert.equal(h.counters().closeCount, 1);
      assert.equal(h.counters().cursorCount, 0);
      assert.deepEqual(h.opened.map(config => config.allowRebuild), [false]);
      h.queryFailure(undefined);
      assert.deepEqual(await h.storage.load(), []);
      assert.deepEqual(h.opened.map(config => config.allowRebuild), [false, false, true]);
      assert.equal(h.operations.filter(operation => operation.kind === 'platform-rebuild-facade').length, 1);
    }
  });

  test('confirmed transaction corruption rolls back prior SQL before close and later recovery', async t => {
    const h = harness(t); await readyAfterActive(h); const before = plainRows(h.db());
    const error = nativeError(14800011, 'transaction corruption');
    h.executeFailure(sql => sql.startsWith('DELETE FROM offline_package'), error);
    let rowsAtClose;
    h.afterClose(filename => {
      const inspect = new DatabaseSync(filename); rowsAtClose = plainRows(inspect); inspect.close();
      fs.writeFileSync(filename, corruptBytes());
    });
    await assert.rejects(h.storage.registerTarget(C, A.version), value => value === error);
    assert.deepEqual(rowsAtClose, before, 'Real transaction rolled the inserted C back before closing');
    assert.equal(h.operations.at(-2).kind, 'rollback');
    assert.equal(h.operations.at(-1).kind, 'close');
    h.executeFailure(undefined);
    assert.deepEqual(await h.storage.load(), []);
    assert.deepEqual(h.opened.map(config => config.allowRebuild), [false, false, true]);
  });

  test('corrupt handle close failure stays visible and retained; repeated native error permits later disposal without marker', async t => {
    const h = harness(t); await makeActive(h);
    const corruption = nativeError(14800011, 'still corrupted');
    const close = nativeError(14800028, 'close failed');
    h.queryFailure(sql => sql.startsWith('SELECT version'), corruption);
    h.closeFailure(close); h.afterClose(filename => fs.writeFileSync(filename, corruptBytes()));
    await assert.rejects(h.storage.load(), error => error === close);
    assert.equal(h.operations.at(-1).closed, false);
    assert.equal(h.opened.length, 1, 'No new open can race the unclosed cached handle');
    await assert.rejects(h.storage.load(), error => error === corruption);
    assert.equal(h.operations.at(-1).closed, true);
    assert.equal(h.opened.length, 1);
    h.queryFailure(undefined);
    assert.deepEqual(await h.storage.load(), []);
    assert.deepEqual(h.opened.map(config => config.allowRebuild), [false, false, true]);
  });

  test('corruption plus rollback/close failures keep STORAGE_ROLLBACK contract and never falsely close', async t => {
    const h = harness(t); await readyAfterActive(h);
    const corruption = nativeError(14800011);
    const close = nativeError(14800028, 'corrupt close failed');
    h.executeFailure(sql => sql.startsWith('DELETE FROM offline_package'), corruption);
    h.rollbackFailure(new Error('rollback failed')); h.closeFailure(close);
    await assert.rejects(h.storage.registerTarget(C, A.version), error => error === close);
    assert.equal(h.operations.at(-1).closed, false);
    assert.equal(h.opened.length, 1);
    // 同一未关闭句柄再次明确报损坏后，才允许关闭；close 真实回滚未完成事务。
    h.executeFailure(undefined); h.queryFailure(sql => sql.startsWith('SELECT version'), corruption);
    await assert.rejects(h.storage.load(), error => error === corruption);
    assert.equal(h.operations.at(-1).closed, true);
    h.queryFailure(undefined);
    assert.deepEqual(await h.storage.load(), [{ ...A, stage: 'active' }, { ...B, stage: 'ready' }]);
    const ordinary = harness(t); await readyAfterActive(ordinary);
    ordinary.zeroUpdate(); ordinary.rollbackFailure(new Error('ordinary rollback failed'));
    await assert.rejects(ordinary.storage.activate(B), /STORAGE_ROLLBACK/);
    assert.deepEqual(ordinary.opened.map(config => config.allowRebuild), [false]);
    for (const source of ['work', 'rollback']) {
      const failed = harness(t); await readyAfterActive(failed); const before = plainRows(failed.db());
      if (source === 'work') failed.executeFailure(sql => sql.startsWith('DELETE FROM offline_package'), corruption);
      else failed.zeroUpdate();
      failed.rollbackFailure(source === 'rollback' ? corruption : new Error('ordinary rollback failed'));
      await assert.rejects(source === 'work' ? failed.storage.registerTarget(C, A.version) : failed.storage.activate(B), /STORAGE_ROLLBACK/);
      assert.equal(failed.operations.at(-1).closed, true);
      failed.executeFailure(undefined);
      assert.deepEqual(await failed.storage.load(), before);
      assert.deepEqual(failed.opened.map(config => config.allowRebuild), [false, false],
        'Previously observed corruption is not permission to rebuild a now-readable database');
    }
  });

  test('a failed platform recovery is thrown once without fallback loop or fabricated rows', async t => {
    const h = harness(t);
    const failedRecovery = nativeError(14800028, 'platform recovery I/O failed');
    h.openFailure(config => config.allowRebuild ? failedRecovery : nativeError(14800011));
    await assert.rejects(h.storage.load(), error => error === failedRecovery);
    assert.deepEqual(h.opened.map(config => config.allowRebuild), [false, true]);
    assert.equal(h.operations.length, 0);
  });

  test('native corruption confirmation alone never manufactures empty rows if platform reopen returns existing data', async t => {
    const h = harness(t); await makeActive(h); await h.closeAll();
    let reported = false;
    h.openFailure(config => {
      if (!reported && !config.allowRebuild) { reported = true; return nativeError(14800011); }
    });
    assert.deepEqual(await new h.ManagedStorage({}, ROOT).load(), [{ ...A, stage: 'active' }]);
    assert.deepEqual(h.opened.slice(-2).map(config => config.allowRebuild), [false, true]);
    assert.equal(h.operations.filter(operation => operation.kind === 'platform-rebuild-facade').length, 0);
  });

  test('real additive schema migration failure preserves data/version and never requests rebuild', async t => {
    const h = harness(t);
    const db = new DatabaseSync(h.filename);
    db.exec('CREATE TABLE offline_package(version INTEGER PRIMARY KEY, sha256 TEXT NOT NULL, stage TEXT NOT NULL)');
    db.prepare('INSERT INTO offline_package VALUES (?, ?, ?)').run(A.version, A.sha256, 'active');
    db.prepare('INSERT INTO offline_package VALUES (?, ?, ?)').run(B.version, B.sha256, 'active');
    const before = plainRows(db); db.close();
    await assert.rejects(h.storage.load(), /UNIQUE constraint failed/);
    assert.deepEqual(h.opened.map(config => config.allowRebuild), [false]);
    const inspect = new DatabaseSync(h.filename);
    assert.equal(inspect.prepare('PRAGMA user_version').get().user_version, 0);
    assert.deepEqual(plainRows(inspect), before);
    assert.equal(inspect.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index'").get().count, 0);
    inspect.close();
  });

  test('production Session gives first eligibility only after real recovered-empty read; ordinary read failure cannot clean bytes', async t => {
    const recovered = sessionFixture(t);
    fs.writeFileSync(recovered.filename, corruptBytes());
    const cancel = new recovered.types.OfflineCancellation();
    assert.equal(await recovered.session.prepareLocal(cancel), true);
    assert.equal(recovered.session.needsInitial(), true);
    assert.deepEqual(await recovered.storage.load(), []);
    assert.deepEqual(recovered.opened.map(config => config.allowRebuild), [false, true]);
    const failed = sessionFixture(t); failed.writeA();
    failed.openFailure(() => nativeError(14800023, 'read permission denied'));
    assert.equal(await failed.session.prepareLocal(new failed.types.OfflineCancellation()), false);
    assert.equal(failed.session.needsInitial(), false);
    assert.equal(failed.cleanup.length, 0);
    assert.deepEqual(fs.readFileSync(path.join(failed.packagePath, 'index.html')), failed.bytes);
    assert.deepEqual(failed.opened.map(config => config.allowRebuild), [false]);
  });

  test('production Session runtime DB recovery keeps fixed active identity and real in-use bytes without repeating cold cleanup', async t => {
    const h = sessionFixture(t); h.writeA(); await makeActive(h);
    const cancel = new h.types.OfflineCancellation();
    assert.equal(await h.session.prepareLocal(cancel), true);
    assert.equal(h.session.needsInitial(), false);
    assert.equal(h.cleanup.length, 1);
    const late = path.join(h.root, 'late-residue'); fs.writeFileSync(late, 'not a new cold-start sweep');
    const corruption = nativeError(14800011);
    h.queryFailure(sql => sql.startsWith('SELECT version'), corruption);
    h.afterClose(filename => fs.writeFileSync(filename, corruptBytes()));
    await assert.rejects(h.storage.load(), error => error === corruption);
    h.queryFailure(undefined);
    assert.deepEqual(await h.storage.load(), []);
    assert.equal(await h.session.prepareLocal(cancel), true);
    assert.equal(h.cleanup.length, 1, 'Recovery did not reset initialization/cold cleanup');
    assert.equal(fs.existsSync(late), true);
    assert.equal(h.session.needsInitial(), false);
    assert.deepEqual(h.session.getState().active, A);
    assert.deepEqual(fs.readFileSync(path.join(h.packagePath, 'index.html')), h.bytes);
    // 正常同版检查会做常规淘汰；即使 DB 忘了 active，真实在用目录仍在 keep 集中。
    await h.session.check({ enabled: true, version: A.version }, cancel, () => {}, () => true);
    assert.deepEqual(h.session.getState().active, A);
    assert.deepEqual(fs.readFileSync(path.join(h.packagePath, 'index.html')), h.bytes);
    assert.equal(h.events.some(event => event.kind === 'Prepared'), false);
  });

  test('Session + file SQLite + actual Worker/Archive reject pinned directory body and empty preferred root without ready or Prepared', async t => {
    // Production composition; only taskpool/zlib/RDB platform boundaries are host facades.
    // Native-entry facade inflates the actual ZIP bytes with Node zlib, never fixture output files.
    const runtime = require('./helpers/worker_runtime.cjs');
    const pinned = path.resolve(__dirname, './fixtures/directory-nonempty.zip');
    const pinnedSha = '0c838ccfc64080fe99ff4d84c0cdf08cb4a241d29c6b9e226a5ea9c527aae9e4';
    const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.equal(hash(pinned), pinnedSha);
    const inputs = [
      { name: 'pinned-directory-body', entries: [{ name: 'dist/index.html', body: 'home' }, { name: 'dist/assets/' }], reason: 'INVALID_ARCHIVE', pinned: true },
      { name: 'empty-root-valid-dist', entries: [{ name: 'index.html', body: '' }, { name: 'dist/index.html', body: 'nested' }], reason: 'MISSING_ENTRY' }
    ];
    for (const input of inputs) {
      const f = runtime.fixture(input.entries);
      if (input.pinned) fs.copyFileSync(pinned, f.zip);
      const root = path.join(f.root, 'versions'); fs.mkdirSync(root);
      const h = harness(t, f.root, root);
      const bytes = Buffer.from('active A bytes survive failed actual ZIP preparation');
      const activeFile = path.join(root, String(A.version), 'index.html');
      fs.mkdirSync(path.dirname(activeFile)); fs.writeFileSync(activeFile, bytes);
      await makeActive(h);
      const archive = runtime.platform(f);
      const worker = runtime.installWorker(f, archive, [], { session: {
        close() {}, cancel() {}, async fetch() { assert.fail('Local ZIP must never enter network'); }
      } });
      const { api } = runtime.installerModule(worker);
      const installer = await api.claimManagedRoot(root);
      const managed = compileSdk('ManagedOfflineTypes');
      const { ManagedPackageSession } = compileSdk('ManagedPackageSession', {
        './PackageInstaller': api, './InstallWorker': worker, './ManagedStorage': h,
        './OfflineTypes': runtime.types, './ManagedOfflineTypes': managed
      });
      const events = [], diagnostics = [];
      const session = new ManagedPackageSession(root, installer, h.storage, A.version,
        value => diagnostics.push(value), value => events.push(value));
      const cancel = new managed.OfflineCancellation();
      assert.equal(await session.prepareLocal(cancel), true, input.name);
      assert.equal(session.currentVersion(), A.version, input.name);
      const target = { ...runtime.packageSpec(f), version: B.version };
      const beforeSha = hash(f.zip);
      const result = await session.check({ enabled: true, version: target.version, sha256: target.sha256,
        localArchive: f.zip }, cancel, () => {}, () => true);
      assert.equal(result.outcome?.success, false, input.name);
      assert.equal(result.outcome?.installReason, input.reason, input.name);
      const rows = await h.storage.load();
      assert.equal(rows.filter(row => row.stage === h.PackageStage.READY).length, 0, input.name);
      assert.deepEqual(rows, [{ ...A, stage: 'active' },
        { version: target.version, sha256: target.sha256, stage: 'downloaded' }], input.name);
      assert.equal(events.filter(event => event.kind === 'Prepared').length, 0, input.name);
      assert.equal(events.filter(event => event.kind === 'PrepareFailed').length, 1, input.name);
      assert.equal(session.currentVersion(), A.version, input.name);
      assert.deepEqual(session.getState().active, A, input.name);
      assert.deepEqual(fs.readFileSync(activeFile), bytes, input.name);
      assert.equal(fs.existsSync(path.join(root, String(target.version))), false, input.name);
      assert.ok(archive.calls.includes('createZip'), input.name);
      assert.equal(hash(f.zip), beforeSha, input.name);
      assert.equal(runtime.positions.size, 0, input.name);
      t.diagnostic(JSON.stringify({ input: input.name, inputSha256: beforeSha, outcome: result.outcome,
        rows, events, nativeFacadeCalls: archive.calls, activeBytesSha256: hash(activeFile),
        sqlMutations: h.operations.filter(operation => ['execute', 'update', 'commit', 'rollback'].includes(operation.kind)) }));
    }
    assert.equal(hash(pinned), pinnedSha);
    t.after(() => runtime.cleanup());
  });

  test('unknown future schema version rejects identical columns without downgrade or row changes', async t => {
    const h = harness(t); await readyAfterActive(h);
    const before = await h.storage.load();
    h.db().exec('PRAGMA user_version = 2');
    await h.closeAll();
    const start = h.operations.length;
    await assert.rejects(new h.ManagedStorage({}, ROOT).load(), /STORAGE_SCHEMA_VERSION/);
    assert.equal(h.operations.slice(start).some(operation => operation.kind === 'execute' || operation.kind === 'update'), false);
    const inspect = new DatabaseSync(h.filename);
    assert.equal(inspect.prepare('PRAGMA user_version').get().user_version, 2);
    assert.deepEqual(plainRows(inspect), before);
    inspect.close();
  });

  test('a malformed existing schema is preserved and rejected without a destructive migration', async t => {
    const h = harness(t);
    const db = new DatabaseSync(h.filename);
    db.exec("CREATE TABLE offline_package(version INTEGER PRIMARY KEY, sha256 TEXT NOT NULL, stage TEXT NOT NULL, history TEXT)");
    db.prepare('INSERT INTO offline_package VALUES (?, ?, ?, ?)').run(A.version, A.sha256, 'active', 'preserve');
    db.close();
    await assert.rejects(h.storage.load(), /STORAGE_SCHEMA/);
    const inspect = new DatabaseSync(h.filename);
    assert.equal(inspect.prepare('SELECT history FROM offline_package').get().history, 'preserve');
    assert.equal(inspect.prepare('PRAGMA table_info(offline_package)').all().length, 4);
    inspect.close();
    assert.equal(h.counters().cursorCount, 0);
  });

  test('actual process termination between UPDATE and COMMIT rolls activation back on file reopen', async t => {
    const h = harness(t); await readyAfterActive(h);
    const before = await h.storage.load();
    await h.closeAll();
    const result = spawnSync(process.execPath, [__filename, '--interrupt-activation', h.directory], {
      encoding: 'utf8', env: process.env, timeout: 10000
    });
    assert.equal(result.status, 17, result.stderr || result.stdout);
    const reopened = new h.ManagedStorage({}, ROOT);
    assert.deepEqual(await reopened.load(), before);
    await reopened.activate(B);
    assert.deepEqual(await reopened.load(), [{ ...B, stage: 'active' }]);
  });
}
