import { url } from '@kit.ArkTS';
import { fileIo as fs } from '@kit.CoreFileKit';
import { regularFilePath } from './PackageFiles';

export interface LocalResource {
  fd: number;
  mime: string;
  size: number;
}

export function relativeResource(requestUrl: string, baseUrl: string, allowHttpAndHttps: boolean = false,
  managedPolicy: boolean = false): string {
  try {
    const base = new url.URL(baseUrl);
    const request = new url.URL(requestUrl);
    if (base.username || base.password || request.username || request.password ||
      base.search || base.hash || !base.pathname.endsWith('/') ||
      !(managedPolicy ? base.protocol === 'https:' || base.protocol === 'http:' :
      (base.protocol === 'https:' && (!base.port || base.port === '443')) ||
      (allowHttpAndHttps && base.protocol === 'http:' && (!base.port || base.port === '80'))) ||
      !request.pathname.startsWith(base.pathname)) { return ''; }
    // 托管默认严格保留 origin；显式跨协议共享只允许两端都是标准端口。
    if (managedPolicy && request.origin === base.origin) {
      // 相同非默认端口也合法；URL 解析器已经验证端口格式与范围。
    } else if (allowHttpAndHttps) {
      if (request.hostname !== base.hostname ||
        !((base.protocol === 'https:' && (!base.port || base.port === '443')) ||
        (base.protocol === 'http:' && (!base.port || base.port === '80'))) ||
        !((request.protocol === 'https:' && (!request.port || request.port === '443')) ||
        (request.protocol === 'http:' && (!request.port || request.port === '80')))) { return ''; }
    } else if (request.origin !== base.origin) { return ''; }
    // 托管base和请求原路径都检查；URL折叠base点段不能把声明范围扩大到整个origin。
    const originalUrls: string[] = managedPolicy ? [baseUrl, requestUrl] : [requestUrl];
    for (let original of originalUrls) {
      const rawPath = original.replace(/^[a-zA-Z]+:\/\/[^/]+/, '').split(/[?#]/)[0];
      const decoded = decodeURIComponent(rawPath);
      if (decoded.includes('\\') || /[\u0000-\u001f\u007f]/.test(decoded) ||
        decoded.split('/').some((part: string) => part === '.' || part === '..')) { return ''; }
    }
    let relative = decodeURIComponent(request.pathname.slice(base.pathname.length));
    if (!relative) { relative = 'index.html'; }
    if (relative.startsWith('/') || relative.endsWith('/') || relative.includes('%') ||
      relative.split('/').some((part: string) => !part || part === '.' || part === '..')) { return ''; }
    return relative;
  } catch (_) { return ''; }
}

export function mimeType(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const types: Record<string, string> = {
    'html': 'text/html', 'htm': 'text/html', 'js': 'application/javascript', 'mjs': 'application/javascript',
    'css': 'text/css', 'json': 'application/json', 'map': 'application/json', 'svg': 'image/svg+xml',
    'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'gif': 'image/gif', 'webp': 'image/webp',
    'ico': 'image/x-icon', 'avif': 'image/avif', 'woff': 'font/woff', 'woff2': 'font/woff2',
    'ttf': 'font/ttf', 'otf': 'font/otf', 'wasm': 'application/wasm', 'txt': 'text/plain',
    'pdf': 'application/pdf', 'mp3': 'audio/mpeg', 'mp4': 'video/mp4'
  };
  return types[extension] || 'application/octet-stream';
}

// The instance holds an immutable directory for the lifetime of one Web component.
export class ResourceInterceptor {
  private directory: string;
  private baseUrl: string;
  private allowHttpAndHttps: boolean;
  private managedPolicy: boolean;
  constructor(directory: string, baseUrl: string, allowHttpAndHttps: boolean = false, managedPolicy: boolean = false) {
    this.directory = directory; this.baseUrl = baseUrl; this.allowHttpAndHttps = allowHttpAndHttps;
    this.managedPolicy = managedPolicy;
  }

  open(requestUrl: string, method: string, hasRange: boolean): LocalResource | undefined {
    if (method !== 'GET' || hasRange || !this.directory) { return undefined; }
    const relative = relativeResource(requestUrl, this.baseUrl, this.allowHttpAndHttps, this.managedPolicy);
    if (!relative) { return undefined; }
    let file: fs.File | undefined = undefined;
    try {
      const path = regularFilePath(this.directory, relative);
      if (!path) { return undefined; }
      file = fs.openSync(path, fs.OpenMode.READ_ONLY | fs.OpenMode.NOFOLLOW);
      const stat = fs.statSync(file.fd);
      if (!stat.isFile() || stat.size <= 0) {
        fs.closeSync(file);
        file = undefined;
        return undefined;
      }
      return { fd: file.fd, mime: mimeType(path), size: stat.size };
    } catch (_) {
      if (file) { try { fs.closeSync(file); } catch (_) {} }
      return undefined;
    }
  }
}
