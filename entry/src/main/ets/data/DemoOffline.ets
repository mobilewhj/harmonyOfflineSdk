import { common } from '@kit.AbilityKit';
import { ConfigRequest, ManagedEvent, ManagedOfflineSdk } from 'com.offline.tool';
import { DemoRepository } from './DemoRepository';

// 应用级单例只提供网络和生命周期事实；首次/版本/事务/重试均由SDK管理。
export class DemoOffline {
  private static manager?: Promise<ManagedOfflineSdk>;
  private static instance?: ManagedOfflineSdk;
  private static privacy: boolean = false;
  private static foreground: boolean = false;
  private static listeners: Array<() => void> = [];
  private static cacheCleaner?: () => void;
  static get privacyAccepted(): boolean { return DemoOffline.privacy; }
  static get canNavigate(): boolean { return DemoOffline.privacy && DemoOffline.foreground; }

  static create(context: common.UIAbilityContext): Promise<ManagedOfflineSdk> {
    if (!DemoOffline.manager) {
      const repository = new DemoRepository();
      DemoOffline.manager = ManagedOfflineSdk.create(context, {
        configProvider: (input: ConfigRequest) => repository.fetchConfig(input),
        resourceCacheCleaner: (): void => {
          if (!DemoOffline.cacheCleaner) { throw new Error('NO_ATTACHED_WEB'); }
          DemoOffline.cacheCleaner();
        },
        onEvent: (event: ManagedEvent): void => {
          // 事件接入在任何检查前就绪；诊断不当作安装结果。
          if (event.kind === 'Prepared' && event.record) {
            console.info('OFFLINE_PREPARED version=' + event.record.version);
          } else if (event.kind === 'PrepareFailed' && event.failure) {
            console.info('OFFLINE_PREPARE_FAILED stage=' + event.failure.stage);
          }
        }
      });
      DemoOffline.manager.then((manager: ManagedOfflineSdk) => {
        DemoOffline.instance = manager;
        manager.updateConditions({ privacyAccepted: DemoOffline.privacy, foreground: DemoOffline.foreground });
      }).catch(() => {});
    }
    return DemoOffline.manager;
  }

  static registerCacheCleaner(cleaner: () => void): () => void {
    DemoOffline.cacheCleaner = cleaner;
    return (): void => { if (DemoOffline.cacheCleaner === cleaner) { DemoOffline.cacheCleaner = undefined; } };
  }
  static setPrivacyAccepted(value: boolean): void { DemoOffline.privacy = value; DemoOffline.changed(); }
  static setForeground(value: boolean): void { DemoOffline.foreground = value; DemoOffline.changed(); }
  private static changed(): void {
    DemoOffline.instance?.updateConditions({ privacyAccepted: DemoOffline.privacy, foreground: DemoOffline.foreground });
    for (let listener of DemoOffline.listeners) { listener(); }
  }
  static observe(listener: () => void): () => void {
    DemoOffline.listeners.push(listener);
    return (): void => { DemoOffline.listeners = DemoOffline.listeners.filter((value: () => void) => value !== listener); };
  }
}
