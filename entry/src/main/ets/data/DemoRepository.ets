import { rcp } from '@kit.RemoteCommunicationKit';
import { ConfigRequest, ManagedConfig } from 'com.offline.tool';
import { DEMO_CONFIG_URL } from './DemoConfig';

// 宿主只提供配置网络边界；首次资格、包策略、准备及冷启动启用全部归SDK。
export class DemoRepository {
  async fetchConfig(input: ConfigRequest): Promise<ManagedConfig> {
    input.cancellation.throwIfCancelled();
    const session = rcp.createSession();
    const request = new rcp.Request(DEMO_CONFIG_URL, 'GET', { 'Cache-Control': 'no-cache' });
    request.configuration = { transfer: { autoRedirect: false,
      timeout: { connectMs: 20000, transferMs: 20000 } } };
    const detach = input.cancellation.onCancel(() => session.cancel(request));
    try {
      const response = await session.fetch(request);
      input.cancellation.throwIfCancelled();
      if (response.statusCode !== 200) { throw new Error('DEMO_CONFIG_HTTP'); }
      const config = response.toJSON() as ManagedConfig;
      if (!config || Array.isArray(config) || typeof config.enabled !== 'boolean') {
        throw new Error('DEMO_CONFIG_SHAPE');
      }
      return config;
    } catch (error) {
      // 网络取消回调常返回普通BusinessError；以调用句柄的事实恢复真取消语义。
      input.cancellation.throwIfCancelled();
      if (error instanceof Error) { throw error; }
      throw new Error('DEMO_CONFIG_REQUEST');
    } finally { detach(); session.close(); }
  }
}
