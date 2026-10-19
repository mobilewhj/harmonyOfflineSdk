import { UIContext } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { fileIo as fs } from '@kit.CoreFileKit';
import { ResourceInterceptor, LocalResource, relativeResource } from './ResourceInterceptor';
import { ArkWebPageOptions, OfflineCancellation } from './ManagedOfflineTypes';

// 仅供 manager 的同步加载提交使用；包资格仍由 session 唯一判断。
export interface PageBinding {
  directory: string;
  version: number;
  isEnabled: () => boolean;
}

export class ArkWebPage {
  private uiContext: UIContext;
  private controller: webview.WebviewController;
  private resourceBaseUrl: string;
  private shareHttpAndHttps: boolean;
  private binding?: ResourceInterceptor;
  private isEnabled?: () => boolean;
  private closed: boolean = false;
  private loadGeneration: number = 0;

  constructor(uiContext: UIContext, controller: webview.WebviewController, options: ArkWebPageOptions) {
    this.uiContext = uiContext;
    this.controller = controller;
    this.resourceBaseUrl = options.resourceBaseUrl;
    this.shareHttpAndHttps = options.shareHttpAndHttps === true;
  }

  // 新调用只使旧的未提交观察失效，不清除已完成的固定绑定。
  startLoad(): number { return ++this.loadGeneration; }

  isLoadCurrent(generation: number, cancellation?: OfflineCancellation): boolean {
    return !this.closed && generation === this.loadGeneration && cancellation?.isCancelled !== true;
  }

  // 页面资格与逐资源匹配复用同一来源规则；这里只解析 URL，不读取包文件。
  canBindUrl(originalUrl: string): boolean {
    return relativeResource(originalUrl, this.resourceBaseUrl, this.shareHttpAndHttps, true) !== '';
  }

  // 所有调用来自主 ArkTS 事件域；此 API 只选择 UI 实例，并不跨线程调度。
  runScopedTask(callback: () => void): void { this.uiContext.runScopedTask(callback); }

  // controller 必须已关联 Web；正常返回仅确认调用成功，真实清理效果须设备验证。
  clearResourceCache(): void { this.controller.removeCache(true); }

  // manager 在 cache 可同步重入后完成最后资格/代际复核；本段不 await、不读入口文件。
  commitLoad(originalUrl: string, binding?: PageBinding): void {
    this.binding = binding ? new ResourceInterceptor(binding.directory, this.resourceBaseUrl,
      this.shareHttpAndHttps, true) : undefined;
    this.isEnabled = binding?.isEnabled;
    this.controller.loadUrl(originalUrl);
  }

  close(): void {
    this.closed = true;
    ++this.loadGeneration;
    this.binding = undefined;
    this.isEnabled = undefined;
    // 页面关闭不解除进程目录保护，也不取消其它页面或共享更新。
  }

  intercept(request: WebResourceRequest): WebResourceResponse | undefined {
    let resource: LocalResource | undefined = undefined;
    try {
      // 既有绑定只动态检查 enabled；隐私、前后台和 manager.close 不构成额外许可。
      if (this.closed || !this.binding || !this.isEnabled || !this.isEnabled()) { return undefined; }
      const hasRange = request.getRequestHeader().some((header: Header) =>
        header.headerKey.toLowerCase() === 'range');
      resource = this.binding.open(request.getRequestUrl(), request.getRequestMethod(), hasRange);
      if (!resource) { return undefined; }
      const response = new WebResourceResponse();
      response.setResponseMimeType(resource.mime);
      response.setResponseEncoding('UTF-8');
      response.setResponseCode(200);
      response.setReasonMessage('OK');
      response.setResponseHeader([{ headerKey: 'Content-Length', headerValue: resource.size.toString() },
        { headerKey: 'Cache-Control', headerValue: 'no-store' }]);
      // number FD 成功交付后由 system Web 读取/关闭；SDK 不复制正文，也不提前关 FD。
      response.setResponseData(resource.fd);
      return response;
    } catch (_) {
      // 未交付的 FD 属于 SDK；元数据或响应构造异常当次同步回源。
      if (resource) { try { fs.closeSync(resource.fd); } catch (_) {} }
      return undefined;
    }
  }
}
