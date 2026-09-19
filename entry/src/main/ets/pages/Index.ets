import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { fileIo as fs } from '@kit.CoreFileKit';
import { ResourceInterceptor } from 'com.offline.tool';
import { DEMO_ORIGIN } from '../data/DemoConfig';
import { SplashViewModel } from '../viewmodel/SplashViewModel';

@Entry
@Component
struct Index {
  @State model: SplashViewModel = new SplashViewModel();

  aboutToAppear(): void {
    this.model.attach(this.getUIContext().getHostContext() as common.UIAbilityContext);
    this.model.start();
  }
  aboutToDisappear(): void { this.model.dispose(); }

  build() {
    Column() {
      if (this.model.showWeb) {
        OfflinePage({ directory: this.model.directory })
          .layoutWeight(1)
        Row({ space: 12 }) {
          Button('重放启动').onClick(() => this.model.replay(false))
          Button('模拟失败').onClick(() => this.model.replay(true))
        }.padding(16).width('100%').justifyContent(FlexAlign.Center)
      } else {
        SplashContent({ model: this.model }).layoutWeight(1)
      }
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
        if (this.model.failed) {
          Text(this.model.text).fontSize(12).fontColor('#777777').width('100%').textAlign(TextAlign.Center)
          Button('重试', { type: ButtonType.Normal }).width(96).height(48)
            .fontColor('#E56E46').backgroundColor(Color.Transparent).fontSize(14)
            .onClick(() => this.model.start())
        } else {
          Row() {
            Text(this.model.text).fontSize(12).fontColor('#777777').layoutWeight(1).textAlign(TextAlign.Start)
            if (this.model.percent >= 0 && !this.model.ready) {
              Text(this.model.percent + '%').fontSize(13).fontColor('#777777')
            }
          }.width('100%')
          if (this.model.ready || this.model.percent >= 0) {
            Progress({ value: this.model.ready ? 100 : this.model.percent, total: 100, type: ProgressType.Linear })
              .width('100%').color('#E56E46').backgroundColor('#F1E5DC').style({ strokeWidth: 3 })
          } else {
            // Indeterminate: local copy, hashing and official ZIP extraction have no true percentage.
            Progress({ value: 100, total: 100, type: ProgressType.Linear })
              .width('100%').color('#E56E46').backgroundColor('#F1E5DC')
              .style({ strokeWidth: 3, enableScanEffect: true })
          }
          if (this.model.ready) {
            Button('进入离线页面', { type: ButtonType.Normal }).height(48)
              .fontColor('#E56E46').backgroundColor(Color.Transparent).fontSize(14)
              .onClick(() => { this.model.showWeb = true; })
          }
        }
      }.width('100%').height(112).justifyContent(FlexAlign.Center)
    }.width('100%').height('100%').padding({ left: 28, right: 28, bottom: 28 })
  }
}

@Component
struct OfflinePage {
  directory: string = '';
  private controller: webview.WebviewController = new webview.WebviewController();
  private binding?: ResourceInterceptor;

  aboutToAppear(): void { this.binding = new ResourceInterceptor(this.directory, DEMO_ORIGIN); }

  private intercept(request: WebResourceRequest): WebResourceResponse | undefined {
    const hasRange = request.getRequestHeader().some((header: Header) => header.headerKey.toLowerCase() === 'range');
    const resource = this.binding?.open(request.getRequestUrl(), request.getRequestMethod(), hasRange);
    if (!resource) { return undefined; }
    try {
      const response = new WebResourceResponse();
      response.setResponseMimeType(resource.mime);
      response.setResponseEncoding('UTF-8');
      response.setResponseCode(200);
      response.setReasonMessage('OK');
      response.setResponseHeader([{ headerKey: 'Content-Length', headerValue: resource.size.toString() },
        { headerKey: 'Cache-Control', headerValue: 'no-store' }]);
      response.setResponseData(resource.fd); // ArkWeb owns the descriptor after this response is returned.
      return response;
    } catch (_) { fs.closeSync(resource.fd); return undefined; }
  }

  build() {
    Web({ src: DEMO_ORIGIN + 'index.html', controller: this.controller })
      .javaScriptAccess(true)
      .onInterceptRequest((event) => (event ? this.intercept(event.request) : undefined) as WebResourceResponse)
      .width('100%').height('100%')
  }
}
