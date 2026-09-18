import { taskpool } from '@kit.ArkTS';
import { runInstall } from './InstallWorker';
import { cleanPackages, removeTree } from './PackageFiles';
import { InstallResult, OfflineProgress, PackageSpec, PackageRecord } from './OfflineTypes';

@Concurrent
async function installTask(root: string, spec: PackageSpec, allowHttp: boolean, signal: SharedArrayBuffer): Promise<InstallResult> {
  return await runInstall(root, spec, allowHttp, signal);
}

@Concurrent
async function localInstallTask(root: string, record: PackageRecord, archive: string,
  signal: SharedArrayBuffer): Promise<InstallResult> {
  const spec: PackageSpec = { version: record.version, sha256: record.sha256, url: '' };
  return await runInstall(root, spec, false, signal, archive);
}

@Concurrent
function cleanupTask(root: string, keep: string): void {
  cleanPackages(root, keep);
}

@Concurrent
function removeTask(path: string): void {
  removeTree(path);
}

// A host keeps one installer for its package root, and serializes all install/cleanup operations.
export class PackageInstaller {
  private active?: taskpool.Task;
  private cancellation?: Int32Array;

  async install(root: string, spec: PackageSpec, progress: (value: OfflineProgress) => void,
    allowHttp: boolean = false): Promise<InstallResult> {
    return this.execute(new taskpool.Task(installTask, root, spec, allowHttp, this.createSignal()), progress);
  }

  async installFromFile(root: string, record: PackageRecord, archive: string,
    progress: (value: OfflineProgress) => void): Promise<InstallResult> {
    return this.execute(new taskpool.Task(localInstallTask, root, record, archive, this.createSignal()), progress);
  }

  private createSignal(): SharedArrayBuffer {
    if (this.active) { throw new Error('An offline installation is already running'); }
    const signal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    this.cancellation = new Int32Array(signal);
    return signal;
  }

  private async execute(task: taskpool.Task, progress: (value: OfflineProgress) => void): Promise<InstallResult> {
    this.active = task;
    task.onReceiveData(progress);
    try {
      return await taskpool.execute(task) as InstallResult;
    } finally {
      task.onReceiveData();
      this.active = undefined;
      this.cancellation = undefined;
    }
  }

  cancel(): void {
    // Shared flag supports API 12 and keeps the task alive until system extraction and cleanup settle.
    if (this.cancellation) { Atomics.store(this.cancellation, 0, 1); }
  }

  async cleanup(root: string, keep: string): Promise<void> {
    if (this.active) { throw new Error('Wait for installation before cleanup'); }
    await taskpool.execute(new taskpool.Task(cleanupTask, root, keep));
  }

  async removeUnbound(path: string): Promise<void> {
    if (this.active) { throw new Error('Wait for installation before removal'); }
    await taskpool.execute(new taskpool.Task(removeTask, path));
  }
}
