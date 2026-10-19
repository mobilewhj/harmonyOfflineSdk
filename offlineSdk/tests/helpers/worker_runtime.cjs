// Reuse the existing real-file ZIP/worker adapters without registering its tests twice.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const file = path.resolve(__dirname, '../test_official_zip.cjs');
const cleanups = [];
const moduleValue = { exports: {} };
const appended = '\nmodule.exports = {fixture,platform,io,files,types,localWorker,installWorker,packageSpec,installerModule,temporary,positions,zipBytes,benign,load};';
vm.runInThisContext('(function(require,module,exports,__dirname){' + fs.readFileSync(file, 'utf8') + appended + '\n})', {filename:file})(
  name => name === 'node:test' ? {test(){},after(callback){cleanups.push(callback);}} : require(name),
  moduleValue, moduleValue.exports, path.dirname(file));
module.exports = {...moduleValue.exports, cleanup(){ for(const work of cleanups) work(); }};
