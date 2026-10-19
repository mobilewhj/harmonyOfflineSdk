import { fileIo as fs } from '@kit.CoreFileKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { safeRelativePath } from './ZipInspection';
import { OfflineError, PackageRecord, packageDirectory, PackageObservation } from './OfflineTypes';

// 词法键只在当前沙盒命名空间成立；安全性另由后台逐级 lstat 验证。
export function normalizePackageRoot(value: string): string {
  if (!value.startsWith('/') || /[\u0000-\u001f\u007f]/.test(value)) { throw new OfflineError('UNSAFE_PATH'); }
  const parts: string[] = [];
  for (let part of value.split('/')) {
    if (!part || part === '.') { continue; }
    if (part === '..') { parts.pop(); } else { parts.push(part); }
  }
  if (!parts.length) { throw new OfflineError('UNSAFE_PATH'); }
  return '/' + parts.join('/');
}

export function overlappingPaths(first: string, second: string): boolean {
  return first === second || first.startsWith(second + '/') || second.startsWith(first + '/');
}

export function validatePackagePath(value: string, source: boolean = false, removableLeaf: boolean = false): string {
  let path: string;
  try { path = normalizePackageRoot(value); } catch (_) {
    throw new OfflineError(source ? 'INVALID_SOURCE' : 'UNSAFE_PATH');
  }
  // 原路径先检查可见节点，再检查折叠后的键；缺失/../link 也不能跳过链接检查。
  for (let candidate of [value, path]) {
    const parts = candidate.split('/').filter((part: string) => !!part && part !== '.');
    let current = '';
    for (let index = 0; index < parts.length; index++) {
      if (parts[index] === '..') { current = current.slice(0, current.lastIndexOf('/')); continue; }
      current += '/' + parts[index];
      let stat: fs.Stat;
      try { stat = fs.lstatSync(current); } catch (error) {
        // 新根只能在已经验证的普通父目录下建立；源文件不允许缺失。
        if (!source && (error as BusinessError).code === 13900002) { break; }
        throw new OfflineError(source ? 'INVALID_SOURCE' : 'UNSAFE_PATH');
      }
      const last = index === parts.length - 1;
      // 删除可安全 unlink 最末文件/链接，祖先仍必须是普通目录。
      if (!(removableLeaf && last) && (stat.isSymbolicLink() || (source && last ? !stat.isFile() : !stat.isDirectory()))) {
        throw new OfflineError(source ? 'INVALID_SOURCE' : 'UNSAFE_PATH');
      }
    }
  }
  return path;
}

// The root is a trusted app-private directory. Reject links in every relative path component.
export function regularFilePath(root: string, relative: string): string {
  const rootStat = fs.lstatSync(root);
  if (!safeRelativePath(relative) || rootStat.isSymbolicLink() || !rootStat.isDirectory()) { return ''; }
  let path = root;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    path += '/' + parts[index];
    const stat = fs.lstatSync(path);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) { return ''; }
  }
  return path;
}

export function contentRoot(directory: string): string {
  for (let relative of ['index.html', 'dist/index.html']) {
    let file: fs.File | undefined = undefined;
    try {
      const entry = regularFilePath(directory, relative);
      if (!entry) { continue; }
      // 后台入口资格要求实际可读；stat 非空不足以保证 ArkWeb 随后能打开正文。
      file = fs.openSync(entry, fs.OpenMode.READ_ONLY | fs.OpenMode.NOFOLLOW);
      const stat = fs.statSync(file.fd);
      if (stat.isFile() && stat.size > 0 && fs.readSync(file.fd, new ArrayBuffer(1)) === 1) {
        return relative === 'index.html' ? directory : directory + '/dist';
      }
    } catch (_) { /* root/dist 两种入口都必须独立核实，失败不授予 usable。 */ }
    finally { if (file) { fs.closeSync(file); } }
  }
  return '';
}

// Never follow symlinks when discarding an unfinished extraction or an old version.
export function removeTree(path: string): void {
  try { fs.lstatSync(path); } catch (error) {
    if ((error as BusinessError).code === 13900002) { return; }
    throw error as Error;
  }
  const pending: string[] = [path];
  const directories: string[] = [];
  while (pending.length) {
    const current = pending.pop() as string;
    const stat = fs.lstatSync(current);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      directories.push(current);
      for (let name of fs.listFileSync(current)) { pending.push(current + '/' + name); }
    } else { fs.unlinkSync(current); }
  }
  for (let index = directories.length - 1; index >= 0; index--) { fs.rmdirSync(directories[index]); }
}

export function usablePackage(root: string, record: PackageRecord): string {
  try {
    const directory = packageDirectory(root, record);
    const rootStat = fs.lstatSync(root), directoryStat = fs.lstatSync(directory);
    if (rootStat.isSymbolicLink() || directoryStat.isSymbolicLink() || !rootStat.isDirectory() || !directoryStat.isDirectory()) {
      return '';
    }
    return contentRoot(directory);
  } catch (_) {
    return '';
  }
}

export function observePackageFiles(root: string, record: PackageRecord): PackageObservation {
  const safeRoot = validatePackagePath(root);
  const target = packageDirectory(safeRoot, record);
  let exists = false;
  try { fs.lstatSync(target); exists = true; } catch (error) {
    if ((error as BusinessError).code !== 13900002) { throw error as Error; }
  }
  return { directory: exists ? usablePackage(safeRoot, record) : '', exists };
}

export function cleanPackages(root: string, keep: string): void {
  root = validatePackagePath(root);
  // 原生 recursive mkdir 对已有目录仍报 EEXIST；普通根已由上方路径验证。
  if (!fs.accessSync(root)) { fs.mkdirSync(root, true); }
  for (let name of fs.listFileSync(root)) {
    // Also discard leftovers from the pre-0.2.0 version-hash naming scheme.
    if (name !== keep && (/^\d+(?:_temp|\.zip\.tmp)?$/.test(name) ||
      /^\d+-[a-f0-9]{64}$/.test(name) || name.startsWith('.install-'))) {
      removeTree(root + '/' + name);
    }
  }
}


// The lifecycle DB is outside this isolated directory. Unknown files are not package facts.
export function cleanLifecyclePackages(root: string, keep: string[], checkCancelled: () => void = () => {}): void {
  root = validatePackagePath(root);
  if (!fs.accessSync(root)) { fs.mkdirSync(root, true); }
  for (let name of fs.listFileSync(root)) {
    if (!keep.includes(name)) {
      checkCancelled();
      try { removeTree(root + '/' + name); }
      catch (error) {
        if (error instanceof OfflineError && error.reason === 'CANCELLED') { throw error; }
        // 单项失败留给后续正常清理重试，不阻断其它淘汰项。
      }
    }
  }
}
