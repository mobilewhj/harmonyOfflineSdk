import { fileIo as fs } from '@kit.CoreFileKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { rcp } from '@kit.RemoteCommunicationKit';
import { taskpool, url } from '@kit.ArkTS';
import { BusinessError, systemDateTime } from '@kit.BasicServicesKit';
import { extractPackage } from './PackageArchive';
import { ManagedInstallResult, ManagedInstallProgress, InstallFactStage, PackageRecord, OfflineError, OfflineStage, PackageSpec, packageDirectory } from './OfflineTypes';
import { contentRoot, removeTree, validatePackagePath, overlappingPaths } from './PackageFiles';

class DownloadState { response?: rcp.Response; }

class InstallFacts {
  requestStarted: boolean = false;
  publishedRecord?: PackageRecord;
  httpStatus?: number;
  retryAfterMillis?: number;
  factStage: InstallFactStage = InstallFactStage.PREPARING;
}

function uptime(): number {
  return systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false);
}


function checkCancellation(signal: Int32Array): void {
  if (Atomics.load(signal, 0) !== 0) {
    throw new OfflineError('CANCELLED');
  }
}

function notify(stage: OfflineStage, percent: number, downloadTotalKnown?: boolean): void {
  const progress: ManagedInstallProgress = { stage, percent, downloadTotalKnown };
  taskpool.Task.sendData(progress);
}

export function validDownloadUrl(value: string, allowHttp: boolean): boolean {
  try {
    const parsed = new url.URL(value);
    return !parsed.username && !parsed.password && !parsed.hash && !!parsed.hostname &&
      (parsed.protocol === 'https:' && (!parsed.port || parsed.port === '443') ||
      allowHttp && parsed.protocol === 'http:' && (!parsed.port || parsed.port === '80'));
  } catch (_) {
    return false;
  }
}

export function validManagedDownloadUrl(value: string): boolean {
  try {
    const parsed = new url.URL(value);
    return !parsed.username && !parsed.password && !parsed.hash && !!parsed.hostname &&
      (parsed.protocol === 'https:' || parsed.protocol === 'http:');
  } catch (_) { return false; }
}

async function download(source: string, destination: string, allowHttp: boolean, signal: Int32Array,
  managed: boolean, facts: InstallFacts): Promise<void> {
  const session = rcp.createSession();
  const deadline = uptime() + 120000;
  const protocol = new url.URL(source).protocol;
  let current = source;
  try {
    for (let redirects = 0; redirects <= 10; redirects++) {
      checkCancellation(signal);
      if (uptime() >= deadline) { throw new OfflineError('TIMEOUT'); }
      if (!(managed ? validManagedDownloadUrl(current) : validDownloadUrl(current, allowHttp)) || new url.URL(current).protocol !== protocol) {
        throw new OfflineError('INVALID_URL');
      }
      let file: fs.File | undefined = managed ? undefined : fs.openSync(destination, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
      let downloaded = 0;
      let total = 0;
      let lastPercent = -2;
      let lastUnknownBytes = -262144;
      let finished = false;
      const state = new DownloadState();
      let failure = '';
      const request = new rcp.Request(current, 'GET');
      request.configuration = {
        transfer: { autoRedirect: false, timeout: { connectMs: 20000, transferMs: Math.max(1, deadline - uptime()) } },
        tracing: { httpEventsHandler: {
          onDataReceive: (chunk: ArrayBuffer): number => {
            if (Atomics.load(signal, 0) !== 0 || uptime() >= deadline) {
              failure = Atomics.load(signal, 0) !== 0 ? 'CANCELLED' : 'TIMEOUT';
              session.cancel(request);
            }
            if (failure) { return 0; }
            try {
              if (!file) { file = fs.openSync(destination, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC); }
              let offset = 0;
              while (offset < chunk.byteLength) {
                const written = fs.writeSync((file as fs.File).fd, chunk.slice(offset));
                if (written <= 0) { throw new Error('write'); }
                offset += written;
              }
              downloaded += chunk.byteLength;
              return chunk.byteLength;
            } catch (_) {
              failure = 'FILE_IO';
              session.cancel(request);
              return 0;
            }
          },
          onDownloadProgress: (totalSize: number, transferredSize: number) => {
            total = Number.isSafeInteger(totalSize) && totalSize > 0 ? totalSize : 0;
          }
        } }
      };
      let pending: Promise<void> | undefined = undefined;
      try {
        facts.requestStarted = true;
        facts.httpStatus = undefined;
        pending = session.fetch(request).then((value: rcp.Response) => {
          state.response = value;
        }).catch((error: BusinessError) => {
          if (!failure) { failure = uptime() >= deadline || error.code === 1007900028 ? 'TIMEOUT' : 'DOWNLOAD'; }
        }).finally(() => { finished = true; });
        while (!finished) {
          if (Atomics.load(signal, 0) !== 0 || uptime() >= deadline) {
            failure = Atomics.load(signal, 0) !== 0 ? 'CANCELLED' : 'TIMEOUT';
            session.cancel(request);
          }
          const percent = total > 0 ? Math.min(99, Math.floor(downloaded * 100 / total)) : -1;
          if (total > 0 ? percent !== lastPercent : downloaded - lastUnknownBytes >= 262144) {
            notify(OfflineStage.DOWNLOADING, percent, total > 0);
            lastPercent = percent; lastUnknownBytes = downloaded;
          }
          await new Promise<void>(resolve => setTimeout(resolve, 80));
        }
        await pending;
      } finally {
        // 回调可能继续写 FD，先等原生网络落定，再关闭并释放写许可。
        if (pending) { await pending; }
        try { if (managed && file && !failure && state.response?.statusCode === 200) { fs.fsyncSync(file.fd); } }
        finally { if (file) { fs.closeSync(file); } }
      }
      checkCancellation(signal);
      if (state.response) { facts.httpStatus = state.response.statusCode; }
      if (uptime() >= deadline) { facts.httpStatus = undefined; throw new OfflineError('TIMEOUT'); }
      if (failure) { facts.httpStatus = undefined; throw new OfflineError(failure); }
      const result = state.response as rcp.Response;
      facts.httpStatus = result.statusCode;
      if (result.statusCode === 429 || result.statusCode === 503) {
        facts.retryAfterMillis = retryAfter(result.headers['retry-after']);
      }
      if (result.statusCode === 200) {
        if (downloaded === 0 || total > 0 && downloaded !== total) { throw new OfflineError('DOWNLOAD_LENGTH'); }
        notify(OfflineStage.DOWNLOADING, 100, total > 0);
        return;
      }
      if ([301, 302, 303, 307, 308].includes(result.statusCode) && result.headers.location) {
        current = new url.URL(result.headers.location, current).toString();
      } else {
        throw new OfflineError('HTTP_' + result.statusCode);
      }
    }
    throw new OfflineError('TOO_MANY_REDIRECTS');
  } finally {
    session.close();
  }
}

function copyArchive(source: string, destination: string, signal: Int32Array): void {
  const input = fs.openSync(source, fs.OpenMode.READ_ONLY | fs.OpenMode.NOFOLLOW);
  try {
    const stat = fs.statSync(input.fd);
    if (!stat.isFile() || stat.size <= 0) { throw new OfflineError('SIZE_LIMIT'); }
    const output = fs.openSync(destination, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
    try {
      const buffer = new ArrayBuffer(65536);
      let copied = 0;
      let count = 0;
      while ((count = fs.readSync(input.fd, buffer)) > 0) {
        checkCancellation(signal);
        copied += count;
        if (copied > stat.size) { throw new OfflineError('FILE_IO'); }
        let offset = 0;
        while (offset < count) {
          const written = fs.writeSync(output.fd, buffer.slice(offset, count));
          if (written <= 0) { throw new OfflineError('FILE_IO'); }
          offset += written;
        }
      }
      if (copied !== stat.size) { throw new OfflineError('FILE_IO'); }
    } finally { fs.closeSync(output); }
  } finally { fs.closeSync(input); }
}

function verifyHash(path: string, expected: string, signal: Int32Array): void {
  const digest = cryptoFramework.createMd('SHA256');
  const file = fs.openSync(path, fs.OpenMode.READ_ONLY);
  try {
    const buffer = new ArrayBuffer(65536);
    let count = 0;
    while ((count = fs.readSync(file.fd, buffer)) > 0) {
      checkCancellation(signal);
      digest.updateSync({ data: new Uint8Array(buffer.slice(0, count)) });
    }
    let actual = '';
    for (let value of digest.digestSync().data) { actual += value.toString(16).padStart(2, '0'); }
    if (actual !== expected) { throw new OfflineError('HASH_MISMATCH'); }
  } finally {
    fs.closeSync(file);
  }
}

export async function runInstall(root: string, spec: PackageSpec, allowHttp: boolean,
  cancellation: SharedArrayBuffer, localArchive: string = '', managed: boolean = false): Promise<ManagedInstallResult> {
  const signal = new Int32Array(cancellation);
  let stage = OfflineStage.PREPARING;
  let directory = packageDirectory(root, spec);
  const facts = new InstallFacts();
  let zip = root + '/' + spec.version + '.zip.tmp';
  let temporary = root + '/' + spec.version + '_temp';
  let reason = '';
  let cleanup = false;
  try {
    // 源和根在删除固定工作路径前验证，父链接别名也不能绕过输入保护。
    root = validatePackagePath(root);
    directory = packageDirectory(root, spec);
    zip = root + '/' + spec.version + '.zip.tmp';
    temporary = root + '/' + spec.version + '_temp';
    if (localArchive) {
      const source = validatePackagePath(localArchive, true);
      if (overlappingPaths(source, root)) { throw new OfflineError('INVALID_SOURCE'); }
    }
    checkCancellation(signal);
    if (!localArchive && !(managed ? validManagedDownloadUrl(spec.url) : validDownloadUrl(spec.url, allowHttp))) { throw new OfflineError('INVALID_URL'); }
    if (fs.accessSync(directory)) { throw new OfflineError('TARGET_EXISTS'); }
    // One installer per root, with serialized install/cleanup. Reuse fixed Android-compatible paths.
    cleanup = true;
    removeTree(zip);
    removeTree(temporary);
    fs.mkdirSync(temporary, true);
    if (localArchive) {
      notify(OfflineStage.PREPARING, -1);
      copyArchive(localArchive, zip, signal);
    } else {
      stage = OfflineStage.DOWNLOADING;
      facts.factStage = InstallFactStage.DOWNLOADING;
      await download(spec.url, zip, allowHttp, signal, managed, facts);
    }
    stage = OfflineStage.VERIFYING;
    facts.factStage = InstallFactStage.VERIFYING;
    notify(stage, -1);
    verifyHash(zip, spec.sha256, signal);
    stage = OfflineStage.EXTRACTING;
    facts.factStage = InstallFactStage.EXTRACTING;
    notify(stage, -1);
    await extractPackage(zip, temporary, () => checkCancellation(signal));
    const content = contentRoot(temporary);
    if (!content) { throw new OfflineError('MISSING_ENTRY'); }
    checkCancellation(signal);
    stage = OfflineStage.SAVING;
    facts.factStage = InstallFactStage.PUBLISHING;
    notify(stage, 99);
    if (fs.accessSync(directory)) { throw new OfflineError('TARGET_EXISTS'); }
    fs.renameSync(content, directory);
    facts.publishedRecord = { version: spec.version, sha256: spec.sha256 };
  } catch (error) {
    reason = error instanceof OfflineError ? error.reason : 'FILE_IO';
  } finally {
    if (cleanup) {
      for (let path of [zip, temporary]) {
        try { removeTree(path); } catch (_) {
          if (!reason) { reason = 'CLEANUP'; facts.factStage = InstallFactStage.CLEANUP; }
        }
      }
    }
  }
  return { success: reason === '', reason, stage, directory, requestStarted: facts.requestStarted,
    publishedRecord: facts.publishedRecord, httpStatus: facts.httpStatus, retryAfterMillis: facts.retryAfterMillis, factStage: facts.factStage };
}


// Match the Android download contract: Retry-After is a non-negative integer number of seconds.
function retryAfter(value?: string): number | undefined {
  if (typeof value !== 'string' || !value.trim()) { return undefined; }
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return Number.isSafeInteger(seconds) && seconds <= Math.floor(Number.MAX_SAFE_INTEGER / 1000) ? seconds * 1000 : undefined;
  }
  return undefined;
}

function validateManagedLocalSource(source: string): string {
  const safe = validatePackagePath(source, false, true);
  try {
    const stat = fs.lstatSync(safe);
    if (stat.isSymbolicLink() || !stat.isFile()) { throw new OfflineError('INVALID_SOURCE'); }
  } catch (error) {
    if ((error as BusinessError).code !== 13900002) { throw error as Error; }
    // Missing leaf is an input-open failure, not an early candidate/preflight rejection.
  }
  return safe;
}

// SHA preflight is outside installation statistics. A failed read is never a cache miss.
export function managedArchiveReusable(root: string, spec: PackageSpec, cancellation: SharedArrayBuffer): boolean {
  const signal = new Int32Array(cancellation);
  root = validatePackagePath(root);
  checkCancellation(signal);
  if (!fs.accessSync(root)) { fs.mkdirSync(root, true); }
  if (spec.localArchive) {
    const input = validateManagedLocalSource(spec.localArchive);
    if (overlappingPaths(input, root)) { throw new OfflineError('INVALID_SOURCE'); }
  } else if (!validManagedDownloadUrl(spec.url)) { throw new OfflineError('INVALID_URL'); }
  const zip = root + '/' + spec.version + '.zip';
  let stat: fs.Stat;
  try { stat = fs.lstatSync(zip); }
  catch (error) {
    if ((error as BusinessError).code === 13900002) { return false; }
    throw error as Error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) { throw new OfflineError('FILE_IO'); }
  try { verifyHash(zip, spec.sha256, signal); return true; }
  catch (error) {
    if (error instanceof OfflineError && error.reason === 'HASH_MISMATCH') { return false; }
    throw error as Error;
  }
}

function copyManagedArchive(source: string, destination: string, signal: Int32Array, facts: InstallFacts): void {
  const output = fs.openSync(destination, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
  try {
    checkCancellation(signal);
    // Local processing starts immediately before the real input open, including an open failure.
    facts.requestStarted = true;
    const input = fs.openSync(source, fs.OpenMode.READ_ONLY | fs.OpenMode.NOFOLLOW);
    try {
      const stat = fs.statSync(input.fd);
      if (!stat.isFile() || stat.size <= 0) { throw new OfflineError('SIZE_LIMIT'); }
      const buffer = new ArrayBuffer(65536);
      let copied = 0;
      let count = 0;
      while ((count = fs.readSync(input.fd, buffer)) > 0) {
        checkCancellation(signal);
        copied += count;
        if (copied > stat.size) { throw new OfflineError('FILE_IO'); }
        let offset = 0;
        while (offset < count) {
          const written = fs.writeSync(output.fd, buffer.slice(offset, count));
          if (written <= 0) { throw new OfflineError('FILE_IO'); }
          offset += written;
        }
      }
      if (copied !== stat.size) { throw new OfflineError('FILE_IO'); }
      fs.fsyncSync(output.fd);
    } finally { fs.closeSync(input); }
  } finally { fs.closeSync(output); }
}

export async function runManagedDownload(root: string, spec: PackageSpec, cancellation: SharedArrayBuffer): Promise<ManagedInstallResult> {
  const facts = new InstallFacts();
  const signal = new Int32Array(cancellation);
  let reason = '';
  let stage = OfflineStage.PREPARING;
  const zip = root + '/' + spec.version + '.zip';
  try {
    root = validatePackagePath(root);
    checkCancellation(signal);
    removeTree(zip);
    if (spec.localArchive) {
      stage = OfflineStage.DOWNLOADING; facts.factStage = InstallFactStage.DOWNLOADING;
      copyManagedArchive(spec.localArchive, zip, signal, facts);
    }
    else {
      stage = OfflineStage.DOWNLOADING; facts.factStage = InstallFactStage.DOWNLOADING;
      await download(spec.url, zip, true, signal, true, facts);
    }
    checkCancellation(signal);
    stage = OfflineStage.VERIFYING; facts.factStage = InstallFactStage.VERIFYING;
    facts.httpStatus = undefined;
    notify(stage, -1);
    verifyHash(zip, spec.sha256, signal);
  } catch (error) { reason = error instanceof OfflineError ? error.reason : 'FILE_IO'; }
  finally { if (reason) { try { removeTree(zip); } catch (_) {} } }
  return { success: !reason, reason, stage, directory: packageDirectory(root, spec),
    requestStarted: facts.requestStarted, httpStatus: facts.httpStatus, retryAfterMillis: facts.retryAfterMillis,
    factStage: facts.factStage };
}

export async function runManagedExtract(root: string, spec: PackageSpec, cancellation: SharedArrayBuffer): Promise<ManagedInstallResult> {
  const signal = new Int32Array(cancellation);
  const directory = packageDirectory(root, spec);
  let reason = '';
  let complete = false;
  try {
    validatePackagePath(root);
    checkCancellation(signal);
    // The lifecycle transaction and fixed in-use guard have already authorized this inactive target.
    removeTree(directory);
    fs.mkdirSync(directory, true);
    notify(OfflineStage.EXTRACTING, -1);
    await extractPackage(root + '/' + spec.version + '.zip', directory, () => checkCancellation(signal));
    if (!contentRoot(directory)) { throw new OfflineError('MISSING_ENTRY'); }
    checkCancellation(signal);
    complete = true;
  } catch (error) { reason = error instanceof OfflineError ? error.reason : 'FILE_IO'; }
  finally { if (!complete) { try { removeTree(directory); } catch (_) {} } }
  return { success: !reason, reason, stage: OfflineStage.EXTRACTING, directory, requestStarted: true,
    factStage: InstallFactStage.EXTRACTING, publishedRecord: complete ? { version: spec.version, sha256: spec.sha256 } : undefined };
}
