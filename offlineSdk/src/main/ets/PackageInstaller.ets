import { taskpool } from '@kit.ArkTS';
import { runInstall, managedArchiveReusable, runManagedDownload, runManagedExtract } from './InstallWorker';
import { cleanPackages, cleanLifecyclePackages, removeTree, validatePackagePath, normalizePackageRoot, overlappingPaths,
  observePackageFiles } from './PackageFiles';
import { InstallResult, OfflineError, OfflineProgress, PackageSpec, PackageRecord, PackageObservation,
  ManagedInstallResult, ManagedInstallProgress, OfflineStage, InstallFactStage } from './OfflineTypes';

export { normalizePackageRoot } from './PackageFiles';

@Concurrent
async function installTask(root: string, spec: PackageSpec, allowHttp: boolean, signal: SharedArrayBuffer,
  managed: boolean): Promise<ManagedInstallResult> {
  return await runInstall(root, spec, allowHttp, signal, '', managed);
}

@Concurrent
function managedPreflightTask(root: string, spec: PackageSpec, signal: SharedArrayBuffer): boolean {
  return managedArchiveReusable(root, spec, signal);
}
@Concurrent
async function managedDownloadTask(root: string, spec: PackageSpec, signal: SharedArrayBuffer): Promise<ManagedInstallResult> {
  return await runManagedDownload(root, spec, signal);
}
@Concurrent
async function managedExtractTask(root: string, spec: PackageSpec, signal: SharedArrayBuffer): Promise<ManagedInstallResult> {
  return await runManagedExtract(root, spec, signal);
}
@Concurrent
function lifecycleCleanupTask(root: string, keep: string[], signal: SharedArrayBuffer): void {
  if (Atomics.load(new Int32Array(signal), 0)) { throw new OfflineError('CANCELLED'); }
  cleanLifecyclePackages(root, keep, () => {
    if (Atomics.load(new Int32Array(signal), 0)) { throw new OfflineError('CANCELLED'); }
  });
}

@Concurrent
async function localInstallTask(root: string, record: PackageRecord, archive: string,
  signal: SharedArrayBuffer): Promise<ManagedInstallResult> {
  const spec: PackageSpec = { version: record.version, sha256: record.sha256, url: '' };
  return await runInstall(root, spec, false, signal, archive);
}

@Concurrent
function validateRootTask(root: string, stateRoot: string, removableLeaf: boolean = false): string {
  const normalized = validatePackagePath(root, false, removableLeaf);
  if (stateRoot && overlappingPaths(normalized, validatePackagePath(stateRoot))) {
    throw new OfflineError('UNSAFE_PATH');
  }
  return normalized;
}

@Concurrent
function observationTask(root: string, record: PackageRecord): PackageObservation {
  return observePackageFiles(root, record);
}

@Concurrent
function cleanupTask(root: string, keep: string, signal: SharedArrayBuffer): void {
  if (Atomics.load(new Int32Array(signal), 0)) { throw new OfflineError('CANCELLED'); }
  cleanPackages(root, keep);
}

@Concurrent
function removeTask(path: string, signal: SharedArrayBuffer): void {
  validatePackagePath(path, false, true);
  if (Atomics.load(new Int32Array(signal), 0)) { throw new OfflineError('CANCELLED'); }
  removeTree(path);
}

// 注册表只在主 ArkTS 执行域修改，TaskPool 只接收路径/记录/共享取消事实。
const claimedRoots: Map<string, PackageInstaller> = new Map();
const writingRoots: Map<string, PackageInstaller> = new Map();

function conflicts(root: string, registry: Map<string, PackageInstaller>): boolean {
  for (let registered of registry.keys()) {
    if (overlappingPaths(root, registered)) { return true; }
  }
  return false;
}

export async function claimManagedRoot(root: string, stateRoot: string = ''): Promise<PackageInstaller> {
  const normalized = await taskpool.execute(new taskpool.Task(validateRootTask, root, stateRoot)) as string;
  // 验证返回后同步比较并认领，不留第二个 create 可插入的 await。
  if (conflicts(normalized, claimedRoots) || conflicts(normalized, writingRoots)) {
    throw new OfflineError('ROOT_IN_USE');
  }
  const installer = new PackageInstaller();
  claimedRoots.set(normalized, installer);
  return installer;
}

export async function observePackage(root: string, record: PackageRecord): Promise<PackageObservation> {
  return await taskpool.execute(new taskpool.Task(observationTask, root, record)) as PackageObservation;
}

export class PackageInstaller {
  private active?: taskpool.Task;
  private busy: boolean = false;
  private cancellation?: Int32Array;

  async install(root: string, spec: PackageSpec, progress: (value: OfflineProgress) => void,
    allowHttp: boolean = false): Promise<InstallResult> {
    const key = await this.beginWrite(root, false);
    try {
      return await this.execute(new taskpool.Task(installTask, key, spec, allowHttp, this.signal(), false), progress);
    } finally { this.finishWrite(key); }
  }

  async installFromFile(root: string, record: PackageRecord, archive: string,
    progress: (value: OfflineProgress) => void): Promise<InstallResult> {
    const key = await this.beginWrite(root, false);
    try {
      return await this.execute(new taskpool.Task(localInstallTask, key, record, archive, this.signal()), progress);
    } finally { this.finishWrite(key); }
  }

  async installManaged(root: string, spec: PackageSpec,
    progress?: (value: ManagedInstallProgress) => void,
    onStage: (stage: string) => Promise<void> = async (_stage: string): Promise<void> => {}): Promise<ManagedInstallResult> {
    const key = await this.beginWrite(root, true);
    let result: ManagedInstallResult = { success: false, reason: '', stage: OfflineStage.PREPARING,
      directory: key + '/' + spec.version, requestStarted: false, factStage: InstallFactStage.PREPARING };
    try {
      const reusable = await taskpool.execute(new taskpool.Task(managedPreflightTask, key, spec, this.signal())) as boolean;
      if (!reusable) {
        try { await onStage('downloading'); }
        catch (error) { result.storageWriteFailed = true; throw error as Error; }
        result = await this.execute(new taskpool.Task(managedDownloadTask, key, spec, this.signal()), progress);
        if (!result.success) { return result; }
      } else {
        // Validated ZIP reuse enters processing without inventing a network request.
        result.requestStarted = true;
      }
      try { await onStage('downloaded'); }
      catch (error) { result.storageWriteFailed = true; throw error as Error; }
      return await this.execute(new taskpool.Task(managedExtractTask, key, spec, this.signal()), progress);
    } catch (error) {
      result.success = false;
      result.reason = error instanceof OfflineError ? error.reason : 'FILE_IO';
      return result;
    } finally { this.finishWrite(key); }
  }

  async cleanupLifecycle(root: string, keep: string[]): Promise<void> {
    const key = await this.beginWrite(root, true);
    try { await this.executeMutation(new taskpool.Task(lifecycleCleanupTask, key, keep, this.signal())); }
    finally { this.finishWrite(key); }
  }

  async deleteManagedZip(root: string, version: number): Promise<void> {
    if (!Number.isSafeInteger(version) || version < 10000) { throw new OfflineError('INVALID_CONFIG'); }
    const key = await this.beginWrite(root, true);
    try { await this.executeMutation(new taskpool.Task(removeTask, key + '/' + version + '.zip', this.signal())); }
    finally { this.finishWrite(key); }
  }

  private async beginWrite(root: string, managed: boolean, removableLeaf: boolean = false): Promise<string> {
    if (this.busy) { throw new OfflineError('ROOT_IN_USE'); }
    this.busy = true;
    this.cancellation = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    let key = '';
    try {
      // 先预留互斥资格；后台验证在途也属于旧 writer，不能让 claim 抢先成功。
      // 词法键不授予文件操作安全，原 root 仍必须在任何写 IO 前验证。
      key = normalizePackageRoot(root);
      if (managed ? claimedRoots.get(key) !== this : conflicts(key, claimedRoots)) {
        throw new OfflineError('ROOT_IN_USE');
      }
      if (conflicts(key, writingRoots)) { throw new OfflineError('ROOT_IN_USE'); }
      writingRoots.set(key, this);
      const validated = await taskpool.execute(new taskpool.Task(validateRootTask, root, '', removableLeaf)) as string;
      if (validated !== key) { throw new OfflineError('UNSAFE_PATH'); }
      if (managed ? claimedRoots.get(key) !== this : conflicts(key, claimedRoots)) {
        throw new OfflineError('ROOT_IN_USE');
      }
      return key;
    } catch (error) {
      if (writingRoots.get(key) === this) { writingRoots.delete(key); }
      this.busy = false;
      this.cancellation = undefined;
      throw error as Error;
    }
  }

  private signal(): SharedArrayBuffer { return (this.cancellation as Int32Array).buffer as SharedArrayBuffer; }

  private async execute(task: taskpool.Task,
    progress?: (value: ManagedInstallProgress) => void): Promise<ManagedInstallResult> {
    this.active = task;
    if (progress) { task.onReceiveData(progress); }
    try { return await taskpool.execute(task) as ManagedInstallResult; }
    finally { task.onReceiveData(); }
  }

  private async executeMutation(task: taskpool.Task): Promise<void> {
    this.active = task;
    await taskpool.execute(task);
  }

  private finishWrite(key: string): void {
    if (writingRoots.get(key) === this) { writingRoots.delete(key); }
    this.active = undefined;
    this.cancellation = undefined;
    this.busy = false;
  }

  cancel(): void {
    // 不终止 Task；必须等网络/系统解压与收尾落定后才释放写许可。
    if (this.cancellation) { Atomics.store(this.cancellation, 0, 1); }
  }

  async cleanup(root: string, keep: string): Promise<void> {
    await this.cleanupRoot(root, keep, false);
  }

  async cleanupManaged(root: string, keepVersion?: number): Promise<void> {
    await this.cleanupRoot(root, keepVersion === undefined ? '' : String(keepVersion), true);
  }

  private async cleanupRoot(root: string, keep: string, managed: boolean): Promise<void> {
    const key = await this.beginWrite(root, managed);
    try { await this.executeMutation(new taskpool.Task(cleanupTask, key, keep, this.signal())); }
    finally { this.finishWrite(key); }
  }

  async removeUnbound(path: string): Promise<void> {
    const key = await this.beginWrite(path, false, true);
    try { await this.executeMutation(new taskpool.Task(removeTask, key, this.signal())); }
    finally { this.finishWrite(key); }
  }

  async removeUnboundManaged(root: string, version: number): Promise<void> {
    if (!Number.isSafeInteger(version) || version < 10000) { throw new OfflineError('INVALID_CONFIG'); }
    const key = await this.beginWrite(root, true);
    try { await this.executeMutation(new taskpool.Task(removeTask, key + '/' + version, this.signal())); }
    finally { this.finishWrite(key); }
  }
}
