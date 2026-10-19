import { PackageRecord } from 'com.offline.tool';
export const DEMO_RECORD: PackageRecord = { version: 10000, sha256: 'fa0d35e2754bf5ba4760e7a2f68014f3629bc3f833c8929c242103532dcea624' };
// 可控测试服务的原URL；改为开发机局域网地址后，线上回源和离线拦截仍使用同一URL。
// sample.zip仍保留为低层fixture，托管主链只从服务配置获取资源包。
export const DEMO_ORIGIN: string = 'http://192.168.1.2:8088/';
export const DEMO_CONFIG_URL: string = DEMO_ORIGIN + 'config.json';
export const DEMO_PAGE_URL: string = DEMO_ORIGIN + 'index.html?demo=managed#home';
