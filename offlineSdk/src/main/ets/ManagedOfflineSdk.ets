import { common } from '@kit.AbilityKit';
import { systemDateTime } from '@kit.BasicServicesKit';
import { claimManagedRoot, normalizePackageRoot } from './PackageInstaller';
import { ManagedStorage } from './ManagedStorage';
import { ManagedPackageSession, PageObservation } from './ManagedPackageSession';
import { ArkWebPage, PageBinding } from './ManagedPage';
import { ManagedOptions, ManagedConditions, ManagedState, ManagedProgress, ManagedProgressStage,
  ManagedConfig, ManagedDiagnostic, ManagedEvent, ManagedFailureReason, ManagedFailureStage, InstallationOutcome,
  OfflineCancellation, OfflineCancelledError, StartupKind, StartupResult, StartupOptions,
  PageLoadResult, PageLoadOptions } from './ManagedOfflineTypes';

function uptime(): number { return systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false); }

// 等待者退出自己的等待，不触碰首次owner；owner必须等native工作安全落定。
function waitFor<T>(work: Promise<T>, cancellation: OfflineCancellation): Promise<T> {
  cancellation.throwIfCancelled();
  return new Promise<T>((resolve, reject) => {
    const detach = cancellation.onCancel(() => reject(new OfflineCancelledError()));
    work.then((value: T) => { detach(); resolve(value); }, (error: Error) => { detach(); reject(error); });
  });
}

export class ManagedOfflineSdk {
  private conditions: ManagedConditions = { privacyAccepted: false, foreground: false };
  private closed: boolean = false;
  private firstWork?: Promise<StartupResult>;
  private firstCancellation?: OfflineCancellation;
  private silentWork?: Promise<void>;
  private silentCancellation?: OfflineCancellation;
  private operation?: Promise<void>;
  private monitorTimer?: number;
  // 无请求轮次让出的正常周期只归monitor；重排不能抹掉截止，也不冒充provider起点。
  private monitorYieldUntil: number = 0;
  private lastProviderStart?: number;
  private session: ManagedPackageSession;
  private options: ManagedOptions;
  private interval: number;

  private constructor(session: ManagedPackageSession, options: ManagedOptions, interval: number) {
    this.session = session; this.options = options; this.interval = interval;
  }

  static async create(context: common.Context, options: ManagedOptions): Promise<ManagedOfflineSdk> {
    if (options.keyValueStore !== undefined) { throw new Error('Managed lifecycle requires SDK relational storage'); }
    const minimum = options.minimumVersion ?? 10000;
    const interval = options.checkIntervalMs ?? 300000;
    if (!Number.isSafeInteger(minimum) || minimum < 10000 || !Number.isFinite(interval) || interval <= 0 ||
      typeof options.configProvider !== 'function') { throw new Error('Invalid managed offline options'); }
    const requestedRoot = options.root ?? context.filesDir + '/offline/lifecycle-packages';
    const root = normalizePackageRoot(requestedRoot);
    const databaseRoot = context.databaseDir ? normalizePackageRoot(context.databaseDir) : undefined;
    if (databaseRoot && (root === databaseRoot || root.startsWith(databaseRoot + '/') || databaseRoot.startsWith(root + '/'))) {
      throw new Error('Managed package root overlaps relational storage');
    }
    // 原路径中的 link/.. 仍由后台逐级检查，词法键不授予文件操作资格。
    const installer = await claimManagedRoot(requestedRoot, context.preferencesDir);
    const storage = new ManagedStorage(context, root);
    const diagnostic = (value: ManagedDiagnostic): void => {
      try { options.onDiagnostic?.(value); } catch (_) {}
    };
    const event = (value: ManagedEvent): void => {
      try { options.onEvent?.(value); } catch (_) {}
    };
    const session = new ManagedPackageSession(root, installer, storage, minimum, diagnostic, event,
      options.resourceCacheCleaner, uptime);
    return new ManagedOfflineSdk(session, options, interval);
  }

  updateConditions(conditions: ManagedConditions): void {
    if (this.closed) { return; }
    this.conditions = { privacyAccepted: conditions.privacyAccepted, foreground: conditions.foreground };
    if (!conditions.privacyAccepted) {
      this.firstCancellation?.cancel();
      this.silentCancellation?.cancel();
    }
    // 普通后台停新的monitor，不取消已经开始的目标安装。
    this.scheduleMonitor();
  }

  getState(): ManagedState {
    const state = this.session.getState();
    state.closed = this.closed;
    state.checking = this.operation !== undefined;
    return state;
  }

  async prepareStartup(options: StartupOptions = {}): Promise<StartupResult> {
    const cancellation = options.cancellation ?? new OfflineCancellation();
    cancellation.throwIfCancelled();
    if (this.closed) { return { kind: StartupKind.CONTINUE }; }
    // 终态回调可同步重入；在任何 local await 前加入既有 owner，不能因收尾微任务清槽而新开首装。
    if (this.firstWork) { return await waitFor(this.firstWork, cancellation); }
    if (!await this.session.prepareLocal(cancellation)) {
      this.session.releaseStartup(); this.scheduleMonitor(); return { kind: StartupKind.CONTINUE };
    }
    cancellation.throwIfCancelled();
    if (!this.session.needsInitial()) {
      this.scheduleMonitor();
      return { kind: StartupKind.CONTINUE };
    }
    if (this.firstWork) { return await waitFor(this.firstWork, cancellation); }
    if (!this.canStart()) { return { kind: StartupKind.DEFERRED }; }
    const owner = new OfflineCancellation();
    const detach = cancellation.onCancel(() => owner.cancel());
    this.firstCancellation = owner;
    const progress = (value: ManagedProgress): void => {
      if (!owner.isCancelled && !this.closed) { try { options.onProgress?.(value); } catch (_) {} }
    };
    const work = this.runUpdate(true, owner, progress);
    this.firstWork = work;
    const finished = (): void => {
      detach();
      if (this.firstWork === work) { this.firstWork = undefined; this.firstCancellation = undefined; }
      this.scheduleMonitor();
    };
    work.then(finished, finished);
    return await work;
  }

  private canStart(): boolean {
    return !this.closed && this.conditions.privacyAccepted && this.conditions.foreground;
  }
  private emitDiagnostic(reason: ManagedFailureReason, stage: ManagedFailureStage): void {
    const diagnostic: ManagedDiagnostic = { reason, stage };
    try { this.options.onDiagnostic?.(diagnostic); } catch (_) {}
    try { this.options.onEvent?.({ kind: 'Diagnostic', diagnostic, activeVersion: this.session.getState().active?.version ?? 0 }); } catch (_) {}
  }
  private offerOutcome(outcome?: InstallationOutcome): void {
    if (outcome) { try { this.options.onInstallationOutcome?.(outcome); } catch (_) {} }
  }

  private async runUpdate(initial: boolean, cancellation: OfflineCancellation,
    progress: (value: ManagedProgress) => void): Promise<StartupResult> {
    while (this.operation) { await waitFor(this.operation, cancellation); }
    cancellation.throwIfCancelled();
    if (!this.canStart()) { return { kind: StartupKind.DEFERRED }; }
    let release: () => void = (): void => {};
    const permit = new Promise<void>((resolve) => { release = resolve; });
    this.operation = permit;
    let outcome: InstallationOutcome | undefined = undefined;
    try {
      const localWasReady = this.session.isLocalReady();
      if (!await this.session.prepareLocal(cancellation)) { return { kind: StartupKind.CONTINUE }; }
      if (!localWasReady && !this.canStart()) { return { kind: StartupKind.DEFERRED }; }
      if (initial) { progress({ stage: ManagedProgressStage.CHECKING, percent: -1 }); }
      cancellation.throwIfCancelled();
      if (initial && !this.canStart()) { return { kind: StartupKind.DEFERRED }; }
      let config: ManagedConfig | undefined = undefined;
      let providerFailed = false;
      // 起点紧贴真实provider调用；排队/初始化不消耗五分钟请求资格。
      this.lastProviderStart = uptime();
      try {
        config = await this.options.configProvider({ currentVersion: this.session.currentVersion(), cancellation });
      } catch (error) {
        if (error instanceof OfflineCancelledError) { throw error; }
        cancellation.throwIfCancelled();
        providerFailed = true;
        this.emitDiagnostic(ManagedFailureReason.CONFIGURATION, ManagedFailureStage.CONFIG);
      }
      cancellation.throwIfCancelled();
      if (config) {
        const result = await this.session.check(config, cancellation, progress, () => this.canStart(), initial);
        outcome = result.outcome;
        if (result.deferred) { return { kind: StartupKind.DEFERRED }; }
      } else if (!providerFailed) {
        this.emitDiagnostic(ManagedFailureReason.CONFIGURATION, ManagedFailureStage.CONFIG);
      }
      if (initial) { await this.session.finishInitial(cancellation); }
      else { await this.session.finishRegular(outcome, cancellation); }
      cancellation.throwIfCancelled();
      return { kind: StartupKind.CONTINUE, outcome };
    } finally {
      // Release the shared operation before compatibility callbacks; event facts belong to the session.
      if (this.operation === permit) { this.operation = undefined; }
      release();
      this.offerOutcome(outcome);
    }
  }

  private scheduleMonitor(): void {
    if (this.monitorTimer !== undefined) { clearTimeout(this.monitorTimer); this.monitorTimer = undefined; }
    const state = this.session.getState();
    if (!this.canStart() || !state.initialFinished || this.operation || this.firstWork || this.silentWork) {
      return;
    }
    const now = uptime();
    const providerRemaining = this.lastProviderStart === undefined ? 0 : this.lastProviderStart + this.interval - now;
    const remaining = Math.max(0, providerRemaining, this.monitorYieldUntil - now);
    this.monitorTimer = setTimeout(() => { this.monitorTimer = undefined; this.startSilent(); },
      Math.min(remaining, 2147483647));
  }
  private startSilent(): void {
    if (!this.canStart() || this.operation || this.firstWork || this.silentWork) { return; }
    if (uptime() < this.monitorYieldUntil ||
      this.lastProviderStart !== undefined && uptime() < this.lastProviderStart + this.interval) {
      this.scheduleMonitor(); return;
    }
    const cancellation = new OfflineCancellation();
    this.silentCancellation = cancellation;
    const priorProviderStart = this.lastProviderStart;
    const work = this.runSilent(cancellation);
    this.silentWork = work;
    const finished = (): void => {
      if (this.silentWork === work) {
        this.silentWork = undefined; this.silentCancellation = undefined;
        const finishedAt = uptime();
        if (this.lastProviderStart === priorProviderStart &&
          (priorProviderStart === undefined || finishedAt >= priorProviderStart + this.interval)) {
          // 本地准备失败等未发provider的轮次让出一周期；真实长请求仍按其起点TTL收尾。
          this.monitorYieldUntil = finishedAt + this.interval;
        }
      }
      this.scheduleMonitor();
    };
    work.then(finished, finished);
  }
  private async runSilent(cancellation: OfflineCancellation): Promise<void> {
    try { await this.runUpdate(false, cancellation, (_value: ManagedProgress): void => {}); }
    catch (error) {
      if (!(error instanceof OfflineCancelledError)) {
        this.emitDiagnostic(ManagedFailureReason.LOCAL_STATE_READ, ManagedFailureStage.LOCAL);
      }
    }
  }

  async loadPage(page: ArkWebPage, originalUrl: string, options: PageLoadOptions = {}): Promise<PageLoadResult> {
    const cancellation = options.cancellation ?? new OfflineCancellation();
    const generation = page.startLoad();
    cancellation.throwIfCancelled();
    let observation: PageObservation | undefined = undefined;
    if (!this.closed) { observation = await this.session.observePage(cancellation); }
    let loaded = false;
    let result: PageLoadResult = { originalUrl, offline: false };
    page.runScopedTask(() => {
      if (!page.isLoadCurrent(generation, cancellation)) { return; }
      // cache可能同步重入；最后复核以后不await、不读文件，紧接保护、绑定和原URL加载。
      const binding = observation && page.canBindUrl(originalUrl) ?
        this.session.finalBinding(observation, this.closed) : undefined;
      if (!page.isLoadCurrent(generation, cancellation)) { return; }
      let pageBinding: PageBinding | undefined = undefined;
      if (binding) {
        pageBinding = { directory: binding.directory, version: binding.version, isEnabled: binding.isEnabled };
        this.session.markPageBound();
      }
      page.commitLoad(originalUrl, pageBinding);
      result = { originalUrl, offline: binding !== undefined, version: binding?.version };
      loaded = true;
    });
    if (!loaded) { throw new OfflineCancelledError(); }
    this.scheduleMonitor();
    return result;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.monitorTimer !== undefined) { clearTimeout(this.monitorTimer); this.monitorTimer = undefined; }
    this.firstCancellation?.cancel();
    this.silentCancellation?.cancel();
    if (this.firstWork) { await this.firstWork.then(() => {}, () => {}); }
    if (this.silentWork) { await this.silentWork.then(() => {}, () => {}); }
    // 不改enabled、不解除旧page binding、不释放root给第二writer。
  }
}
