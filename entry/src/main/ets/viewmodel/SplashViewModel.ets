import { common } from '@kit.AbilityKit';
import { OfflineProgress, OfflineStage } from 'com.offline.demo';
import { DemoRepository } from '../data/DemoRepository';

export function startupText(stage: OfflineStage): string {
  switch (stage) {
    case OfflineStage.DOWNLOADING: return '正在下载资源包…';
    case OfflineStage.VERIFYING: return '正在校验资源包…';
    case OfflineStage.EXTRACTING: return '正在解压资源包…';
    case OfflineStage.SAVING: return '正在完成初始化…';
    case OfflineStage.COMPLETE: return '启动配置准备完成';
    default: return '正在准备启动配置…';
  }
}

@Observed
export class SplashViewModel {
  running: boolean = false;
  failed: boolean = false;
  ready: boolean = false;
  showWeb: boolean = false;
  text: string = startupText(OfflineStage.PREPARING);
  percent: number = -1;
  directory: string = '';
  diagnostic: string = '';
  private repository?: DemoRepository;
  private alive: boolean = true;

  attach(context: common.UIAbilityContext): void { this.repository = new DemoRepository(context); }

  async start(failHash: boolean = false): Promise<void> {
    if (this.running || !this.repository || !this.alive) { return; }
    // Reset every rendered property before the first await, including on retry.
    this.running = true;
    this.failed = false;
    this.ready = false;
    this.showWeb = false;
    this.text = startupText(OfflineStage.PREPARING);
    this.percent = -1;
    this.diagnostic = '';
    try {
      const directory = await this.repository.prepare((value: OfflineProgress) => {
        if (!this.alive) { return; }
        this.text = startupText(value.stage);
        this.percent = value.stage === OfflineStage.DOWNLOADING ? value.percent : -1;
      }, failHash);
      if (!this.alive) { return; }
      this.directory = directory;
      this.text = startupText(OfflineStage.COMPLETE);
      this.ready = true;
    } catch (error) {
      if (!this.alive) { return; }
      this.failed = true;
      this.text = '启动配置准备失败，请稍后重试。';
      this.diagnostic = (error as Error).message;
    } finally { if (this.alive) { this.running = false; } }
  }

  replay(failHash: boolean): void {
    if (this.running || !this.repository) { return; }
    this.showWeb = false;
    this.repository.beginReplay();
    this.start(failHash);
  }

  dispose(): void { this.alive = false; this.repository?.dispose(); }
}
