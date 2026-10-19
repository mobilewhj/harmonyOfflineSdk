#!/usr/bin/env node
// 仅提供可控的隔离 LAN fixture；不部署服务、不读取业务资源或修改 SDK 的版本策略。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const archive = path.join(root, 'entry/src/main/resources/rawfile/sample.zip');
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Missing ' + name);
  return args[index + 1];
}
const host = option('--host', '127.0.0.1');
const port = Number(option('--port', '8088'));
const origin = new URL(option('--origin', 'http://' + host + ':' + port + '/'));
if (!Number.isInteger(port) || port < 1 || port > 65535 || origin.protocol !== 'http:' ||
    origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
  throw new Error('Use an HTTP origin with a legal port and root path');
}
// 只读经过 generate-sample.py --check 核对的仓库样例；Python 标准 ZIP 库负责读取。
const read = spawnSync('python3', ['-c',
  'import zipfile,json,base64,sys\nwith zipfile.ZipFile(sys.argv[1]) as z:\n print(json.dumps({n:base64.b64encode(z.read(n)).decode() for n in ["index.html","style.css","app.js"]}))',
  archive], { encoding: 'utf8' });
if (read.status !== 0) throw new Error('Unable to read reviewed sample ZIP');
const files = new Map(Object.entries(JSON.parse(read.stdout)).map(([name, data]) => ['/' + name, Buffer.from(data, 'base64')]));
const zip = fs.readFileSync(archive);
const sha256 = crypto.createHash('sha256').update(zip).digest('hex');
const version = Number(option('--version', '10000'));
if (!Number.isSafeInteger(version) || version < 10000) throw new Error('Invalid fixture version');
const config = Buffer.from(JSON.stringify({ enabled: true, version, sha256, url: new URL('sample.zip', origin).href }));
files.set('/sample.zip', zip);
files.set('/config.json', config);
// ZIP 中没有这些路径。设备的同源请求应当得到本服务的标记，证明当次回源。
files.set('/missing.js', Buffer.from('window.__offlineFixtureMissing="NETWORK_FALLBACK";'));
files.set('/empty.js', Buffer.from('window.__offlineFixtureEmpty="NETWORK_FALLBACK";'));
files.set('/fallback.html', Buffer.from('<!doctype html><meta charset="utf-8"><title>Network fallback</title><p>NETWORK_FALLBACK</p>'));
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.zip': 'application/zip' };
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, origin).pathname;
  const body = files.get(pathname);
  if ((request.method !== 'GET' && request.method !== 'HEAD') || !body) {
    response.writeHead(body ? 405 : 404); response.end(); return;
  }
  response.writeHead(200, { 'Content-Type': mime[path.extname(pathname)] || 'application/octet-stream',
    'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Offline-Fixture': 'NETWORK_FALLBACK' });
  response.end(request.method === 'HEAD' ? undefined : body);
});
server.listen(port, host, () => {
  process.stdout.write(JSON.stringify({ host, port, origin: origin.href, configUrl: new URL('config.json', origin).href,
    pageUrl: new URL('index.html?demo=managed#home', origin).href, sha256 }) + '\n');
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
