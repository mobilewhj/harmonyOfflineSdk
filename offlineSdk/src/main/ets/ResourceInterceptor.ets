import { url } from '@kit.ArkTS';
import { fileIo as fs } from '@kit.CoreFileKit';
import { regularFilePath } from './PackageFiles';

export interface LocalResource {
  fd: number;
  mime: string;
  size: number;
}

export function relativeResource(requestUrl: string, baseUrl: string, allowHttpAndHttps: boolean = false): string {
  try {
    const base = new url.URL(baseUrl);
    const request = new url.URL(requestUrl);
    if (base.username || base.password || request.username || request.password ||
      base.search || base.hash || !base.pathname.endsWith('/') ||
      !((base.protocol === 'https:' && (!base.port || base.port === '443')) ||
      (allowHttpAndHttps && base.protocol === 'http:' && (!base.port || base.port === '80'))) ||
      !request.pathname.startsWith(base.pathname)) { return ''; }
    // Legacy business routes use HTTP even when the configured origin uses HTTPS.
    // Sharing local files is opt-in and limited to the same hostname and each protocol's default port.
    if (allowHttpAndHttps) {
      if (request.hostname !== base.hostname ||
        !((request.protocol === 'https:' && (!request.port || request.port === '443')) ||
        (request.protocol === 'http:' && (!request.port || request.port === '80')))) { return ''; }
    } else if (request.origin !== base.origin) { return ''; }
    // Inspect the original path before URL normalization can erase dot segments.
    const rawPath = requestUrl.replace(/^[a-zA-Z]+:\/\/[^/]+/, '').split(/[?#]/)[0];
    const decoded = decodeURIComponent(rawPath);
    if (decoded.includes('\\') || /[\u0000-\u001f\u007f]/.test(decoded) ||
      decoded.split('/').some((part: string) => part === '.' || part === '..')) { return ''; }
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
  constructor(directory: string, baseUrl: string, allowHttpAndHttps: boolean = false) {
    this.directory = directory; this.baseUrl = baseUrl; this.allowHttpAndHttps = allowHttpAndHttps;
  }

  open(requestUrl: string, method: string, hasRange: boolean): LocalResource | undefined {
    if (method !== 'GET' || hasRange || !this.directory) { return undefined; }
    const relative = relativeResource(requestUrl, this.baseUrl, this.allowHttpAndHttps);
    if (!relative) { return undefined; }
    let file: fs.File | undefined = undefined;
    try {
      const path = regularFilePath(this.directory, relative);
      if (!path) { return undefined; }
      file = fs.openSync(path, fs.OpenMode.READ_ONLY | fs.OpenMode.NOFOLLOW);
      return { fd: file.fd, mime: mimeType(path), size: fs.statSync(file.fd).size };
    } catch (_) {
      if (file) { try { fs.closeSync(file); } catch (_) {} }
      return undefined;
    }
  }
}
