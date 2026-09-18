import { fileIo as fs } from '@kit.CoreFileKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { rcp } from '@kit.RemoteCommunicationKit';
import { taskpool, url } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { extractPackage } from './PackageArchive';
import { InstallResult, OfflineError, OfflineProgress, OfflineStage, PackageSpec, packageDirectory } from './OfflineTypes';
import { contentRoot, removeTree } from './PackageFiles';

class DownloadState { response?: rcp.Response; }


function checkCancellation(signal: Int32Array): void {
  if (Atomics.load(signal, 0) !== 0) {
    throw new OfflineError('CANCELLED');
  }
}

function notify(stage: OfflineStage, percent: number): void {
  const progress: OfflineProgress = { stage, percent };
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

async function download(source: string, destination: string, allowHttp: boolean, signal: Int32Array): Promise<void> {
  const session = rcp.createSession();
  const deadline = Date.now() + 120000;
  const protocol = new url.URL(source).protocol;
  let current = source;
  try {
    for (let redirects = 0; redirects <= 10; redirects++) {
      checkCancellation(signal);
      if (Date.now() >= deadline) { throw new OfflineError('TIMEOUT'); }
      if (!validDownloadUrl(current, allowHttp) || new url.URL(current).protocol !== protocol) {
        throw new OfflineError('INVALID_URL');
      }
      const file = fs.openSync(destination, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
      let downloaded = 0;
      let total = 0;
      let finished = false;
      const state = new DownloadState();
      let failure = '';
      const request = new rcp.Request(current, 'GET');
      request.configuration = {
        transfer: { autoRedirect: false, timeout: { connectMs: 20000, transferMs: Math.max(1, deadline - Date.now()) } },
        tracing: { httpEventsHandler: {
          onDataReceive: (chunk: ArrayBuffer): number => {
            if (failure) { return 0; }
            if (downloaded + chunk.byteLength > 64 * 1024 * 1024) {
              failure = 'SIZE_LIMIT';
              session.cancel(request);
              return 0;
            }
            try {
              let offset = 0;
              while (offset < chunk.byteLength) {
                const written = fs.writeSync(file.fd, chunk.slice(offset));
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
            total = totalSize;
          }
        } }
      };
      const pending = session.fetch(request).then((value: rcp.Response) => {
        state.response = value;
      }).catch((error: BusinessError) => {
        if (!failure) { failure = Date.now() >= deadline || error.code === 1007900028 ? 'TIMEOUT' : 'DOWNLOAD'; }
      }).finally(() => { finished = true; });
      try {
        while (!finished) {
          if (Atomics.load(signal, 0) !== 0 || Date.now() >= deadline) {
            failure = Atomics.load(signal, 0) !== 0 ? 'CANCELLED' : 'TIMEOUT';
            session.cancel(request);
          }
          notify(OfflineStage.DOWNLOADING, total > 0 ? Math.min(99, Math.floor(downloaded * 100 / total)) : -1);
          await new Promise<void>(resolve => setTimeout(resolve, 80));
        }
        await pending;
      } finally {
        // The network callback must finish before closing the descriptor.
        await pending;
        fs.closeSync(file);
      }
      if (failure) { throw new OfflineError(failure); }
      checkCancellation(signal);
      const result = state.response as rcp.Response;
      if (result.statusCode === 200) {
        if (downloaded === 0 || total > 0 && downloaded !== total) { throw new OfflineError('DOWNLOAD_LENGTH'); }
        notify(OfflineStage.DOWNLOADING, 100);
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
    if (!stat.isFile() || stat.size <= 0 || stat.size > 64 * 1024 * 1024) { throw new OfflineError('SIZE_LIMIT'); }
    const output = fs.openSync(destination, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
    try {
      const buffer = new ArrayBuffer(65536);
      let copied = 0;
      let count = 0;
      while ((count = fs.readSync(input.fd, buffer)) > 0) {
        checkCancellation(signal);
        copied += count;
        if (copied > 64 * 1024 * 1024) { throw new OfflineError('SIZE_LIMIT'); }
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
  cancellation: SharedArrayBuffer, localArchive: string = ''): Promise<InstallResult> {
  const signal = new Int32Array(cancellation);
  let stage = OfflineStage.PREPARING;
  const directory = packageDirectory(root, spec);
  const temporary = root + '/.install-' + spec.version + '-' + Date.now();
  let reason = '';
  try {
    checkCancellation(signal);
    if (!localArchive && !validDownloadUrl(spec.url, allowHttp)) { throw new OfflineError('INVALID_URL'); }
    fs.mkdirSync(temporary + '/content', true);
    if (localArchive) {
      notify(OfflineStage.PREPARING, -1);
      copyArchive(localArchive, temporary + '/package.zip', signal);
    } else {
      stage = OfflineStage.DOWNLOADING;
      await download(spec.url, temporary + '/package.zip', allowHttp, signal);
    }
    stage = OfflineStage.VERIFYING;
    notify(stage, -1);
    verifyHash(temporary + '/package.zip', spec.sha256, signal);
    stage = OfflineStage.EXTRACTING;
    notify(stage, -1);
    await extractPackage(temporary + '/package.zip', temporary + '/content', () => checkCancellation(signal));
    if (!contentRoot(temporary + '/content')) { throw new OfflineError('MISSING_ENTRY'); }
    checkCancellation(signal);
    stage = OfflineStage.SAVING;
    notify(stage, 99);
    // The host removes invalid unbound destinations before installing. Never overwrite a published package.
    if (fs.accessSync(directory)) { throw new OfflineError('TARGET_EXISTS'); }
    fs.renameSync(temporary + '/content', directory);
  } catch (error) {
    if (error instanceof OfflineError) {
      reason = error.reason;
    } else {
      reason = 'FILE_IO';
    }
  } finally {
    try { removeTree(temporary); } catch (_) { if (!reason) { reason = 'CLEANUP'; } }
  }
  return { success: reason === '', reason, stage, directory };
}
