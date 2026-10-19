import { common } from '@kit.AbilityKit';
import { ManagedProgress, ManagedProgressStage, OfflineCancellation, OfflineCancelledError,
  StartupKind } from 'com.offline.tool';
import { DemoOffline } from '../data/DemoOffline';

export function startupText(stage: ManagedProgressStage): string {
  switch (stage) {
    case ManagedProgressStage.CHECKING: return '正在检查离线配置…';
    case ManagedProgressStage.PREPARING: return '正在准备离线资源…';
    case ManagedProgressStage.DOWNLOADING: return '正在下载资源包…';
    case ManagedProgressStage.VERIFYING: return '正在校验资源包…';
    case ManagedProgressStage.EXTRACTING: return '正在解压资源包…';
    case ManagedProgressStage.SAVING: return '正在保存版本记录…';
    case ManagedProgressStage.CONFIRMING: return '正在确认离线资源…';
    case ManagedProgressStage.COMPLETE: return '离线资源准备完成';
    default: return '正在准备启动配置…';
  }
}

@Observed
export class SplashViewModel {
  running: boolean = false;
  failed: boolean = false;
  deferred: boolean = false;
  ready: boolean = false;
  showWeb: boolean = false;
  needsConsent: boolean = true;
  showProgress: boolean = false;
  text: string = '正在准备启动配置…';
  percent: number = -1;
  diagnostic: string = '';
  private context?: common.UIAbilityContext;
  private businessReady: boolean = false;
  private offlineReady: boolean = false;
  private alive: boolean = true;
  private cancellation?: OfflineCancellation;
  private unobserve?: () => void;

  attach(context: common.UIAbilityContext): void {
    this.context = context;
    this.unobserve = DemoOffline.observe(() => this.updateReady());
    this.updateReady();
    // 业务准备有独立门禁；实际App在自己的登录/配置成功后解除，不由离线结果代办。
    context.resourceManager.getStringByName('module_desc').then(() => {
      if (this.alive) { this.businessReady = true; this.updateReady(); }
    }).catch(() => { if (this.alive) { this.text = '业务启动准备失败，请重新进入。'; } });
  }

  acceptPrivacy(): void { DemoOffline.setPrivacyAccepted(true); this.start(); }
  private updateReady(): void {
    this.needsConsent = !DemoOffline.privacyAccepted;
    this.ready = this.alive && this.businessReady && this.offlineReady && DemoOffline.canNavigate;
  }
  enterPage(): void { this.updateReady(); if (this.ready) { this.showWeb = true; } }

  async start(): Promise<void> {
    if (this.running || !this.context || !this.alive || !DemoOffline.privacyAccepted) { return; }
    // 重试前先重置全部可见状态；本页面句柄只取消自己的等待，不复刻SDK首次策略。
    this.running = true; this.failed = false; this.deferred = false; this.ready = false;
    this.showWeb = false; this.offlineReady = false; this.showProgress = false;
    this.text = '正在准备启动配置…'; this.percent = -1; this.diagnostic = '';
    const cancellation = new OfflineCancellation();
    this.cancellation = cancellation;
    try {
      const manager = await DemoOffline.create(this.context);
      cancellation.throwIfCancelled();
      const result = await manager.prepareStartup({ cancellation, onProgress: (value: ManagedProgress) => {
        if (!this.alive || cancellation.isCancelled) { return; }
        this.text = startupText(value.stage);
        this.showProgress = value.stage !== ManagedProgressStage.CHECKING;
        this.percent = value.stage === ManagedProgressStage.COMPLETE ? 100 :
          value.stage === ManagedProgressStage.DOWNLOADING && value.percent >= 0 ? Math.min(value.percent, 99) : -1;
      } });
      if (!this.alive || cancellation.isCancelled) { return; }
      this.showProgress = false;
      if (result.kind === StartupKind.DEFERRED) {
        this.deferred = true; this.text = '离线准备已暂停';
      } else {
        this.offlineReady = true;
        this.text = '启动配置准备完成';
        if (result.outcome && result.outcome.success === false) {
          this.text = '离线资源准备未完成，将继续在线加载';
          this.diagnostic = result.outcome.reason + '/' + result.outcome.stage;
        }
      }
      this.updateReady();
    } catch (error) {
      if (!this.alive) { return; }
      this.showProgress = false;
      if (error instanceof OfflineCancelledError) {
        this.deferred = true; this.text = '离线准备已暂停';
      } else { this.failed = true; this.text = '启动准备暂不可用，请重试。'; }
    } finally { if (this.alive) { this.running = false; } }
  }

  dispose(): void { this.alive = false; this.cancellation?.cancel(); this.unobserve?.(); }
}
