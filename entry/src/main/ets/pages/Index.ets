import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { ArkWebPage, OfflineCancellation } from 'com.offline.tool';
import { DEMO_ORIGIN, DEMO_PAGE_URL } from '../data/DemoConfig';
import { DemoOffline } from '../data/DemoOffline';
import { SplashViewModel } from '../viewmodel/SplashViewModel';

@Entry
@Component
struct Index {
  @State model: SplashViewModel = new SplashViewModel();
  aboutToAppear(): void {
    this.model.attach(this.getUIContext().getHostContext() as common.UIAbilityContext);
    if (DemoOffline.privacyAccepted) { this.model.start(); }
  }
  aboutToDisappear(): void { this.model.dispose(); }
  build() {
    Column() {
      if (this.model.showWeb) { OfflinePage().layoutWeight(1) }
      else { SplashContent({ model: this.model }).layoutWeight(1) }
    }.width('100%').height('100%').backgroundColor('#FFF9F4')
  }
}

@Component
struct SplashContent {
  @ObjectLink model: SplashViewModel;
  build() {
    Column() {
      Column({ space: 20 }) {
        Text('OFFLINE').fontSize(14).letterSpacing(5).fontColor('#A36648')
        Text('每一次出发\n都准备妥当').fontSize(36).fontWeight(FontWeight.Medium)
          .fontColor('#332D28').textAlign(TextAlign.Center).lineHeight(52)
        Text('HarmonyOS 离线资源示例').fontSize(14).fontColor('#8A8077')
      }.layoutWeight(1).width('100%').justifyContent(FlexAlign.Center)
      Column({ space: 12 }) {
        if (this.model.needsConsent) {
          Text('同意示例隐私说明后开始启动准备。').fontSize(12).fontColor('#777777')
          Button('同意并开始').onClick(() => this.model.acceptPrivacy())
        } else {
          Row() {
            Text(this.model.text).fontSize(12).fontColor('#777777').layoutWeight(1)
            if (this.model.showProgress && this.model.percent >= 0) {
              Text(this.model.percent + '%').fontSize(13).fontColor('#777777')
            }
          }.width('100%')
          if (this.model.showProgress) {
            if (this.model.percent >= 0) {
              Progress({ value: this.model.percent, total: 100, type: ProgressType.Linear })
                .width('100%').color('#E56E46').backgroundColor('#F1E5DC').style({ strokeWidth: 3 })
            } else {
              // 无真实下载/解压比例时显示不定进度，不把扫描动画当成完成比例。
              Progress({ value: 100, total: 100, type: ProgressType.Linear })
                .width('100%').color('#E56E46').backgroundColor('#F1E5DC')
                .style({ strokeWidth: 3, enableScanEffect: true })
            }
          }
          if (this.model.failed || this.model.deferred) {
            Button('重试').onClick(() => this.model.start())
          }
          if (this.model.ready) { Button('进入页面').onClick(() => this.model.enterPage()) }
        }
      }.width('100%').height(144).justifyContent(FlexAlign.Center)
    }.width('100%').height('100%').padding({ left: 28, right: 28, bottom: 28 })
  }
}

class DemoBridge { ping(): string { return 'harmony-managed-demo'; } }
@Component
struct OfflinePage {
  @State text: string = '';
  private controller: webview.WebviewController = new webview.WebviewController();
  private page?: ArkWebPage;
  private cancellation: OfflineCancellation = new OfflineCancellation();
  private loaded: boolean = false;
  private bridge: DemoBridge = new DemoBridge();
  private detachCleaner?: () => void;
  aboutToAppear(): void {
    this.page = new ArkWebPage(this.getUIContext(), this.controller, {
      resourceBaseUrl: DEMO_ORIGIN, shareHttpAndHttps: false
    });
  }
  aboutToDisappear(): void { this.cancellation.cancel(); this.page?.close(); this.detachCleaner?.(); }
  private async load(): Promise<void> {
    if (this.loaded || !this.page) { return; }
    this.loaded = true;
    try {
      // Cookie/Bridge先就绪；占位Web关联controller后，manager只加载一次原HTTP(S) URL。
      await webview.WebCookieManager.configCookie(DEMO_ORIGIN, 'offlineDemo=managed; Path=/');
      this.cancellation.throwIfCancelled();
      const manager = await DemoOffline.create(this.getUIContext().getHostContext() as common.UIAbilityContext);
      await manager.loadPage(this.page, DEMO_PAGE_URL, { cancellation: this.cancellation });
    } catch (_) { if (!this.cancellation.isCancelled) { this.text = '页面暂不可用，请重新进入。'; } }
  }
  build() {
    Column() {
      if (this.text) { Text(this.text).fontSize(12).fontColor('#777777') }
      Web({ src: 'about:blank', controller: this.controller })
        .javaScriptAccess(true).domStorageAccess(true)
        .javaScriptProxy({ object: this.bridge, name: 'offlineDemo', methodList: ['ping'], controller: this.controller })
        .onControllerAttached(() => {
          this.detachCleaner?.();
          this.detachCleaner = DemoOffline.registerCacheCleaner(() => this.controller.removeCache(true));
          this.load();
        })
        .onInterceptRequest((event) => (event ? this.page?.intercept(event.request) : undefined) as WebResourceResponse)
        .width('100%').layoutWeight(1)
    }.width('100%').height('100%')
  }
}
