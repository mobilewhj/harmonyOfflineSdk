import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { preferences } from '@kit.ArkData';
import { PackageInstaller, PackageRecord, OfflineProgress, OfflineStage, OfflineError,
  usablePackage, packageDirectory } from 'harmony-offline-sdk';
import { DEMO_RECORD } from './DemoConfig';

// Owns app-private paths and activation. The SDK never decides when a host activates a version.
export class DemoRepository {
  private installer: PackageInstaller = new PackageInstaller();
  private root: string;
  private disposed: boolean = false;
  private replay: boolean = false;

  private context: common.UIAbilityContext;

  constructor(context: common.UIAbilityContext) {
    this.context = context;
    this.root = context.filesDir + '/offline/packages';
  }

  async prepare(progress: (value: OfflineProgress) => void, failHash: boolean = false): Promise<string> {
    progress({ stage: OfflineStage.PREPARING, percent: -1 });
    const store = await preferences.getPreferences(this.context, { name: 'offline-demo' });
    this.checkAlive();
    if (!this.replay && !failHash) {
      const active = await store.get('active', '') as string;
      this.checkAlive();
      const ready = usablePackage(this.root, DEMO_RECORD);
      if (active === DEMO_RECORD.sha256 && ready) { return ready; }
    }
    const record: PackageRecord = { version: DEMO_RECORD.version,
      sha256: failHash ? '0'.repeat(64) : DEMO_RECORD.sha256 };
    // Only unbound destinations are removed. Replays use a separate root from the displayed page.
    const destination = packageDirectory(this.root, record);
    await this.installer.cleanup(this.root, '');
    this.checkAlive();
    if (fs.accessSync(destination)) { await this.installer.removeUnbound(destination); }
    this.checkAlive();
    const archive = this.context.cacheDir + '/offline-demo.zip';
    const bytes = await this.context.resourceManager.getRawFileContent('sample.zip');
    this.checkAlive();
    const file = fs.openSync(archive, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.writeSync(file.fd, bytes.buffer.slice(bytes.byteOffset + offset, bytes.byteOffset + bytes.length));
        if (count <= 0) { throw new Error('Cannot write demo ZIP'); }
        offset += count;
      }
    } finally { fs.closeSync(file); }
    try {
      const result = await this.installer.installFromFile(this.root, record, archive, progress);
      this.checkAlive();
      if (!result.success) { throw new OfflineError(result.reason, result.stage); }
      const directory = usablePackage(this.root, record);
      if (!directory) { throw new OfflineError('MISSING_ENTRY'); }
      progress({ stage: OfflineStage.SAVING, percent: -1 });
      if (!this.replay) {
        await store.put('active', record.sha256);
        await store.flush();
      }
      this.checkAlive();
      return directory;
    } finally {
      if (fs.accessSync(archive)) { fs.unlinkSync(archive); }
    }
  }

  beginReplay(): void {
    this.replay = true;
    this.root = this.context.cacheDir + '/offline-replay-' + Date.now();
  }

  private checkAlive(): void {
    if (this.disposed) { throw new OfflineError('CANCELLED'); }
  }

  dispose(): void { this.disposed = true; this.installer.cancel(); }
}
