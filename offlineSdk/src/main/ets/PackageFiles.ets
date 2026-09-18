import { fileIo as fs } from '@kit.CoreFileKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { safeRelativePath } from './ZipInspection';
import { PackageRecord, packageDirectory } from './OfflineTypes';

// The root is a trusted app-private directory. Reject links in every relative path component.
export function regularFilePath(root: string, relative: string): string {
  if (!safeRelativePath(relative) || !fs.lstatSync(root).isDirectory()) { return ''; }
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
    try {
      const entry = regularFilePath(directory, relative);
      if (entry && fs.lstatSync(entry).size > 0) {
        return relative === 'index.html' ? directory : directory + '/dist';
      }
    } catch (_) { /* A package can use either root/index.html or dist/index.html. */ }
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
    if (!fs.lstatSync(root).isDirectory() || !fs.lstatSync(directory).isDirectory()) {
      return '';
    }
    return contentRoot(directory);
  } catch (_) {
    return '';
  }
}

export function cleanPackages(root: string, keep: string): void {
  fs.mkdirSync(root, true);
  for (let name of fs.listFileSync(root)) {
    // Also discard leftovers from the pre-0.1.4 version-hash naming scheme.
    if (name !== keep && (/^\d+(?:_temp|\.zip\.tmp)?$/.test(name) ||
      /^\d+-[a-f0-9]{64}$/.test(name) || name.startsWith('.install-'))) {
      removeTree(root + '/' + name);
    }
  }
}
