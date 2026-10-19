import { PackageInstaller, observePackage } from './PackageInstaller';
import { validManagedDownloadUrl } from './InstallWorker';
import { ManagedStoragePort, PackageStage, LifecycleRecord, PackageIdentityConflictError } from './ManagedStorage';
import { PackageRecord, PackageSpec, ManagedInstallProgress, ManagedInstallResult, OfflineStage, InstallFactStage } from './OfflineTypes';
import { ManagedConfig, ManagedState, ManagedDiagnostic, ManagedEvent, ManagedProgress, ManagedProgressStage,
  ManagedFailureReason, ManagedFailureStage, ManagedInstallReason, InstallationOutcome, InstallationFailure,
  OfflineCancellation, OfflineCancelledError } from './ManagedOfflineTypes';

export interface PackageCheckResult { outcome?: InstallationOutcome; deferred: boolean; }
export interface PageObservation { record?: PackageRecord; directory?: string; epoch: number; ready: boolean; }
export interface SessionBinding { directory: string; version: number; isEnabled: () => boolean; }
interface TargetAttempt { target: PackageRecord; failures: number; notBefore: number; cacheClearRequested: boolean; }

function sameRecord(left?: PackageRecord, right?: PackageRecord): boolean {
  return left?.version === right?.version && left?.sha256 === right?.sha256;
}
function conflicts(left: PackageRecord | undefined, right: PackageRecord): boolean {
  return !!left && left.version === right.version && left.sha256 !== right.sha256;
}

// One process owns one immutable in-use identity, including an unusable active directory.
export class ManagedPackageSession {
  private root: string;
  private installer: PackageInstaller;
  private storage: ManagedStoragePort;
  private minimumVersion: number;
  private onDiagnostic: (value: ManagedDiagnostic) => void;
  private onEvent: (value: ManagedEvent) => void;
  private cleaner: () => void;
  private now: () => number;
  private initialized: boolean = false;
  private startedEmpty: boolean = false;
  private startupGate: 'undecided' | 'first' | 'released' = 'undecided';
  private localChain: Promise<void> = Promise.resolve();
  private active?: PackageRecord;
  private usable: boolean = false;
  private enabled: boolean = true;
  private onlineVersion?: number;
  private policySha?: string;
  private shaConflict: boolean = false;
  private coldCleanupDone: boolean = false;
  private pagesBound: boolean = false;
  private epoch: number = 0;
  private attempt?: TargetAttempt;

  constructor(root: string, installer: PackageInstaller, storage: ManagedStoragePort,
    minimumVersion: number, onDiagnostic: (value: ManagedDiagnostic) => void,
    onEvent: (value: ManagedEvent) => void = (_value: ManagedEvent): void => {},
    cleaner: () => void = (): void => {}, now: () => number = (): number => Date.now()) {
    this.root = root; this.installer = installer; this.storage = storage; this.minimumVersion = minimumVersion;
    this.onDiagnostic = onDiagnostic; this.onEvent = onEvent; this.cleaner = cleaner; this.now = now;
  }
  private diagnostic(reason: ManagedFailureReason, stage: ManagedFailureStage, detail?: string): void {
    const diagnostic: ManagedDiagnostic = { reason, stage, detail };
    try { this.onDiagnostic(diagnostic); } catch (_) {}
    this.event({ kind: 'Diagnostic', diagnostic, activeVersion: this.active?.version ?? 0 });
  }
  private event(value: ManagedEvent): void { try { this.onEvent(value); } catch (_) {} }
  private kept(rows: LifecycleRecord[]): string[] {
    const keep = rows.map((row: LifecycleRecord): string => row.stage === PackageStage.DOWNLOADING ||
      row.stage === PackageStage.DOWNLOADED ? row.version + '.zip' : String(row.version));
    if (this.active && !keep.includes(String(this.active.version))) { keep.push(String(this.active.version)); }
    return keep;
  }
  private async cleanup(rows: LifecycleRecord[], cancel: OfflineCancellation): Promise<void> {
    cancel.throwIfCancelled();
    const detach = cancel.onCancel(() => this.installer.cancel());
    try { await this.installer.cleanupLifecycle(this.root, this.kept(rows)); }
    catch (error) {
      if (error instanceof OfflineCancelledError) { throw error; }
      cancel.throwIfCancelled();
      this.diagnostic(ManagedFailureReason.INSTALL, ManagedFailureStage.CLEANUP);
    } finally { detach(); }
    cancel.throwIfCancelled();
  }
  prepareLocal(cancel: OfflineCancellation): Promise<boolean> {
    const result = this.localChain.then(() => this.prepareLocalOnce(cancel));
    this.localChain = result.then(() => {}, () => {});
    return result;
  }
  private async prepareLocalOnce(cancel: OfflineCancellation): Promise<boolean> {
    cancel.throwIfCancelled();
    try {
      if (!this.initialized) {
        let rows = await this.storage.load();
        cancel.throwIfCancelled();
        // First successful read decides first-install eligibility, independently of file usability.
        if (!this.coldCleanupDone) { this.startedEmpty = rows.length === 0; this.coldCleanupDone = true; }
        const ready = rows.find((row: LifecycleRecord): boolean => row.stage === PackageStage.READY);
        if (ready) {
          const observed = await observePackage(this.root, ready);
          cancel.throwIfCancelled();
          if (observed.directory) {
            try { await this.storage.activate(ready); }
            catch (_) { this.diagnostic(ManagedFailureReason.STORAGE_WRITE, ManagedFailureStage.PUBLISHING); }
          }
        }
        // A failed read after activation never authorizes file cleanup or an inferred empty database.
        rows = await this.storage.load();
        cancel.throwIfCancelled();
        const active = rows.find((row: LifecycleRecord): boolean => row.stage === PackageStage.ACTIVE);
        const observed = active ? await observePackage(this.root, active) : undefined;
        cancel.throwIfCancelled();
        this.active = active ? { version: active.version, sha256: active.sha256 } : undefined;
        this.usable = !!observed?.directory;
        await this.cleanup(rows, cancel);
        this.initialized = true;
        this.epoch++;
      } else if (this.active) {
        const observed = await observePackage(this.root, this.active);
        cancel.throwIfCancelled();
        this.usable = !!observed.directory;
      }
      return true;
    } catch (error) {
      if (error instanceof OfflineCancelledError) { throw error; }
      cancel.throwIfCancelled();
      this.diagnostic(ManagedFailureReason.LOCAL_STATE_READ, ManagedFailureStage.LOCAL);
      return false;
    }
  }
  needsInitial(): boolean {
    if (this.startupGate === 'undecided') { this.startupGate = this.initialized && this.startedEmpty ? 'first' : 'released'; }
    return this.startupGate === 'first';
  }
  isLocalReady(): boolean { return this.initialized; }
  releaseStartup(): void { this.startupGate = 'released'; }
  currentVersion(): number | undefined { return this.usable ? this.active?.version : undefined; }
  getState(): ManagedState {
    return { active: this.active ? { version: this.active.version, sha256: this.active.sha256 } : undefined, usable: this.usable,
      enabled: this.enabled, initialFinished: this.startupGate === 'released', onlineVersion: this.onlineVersion,
      shaConflict: this.shaConflict, pagesBound: this.pagesBound };
  }

  async check(config: ManagedConfig, cancel: OfflineCancellation, onProgress: (value: ManagedProgress) => void,
    canStart: () => boolean, initial: boolean = false): Promise<PackageCheckResult> {
    cancel.throwIfCancelled();
    if (!this.initialized) { return { deferred: false }; }
    if (!config || typeof config.enabled !== 'boolean') { return this.invalid('enabled_invalid'); }
    if (!config.enabled) {
      this.enabled = false; this.onlineVersion = undefined; this.policySha = undefined; this.shaConflict = false;
      if (initial && !canStart()) { return { deferred: true }; }
      return { deferred: false };
    }
    if (!Number.isSafeInteger(config.version) || (config.version ?? 0) < this.minimumVersion) {
      return this.invalid('version_invalid');
    }
    const version = config.version as number;
    const hasCandidate = config.sha256 !== undefined || config.url !== undefined || config.localArchive !== undefined;
    if (!hasCandidate) {
      if (!this.usable || !this.active || this.active.version < version) { return this.invalid('candidate_missing'); }
      this.applyPolicy(version);
      if (initial && !canStart()) { return { deferred: true }; }
      await this.evictStale(cancel);
      return { deferred: false };
    }
    const sha = typeof config.sha256 === 'string' ? config.sha256.toLowerCase() : '';
    if (!/^[a-f0-9]{64}$/.test(sha)) { return this.invalid('sha_invalid'); }
    if (config.localArchive !== undefined ? typeof config.localArchive !== 'string' || !config.localArchive :
      typeof config.url !== 'string' || !validManagedDownloadUrl(config.url)) { return this.invalid('source_invalid'); }
    const target: PackageSpec = { version, sha256: sha, url: config.url ?? '', localArchive: config.localArchive };
    let rows: LifecycleRecord[];
    try { rows = await this.storage.load(); }
    catch (_) { cancel.throwIfCancelled(); this.diagnostic(ManagedFailureReason.LOCAL_STATE_READ, ManagedFailureStage.LOCAL); return { deferred: false }; }
    cancel.throwIfCancelled();
    const recorded = rows.find((row: LifecycleRecord): boolean => row.version === version);
    if (conflicts(this.active, target) || conflicts(recorded, target) || conflicts(this.attempt?.target, target)) {
      return this.invalid('same_version_sha256_conflict');
    }
    if (this.attempt && version < this.attempt.target.version) { return this.invalid('candidate_version_rollback'); }
    let readyUsable = false;
    if (recorded?.stage === PackageStage.READY) {
      try { readyUsable = !!(await observePackage(this.root, target)).directory; }
      catch (_) { this.diagnostic(ManagedFailureReason.LOCAL_STATE_READ, ManagedFailureStage.LOCAL); return { deferred: false }; }
      cancel.throwIfCancelled();
    }
    this.applyPolicy(version, sha, target);
    // Policy -> synchronous resource-cache call -> preparation, once for this target even on failure.
    if (!initial && this.active && version > this.active.version && this.attempt && !this.attempt.cacheClearRequested) {
      this.attempt.cacheClearRequested = true;
      try { this.cleaner(); }
      catch (error) {
        if (error instanceof OfflineCancelledError) { throw error; }
        this.diagnostic(ManagedFailureReason.CACHE_CLEAR, ManagedFailureStage.RESOURCE_CACHE);
      }
    }
    cancel.throwIfCancelled();
    if (initial && !canStart()) { return { deferred: true }; }
    // Unusable active is still protected; never repair, downgrade, or switch it in this process.
    if (this.active && this.active.version >= version) { await this.evictStale(cancel); return { deferred: false }; }
    if (readyUsable) {
      if (!this.active) { await this.activateNow(target); }
      return { deferred: false };
    }
    if (this.attempt && (this.attempt.failures >= 2 || this.now() < this.attempt.notBefore)) { return { deferred: false }; }
    this.progress(onProgress, ManagedProgressStage.PREPARING);
    try {
      // The transaction checks the complete identity set before removing rows or any files.
      await this.storage.registerTarget(target, this.active?.version);
      cancel.throwIfCancelled();
      await this.cleanup(await this.storage.load(), cancel);
    } catch (error) {
      if (error instanceof OfflineCancelledError) { throw error; }
      cancel.throwIfCancelled();
      return this.failed(target, error instanceof PackageIdentityConflictError ? ManagedFailureReason.CONFIGURATION :
        ManagedFailureReason.STORAGE_WRITE, ManagedFailureStage.REGISTER, undefined, false);
    }
    let installed: ManagedInstallResult;
    const detach = cancel.onCancel(() => this.installer.cancel());
    try {
      installed = await this.installer.installManaged(this.root, target,
        (value: ManagedInstallProgress): void => this.installProgress(value, onProgress), async (stage: string): Promise<void> => {
          cancel.throwIfCancelled();
          const saved = await this.storage.setStage(target, stage === 'downloading' ? PackageStage.DOWNLOADING : PackageStage.DOWNLOADED);
          if (!saved) { throw new Error('Package stage update affected no row'); }
          cancel.throwIfCancelled();
        });
    } catch (error) {
      if (error instanceof OfflineCancelledError) { throw error; }
      cancel.throwIfCancelled();
      return this.failed(target, ManagedFailureReason.INSTALL, ManagedFailureStage.PREPARING, ManagedInstallReason.FILE_IO, false);
    } finally { detach(); }
    cancel.throwIfCancelled();
    if (!installed.success) {
      if (installed.reason === 'CANCELLED') { throw new OfflineCancelledError(); }
      return this.failed(target, installed.storageWriteFailed ? ManagedFailureReason.STORAGE_WRITE : ManagedFailureReason.INSTALL,
        installed.storageWriteFailed ? ManagedFailureStage.PREPARING : this.installStage(installed.factStage),
        installed.storageWriteFailed ? undefined : this.installReason(installed.reason), installed.requestStarted,
        installed.httpStatus, installed.retryAfterMillis);
    }
    // Only this small finishing boundary is non-cancellable. A real ready write is the success fact.
    this.progress(onProgress, ManagedProgressStage.SAVING);
    try {
      if (!await this.storage.setStage(target, PackageStage.READY)) { throw new Error('Ready update affected no row'); }
    } catch (_) {
      return this.failed(target, ManagedFailureReason.STORAGE_WRITE, ManagedFailureStage.PUBLISHING, undefined, true);
    }
    if (this.attempt) { this.attempt.failures = 0; this.attempt.notBefore = 0; }
    try { await this.installer.deleteManagedZip(this.root, version); }
    catch (_) { this.diagnostic(ManagedFailureReason.INSTALL, ManagedFailureStage.CLEANUP); }
    const outcome: InstallationOutcome = { success: true, targetVersion: version, targetSha256: sha };
    this.event({ kind: 'Prepared', record: { version, sha256: sha }, activeVersion: this.active?.version ?? 0 });
    if (!this.active) { await this.activateNow(target); }
    this.progress(onProgress, ManagedProgressStage.COMPLETE, 100);
    return { deferred: false, outcome };
  }
  private applyPolicy(version: number, sha?: string, target?: PackageRecord): void {
    this.enabled = true; this.onlineVersion = version; this.policySha = sha; this.shaConflict = false;
    if (target && !sameRecord(this.attempt?.target, target)) {
      this.attempt = { target: { version: target.version, sha256: target.sha256 }, failures: 0, notBefore: 0, cacheClearRequested: false };
    }
  }
  private async activateNow(target: PackageRecord): Promise<void> {
    if (this.active) { return; }
    try { await this.storage.activate(target); }
    catch (_) { this.diagnostic(ManagedFailureReason.STORAGE_WRITE, ManagedFailureStage.PUBLISHING); return; }
    // A committed active identity remains in-use even when its directory cannot be observed.
    this.active = { version: target.version, sha256: target.sha256 }; this.usable = false; this.epoch++;
    try { this.usable = !!(await observePackage(this.root, target)).directory; }
    catch (_) { this.diagnostic(ManagedFailureReason.LOCAL_STATE_READ, ManagedFailureStage.LOCAL); }
  }
  private async evictStale(cancel: OfflineCancellation): Promise<void> {
    if (!this.active) { return; }
    try {
      await this.storage.evictInactive(this.active.version);
      cancel.throwIfCancelled();
      await this.cleanup(await this.storage.load(), cancel);
    } catch (error) {
      if (error instanceof OfflineCancelledError) { throw error; }
      cancel.throwIfCancelled();
      this.diagnostic(ManagedFailureReason.STORAGE_WRITE, ManagedFailureStage.CLEANUP);
    }
  }
  private invalid(detail: string): PackageCheckResult {
    this.diagnostic(ManagedFailureReason.CONFIGURATION, ManagedFailureStage.CONFIG, detail);
    return { deferred: false };
  }
  private failed(target: PackageRecord, reason: ManagedFailureReason, stage: ManagedFailureStage,
    installReason: ManagedInstallReason | undefined, started: boolean, httpStatus?: number, retryAfterMillis?: number): PackageCheckResult {
    const failure: InstallationFailure = { success: false, targetVersion: target.version, targetSha256: target.sha256,
      reason, stage, installReason, httpStatus };
    const network = installReason === ManagedInstallReason.DOWNLOAD || installReason === ManagedInstallReason.DOWNLOAD_TIMEOUT ||
      installReason === ManagedInstallReason.TIMEOUT || installReason === ManagedInstallReason.HTTP_STATUS &&
      httpStatus !== undefined && [408, 429, 500, 502, 503, 504].includes(httpStatus);
    if (this.attempt) {
      if (!network) { this.attempt.failures++; }
      this.attempt.notBefore = network && retryAfterMillis !== undefined ? Math.min(Number.MAX_SAFE_INTEGER, this.now() + retryAfterMillis) : 0;
    }
    if (started) {
      this.event({ kind: 'PrepareFailed', failure, activeVersion: this.active?.version ?? 0 });
      return { deferred: false, outcome: failure };
    }
    this.event({ kind: 'Diagnostic', failure, activeVersion: this.active?.version ?? 0 });
    try { this.onDiagnostic({ reason, stage, targetVersion: target.version, targetSha256: target.sha256 }); } catch (_) {}
    return { deferred: false };
  }
  private installReason(reason: string): ManagedInstallReason {
    if (reason === 'TIMEOUT') { return ManagedInstallReason.DOWNLOAD_TIMEOUT; }
    const name = reason.startsWith('HTTP_') ? 'HTTP_STATUS' : reason;
    return Object.values(ManagedInstallReason).includes(name as ManagedInstallReason) ? name as ManagedInstallReason : ManagedInstallReason.FILE_IO;
  }
  private installStage(stage: InstallFactStage): ManagedFailureStage {
    switch (stage) {
      case InstallFactStage.DOWNLOADING: return ManagedFailureStage.DOWNLOADING;
      case InstallFactStage.VERIFYING: return ManagedFailureStage.VERIFYING;
      case InstallFactStage.EXTRACTING: return ManagedFailureStage.EXTRACTING;
      case InstallFactStage.PUBLISHING: return ManagedFailureStage.PUBLISHING;
      case InstallFactStage.CLEANUP: return ManagedFailureStage.CLEANUP;
      default: return ManagedFailureStage.PREPARING;
    }
  }
  private progress(callback: (value: ManagedProgress) => void, stage: ManagedProgressStage, percent: number = -1): void {
    try { callback({ stage, percent }); } catch (_) {}
  }
  private installProgress(value: ManagedInstallProgress, callback: (value: ManagedProgress) => void): void {
    switch (value.stage) {
      case OfflineStage.DOWNLOADING:
        this.progress(callback, ManagedProgressStage.DOWNLOADING, value.downloadTotalKnown === true && value.percent >= 0 ? Math.min(99, value.percent) : -1); break;
      case OfflineStage.VERIFYING: this.progress(callback, ManagedProgressStage.VERIFYING); break;
      case OfflineStage.EXTRACTING: this.progress(callback, ManagedProgressStage.EXTRACTING, value.percent); break;
    }
  }
  async finishInitial(cancel: OfflineCancellation): Promise<void> { cancel.throwIfCancelled(); this.releaseStartup(); }
  async finishRegular(_outcome: InstallationOutcome | undefined, cancel: OfflineCancellation): Promise<void> { cancel.throwIfCancelled(); }
  async observePage(cancel: OfflineCancellation): Promise<PageObservation> {
    const ready = this.initialized || await this.prepareLocal(cancel);
    const record = ready ? this.active : undefined;
    const observation: PageObservation = { record, epoch: this.epoch, ready };
    try { if (record) { observation.directory = (await observePackage(this.root, record)).directory; } }
    catch (_) { this.diagnostic(ManagedFailureReason.LOCAL_STATE_READ, ManagedFailureStage.LOCAL); }
    cancel.throwIfCancelled();
    return observation;
  }
  finalBinding(observation: PageObservation, managerClosed: boolean): SessionBinding | undefined {
    const record = observation.record;
    if (!managerClosed && observation.ready && this.initialized && this.usable && this.enabled && !this.shaConflict &&
      observation.epoch === this.epoch && sameRecord(this.active, record) && record && observation.directory &&
      (this.onlineVersion === undefined || this.onlineVersion === record.version) &&
      (this.policySha === undefined || this.policySha === record.sha256)) {
      return { directory: observation.directory, version: record.version, isEnabled: (): boolean => this.enabled };
    }
    return undefined;
  }
  markPageBound(): void { this.pagesBound = true; }
}
