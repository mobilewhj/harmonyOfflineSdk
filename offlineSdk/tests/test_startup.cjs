const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require(process.env.OFFLINE_TEST_TYPESCRIPT || 'typescript');
const stages = { PREPARING:'preparing', DOWNLOADING:'downloading', VERIFYING:'verifying',
  EXTRACTING:'extracting', SAVING:'saving', COMPLETE:'complete' };
function setup() {
  let calls = 0, resolve, reject, progress, disposed = false;
  class Repository {
    prepare(callback) {
      calls++; progress = callback;
      return new Promise((yes, no) => { resolve = yes; reject = no; });
    }
    dispose() { disposed = true; }
  }
  const file = path.resolve(__dirname, '../../entry/src/main/ets/viewmodel/SplashViewModel.ets');
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, experimentalDecorators: true }
  }).outputText;
  const module = { exports: {} };
  vm.runInThisContext('(function(require,module,exports,Observed){' + output + '\n})')(
    name => name === 'harmony-offline-sdk' ? { OfflineStage: stages } : { DemoRepository: Repository },
    module, module.exports, value => value);
  const model = new module.exports.SplashViewModel(); model.attach({});
  return { model, calls:()=>calls, resolve:v=>resolve(v), reject:e=>reject(e), progress:v=>progress(v), disposed:()=>disposed };
}
test('retry restores all visible loading state before awaiting work and prevents duplicate installation', async () => {
  const h = setup(); const first = h.model.start();
  h.reject(new Error('HASH_MISMATCH')); await first;
  assert.equal(h.model.failed, true);
  assert.equal(h.model.text, '启动配置准备失败，请稍后重试。');
  const retry = h.model.start();
  assert.equal(h.model.failed, false); assert.equal(h.model.running, true);
  assert.equal(h.model.text, '正在准备启动配置…'); assert.equal(h.model.percent, -1);
  await h.model.start(); assert.equal(h.calls(), 2);
  h.progress({ stage: stages.DOWNLOADING, percent: 42 }); assert.equal(h.model.percent, 42);
  h.progress({ stage: stages.EXTRACTING, percent: 90 }); assert.equal(h.model.percent, -1);
  h.resolve('/private/offline/dist'); await retry;
  assert.equal(h.model.ready, true); assert.equal(h.model.running, false);
  assert.equal(h.model.text, '启动配置准备完成');
  assert.equal(h.model.directory, '/private/offline/dist');
});
test('disposed startup ignores late progress and success', async () => {
  const h = setup(); const pending = h.model.start();
  h.model.dispose(); assert.equal(h.disposed(), true);
  h.progress({stage:stages.DOWNLOADING,percent:45}); h.resolve('/late'); await pending;
  assert.equal(h.model.ready, false); assert.equal(h.model.directory, '');
  assert.equal(h.model.text, '正在准备启动配置…');
});
